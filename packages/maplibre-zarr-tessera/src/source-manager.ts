/**
 * ZarrSourceManager: lazily manages multiple ZarrTesseraSource instances (one
 * per UTM zone) and routes geographic queries to the correct zone(s).
 *
 * Consumers interact with the manager instead of individual sources. The
 * manager transparently opens zone sources on demand and broadcasts settings
 * changes (opacity, bands, grid visibility, etc.) to all active sources.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import { ZarrTesseraSource } from './zarr-source.js';
import type {
  ZarrTesseraOptions, StoreMetadata, PreviewMode,
  EmbeddingRegion, EmbeddingAt, ZarrTesseraEvents, DebugLogEntry,
} from './types.js';

// ---- Zone descriptor (subset of the app-level ZoneDescriptor) ----

export interface ZoneInfo {
  id: string;
  bbox: [number, number, number, number]; // [west, south, east, north] WGS84
  zarrUrl: string;
}

// ---- Multi-zone chunk reference ----

export interface ManagedChunk {
  zoneId: string;
  ci: number;
  cj: number;
}

// ---- Helpers ----

function pointInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  const [w, s, e, n] = bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function polygonBbox(polygon: GeoJSON.Polygon): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of polygon.coordinates[0]) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

// ---- Event system ----

type EventCallback<T> = (data: T) => void;

export class ZarrSourceManager {
  private zones: ZoneInfo[];
  private sources = new Map<string, ZarrTesseraSource>();
  private opening = new Map<string, Promise<ZarrTesseraSource>>();
  private map: MaplibreMap | null = null;
  private baseOpts: Omit<ZarrTesseraOptions, 'url'>;
  private listeners = new Map<string, Set<EventCallback<unknown>>>();

  constructor(zones: ZoneInfo[], opts: Omit<ZarrTesseraOptions, 'url'>) {
    this.zones = zones;
    this.baseOpts = opts;
  }

  // ---- Lifecycle ----

  /** Attach to map. Does NOT open any zone sources yet — they open on demand. */
  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
  }

  /** Remove all sources and clean up. */
  remove(): void {
    for (const src of this.sources.values()) src.remove();
    this.sources.clear();
    this.opening.clear();
    this.map = null;
  }

  // ---- Zone routing ----

  /** Find zones whose bbox contains a point. */
  zonesAtPoint(lng: number, lat: number): ZoneInfo[] {
    return this.zones.filter(z => pointInBbox(lng, lat, z.bbox));
  }

  /** Find zones whose bbox overlaps a polygon. */
  zonesForPolygon(polygon: GeoJSON.Polygon): ZoneInfo[] {
    const pBbox = polygonBbox(polygon);
    return this.zones.filter(z => bboxOverlap(z.bbox, pBbox));
  }

  /** Get or lazily open a ZarrTesseraSource for a zone. */
  async getSource(zoneId: string): Promise<ZarrTesseraSource> {
    const existing = this.sources.get(zoneId);
    if (existing) return existing;

    // Deduplicate concurrent open requests for the same zone
    let pending = this.opening.get(zoneId);
    if (pending) return pending;

    pending = this._openSource(zoneId);
    this.opening.set(zoneId, pending);
    try {
      const src = await pending;
      return src;
    } finally {
      this.opening.delete(zoneId);
    }
  }

  /** Get a source only if it's already open (synchronous). */
  getOpenSource(zoneId: string): ZarrTesseraSource | null {
    return this.sources.get(zoneId) ?? null;
  }

  /** All currently open sources. */
  getActiveSources(): Map<string, ZarrTesseraSource> {
    return this.sources;
  }

  private async _openSource(zoneId: string): Promise<ZarrTesseraSource> {
    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone) throw new Error(`Unknown zone: ${zoneId}`);
    if (!this.map) throw new Error('Manager not attached to map');

    const src = new ZarrTesseraSource({
      ...this.baseOpts,
      url: zone.zarrUrl,
    });

    // Forward events from per-zone sources to manager listeners
    const forwardEvent = <K extends keyof ZarrTesseraEvents>(event: K) => {
      src.on(event, (data: ZarrTesseraEvents[K]) => {
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

    await src.addTo(this.map);
    this.sources.set(zoneId, src);
    return src;
  }

  // ---- Geographic queries (cross-zone) ----

  /** Get chunks across all zones that overlap a polygon. */
  async getChunksInRegion(polygon: GeoJSON.Polygon): Promise<ManagedChunk[]> {
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

  /** Get embedding at a map coordinate, routing to the correct zone. */
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

  /** Get embeddings in a kernel around a point, routing to the correct zone. */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): (EmbeddingAt & { zoneId: string })[] {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const results = src.getEmbeddingsInKernel(lng, lat, kernelSize);
      if (results.length > 0) {
        return results.map(r => ({ zoneId: zone.id, ...r }));
      }
    }
    return [];
  }

  /** Return the [TL, TR, BR, BL] lng/lat corners of a single embedding pixel.
   *  Searches all open zone sources for the matching chunk. */
  getPixelBoundsLngLat(ci: number, cj: number, row: number, col: number): [[number, number], [number, number], [number, number], [number, number]] | null {
    for (const src of this.sources.values()) {
      if (src.regionHasTile(ci, cj)) {
        return src.getPixelBoundsLngLat(ci, cj, row, col);
      }
    }
    return null;
  }

  /** Get chunk indices at a map coordinate, routing to the correct zone. */
  getChunkAtLngLat(lng: number, lat: number): (ManagedChunk) | null {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const result = src.getChunkAtLngLat(lng, lat);
      if (result) return { zoneId: zone.id, ...result };
    }
    return null;
  }

  /** Get chunk corner bounds, routing to the correct zone. */
  getChunkBoundsLngLat(zoneId: string, ci: number, cj: number): [[number, number], [number, number], [number, number], [number, number]] | null {
    const src = this.sources.get(zoneId);
    if (!src) return null;
    return src.getChunkBoundsLngLat(ci, cj);
  }

  /** Get classification class ID at a map coordinate, routing to the correct zone. */
  getClassificationAt(lng: number, lat: number): number | null {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const result = src.getClassificationAt(lng, lat);
      if (result !== null) return result;
    }
    return null;
  }

  // ---- Embedding region queries ----

  /** Get all embedding regions across open zones. */
  getEmbeddingRegions(): Map<string, EmbeddingRegion> {
    const regions = new Map<string, EmbeddingRegion>();
    for (const [zoneId, src] of this.sources) {
      if (src.embeddingRegion) regions.set(zoneId, src.embeddingRegion);
    }
    return regions;
  }

  /** Check if a tile is loaded in any zone. */
  regionHasTile(zoneId: string, ci: number, cj: number): boolean {
    const src = this.sources.get(zoneId);
    return src?.regionHasTile(ci, cj) ?? false;
  }

  /** Total loaded tile count across all zones. */
  totalTileCount(): number {
    let n = 0;
    for (const src of this.sources.values()) n += src.regionTileCount();
    return n;
  }

  /** Bounding box of all loaded embeddings across all zones. */
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

  // ---- Broadcast operations (applied to ALL active sources) ----

  setOpacity(opacity: number): void {
    this.baseOpts.opacity = opacity;
    for (const src of this.sources.values()) src.setOpacity(opacity);
  }

  setBands(bands: [number, number, number]): void {
    this.baseOpts.bands = bands;
    for (const src of this.sources.values()) src.setBands(bands);
  }

  setPreview(mode: PreviewMode): void {
    this.baseOpts.preview = mode;
    for (const src of this.sources.values()) src.setPreview(mode);
  }


  setClassificationOpacity(opacity: number): void {
    for (const src of this.sources.values()) src.setClassificationOpacity(opacity);
  }

  raiseAllLayers(): void {
    for (const src of this.sources.values()) src.raiseAllLayers();
  }

  reAddAllLayers(): void {
    for (const src of this.sources.values()) src.reAddAllLayers();
  }

  recolorAllChunks(): void {
    for (const src of this.sources.values()) src.recolorAllChunks();
  }

  // ---- Overlay operations ----

  clearSimilarityOverlay(): void {
    for (const src of this.sources.values()) src.clearSimilarityOverlay();
  }

  clearClassificationOverlays(): void {
    for (const src of this.sources.values()) src.clearClassificationOverlays();
  }

  clearRgbOverlay(): void {
    for (const src of this.sources.values()) src.clearRgbOverlay();
  }

  // ---- Region animation (routes to specific zone) ----

  startRegionAnimation(zoneId: string, polygon: GeoJSON.Polygon, chunks: { ci: number; cj: number }[]): void {
    const src = this.sources.get(zoneId);
    src?.startRegionAnimation(polygon, chunks);
  }

  updateRegionAnimation(zoneId: string, loaded: number, total: number, ci?: number, cj?: number): void {
    const src = this.sources.get(zoneId);
    src?.updateRegionAnimation(loaded, total, ci, cj);
  }

  stopRegionAnimation(zoneId?: string): void {
    if (zoneId) {
      this.sources.get(zoneId)?.stopRegionAnimation();
    } else {
      for (const src of this.sources.values()) src.stopRegionAnimation();
    }
  }

  // ---- Metadata ----

  /** Get metadata from the first open source (for nBands, etc.). */
  getMetadata(): StoreMetadata | null {
    for (const src of this.sources.values()) {
      const meta = src.getMetadata();
      if (meta) return meta;
    }
    return null;
  }

  /** All zone descriptors. */
  getZones(): ZoneInfo[] {
    return this.zones;
  }

  // ---- Events (aggregated from all sources) ----

  on<K extends keyof ZarrTesseraEvents>(
    event: K,
    callback: EventCallback<ZarrTesseraEvents[K]>,
  ): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
  }

  off<K extends keyof ZarrTesseraEvents>(
    event: K,
    callback: EventCallback<ZarrTesseraEvents[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  private emit<K extends keyof ZarrTesseraEvents>(
    event: K, data: ZarrTesseraEvents[K],
  ): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}
