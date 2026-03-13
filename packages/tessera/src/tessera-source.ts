import { EventEmitter } from './event-emitter.js';
import { UtmProjection } from './projection.js';
import { openStore, fetchRegion, type ZarrStore } from './zarr-reader.js';
import type {
  TesseraOptions,
  StoreMetadata,
  ChunkRef,
  EmbeddingRegion,
  EmbeddingAt,
  EmbeddingProgress,
  TesseraEvents,
  UtmBounds,
  ChunkBounds,
  DebugLogEntry,
} from './types.js';


/**
 * Options for {@link TesseraSource.loadChunks}.
 */
export interface LoadChunksOptions {
  /** AbortSignal to cancel in-flight fetches. */
  signal?: AbortSignal;

  /** Progress callback invoked after each chunk completes. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Framework-agnostic data-access layer for a single TESSERA Zarr store.
 *
 * @remarks
 * Handles store opening, chunk loading with dequantisation, embedding
 * queries, and coordinate conversions. Contains no rendering or
 * map-framework code — those concerns live in framework-specific
 * wrappers (e.g. `MaplibreTesseraSource`).
 *
 * @example
 * ```typescript
 * const source = new TesseraSource({ url: 'https://example.com/zarr' });
 * const meta = await source.open();
 * const chunks = source.getChunksInRegion(polygon);
 * const region = await source.loadChunks(chunks);
 * const emb = source.getEmbeddingAt(13.4, 52.5);
 * ```
 */
export class TesseraSource extends EventEmitter<TesseraEvents> {
  private readonly url: string;
  private readonly concurrency: number;
  private store: ZarrStore | null = null;
  private proj: UtmProjection | null = null;
  private currentAbort: AbortController | null = null;

  /** Contiguous embedding buffer for all loaded tiles. */
  private _embeddingRegion: EmbeddingRegion | null = null;

