/**
 * SourceManager: lazily manages multiple TesseraSource instances (one per
 * UTM zone) and routes geographic queries to the correct zone(s).
 *
 * @remarks
 * Consumers interact with the manager instead of individual sources. The
 * manager transparently opens zone sources on demand and aggregates results
 * across zones for multi-zone queries.
 *
 * This class is framework-agnostic — it contains no rendering or
 * map-framework code. Framework-specific managers (e.g. MaplibreTesseraManager)
 * extend or wrap this class.
 *
 * @example
 * ```typescript
 * const mgr = new SourceManager(zones);
 * const chunks = await mgr.getChunksInRegion(polygon);
 * const src = await mgr.getSource('32N');
 * await src.loadChunks(chunks.filter(c => c.zoneId === '32N'));
 * ```
 */
import { EventEmitter } from './event-emitter.js';
import { TesseraSource } from './tessera-source.js';
import type { GeoJsonPolygon } from './tessera-source.js';
import type {
  ZoneDescriptor,
  TesseraOptions,
  StoreMetadata,
  ManagedChunk,
  EmbeddingRegion,
  EmbeddingAt,
  TesseraEvents,
} from './types.js';

// ---- Helpers ----

/**
 * Test whether a WGS84 point lies within a bounding box.
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @param bbox - `[west, south, east, north]` in WGS84 degrees.
 */
function pointInBbox(
  lng: number,
  lat: number,
  bbox: [number, number, number, number],
): boolean {
  const [w, s, e, n] = bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

/**
 * Test whether two WGS84 bounding boxes overlap.
 *
 * @param a - First bbox `[west, south, east, north]`.
 * @param b - Second bbox `[west, south, east, north]`.
 */
function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Compute the WGS84 bounding box of a polygon's outer ring.
 *
 * @param polygon - GeoJSON Polygon.
 * @returns `[west, south, east, north]`.
 */
function polygonBbox(polygon: GeoJsonPolygon): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of polygon.coordinates[0]) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/**
 * Multi-zone routing manager for TESSERA Zarr stores.
 *
 * @remarks
 * Manages a set of {@link ZoneDescriptor}s, each representing one UTM
 * zone with its own Zarr store. Sources are opened lazily on first
 * access and cached. Events from per-zone sources are forwarded to
 * manager listeners, so callers can subscribe once on the manager
 * rather than on each zone.
 */
export class SourceManager extends EventEmitter<TesseraEvents> {
  private readonly zones: ZoneDescriptor[];
  private readonly baseOpts: Omit<TesseraOptions, 'url'>;
  private readonly sources = new Map<string, TesseraSource>();
  private readonly opening = new Map<string, Promise<TesseraSource>>();

  /**
   * @param zones - Zone descriptors for all available UTM zones.
   * @param options - Base options applied to every zone source (excluding `url`).
   */
  constructor(zones: ZoneDescriptor[], options?: Omit<TesseraOptions, 'url'>) {
    super();
    this.zones = zones;
    this.baseOpts = options ?? {};
  }

  // ---------------------------------------------------------------------------
  // Zone routing
  // ---------------------------------------------------------------------------

  /**
   * Find zones whose bounding box contains a WGS84 point.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns Matching zone descriptors (may be more than one near zone edges).
   */
  zonesAtPoint(lng: number, lat: number): ZoneDescriptor[] {
    return this.zones.filter(z => pointInBbox(lng, lat, z.bbox));
  }

  /**
   * Find zones whose bounding box overlaps a polygon.
   *
   * @param polygon - A GeoJSON Polygon (outer ring used for bbox computation).
   * @returns Zone descriptors whose bbox overlaps the polygon's bbox.
   */
  zonesForPolygon(polygon: GeoJsonPolygon): ZoneDescriptor[] {
    const pBbox = polygonBbox(polygon);
    return this.zones.filter(z => bboxOverlap(z.bbox, pBbox));
  }