  /**
   * @param opts - Configuration for the Zarr store connection.
   */
  constructor(opts: TesseraOptions) {
    super();
    this.url = opts.url;
    this.concurrency = opts.concurrency ?? 4;
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  /** The current embedding region, or `null` if no chunks are loaded. */
  get embeddingRegion(): EmbeddingRegion | null {
    return this._embeddingRegion;
  }

  /** Store metadata, available after {@link open}. */
  get metadata(): StoreMetadata | null {
    return this.store?.meta ?? null;
  }

  /** The UTM projection, available after {@link open}. */
  get projection(): UtmProjection | null {
    return this.proj;
  }

  /** Number of tiles that have been loaded into the embedding region. */
  get tileCount(): number {
    const r = this._embeddingRegion;
    if (!r) return 0;
    let n = 0;
    for (let i = 0; i < r.loaded.length; i++) if (r.loaded[i]) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the Zarr store, read metadata, and prepare the projection.
   *
   * @returns The store metadata.
   * @throws If the store cannot be opened or is missing required attributes.
   */
  async open(): Promise<StoreMetadata> {
    this.debug('fetch', `Opening store: ${this.url}`);
    this.store = await openStore(this.url);
    this.proj = new UtmProjection(this.store.meta.epsg);
    this.debug('info', `Store opened: zone ${this.store.meta.utmZone}, EPSG:${this.store.meta.epsg}, ${this.store.meta.nBands} bands`);
    this.debug('info', `Shape: ${this.store.meta.shape.join('x')}, chunks: ${this.store.meta.chunkShape.join('x')}`);
    if (this.store.chunkManifest) {
      this.debug('info', `Manifest: ${this.store.chunkManifest.size} chunks with data`);
    }
    this.emit('metadata-loaded', this.store.meta);
    return this.store.meta;
  }

  /**
   * Close the source, cancelling any in-flight requests and releasing
   * the embedding region.
   */
  close(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
    this._embeddingRegion = null;
    this.store = null;
    this.proj = null;
  }

  // ---------------------------------------------------------------------------
  // Chunk loading
  // ---------------------------------------------------------------------------

  /**
   * Load a batch of embedding chunks with parallel concurrency.
   *
   * @remarks
   * Creates or grows the {@link EmbeddingRegion} to cover the requested
   * chunks. Each chunk's int8 embeddings are dequantised inline using
   * per-pixel scale factors: `value = int8 * scale`. Invalid pixels
   * (zero / NaN / non-finite scales) are set to `NaN`.
   *
   * @param chunks - Chunk references to load.
   * @param opts - Optional abort signal and progress callback.
   * @returns The embedding region containing the loaded data.
   */
  async loadChunks(
    chunks: ChunkRef[],
    opts?: LoadChunksOptions,
  ): Promise<EmbeddingRegion> {
    if (!this.store || chunks.length === 0) {
      return this._embeddingRegion ?? this.createEmptyRegion();
    }

    // Cancel any previous load
    this.currentAbort?.abort();
    const abort = new AbortController();
    this.currentAbort = abort;

    // Compute grid bounds for this batch
    let ciMin = Infinity, ciMax = -Infinity, cjMin = Infinity, cjMax = -Infinity;
    for (const { ci, cj } of chunks) {
      if (ci < ciMin) ciMin = ci;
      if (ci > ciMax) ciMax = ci;
      if (cj < cjMin) cjMin = cj;
      if (cj > cjMax) cjMax = cj;
    }

    // Create or grow the region
    this.ensureRegion(ciMin, ciMax, cjMin, cjMax);

    const total = chunks.length;
    this.debug('fetch', `Region download started: ${total} tiles [${ciMin},${ciMax}]x[${cjMin},${cjMax}]`);

    let loaded = 0;
    let succeeded = 0;
    const concurrency = this.concurrency;

    let cursor = 0;
    const next = async (): Promise<void> => {
      while (cursor < total) {
        if (abort.signal.aborted || opts?.signal?.aborted) return;

        const idx = cursor++;
        const { ci, cj } = chunks[idx];
        if (this.regionHasTile(ci, cj)) {
          succeeded++;
          loaded++;
          opts?.onProgress?.(loaded, total);
          this.emit('loading', { total, done: loaded });
          continue;
        }
        try {
          await this.loadSingleChunk(ci, cj, abort.signal);
          succeeded++;
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          this.debug('error', `Failed to load chunk (${ci},${cj}): ${(err as Error).message}`);
        }
        loaded++;
        opts?.onProgress?.(loaded, total);
        this.emit('loading', { total, done: loaded });
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, total) },
      () => next(),
    );
    await Promise.all(workers);

    this.debug('fetch', `Region download complete: ${succeeded}/${total} tiles loaded`);

    if (this.currentAbort === abort) {
      this.currentAbort = null;
    }

    return this._embeddingRegion!;
  }

  // ---------------------------------------------------------------------------
  // Embedding queries
  // ---------------------------------------------------------------------------

  /**
   * Extract the embedding vector at a WGS84 coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The embedding with its tile/pixel location, or `null`
   *   if the coordinate is outside the data extent or the tile is
   *   not loaded.
   */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null {
    if (!this.store || !this.proj || !this._embeddingRegion) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const globalCol = Math.floor((e - originE) / px);
    const globalRow = Math.floor((originN - n) / px);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;

    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    if (!this.regionHasTile(ci, cj)) return null;

    const region = this._embeddingRegion;
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= region.tileH || col < 0 || col >= region.tileW) return null;

    const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
    const pixBase = tIdx * region.tileW * region.tileH;
    const pixelIdx = row * region.tileW + col;
    const offset = (pixBase + pixelIdx) * region.nBands;

    if (isNaN(region.emb[offset])) return null;
    const embedding = region.emb.slice(offset, offset + region.nBands);
    return { embedding, ci, cj, row, col };
  }