  // ---------------------------------------------------------------------------
  // Source lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Get or lazily open a {@link TesseraSource} for a zone.
   *
   * @remarks
   * Concurrent calls for the same zone are deduplicated — only one
   * open request is in flight at a time. Subsequent calls wait for
   * the same Promise.
   *
   * @param zoneId - Zone identifier (e.g. `"32N"`).
   * @returns The opened source.
   * @throws If the zone ID is unknown or the store cannot be opened.
   */
  async getSource(zoneId: string): Promise<TesseraSource> {
    const existing = this.sources.get(zoneId);
    if (existing) return existing;

    // Deduplicate concurrent open requests for the same zone
    let pending = this.opening.get(zoneId);
    if (pending) return pending;

    pending = this._openSource(zoneId);
    this.opening.set(zoneId, pending);
    try {
      return await pending;
    } finally {
      this.opening.delete(zoneId);
    }
  }

  /**
   * Get a source only if it is already open (synchronous).
   *
   * @param zoneId - Zone identifier.
   * @returns The open source, or `null` if the zone has not been opened yet.
   */
  getOpenSource(zoneId: string): TesseraSource | null {
    return this.sources.get(zoneId) ?? null;
  }

  /**
   * All currently open zone sources.
   *
   * @returns A read-only view of the internal sources map.
   */
  getActiveSources(): Map<string, TesseraSource> {
    return this.sources;
  }

  /**
   * Close all open sources, cancelling in-flight requests and releasing memory.
   */
  close(): void {
    for (const src of this.sources.values()) src.close();
    this.sources.clear();
    this.opening.clear();
  }

  // ---------------------------------------------------------------------------
  // Geographic queries (cross-zone)
  // ---------------------------------------------------------------------------

  /**
   * Get all chunk references across zones that overlap a polygon.
   *
   * @remarks
   * Opens any needed zone sources on demand. Each returned
   * {@link ManagedChunk} includes the `zoneId` so callers can
   * route the chunks back to the correct source.
   *
   * @param polygon - A GeoJSON Polygon defining the region of interest.
   * @returns All chunk references overlapping the polygon, across all zones.
   */
  async getChunksInRegion(polygon: GeoJsonPolygon): Promise<ManagedChunk[]> {
    const zones = this.zonesForPolygon(polygon);
    const allChunks: ManagedChunk[] = [];

    for (const zone of zones) {
      const src = await this.getSource(zone.id);
      const chunks = src.getChunksInRegion(polygon);
      for (const { ci, cj } of chunks) {
        allChunks.push({ zoneId: zone.id, ci, cj });
      }
    }
    return allChunks;
  }