  /**
   * Extract embeddings for all valid pixels in a kernel around a coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @param kernelSize - Side length of the square kernel (e.g. 3 for 3x3).
   * @returns Array of embeddings with their tile/pixel locations.
   */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): EmbeddingAt[] {
    if (!this.store || !this.proj || !this._embeddingRegion) return [];
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const region = this._embeddingRegion;

    const centerCol = Math.floor((e - originE) / px);
    const centerRow = Math.floor((originN - n) / px);
    const radius = Math.floor((kernelSize - 1) / 2);
    const results: EmbeddingAt[] = [];

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const gr = centerRow + dr;
        const gc = centerCol + dc;
        if (gr < 0 || gr >= s[0] || gc < 0 || gc >= s[1]) continue;

        const ci = Math.floor(gr / cs[0]);
        const cj = Math.floor(gc / cs[1]);
        if (!this.regionHasTile(ci, cj)) continue;

        const row = gr - ci * cs[0];
        const col = gc - cj * cs[1];
        const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
        const pixBase = tIdx * region.tileW * region.tileH;
        const pixelIdx = row * region.tileW + col;
        const offset = (pixBase + pixelIdx) * region.nBands;

        if (isNaN(region.emb[offset])) continue;
        const embedding = region.emb.slice(offset, offset + region.nBands);
        results.push({ embedding, ci, cj, row, col });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Spatial queries
  // ---------------------------------------------------------------------------

  /**
   * Return the chunk indices containing a WGS84 point, or `null` if
   * the point is outside the data extent.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   */
  getChunkAtLngLat(lng: number, lat: number): ChunkRef | null {
    if (!this.store || !this.proj) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const col = Math.floor((e - originE) / px);
    const row = Math.floor((originN - n) / px);
    if (col < 0 || col >= s[1] || row < 0 || row >= s[0]) return null;

    const ci = Math.floor(row / cs[0]);
    const cj = Math.floor(col / cs[1]);
    return { ci, cj };
  }

  /**
   * Return all chunk indices whose bounding boxes intersect a polygon.
   *
   * @remarks
   * Projects the polygon to UTM, uses a one-tile buffer on the chunk
   * index range, then tests overlap via center-in-polygon and
   * vertex-in-chunk. Skips chunks not in the manifest (if available)
   * and chunks already loaded in the region.
   *
   * @param polygon - A GeoJSON Polygon (outer ring used).
   */
  getChunksInRegion(polygon: GeoJSON.Polygon): ChunkRef[] {
    if (!this.store || !this.proj) return [];

    // Convert polygon ring to UTM coordinates
    const coords = polygon.coordinates[0];
    const utmRing: [number, number][] = [];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const coord of coords) {
      const [lng, lat] = coord;
      const [e, n] = this.proj.forward(lng, lat);
      utmRing.push([e, n]);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }

    // Ray-casting point-in-polygon test (UTM coords)
    const pointInPoly = (px: number, py: number): boolean => {
      let inside = false;
      for (let i = 0, j = utmRing.length - 1; i < utmRing.length; j = i++) {
        const [xi, yi] = utmRing[i], [xj, yj] = utmRing[j];
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };

    // Convert UTM bounds to chunk index ranges with a one-tile buffer
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)) - 1);
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)) + 1);
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)) - 1);
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)) + 1);

    const chunkW = cs[1] * px;
    const chunkH = cs[0] * px;

    const result: ChunkRef[] = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        if (this.store.chunkManifest && !this.store.chunkManifest.has(`${ci}_${cj}`)) continue;
        if (this.regionHasTile(ci, cj)) continue;

        // Chunk bounds in UTM
        const cMinE = originE + cj * chunkW;
        const cMaxE = cMinE + chunkW;
        const cMaxN = originN - ci * chunkH;
        const cMinN = cMaxN - chunkH;

        // Test overlap: chunk center in polygon, or any polygon vertex in chunk
        const centerE = (cMinE + cMaxE) / 2;
        const centerN = (cMinN + cMaxN) / 2;
        let overlaps = pointInPoly(centerE, centerN);
        if (!overlaps) {
          for (const [e, n] of utmRing) {
            if (e >= cMinE && e <= cMaxE && n >= cMinN && n <= cMaxN) {
              overlaps = true;
              break;
            }
          }
        }

        if (overlaps) result.push({ ci, cj });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the WGS84 corners of a chunk tile.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if the store is not open.
   */
  getChunkBoundsLngLat(
    ci: number,
    cj: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    if (!this.store || !this.proj) return null;
    return this.chunkCorners(ci, cj);
  }

  /**
   * Get the WGS84 corners of a single embedding pixel.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param row - Pixel row within the chunk.
   * @param col - Pixel column within the chunk.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if the store is not open.
   */
  getPixelBoundsLngLat(
    ci: number,
    cj: number,
    row: number,
    col: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    if (!this.store || !this.proj) return null;
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const globalRow = ci * cs[0] + row;
    const globalCol = cj * cs[1] + col;
    const minE = originE + globalCol * px;
    const maxE = minE + px;
    const maxN = originN - globalRow * px;
    const minN = maxN - px;
    return this.proj.chunkCornersToLngLat({ minE, maxE, minN, maxN });
  }

  /**
   * Compute the WGS84 bounding box of all loaded embedding tiles.
   *
   * @returns `[south, west, north, east]` or `null` if no tiles are loaded.
   */
  embeddingBoundsLngLat(): [number, number, number, number] | null {
    const r = this._embeddingRegion;
    if (!r || this.tileCount === 0) return null;
    let south = 90, west = 180, north = -90, east = -180;
    for (let t = 0; t < r.loaded.length; t++) {
      if (!r.loaded[t]) continue;
      const ci = r.ciMin + Math.floor(t / r.gridCols);
      const cj = r.cjMin + (t % r.gridCols);
      const corners = this.chunkCorners(ci, cj);
      for (const [lng, lat] of corners) {
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lng < west) west = lng;
        if (lng > east) east = lng;
      }
    }
    return [south, west, north, east];
  }

  // ---------------------------------------------------------------------------
  // Region management
  // ---------------------------------------------------------------------------

  /**
   * Check whether a tile has been loaded into the embedding region.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  regionHasTile(ci: number, cj: number): boolean {
    const r = this._embeddingRegion;
    if (!r) return false;
    if (ci < r.ciMin || ci > r.ciMax || cj < r.cjMin || cj > r.cjMax) return false;
    const t = (ci - r.ciMin) * r.gridCols + (cj - r.cjMin);
    return r.loaded[t] === 1;
  }

  /**
   * Zero out a tile's data and mark it as unloaded.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  evictTile(ci: number, cj: number): void {
    const r = this._embeddingRegion;
    if (!r) return;
    if (ci < r.ciMin || ci > r.ciMax || cj < r.cjMin || cj > r.cjMax) return;
    const tIdx = (ci - r.ciMin) * r.gridCols + (cj - r.cjMin);
    if (!r.loaded[tIdx]) return;

    const tilePixels = r.tileW * r.tileH;
    const base = tIdx * tilePixels * r.nBands;
    r.emb.fill(NaN, base, base + tilePixels * r.nBands);
    r.loaded[tIdx] = 0;
  }

  /**
   * Discard the entire embedding region, releasing memory.
   */
  clearRegion(): void {
    this._embeddingRegion = null;
  }

  // ---------------------------------------------------------------------------
  // Internal: store access (for framework wrappers)
  // ---------------------------------------------------------------------------

  /**
   * Access the underlying Zarr store.
   * @internal
   */
  get _store(): ZarrStore | null {
    return this.store;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load and dequantise a single chunk into the embedding region.
   */
  private async loadSingleChunk(
    ci: number,
    cj: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.store) return;

    // Ensure region covers this chunk
    this.ensureRegion(ci, ci, cj, cj);

    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const h = r1 - r0;
    const w = c1 - c0;
    const nBands = this.store.meta.nBands;
    const expectedBytes = w * h * nBands;

    this.emit('embedding-progress', {
      ci, cj, stage: 'fetching',
      bytes: expectedBytes, bytesLoaded: 0,
    });

    const onProgress = (ev: {
      bytes_loaded: number;
      chunks_completed: number;
      chunks_total: number;
    }) => {
      this.emit('embedding-progress', {
        ci, cj, stage: 'fetching',
        bytes: expectedBytes,
        bytesLoaded: ev.bytes_loaded,
        chunksCompleted: ev.chunks_completed,
        chunksTotal: ev.chunks_total,
      });
    };

    // Check for abort before starting the fetch
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const [embView, scalesView] = await Promise.all([
      fetchRegion(this.store.embArr, [[r0, r1], [c0, c1], null], { onProgress }),
      fetchRegion(this.store.scalesArr, [[r0, r1], [c0, c1]]),
    ]);

    // Check for abort after fetch
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    this.emit('embedding-progress', {
      ci, cj, stage: 'rendering', bytes: expectedBytes,
    });

    // Copy into typed arrays for dequantisation
    const embInt8 = new Int8Array(
      embView.data.buffer, embView.data.byteOffset, embView.data.byteLength,
    ).slice();
    const scalesCopy = new Uint8Array(
      scalesView.data.buffer, scalesView.data.byteOffset, scalesView.data.byteLength,
    ).slice();
    const scalesF32 = new Float32Array(scalesCopy.buffer);

    // Dequantize directly into the region buffer (NaN for invalid pixels)
    const region = this._embeddingRegion;
    if (region) {
      const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
      const pixBase = tIdx * region.tileW * region.tileH;
      const embBase = pixBase * nBands;
      for (let i = 0; i < h * w; i++) {
        const s = scalesF32[i];
        const valid = s && !isNaN(s) && isFinite(s);
        const dst = embBase + i * nBands;
        if (valid) {
          for (let b = 0; b < nBands; b++) region.emb[dst + b] = embInt8[i * nBands + b] * s;
        } else {
          for (let b = 0; b < nBands; b++) region.emb[dst + b] = NaN;
        }
      }
      region.loaded[tIdx] = 1;
    }

    this.emit('embedding-progress', {
      ci, cj, stage: 'done', bytes: w * h * nBands * 4,
    });
    this.emit('chunk-loaded', { ci, cj });
  }

  /**
   * Create or grow the EmbeddingRegion to cover the given chunk bounds.
   */
  private ensureRegion(
    ciMin: number,
    ciMax: number,
    cjMin: number,
    cjMax: number,
  ): void {
    if (!this.store) return;
    const cs = this.store.meta.chunkShape;
    const nBands = this.store.meta.nBands;
    const tileH = cs[0], tileW = cs[1];

    const old = this._embeddingRegion;
    if (old) {
      // Check if existing region already covers these bounds
      if (
        ciMin >= old.ciMin && ciMax <= old.ciMax &&
        cjMin >= old.cjMin && cjMax <= old.cjMax
      ) return;

      // Grow: compute union bounds
      const newCiMin = Math.min(old.ciMin, ciMin);
      const newCiMax = Math.max(old.ciMax, ciMax);
      const newCjMin = Math.min(old.cjMin, cjMin);
      const newCjMax = Math.max(old.cjMax, cjMax);
      const newCols = newCjMax - newCjMin + 1;
      const newRows = newCiMax - newCiMin + 1;
      const newTiles = newRows * newCols;
      const tilePixels = tileW * tileH;

      const newEmb = new Float32Array(newTiles * tilePixels * nBands);
      newEmb.fill(NaN);
      const newLoaded = new Uint8Array(newTiles);

      // Copy old data into new buffer at correct offsets
      for (let oci = old.ciMin; oci <= old.ciMax; oci++) {
        for (let ocj = old.cjMin; ocj <= old.cjMax; ocj++) {
          const oldT = (oci - old.ciMin) * old.gridCols + (ocj - old.cjMin);
          if (!old.loaded[oldT]) continue;
          const newT = (oci - newCiMin) * newCols + (ocj - newCjMin);
          const oldBase = oldT * tilePixels * nBands;
          const newBase = newT * tilePixels * nBands;
          newEmb.set(
            old.emb.subarray(oldBase, oldBase + tilePixels * nBands),
            newBase,
          );
          newLoaded[newT] = 1;
        }
      }

      this._embeddingRegion = {
        ciMin: newCiMin, ciMax: newCiMax,
        cjMin: newCjMin, cjMax: newCjMax,
        gridCols: newCols, gridRows: newRows,
        tileW, tileH, nBands, emb: newEmb, loaded: newLoaded,
      };
      this.debug('info', `Region grown to [${newCiMin},${newCiMax}]x[${newCjMin},${newCjMax}] (${newTiles} tiles)`);
    } else {
      // Create new region
      const gridCols = cjMax - cjMin + 1;
      const gridRows = ciMax - ciMin + 1;
      const nTiles = gridRows * gridCols;
      const tilePixels = tileW * tileH;
      const emb = new Float32Array(nTiles * tilePixels * nBands);
      emb.fill(NaN);
      this._embeddingRegion = {
        ciMin, ciMax, cjMin, cjMax, gridCols, gridRows,
        tileW, tileH, nBands, emb, loaded: new Uint8Array(nTiles),
      };
      this.debug('info', `Region created [${ciMin},${ciMax}]x[${cjMin},${cjMax}] (${nTiles} tiles, ${(emb.byteLength / 1024 / 1024).toFixed(0)} MB)`);
    }
  }

  /** Compute pixel bounds for a chunk. */
  private chunkPixelBounds(ci: number, cj: number): ChunkBounds {
    const s = this.store!.meta.shape;
    const cs = this.store!.meta.chunkShape;
    return {
      r0: ci * cs[0],
      r1: Math.min(ci * cs[0] + cs[0], s[0]),
      c0: cj * cs[1],
      c1: Math.min(cj * cs[1] + cs[1], s[1]),
    };
  }

  /** Compute UTM bounds for a chunk. */
  private chunkUtmBounds(ci: number, cj: number): UtmBounds {
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const t = this.store!.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    return {
      minE: originE + c0 * px,
      maxE: originE + c1 * px,
      minN: originN - r1 * px,
      maxN: originN - r0 * px,
    };
  }

  /** Get WGS84 corners [TL, TR, BR, BL] for a chunk. */
  private chunkCorners(ci: number, cj: number) {
    return this.proj!.chunkCornersToLngLat(this.chunkUtmBounds(ci, cj));
  }

  /** Create an empty region for the degenerate case. */
  private createEmptyRegion(): EmbeddingRegion {
    return {
      ciMin: 0, ciMax: 0, cjMin: 0, cjMax: 0,
      gridRows: 1, gridCols: 1,
      tileW: 1, tileH: 1, nBands: 1,
      emb: new Float32Array(1).fill(NaN),
      loaded: new Uint8Array(1),
    };
  }

  /** Emit a debug log entry. */
  private debug(type: DebugLogEntry['type'], msg: string): void {
    this.emit('debug', { time: Date.now(), type, msg });
  }
}