  /**
   * Get the embedding vector at a WGS84 coordinate, routing to the correct zone.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The embedding with zone and tile/pixel location, or `null` if
   *   the coordinate is outside all data extents or no tile is loaded.
   */
  getEmbeddingAt(lng: number, lat: number): (EmbeddingAt & { zoneId: string }) | null {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const result = src.getEmbeddingAt(lng, lat);
      if (result) return { zoneId: zone.id, ...result };
    }
    return null;
  }

  /**
   * Get embeddings in a kernel around a WGS84 coordinate, routing to the correct zone.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @param size - Side length of the square kernel (e.g. 3 for 3×3).
   * @returns Array of embeddings with zone and tile/pixel locations.
   */
  getEmbeddingsInKernel(
    lng: number,
    lat: number,
    size: number,
  ): (EmbeddingAt & { zoneId: string })[] {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const results = src.getEmbeddingsInKernel(lng, lat, size);
      if (results.length > 0) {
        return results.map(r => ({ zoneId: zone.id, ...r }));
      }
    }
    return [];
  }

  /**
   * Return the WGS84 corners of a single embedding pixel, searching all open
   * zone sources for the matching chunk.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param row - Pixel row within the chunk.
   * @param col - Pixel column within the chunk.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if no source has the tile loaded.
   */
  getPixelBoundsLngLat(
    ci: number,
    cj: number,
    row: number,
    col: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    for (const src of this.sources.values()) {
      if (src.regionHasTile(ci, cj)) {
        return src.getPixelBoundsLngLat(ci, cj, row, col);
      }
    }
    return null;
  }

  /**
   * Get the chunk indices containing a WGS84 point, routing to the correct zone.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns A {@link ManagedChunk} with zone ID, or `null` if the point is
   *   outside all data extents.
   */
  getChunkAtLngLat(lng: number, lat: number): ManagedChunk | null {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const result = src.getChunkAtLngLat(lng, lat);
      if (result) return { zoneId: zone.id, ...result };
    }
    return null;
  }

  /**
   * Get the WGS84 corner bounds of a chunk in a specific zone.
   *
   * @param zoneId - Zone identifier.
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if the zone source is not open.
   */
  getChunkBoundsLngLat(
    zoneId: string,
    ci: number,
    cj: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    const src = this.sources.get(zoneId);
    if (!src) return null;
    return src.getChunkBoundsLngLat(ci, cj);
  }

  // ---------------------------------------------------------------------------
  // Embedding region queries
  // ---------------------------------------------------------------------------

  /**
   * Get all embedding regions across open zones.
   *
   * @returns Map from zone ID to {@link EmbeddingRegion} for each zone that
   *   has a region loaded.
   */
  getEmbeddingRegions(): Map<string, EmbeddingRegion> {
    const regions = new Map<string, EmbeddingRegion>();
    for (const [zoneId, src] of this.sources) {
      if (src.embeddingRegion) regions.set(zoneId, src.embeddingRegion);
    }
    return regions;
  }

  /**
   * Check whether a tile has been loaded in a specific zone.
   *
   * @param zoneId - Zone identifier.
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns `true` if the tile is loaded, `false` otherwise (including if
   *   the zone source is not open).
   */
  regionHasTile(zoneId: string, ci: number, cj: number): boolean {
    const src = this.sources.get(zoneId);
    return src?.regionHasTile(ci, cj) ?? false;
  }

  /**
   * Total number of loaded tiles across all open zone sources.
   */
  totalTileCount(): number {
    let n = 0;
    for (const src of this.sources.values()) n += src.tileCount;
    return n;
  }

  /**
   * Bounding box of all loaded embeddings across all zones.
   *
   * @returns `[south, west, north, east]` in WGS84 degrees, or `null` if no
   *   tiles are loaded anywhere.
   */
  embeddingBoundsLngLat(): [number, number, number, number] | null {
    let south = 90, west = 180, north = -90, east = -180;
    let any = false;
    for (const src of this.sources.values()) {
      const bounds = src.embeddingBoundsLngLat();
      if (!bounds) continue;
      any = true;
      if (bounds[0] < south) south = bounds[0];
      if (bounds[1] < west) west = bounds[1];
      if (bounds[2] > north) north = bounds[2];
      if (bounds[3] > east) east = bounds[3];
    }
    return any ? [south, west, north, east] : null;
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  /**
   * Get metadata from the first open source.
   *
   * @remarks
   * All zones in a TESSERA catalog share the same metadata schema
   * (nBands, chunkShape, etc.). The first available source is used
   * as a representative.
   *
   * @returns The store metadata, or `null` if no sources are open.
   */
  getMetadata(): StoreMetadata | null {
    for (const src of this.sources.values()) {
      const meta = src.metadata;
      if (meta) return meta;
    }
    return null;
  }

  /**
   * All zone descriptors registered with this manager.
   */
  getZones(): ZoneDescriptor[] {
    return this.zones;
  }

  // ---------------------------------------------------------------------------
  // Private: source opening
  // ---------------------------------------------------------------------------

  /**
   * Open a zone source, wire up event forwarding, and register it.
   *
   * @param zoneId - Zone to open.
   * @throws If the zone ID is not found in the zone list.
   */
  private async _openSource(zoneId: string): Promise<TesseraSource> {
    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone) throw new Error(`Unknown zone: ${zoneId}`);

    const src = new TesseraSource({
      ...this.baseOpts,
      url: zone.zarrUrl,
    });

    // Forward events from per-zone sources to manager listeners
    const forwardEvent = <K extends keyof TesseraEvents>(event: K): void => {
      src.on(event, (data: TesseraEvents[K]) => {
        this.emit(event, data);
      });
    };
    forwardEvent('metadata-loaded');
    forwardEvent('chunk-loaded');
    forwardEvent('embeddings-loaded');
    forwardEvent('embedding-progress');
    forwardEvent('error');
    forwardEvent('loading');
    forwardEvent('debug');

    await src.open();
    this.sources.set(zoneId, src);
    return src;
  }
}
