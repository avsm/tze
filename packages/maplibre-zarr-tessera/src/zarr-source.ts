import type { Map as MaplibreMap } from 'maplibre-gl';
import type {
  ZarrTesseraOptions, StoreMetadata, CachedChunk,
  ChunkBounds, UtmBounds, PreviewMode, ZarrTesseraEvents, DebugLogEntry,
  EmbeddingRegion, EmbeddingAt,
} from './types.js';
import { UtmProjection } from './projection.js';
import { openStore, fetchRegion, type ZarrStore } from './zarr-reader.js';
import { WorkerPool } from './worker-pool.js';
import { ZarrLayer } from '@carbonplan/zarr-layer';

type EventCallback<T> = (data: T) => void;

type ResolvedOptions = Required<Omit<ZarrTesseraOptions, 'globalPreviewBounds'>> & {
  globalPreviewBounds?: [number, number, number, number];
};

export class ZarrTesseraSource {
  private opts: ResolvedOptions;
  private map: MaplibreMap | null = null;
  private store: ZarrStore | null = null;
  private proj: UtmProjection | null = null;
  private workerPool: WorkerPool | null = null;
  private chunkCache = new Map<string, CachedChunk>();
  private currentAbort: AbortController | null = null;
  private previewLayer: any | null = null;

  /** Contiguous embedding buffer for all loaded tiles. */
  public embeddingRegion: EmbeddingRegion | null = null;
  private moveHandler: (() => void) | null = null;
  private abortHandler: ((e: PromiseRejectionEvent) => void) | null = null;
  private listeners = new Map<string, Set<EventCallback<unknown>>>();
  /** Tracks active loading animations per chunk key → animation frame ID. */
  private loadingAnimations = new Map<string, number>();
  /** Per-tile download progress (0..1), keyed by chunk key. */
  private tileProgress = new Map<string, number>();
  /** Per-pixel class ID maps from classification, keyed by chunk key. */
  private classificationMaps = new Map<string, { width: number; height: number; classMap: Int16Array }>();

  constructor(options: ZarrTesseraOptions) {
    this.opts = {
      url: options.url,
      bands: options.bands ?? [0, 1, 2],
      opacity: options.opacity ?? 0.8,
      preview: options.preview ?? 'rgb',
      maxCached: options.maxCached ?? 50,
      maxLoadPerUpdate: options.maxLoadPerUpdate ?? 80,
      concurrency: options.concurrency ?? 4,
      gridVisible: options.gridVisible ?? true,
      utmBoundaryVisible: options.utmBoundaryVisible ?? true,
      globalPreviewUrl: options.globalPreviewUrl ?? '',
      globalPreviewBounds: options.globalPreviewBounds,
    };
  }

  // --- Public API ---

  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
    this.workerPool = new WorkerPool(
      Math.min(navigator.hardwareConcurrency || 4, 8)
    );

    // Suppress AbortError from MapLibre ImageSource.updateImage internal fetches.
    // These fire when a source is removed while an image load is in flight — benign.
    // MapLibre emits these through its error event system, not as unhandled rejections.
    this.abortHandler = (e: PromiseRejectionEvent) => {
      if (e.reason?.name === 'AbortError') e.preventDefault();
    };
    window.addEventListener('unhandledrejection', this.abortHandler);
    map.on('error', (e: { error?: Error }) => {
      if (e.error?.name === 'AbortError') return;
    });

    try {
      this.debug('fetch', `Opening store: ${this.opts.url}`);
      this.store = await openStore(this.opts.url);
      this.proj = new UtmProjection(this.store.meta.epsg);
      this.debug('info', `Store opened: zone ${this.store.meta.utmZone}, EPSG:${this.store.meta.epsg}, ${this.store.meta.nBands} bands`);
      this.debug('info', `Shape: ${this.store.meta.shape.join('x')}, chunks: ${this.store.meta.chunkShape.join('x')}`);
      if (this.store.chunkManifest) this.debug('info', `Manifest: ${this.store.chunkManifest.size} chunks with data`);
      this.emit('metadata-loaded', this.store.meta);

      // Add overlays
      this.addOverlays();

      // Add zarr-layer preview if global preview URL is configured
      if (this.opts.globalPreviewUrl) {
          this.addPreviewLayer();
      }

      // Listen for viewport changes
      this.moveHandler = () => this.updateVisibleChunks();
      map.on('moveend', this.moveHandler);

      // Load visible chunks immediately
      this.updateVisibleChunks();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }


  remove(): void {
    // Remove zarr-layer preview
    if (this.previewLayer && this.map) {
        try {
            this.map.removeLayer(this.previewLayer.id);
        } catch (e) {
            // Layer may already be removed
        }
        this.previewLayer = null;
    }

    if (this.moveHandler && this.map) {
      this.map.off('moveend', this.moveHandler);
    }
    if (this.abortHandler) {
      window.removeEventListener('unhandledrejection', this.abortHandler);
      this.abortHandler = null;
    }
    this.currentAbort?.abort();
    for (const [, frameId] of this.loadingAnimations) cancelAnimationFrame(frameId);
    this.loadingAnimations.clear();
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
    this.embeddingRegion = null;
    this.classificationMaps.clear();
    this.chunkCache.clear();
    this.removeOverlays();
    this.workerPool?.terminate();
    this.store = null;
    this.proj = null;
    this.map = null;
  }

  getMetadata(): StoreMetadata | null {
    return this.store?.meta ?? null;
  }

  setBands(bands: [number, number, number]): void {
    this.opts.bands = bands;
    this.reRenderChunks();
  }

  setOpacity(opacity: number): void {
    this.opts.opacity = opacity;
    if (!this.map) return;
    // Update the global preview layer (RGB/PCA background)
    if (this.previewLayer) {
        this.previewLayer.setOpacity(opacity);
    }
    // Update region-wide RGB overlay
    if (this.map.getLayer('zarr-rgb-overlay-lyr')) {
      this.map.setPaintProperty('zarr-rgb-overlay-lyr', 'raster-opacity', opacity);
    }
    // Update any remaining per-tile chunk layers
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-chunk-lyr-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', opacity);
      }
    }
  }

  setPreview(mode: PreviewMode): void {
    this.opts.preview = mode;
    if (this.previewLayer && this.opts.globalPreviewUrl) {
        // Global preview layer handles mode switch directly
        const newVar = mode === 'pca' ? 'pca_rgb' : 'rgb';
        this.previewLayer.setVariable(newVar);
    } else {
        // Legacy path: clear cache and reload with new preview mode
        for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
        this.chunkCache.clear();
        this.updateVisibleChunks();
    }
  }

  setGridVisible(visible: boolean): void {
    this.opts.gridVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['chunk-grid-lines']) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  setUtmBoundaryVisible(visible: boolean): void {
    this.opts.utmBoundaryVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['utm-zone-line']) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  /** Re-add all chunk, overlay, and grid layers to the map.
   *  Call after a basemap switch that preserves sources but resets layers. */
  reAddAllLayers(): void {
    if (!this.map || !this.store) return;
    this.debug('overlay', 'Re-adding all layers after basemap switch');

    // Re-add overlays (removes first if present)
    this.addOverlays();

    // Re-add the global preview layer if configured
    if (this.opts.globalPreviewUrl) {
      this.previewLayer = null; // stale after basemap switch
      this.addPreviewLayer();
    }

    // Re-render the region-wide RGB overlay if embeddings are loaded
    if (this.embeddingRegion && this.regionTileCount() > 0) {
      this.recolorAllChunks();
    }

    // Re-add any remaining per-tile chunk layers (preview tiles etc.)
    let reAdded = 0;
    for (const [, entry] of this.chunkCache) {
      if (!entry.canvas) continue;
      if (this.previewLayer && entry.isPreview) continue;
      entry.sourceId = null;
      entry.layerId = null;
      const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
      entry.sourceId = ids.sourceId;
      entry.layerId = ids.layerId;
      reAdded++;
    }
    if (reAdded > 0) this.debug('overlay', `Re-added ${reAdded} cached chunk layers`);
  }

  /** Load full embedding data for a specific chunk.
   *  Dequantizes directly into the EmbeddingRegion buffer (NaN for invalid). */
  async loadFullChunk(ci: number, cj: number): Promise<void> {
    if (!this.store || !this.map) return;
    // Ensure region exists (auto-create for standalone calls e.g. from tutorials)
    this.ensureRegion(ci, ci, cj, cj);
    const key = this.chunkKey(ci, cj);
    this.startLoadingAnimation(ci, cj);

    try {
      const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
      const h = r1 - r0;
      const w = c1 - c0;
      const nBands = this.store.meta.nBands;
      const expectedBytes = w * h * nBands;

      this.debug('fetch', `Loading embeddings (${ci},${cj}): ${w}x${h}x${nBands} = ${(expectedBytes / 1024).toFixed(0)} KB`);
      this.tileProgress.set(key, 0);
      this.emit('embedding-progress', { ci, cj, stage: 'fetching', bytes: expectedBytes, bytesLoaded: 0 });

      const onProgress = (ev: { bytes_loaded: number; chunks_completed: number; chunks_total: number }) => {
        const frac = expectedBytes > 0 ? Math.min(1, ev.bytes_loaded / expectedBytes) : 0;
        this.tileProgress.set(key, frac);
        this.emit('embedding-progress', {
          ci, cj, stage: 'fetching', bytes: expectedBytes,
          bytesLoaded: ev.bytes_loaded,
          chunksCompleted: ev.chunks_completed,
          chunksTotal: ev.chunks_total,
        });
      };

      const [embView, scalesView] = await Promise.all([
        fetchRegion(this.store.embArr, [[r0, r1], [c0, c1], null], { onProgress }),
        fetchRegion(this.store.scalesArr, [[r0, r1], [c0, c1]]),
      ]);
      this.debug('fetch', `Embeddings fetched (${ci},${cj}), rendering...`);
      this.emit('embedding-progress', { ci, cj, stage: 'rendering', bytes: expectedBytes });

      const embInt8 = new Int8Array(embView.data.buffer, embView.data.byteOffset,
        embView.data.byteLength).slice();
      const scalesCopy = new Uint8Array(scalesView.data.buffer, scalesView.data.byteOffset,
        scalesView.data.byteLength).slice();
      const scalesF32 = new Float32Array(scalesCopy.buffer);

      // Dequantize directly into the region buffer (NaN for invalid pixels)
      const region = this.embeddingRegion;
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

      this.debug('render', `Embedding dequantized (${ci},${cj})`);

      // Stop animation and remove preview before adding embedding layer
      this.stopLoadingAnimation(ci, cj);
      const existing = this.chunkCache.get(key);
      if (existing?.sourceId) this.removeChunkFromMap(key);

      this.chunkCache.set(key, {
        ci, cj,
        canvas: null, sourceId: null, layerId: null, isPreview: false,
      });

      this.emit('embedding-progress', { ci, cj, stage: 'done', bytes: w * h * nBands * 4 });
      this.emit('embeddings-loaded', { ci, cj });
    } catch (err) {
      this.stopLoadingAnimation(ci, cj);
      this.debug('error', `Embedding load (${ci},${cj}) failed: ${(err as Error).message}`);
      this.emit('embedding-progress', { ci, cj, stage: 'done', bytes: 0 });
    }
  }

  /** Given a map coordinate, return the chunk indices containing that point, or null. */
  getChunkAtLngLat(lng: number, lat: number): { ci: number; cj: number } | null {
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

  /** Get the lng/lat corners of a chunk tile: [topLeft, topRight, bottomRight, bottomLeft]. */
  getChunkBoundsLngLat(ci: number, cj: number): [[number, number], [number, number], [number, number], [number, number]] | null {
    if (!this.store || !this.proj) return null;
    return this.chunkCorners(ci, cj);
  }

  /** Return all chunk indices whose bounding boxes intersect a GeoJSON polygon. */
  getChunksInRegion(polygon: GeoJSON.Polygon): { ci: number; cj: number }[] {
    if (!this.store || !this.proj) return [];
    // Convert polygon ring to UTM coordinates
    const coords = polygon.coordinates[0]; // outer ring
    const utmRing: [number, number][] = [];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [lng, lat] of coords) {
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

    // Convert UTM bounds to chunk index ranges (same math as visibleChunkIndices)
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)));
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)));
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)));
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)));

    const chunkW = cs[1] * px;
    const chunkH = cs[0] * px;

    const result: { ci: number; cj: number }[] = [];
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

  /** Re-render all embedding tiles using global min/max from the region buffer.
   *  Renders a single region-wide canvas (no seams between tiles). */
  recolorAllChunks(): void {
    if (!this.map || !this.store || !this.embeddingRegion) return;
    const [bR, bG, bB] = this.opts.bands;
    const region = this.embeddingRegion;
    const { nBands, tileW, tileH, emb, loaded, gridCols, gridRows } = region;
    const tilePixels = tileW * tileH;

    // First pass: global min/max across all loaded tiles
    let gMinR = Infinity, gMaxR = -Infinity;
    let gMinG = Infinity, gMaxG = -Infinity;
    let gMinB = Infinity, gMaxB = -Infinity;
    const nTiles = loaded.length;
    for (let t = 0; t < nTiles; t++) {
      if (!loaded[t]) continue;
      const base = t * tilePixels * nBands;
      for (let i = 0; i < tilePixels; i++) {
        const off = base + i * nBands;
        if (isNaN(emb[off])) continue;
        const vr = emb[off + bR], vg = emb[off + bG], vb = emb[off + bB];
        if (vr < gMinR) gMinR = vr; if (vr > gMaxR) gMaxR = vr;
        if (vg < gMinG) gMinG = vg; if (vg > gMaxG) gMaxG = vg;
        if (vb < gMinB) gMinB = vb; if (vb > gMaxB) gMaxB = vb;
      }
    }

    if (!isFinite(gMinR)) return;
    const rangeR = gMaxR - gMinR || 1, rangeG = gMaxG - gMinG || 1, rangeB = gMaxB - gMinB || 1;
    this.debug('render', `recolorAllChunks: R[${gMinR.toFixed(2)},${gMaxR.toFixed(2)}] G[${gMinG.toFixed(2)},${gMaxG.toFixed(2)}] B[${gMinB.toFixed(2)},${gMaxB.toFixed(2)}]`);

    // Remove old per-tile chunk layers (they'll be replaced by the single region canvas)
    for (let t = 0; t < nTiles; t++) {
      if (!loaded[t]) continue;
      const ci = region.ciMin + Math.floor(t / gridCols);
      const cj = region.cjMin + (t % gridCols);
      const key = this.chunkKey(ci, cj);
      const entry = this.chunkCache.get(key);
      if (entry?.sourceId) this.removeChunkFromMap(key);
    }

    // Second pass: render all tiles into a single region-wide canvas
    const W = gridCols * tileW;
    const H = gridRows * tileH;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(W, H);
    const rgba = imgData.data;

    for (let t = 0; t < nTiles; t++) {
      if (!loaded[t]) continue;
      const tileRow = Math.floor(t / gridCols);
      const tileCol = t % gridCols;
      const base = t * tilePixels * nBands;
      const pixelY0 = tileRow * tileH;
      const pixelX0 = tileCol * tileW;

      for (let py = 0; py < tileH; py++) {
        for (let px = 0; px < tileW; px++) {
          const i = py * tileW + px;
          const off = base + i * nBands;
          if (isNaN(emb[off])) continue;
          const outIdx = ((pixelY0 + py) * W + (pixelX0 + px)) * 4;
          rgba[outIdx]     = Math.max(0, Math.min(255, ((emb[off + bR] - gMinR) / rangeR) * 255));
          rgba[outIdx + 1] = Math.max(0, Math.min(255, ((emb[off + bG] - gMinG) / rangeG) * 255));
          rgba[outIdx + 2] = Math.max(0, Math.min(255, ((emb[off + bB] - gMinB) / rangeB) * 255));
          rgba[outIdx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Place the single canvas as a region-wide ImageSource
    const topLeft = this.chunkUtmBounds(region.ciMin, region.cjMin);
    const bottomRight = this.chunkUtmBounds(region.ciMax, region.cjMax);
    const regionBounds: UtmBounds = {
      minE: topLeft.minE,
      maxE: bottomRight.maxE,
      minN: bottomRight.minN,
      maxN: topLeft.maxN,
    };
    const corners = this.proj!.chunkCornersToLngLat(regionBounds);
    const dataUrl = canvas.toDataURL('image/png');

    const sourceId = 'zarr-rgb-overlay-src';
    const layerId = 'zarr-rgb-overlay-lyr';

    // Update in-place if source exists, otherwise create
    const existing = this.map.getSource(sourceId) as
      { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
    if (existing?.updateImage) {
      existing.updateImage({ url: dataUrl, coordinates: corners });
    } else {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
      this.map.addSource(sourceId, {
        type: 'image', url: dataUrl, coordinates: corners,
      });
      this.map.addLayer({
        id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': this.opts.opacity, 'raster-fade-duration': 0 },
      });
      this.raiseOverlayLayers();
    }
  }

  /** Load a batch of embedding chunks with parallel concurrency.
   *  Creates/grows the EmbeddingRegion to cover the chunk grid.
   *  Returns the number of chunks successfully loaded. */
  async loadChunkBatch(
    chunks: { ci: number; cj: number }[],
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<number> {
    if (!this.store || chunks.length === 0) return 0;

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

    let loaded = 0;
    let succeeded = 0;
    const total = chunks.length;
    const concurrency = 8;

    let cursor = 0;
    const next = async (): Promise<void> => {
      while (cursor < total) {
        const idx = cursor++;
        const { ci, cj } = chunks[idx];
        if (this.regionHasTile(ci, cj)) {
          succeeded++;
          loaded++;
          onProgress?.(loaded, total);
          continue;
        }
        try {
          await this.loadFullChunk(ci, cj);
          succeeded++;
        } catch (err) {
          this.debug('error', `Failed to load chunk (${ci},${cj}): ${(err as Error).message}`);
        }
        loaded++;
        onProgress?.(loaded, total);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => next());
    await Promise.all(workers);
    return succeeded;
  }

  /** Check if a tile is loaded in the region. */
  regionHasTile(ci: number, cj: number): boolean {
    const r = this.embeddingRegion;
    if (!r) return false;
    if (ci < r.ciMin || ci > r.ciMax || cj < r.cjMin || cj > r.cjMax) return false;
    const t = (ci - r.ciMin) * r.gridCols + (cj - r.cjMin);
    return r.loaded[t] === 1;
  }

  /** Return the number of loaded tiles in the region. */
  regionTileCount(): number {
    const r = this.embeddingRegion;
    if (!r) return 0;
    let n = 0;
    for (let i = 0; i < r.loaded.length; i++) if (r.loaded[i]) n++;
    return n;
  }

  /** Create or grow the EmbeddingRegion to cover the given bounds. */
  private ensureRegion(ciMin: number, ciMax: number, cjMin: number, cjMax: number): void {
    if (!this.store) return;
    const cs = this.store.meta.chunkShape;
    const nBands = this.store.meta.nBands;
    const tileH = cs[0], tileW = cs[1];

    const old = this.embeddingRegion;
    if (old) {
      // Check if existing region already covers these bounds
      if (ciMin >= old.ciMin && ciMax <= old.ciMax && cjMin >= old.cjMin && cjMax <= old.cjMax) return;

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
          newEmb.set(old.emb.subarray(oldBase, oldBase + tilePixels * nBands), newBase);
          newLoaded[newT] = 1;
        }
      }

      this.embeddingRegion = {
        ciMin: newCiMin, ciMax: newCiMax, cjMin: newCjMin, cjMax: newCjMax,
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
      this.embeddingRegion = {
        ciMin, ciMax, cjMin, cjMax, gridCols, gridRows,
        tileW, tileH, nBands, emb, loaded: new Uint8Array(nTiles),
      };
      this.debug('info', `Region created [${ciMin},${ciMax}]x[${cjMin},${cjMax}] (${nTiles} tiles, ${(emb.byteLength / 1024 / 1024).toFixed(0)} MB)`);
    }
  }

  /** Extract the embedding vector at a map coordinate from the region buffer. */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null {
    if (!this.store || !this.proj || !this.embeddingRegion) return null;
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

    const region = this.embeddingRegion;
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

  /** Extract embeddings for all valid pixels in a kernel around a map coordinate. */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): EmbeddingAt[] {
    if (!this.store || !this.proj || !this.embeddingRegion) return [];
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const region = this.embeddingRegion;

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

  /** Compute the bounding box (in WGS84) of all loaded embedding tiles. */
  embeddingBoundsLngLat(): [number, number, number, number] | null {
    const r = this.embeddingRegion;
    if (!r || this.regionTileCount() === 0) return null;
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

  /** Add or update a single overlay canvas covering the entire embedding region.
   *  One PNG encode + one ImageSource — much faster than per-tile overlays.
   *  Uses updateImage when possible to avoid remove+re-add flicker. */
  setSimilarityOverlay(canvas: HTMLCanvasElement): void {
    if (!this.map || !this.embeddingRegion) return;
    const r = this.embeddingRegion;
    // Compute corners spanning the full region grid
    const topLeft = this.chunkUtmBounds(r.ciMin, r.cjMin);
    const bottomRight = this.chunkUtmBounds(r.ciMax, r.cjMax);
    const regionBounds: UtmBounds = {
      minE: topLeft.minE,
      maxE: bottomRight.maxE,
      minN: bottomRight.minN,
      maxN: topLeft.maxN,
    };
    const corners = this.proj!.chunkCornersToLngLat(regionBounds);
    const dataUrl = canvas.toDataURL('image/png');

    const sourceId = 'zarr-sim-overlay-src';
    const layerId = 'zarr-sim-overlay-lyr';

    // Fast path: update existing source in-place (no flicker, no layer re-order)
    const existing = this.map.getSource(sourceId) as
      { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
    if (existing?.updateImage) {
      existing.updateImage({ url: dataUrl, coordinates: corners });
      return;
    }

    // First time: create source + layer
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 },
    });
    this.raiseOverlayLayers();
  }

  /** Remove the similarity overlay. */
  clearSimilarityOverlay(): void {
    if (!this.map) return;
    const layerId = 'zarr-sim-overlay-lyr';
    const sourceId = 'zarr-sim-overlay-src';
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Remove the region-wide RGB overlay. */
  clearRgbOverlay(): void {
    if (!this.map) return;
    const layerId = 'zarr-rgb-overlay-lyr';
    const sourceId = 'zarr-rgb-overlay-src';
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Add or update a classification RGBA canvas as a map layer for a chunk.
   *  Called repeatedly during incremental classification — updates in-place
   *  if the source already exists. */
  addClassificationOverlay(ci: number, cj: number, canvas: HTMLCanvasElement): void {
    this.addClassificationOverlayBatch([{ ci, cj, canvas }]);
  }

  /** Add or update classification overlays for multiple tiles at once.
   *  Only raises overlay layers once at the end (O(N) instead of O(N²)). */
  addClassificationOverlayBatch(tiles: { ci: number; cj: number; canvas: HTMLCanvasElement }[]): void {
    if (!this.map || tiles.length === 0) return;
    let needsRaise = false;

    for (const { ci, cj, canvas } of tiles) {
      const key = this.chunkKey(ci, cj);
      const sourceId = `zarr-class-src-${key}`;
      const layerId = `zarr-class-lyr-${key}`;
      const corners = this.chunkCorners(ci, cj);

      // Always remove + re-add to guarantee the canvas content is picked up
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

      this.map.addSource(sourceId, {
        type: 'image',
        url: canvas.toDataURL('image/png'),
        coordinates: corners,
      });
      this.map.addLayer({
        id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
      });
      needsRaise = true;
    }

    if (needsRaise) this.raiseOverlayLayers();
  }

  /** Store a per-pixel class ID map for a classified chunk. */
  setClassificationMap(ci: number, cj: number, classMap: Int16Array, width: number, height: number): void {
    this.classificationMaps.set(this.chunkKey(ci, cj), { width, height, classMap });
  }

  /** Look up the classification class ID at a map coordinate.
   *  Returns the class ID (>= 0), -1 for uncertain, -2 for nodata, or null if
   *  no classification exists at that location. */
  getClassificationAt(lng: number, lat: number): number | null {
    if (!this.store || !this.proj) return null;
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
    const key = this.chunkKey(ci, cj);
    const entry = this.classificationMaps.get(key);
    if (!entry) return null;

    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= entry.height || col < 0 || col >= entry.width) return null;

    return entry.classMap[row * entry.width + col];
  }

  /** Remove all classification overlays from the map. */
  clearClassificationOverlays(): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    // Remove region-wide overlays
    this.clearRgbOverlay();
    this.clearSimilarityOverlay();
    // Remove per-tile classification overlays
    const classLayers = style.layers.filter(l => l.id.startsWith('zarr-class-lyr-'));
    for (const layer of classLayers) {
      this.map.removeLayer(layer.id);
      const srcId = layer.id.replace('zarr-class-lyr-', 'zarr-class-src-');
      if (this.map.getSource(srcId)) this.map.removeSource(srcId);
    }
    this.classificationMaps.clear();
    this.debug('overlay', 'Cleared all classification overlays');
  }

  /** Set opacity on all classification overlay layers. */
  setClassificationOpacity(opacity: number): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-class-lyr-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', opacity);
      }
    }
  }

  /** Update the GeoJSON highlight border around tiles with cached embeddings. */
  private updateEmbeddingHighlights(): void {
    // No-op: per-tile borders removed; ROI polygon outline in App.svelte is sufficient
  }

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

  // --- Private implementation ---

  private emit<K extends keyof ZarrTesseraEvents>(
    event: K, data: ZarrTesseraEvents[K],
  ): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  private debug(type: DebugLogEntry['type'], msg: string): void {
    this.emit('debug', { time: Date.now(), type, msg });
  }

  private chunkKey(ci: number, cj: number): string { return `${ci}_${cj}`; }

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

  private chunkCorners(ci: number, cj: number) {
    return this.proj!.chunkCornersToLngLat(this.chunkUtmBounds(ci, cj));
  }

  private visibleChunkIndices(): [number, number][] {
    if (!this.store || !this.map || !this.proj) return [];
    const bounds = this.map.getBounds();
    const sw = this.proj.forward(bounds.getWest(), bounds.getSouth());
    const ne = this.proj.forward(bounds.getEast(), bounds.getNorth());
    const nw = this.proj.forward(bounds.getWest(), bounds.getNorth());
    const se = this.proj.forward(bounds.getEast(), bounds.getSouth());

    const minE = Math.min(sw[0], nw[0]) - 1000;
    const maxE = Math.max(ne[0], se[0]) + 1000;
    const minN = Math.min(sw[1], se[1]) - 1000;
    const maxN = Math.max(ne[1], nw[1]) + 1000;

    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)));
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)));
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)));
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)));

    const result: [number, number][] = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        if (this.store.chunkManifest && !this.store.chunkManifest.has(`${ci}_${cj}`)) continue;
        result.push([ci, cj]);
      }
    }
    return result;
  }

  private rgbaToCanvas(rgbaBuffer: ArrayBuffer, w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    img.data.set(new Uint8Array(rgbaBuffer));
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  private addChunkToMap(ci: number, cj: number, canvas: HTMLCanvasElement) {
    const key = this.chunkKey(ci, cj);
    const sourceId = `zarr-chunk-src-${key}`;
    const layerId = `zarr-chunk-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const dataUrl = canvas.toDataURL('image/png');

    if (this.map!.getLayer(layerId)) this.map!.removeLayer(layerId);
    if (this.map!.getSource(sourceId)) this.map!.removeSource(sourceId);

    this.map!.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map!.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': this.opts.opacity, 'raster-fade-duration': 0 },
    });

    this.raiseOverlayLayers();
    return { sourceId, layerId };
  }

  /** Start a scanning animation overlay on a tile while embeddings load. */
  private startLoadingAnimation(ci: number, cj: number): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);

    // Stop any existing animation for this tile
    if (this.loadingAnimations.has(key)) {
      cancelAnimationFrame(this.loadingAnimations.get(key)!);
    }

    const sourceId = `zarr-load-src-${key}`;
    const layerId = `zarr-load-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const h = r1 - r0;
    const w = c1 - c0;

    // Create the animation canvas
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    // Capture existing tile pixels for background distortion
    const existing = this.chunkCache.get(key);
    let bgPixels: ImageData | null = null;
    if (existing?.canvas) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const tmpCtx = tmp.getContext('2d')!;
      tmpCtx.drawImage(existing.canvas, 0, 0, w, h);
      bgPixels = tmpCtx.getImageData(0, 0, w, h);
    }

    // If no preview tile, capture the basemap pixels from the map canvas.
    // MapLibre needs preserveDrawingBuffer:true for this to work — check that
    // the captured pixels are non-empty before using them.
    if (!bgPixels && this.map) {
      try {
        const mapCanvas = this.map.getCanvas();
        const tl = this.map.project(corners[0] as [number, number]);
        const tr = this.map.project(corners[1] as [number, number]);
        const br = this.map.project(corners[2] as [number, number]);
        const bl = this.map.project(corners[3] as [number, number]);
        const sx = Math.round(Math.min(tl.x, bl.x));
        const sy = Math.round(Math.min(tl.y, tr.y));
        const sw = Math.round(Math.max(tr.x, br.x)) - sx;
        const sh = Math.round(Math.max(bl.y, br.y)) - sy;
        if (sw > 0 && sh > 0) {
          const tmp = document.createElement('canvas');
          tmp.width = w;
          tmp.height = h;
          const tmpCtx = tmp.getContext('2d')!;
          tmpCtx.drawImage(mapCanvas, sx, sy, sw, sh, 0, 0, w, h);
          const captured = tmpCtx.getImageData(0, 0, w, h);
          // Verify pixels aren't all blank (WebGL preserveDrawingBuffer=false yields zeros)
          let nonZero = 0;
          const d = captured.data;
          for (let i = 0; i < d.length; i += 40) { if (d[i] || d[i + 1] || d[i + 2]) { nonZero++; } }
          if (nonZero > 0) bgPixels = captured;
        }
      } catch { /* ignore CORS/security errors on map canvas read */ }
    }

    // Simple hash for pseudo-random per-pixel noise
    const rng = (x: number) => {
      x = ((x >> 16) ^ x) * 0x45d9f3b;
      x = ((x >> 16) ^ x) * 0x45d9f3b;
      return ((x >> 16) ^ x) & 0xff;
    };

    const renderFrame = (canvas: HTMLCanvasElement, t: number) => {
      const ctx = canvas.getContext('2d')!;
      const progress = this.tileProgress.get(key) ?? 0;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.30;
      const tau = Math.PI * 2;

      // --- Background: distorted RGB tile ---
      if (bgPixels) {
        const src = bgPixels.data;
        const out = ctx.createImageData(w, h);
        const dst = out.data;
        const glitchIntensity = 1.0 - progress; // distortion fades as download completes
        const tSec = t / 1000;

        // Chromatic aberration offset (pixels)
        const caOffset = Math.round(3 + 6 * glitchIntensity * (0.5 + 0.5 * Math.sin(tSec * 2.3)));

        // Glitch band: a horizontal band that shifts pixels sideways
        const glitchBandY = Math.floor((t * 0.15) % h);
        const glitchBandH = Math.floor(8 + 20 * glitchIntensity);
        const glitchShift = Math.floor((Math.sin(tSec * 7.1) * 12 + Math.sin(tSec * 13.3) * 6) * glitchIntensity);

        for (let y = 0; y < h; y++) {
          // Scanline darkening (every other line)
          const scanline = y % 2 === 0 ? 1.0 : (0.85 + 0.15 * progress);

          // Per-line horizontal jitter
          const inGlitchBand = y >= glitchBandY && y < glitchBandY + glitchBandH;
          const lineShift = inGlitchBand ? glitchShift : 0;

          for (let x = 0; x < w; x++) {
            const di = (y * w + x) * 4;

            // Source coordinates with chromatic aberration
            const sx = x + lineShift;
            const rX = Math.max(0, Math.min(w - 1, sx + caOffset));
            const gX = Math.max(0, Math.min(w - 1, sx));
            const bX = Math.max(0, Math.min(w - 1, sx - caOffset));

            const rI = (y * w + rX) * 4;
            const gI = (y * w + gX) * 4;
            const bI = (y * w + bX) * 4;

            // Read split channels
            let r = src[rI];
            let g = src[gI + 1];
            let b = src[bI + 2];

            // Cyan/green colour shift
            const shift = 0.3 * glitchIntensity;
            r = Math.round(r * (1 - shift * 0.7));
            g = Math.round(g * (1 + shift * 0.15));
            b = Math.round(b * (1 + shift * 0.3));

            // Pulsing digital quantisation wave — posterizes brightness in sweeping bands
            const wave = Math.sin(tSec * 3 + y * 0.05 + x * 0.02) * 0.5 + 0.5;
            const quantize = glitchIntensity * wave;
            if (quantize > 0.2) {
              const levels = 6;
              r = Math.round(Math.round(r / 255 * levels) / levels * 255);
              g = Math.round(Math.round(g / 255 * levels) / levels * 255);
              b = Math.round(Math.round(b / 255 * levels) / levels * 255);
            }

            // Brightness pulse (rhythmic throb)
            const pulse = 1.0 + 0.15 * glitchIntensity * Math.sin(tSec * 4 - y * 0.03);
            r = Math.min(255, Math.round(r * pulse));
            g = Math.min(255, Math.round(g * pulse));
            b = Math.min(255, Math.round(b * pulse));

            // Static noise in glitch band
            if (inGlitchBand && Math.random() < 0.08 * glitchIntensity) {
              const n = rng(x * 7919 + y * 6271 + (t | 0)) & 0x3f;
              r = n; g = n + 40; b = n + 50;
            }

            // Apply scanline — blend towards transparent as progress nears 1
            const alpha = Math.round(200 + 55 * (1 - progress));
            dst[di]     = Math.min(255, r * scanline) | 0;
            dst[di + 1] = Math.min(255, g * scanline) | 0;
            dst[di + 2] = Math.min(255, b * scanline) | 0;
            dst[di + 3] = alpha;
          }
        }

        ctx.putImageData(out, 0, 0);

        // Dark vignette overlay
        const vg = ctx.createRadialGradient(cx, cy, radius * 0.8, cx, cy, Math.max(w, h) * 0.8);
        vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vg.addColorStop(1, `rgba(0, 5, 10, ${0.4 + 0.3 * glitchIntensity})`);
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
      } else {
        // No preview — semi-transparent with scanning grid effect
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = `rgba(0, 8, 12, ${0.15 + 0.10 * (1 - progress)})`;
        ctx.fillRect(0, 0, w, h);

        const tSec = t / 1000;
        const gridSpacing = 16;
        const glitchIntensity = 1.0 - progress;

        // Faint grid lines
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.04 + 0.03 * glitchIntensity})`;
        ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += gridSpacing) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += gridSpacing) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        // Horizontal scan line sweeping downward
        const scanY = (tSec * 80) % (h + 40) - 20;
        const scanGrad = ctx.createLinearGradient(0, scanY - 20, 0, scanY + 20);
        scanGrad.addColorStop(0, 'rgba(0, 229, 255, 0)');
        scanGrad.addColorStop(0.5, `rgba(0, 229, 255, ${0.12 * glitchIntensity})`);
        scanGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = scanGrad;
        ctx.fillRect(0, scanY - 20, w, 40);

        // Corner brackets
        const bracketLen = Math.min(w, h) * 0.1;
        const bracketInset = 6;
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.15 + 0.1 * Math.sin(tSec * 2)})`;
        ctx.lineWidth = 1.5;
        // top-left
        ctx.beginPath(); ctx.moveTo(bracketInset, bracketInset + bracketLen); ctx.lineTo(bracketInset, bracketInset); ctx.lineTo(bracketInset + bracketLen, bracketInset); ctx.stroke();
        // top-right
        ctx.beginPath(); ctx.moveTo(w - bracketInset - bracketLen, bracketInset); ctx.lineTo(w - bracketInset, bracketInset); ctx.lineTo(w - bracketInset, bracketInset + bracketLen); ctx.stroke();
        // bottom-left
        ctx.beginPath(); ctx.moveTo(bracketInset, h - bracketInset - bracketLen); ctx.lineTo(bracketInset, h - bracketInset); ctx.lineTo(bracketInset + bracketLen, h - bracketInset); ctx.stroke();
        // bottom-right
        ctx.beginPath(); ctx.moveTo(w - bracketInset - bracketLen, h - bracketInset); ctx.lineTo(w - bracketInset, h - bracketInset); ctx.lineTo(w - bracketInset, h - bracketInset - bracketLen); ctx.stroke();
      }

      // --- HUD overlay: spinning rings + progress arc ---

      // Spinning outer ring
      const spin1 = (t / 600) % tau;
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.15, spin1, spin1 + tau * 0.7);
      ctx.stroke();

      // Counter-spinning dashed ring
      const spin2 = -(t / 900) % tau;
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = 'rgba(0, 180, 220, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.30, spin2, spin2 + tau);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tick marks around the ring
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.1)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * tau;
        const inner = radius * 1.02;
        const outer = i % 9 === 0 ? radius * 1.12 : radius * 1.06;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }

      // Progress arc
      const arcEnd = progress * tau;
      const arcStart = -Math.PI / 2;
      if (progress > 0) {
        // Glow
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
        ctx.lineWidth = Math.max(6, radius * 0.20);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, arcStart, arcStart + arcEnd);
        ctx.stroke();

        // Main arc
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
        ctx.lineWidth = Math.max(2, radius * 0.08);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, arcStart, arcStart + arcEnd);
        ctx.stroke();
      }

      // Track ring (dim)
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
      ctx.lineWidth = Math.max(2, radius * 0.08);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, arcStart + arcEnd, arcStart + tau);
      ctx.stroke();

      // Tip glow
      if (progress > 0 && progress < 1) {
        const tipAngle = arcStart + arcEnd;
        const tx = cx + Math.cos(tipAngle) * radius;
        const ty = cy + Math.sin(tipAngle) * radius;
        const dotGlow = ctx.createRadialGradient(tx, ty, 0, tx, ty, radius * 0.15);
        dotGlow.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
        dotGlow.addColorStop(0.3, 'rgba(0, 229, 255, 0.5)');
        dotGlow.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = dotGlow;
        ctx.fillRect(tx - radius * 0.15, ty - radius * 0.15, radius * 0.3, radius * 0.3);
      }

      // Percentage text
      const pct = Math.round(progress * 100);
      const fontSize = Math.max(10, Math.round(radius * 0.40));
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(0, 229, 255, ${0.8 + 0.2 * Math.sin(t / 400)})`;
      ctx.fillText(`${pct}%`, cx, cy - fontSize * 0.15);

      // Sub-label
      const subSize = Math.max(7, Math.round(radius * 0.15));
      ctx.font = `${subSize}px monospace`;
      ctx.fillStyle = 'rgba(0, 229, 255, 0.3)';
      ctx.fillText('ACQUIRING', cx, cy + fontSize * 0.65);
    };

    // Initial frame
    renderFrame(canvas, performance.now());
    const dataUrl = canvas.toDataURL('image/png');

    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    });
    this.raiseOverlayLayers();

    // Animation loop — throttle updateImage to avoid MapLibre AbortError spam.
    // Render canvas every frame but only push to MapLibre every ~150ms.
    let lastPush = 0;
    let pendingUpdate = false;
    const PUSH_INTERVAL = 150;

    const animate = (t: number) => {
      if (!this.map || !this.map.getSource(sourceId)) return;
      renderFrame(canvas, t);

      if (t - lastPush >= PUSH_INTERVAL && !pendingUpdate) {
        pendingUpdate = true;
        lastPush = t;
        const url = canvas.toDataURL('image/png');
        const src = this.map.getSource(sourceId) as
          { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => unknown } | undefined;
        try {
          const result = src?.updateImage?.({ url, coordinates: corners });
          if (result && typeof (result as any).then === 'function') {
            (result as any).then(() => { pendingUpdate = false; }, () => { pendingUpdate = false; });
          } else {
            pendingUpdate = false;
          }
        } catch { pendingUpdate = false; }
      }

      this.loadingAnimations.set(key, requestAnimationFrame(animate));
    };
    this.loadingAnimations.set(key, requestAnimationFrame(animate));
  }

  /** Stop and remove loading animation for a tile. */
  private stopLoadingAnimation(ci: number, cj: number): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);
    this.tileProgress.delete(key);
    const frameId = this.loadingAnimations.get(key);
    if (frameId != null) {
      cancelAnimationFrame(frameId);
      this.loadingAnimations.delete(key);
    }
    const layerId = `zarr-load-lyr-${key}`;
    const sourceId = `zarr-load-src-${key}`;
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Ensure overlay layers stay above chunk data layers.
   *  Order (bottom→top): chunk data, grid fills, loading anim, classification, grid lines, UTM */
  private raiseOverlayLayers(): void {
    const style = this.map!.getStyle();
    if (!style?.layers) return;
    // Collect layer IDs in a single pass, then move in order
    const loadLayers: string[] = [];
    const classLayers: string[] = [];
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-load-lyr-')) loadLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-class-lyr-')) classLayers.push(layer.id);
    }
    // RGB region canvas (below everything else)
    if (this.map!.getLayer('zarr-rgb-overlay-lyr')) this.map!.moveLayer('zarr-rgb-overlay-lyr');
    for (const id of loadLayers) this.map!.moveLayer(id);
    // Similarity overlay (single region-wide layer)
    if (this.map!.getLayer('zarr-sim-overlay-lyr')) this.map!.moveLayer('zarr-sim-overlay-lyr');
    for (const id of classLayers) this.map!.moveLayer(id);
    // ROI polygon outlines should be above classification overlays
    if (this.map!.getLayer('roi-regions-fill')) this.map!.moveLayer('roi-regions-fill');
    if (this.map!.getLayer('roi-regions-line')) this.map!.moveLayer('roi-regions-line');
    if (this.map!.getLayer('chunk-grid-lines')) this.map!.moveLayer('chunk-grid-lines');
    if (this.map!.getLayer('utm-zone-line')) this.map!.moveLayer('utm-zone-line');
    // Similarity reference marker should be topmost
    if (this.map!.getLayer('sim-ref-marker-ring')) this.map!.moveLayer('sim-ref-marker-ring');
    if (this.map!.getLayer('sim-ref-marker-dot')) this.map!.moveLayer('sim-ref-marker-dot');
  }

  private removeChunkFromMap(key: string): void {
    const entry = this.chunkCache.get(key);
    if (!entry) return;
    try {
      if (entry.layerId && this.map?.getLayer(entry.layerId)) this.map.removeLayer(entry.layerId);
      if (entry.sourceId && this.map?.getSource(entry.sourceId)) this.map.removeSource(entry.sourceId);
    } catch { /* ignore */ }
    entry.sourceId = null;
    entry.layerId = null;
  }

  private async updateVisibleChunks(): Promise<void> {
    if (!this.store || !this.map) return;
    // When the global preview layer handles RGB/PCA rendering, the legacy
    // per-chunk loading is unnecessary.  Embedding tiles are loaded separately
    // via loadFullChunk (double-click) and always use zarr-chunk-lyr layers.
    if (this.previewLayer) return;
    this.currentAbort?.abort();
    const abort = this.currentAbort = new AbortController();
    const signal = abort.signal;

    const visible = this.visibleChunkIndices();
    const visibleKeys = new Set(visible.map(([ci, cj]) => this.chunkKey(ci, cj)));
    this.debug('info', `Viewport: ${visible.length} chunks visible, ${this.chunkCache.size} cached`);

    // Remove off-screen chunks from map (keep in cache)
    let removed = 0;
    for (const [key, entry] of this.chunkCache) {
      if (!visibleKeys.has(key) && entry.sourceId) { this.removeChunkFromMap(key); removed++; }
    }
    if (removed) this.debug('info', `Removed ${removed} off-screen chunk layers`);

    // Re-add cached chunks and collect new ones to load
    const toLoad: [number, number][] = [];
    for (const [ci, cj] of visible) {
      const key = this.chunkKey(ci, cj);
      const entry = this.chunkCache.get(key);
      if (entry?.canvas && !entry.sourceId) {
        const ids = this.addChunkToMap(ci, cj, entry.canvas);
        entry.sourceId = ids.sourceId;
        entry.layerId = ids.layerId;
      } else if (!entry) {
        toLoad.push([ci, cj]);
      }
    }

    // Sort by distance from center
    try {
      const center = this.map.getCenter();
      const [cE, cN] = this.proj!.forward(center.lng, center.lat);
      toLoad.sort((a, b) => {
        const ba = this.chunkUtmBounds(a[0], a[1]);
        const bb = this.chunkUtmBounds(b[0], b[1]);
        const da = Math.hypot((ba.minE + ba.maxE) / 2 - cE, (ba.minN + ba.maxN) / 2 - cN);
        const db = Math.hypot((bb.minE + bb.maxE) / 2 - cE, (bb.minN + bb.maxN) / 2 - cN);
        return da - db;
      });
    } catch { /* keep original order */ }

    if (toLoad.length > this.opts.maxLoadPerUpdate) {
      this.debug('info', `Clamping load queue: ${toLoad.length} -> ${this.opts.maxLoadPerUpdate}`);
      toLoad.length = this.opts.maxLoadPerUpdate;
    }
    if (toLoad.length > 0) this.debug('fetch', `Loading ${toLoad.length} chunks (concurrency=${this.opts.concurrency})`);

    // Determine preview mode
    const usePreview =
      (this.opts.preview === 'pca' && this.store.meta.hasPca) ||
      (this.opts.preview === 'rgb' && this.store.meta.hasRgb);

    this.emit('loading', { total: toLoad.length, done: 0 });
    let done = 0;

    for (let i = 0; i < toLoad.length; i += this.opts.concurrency) {
      if (signal.aborted) break;
      const batch = toLoad.slice(i, i + this.opts.concurrency);
      await Promise.all(batch.map(([ci, cj]) =>
        this.loadChunk(ci, cj, signal, usePreview).then(() => {
          done++;
          this.emit('loading', { total: toLoad.length, done });
        })
      ));
    }

    // LRU eviction
    if (this.chunkCache.size > this.opts.maxCached) {
      const keys = [...this.chunkCache.keys()];
      for (let i = 0; i < keys.length && this.chunkCache.size > this.opts.maxCached; i++) {
        if (!visibleKeys.has(keys[i])) {
          this.removeChunkFromMap(keys[i]);
          this.chunkCache.delete(keys[i]);
        }
      }
    }
  }

  private async loadChunk(
    ci: number, cj: number, signal: AbortSignal, usePreview: boolean,
  ): Promise<void> {
    const key = this.chunkKey(ci, cj);
    if (this.chunkCache.has(key)) return;

    try {
      const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
      const h = r1 - r0;
      const w = c1 - c0;

      let result: Record<string, unknown>;

      if (usePreview && !this.regionHasTile(ci, cj)) {
        const previewArr = this.opts.preview === 'pca'
          ? this.store!.pcaArr! : this.store!.rgbArr!;
        const rgbView = await fetchRegion(previewArr, [[r0, r1], [c0, c1], null]);
        if (signal.aborted) return;
        const rgbData = new Uint8Array(
          rgbView.data.buffer, rgbView.data.byteOffset, rgbView.data.byteLength,
        ).slice().buffer;

        result = await this.workerPool!.dispatch({
          type: 'render-rgb', rgbData, width: w, height: h,
        }, [rgbData]);
      } else {
        const [embView, scalesView] = await Promise.all([
          fetchRegion(this.store!.embArr, [[r0, r1], [c0, c1], null]),
          fetchRegion(this.store!.scalesArr, [[r0, r1], [c0, c1]]),
        ]);
        if (signal.aborted) return;
        const embBuf = new Int8Array(
          embView.data.buffer, embView.data.byteOffset, embView.data.byteLength,
        ).slice().buffer;
        const scalesBuf = new Uint8Array(
          new Float32Array(scalesView.data.buffer, scalesView.data.byteOffset, scalesView.data.byteLength).buffer,
        ).slice().buffer;

        result = await this.workerPool!.dispatch({
          type: 'render-emb', embRaw: embBuf, scalesRaw: scalesBuf,
          width: w, height: h, nBands: this.store!.meta.nBands, bands: this.opts.bands,
        }, [embBuf, scalesBuf]);
      }

      let canvas: HTMLCanvasElement | null = null;
      let sourceId: string | null = null;
      let layerId: string | null = null;

      if ((result.nValid as number) > 0) {
        canvas = this.rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
        ({ sourceId, layerId } = this.addChunkToMap(ci, cj, canvas));
      }

      this.chunkCache.set(key, {
        ci, cj,
        canvas, sourceId, layerId, isPreview: usePreview,
      });
      this.debug('render', `Chunk (${ci},${cj}): ${(result.nValid as number)} valid px, preview=${usePreview}`);
      this.emit('chunk-loaded', { ci, cj });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.debug('error', `Chunk (${ci},${cj}) failed: ${(err as Error).message}`);
      this.chunkCache.set(key, {
        ci, cj,
        canvas: null, sourceId: null, layerId: null, isPreview: false,
      });
    }
  }

  private async reRenderChunks(): Promise<void> {
    // Re-render embedding tiles from the region buffer with current band selection
    this.recolorAllChunks();
  }

  private addOverlays(): void {
    if (!this.store || !this.map || !this.proj) return;
    this.removeOverlays();
    this.debug('overlay', 'Adding UTM zone + chunk grid overlays');

    // UTM zone boundary
    const zone = this.store.meta.utmZone;
    const isSouth = this.proj.isSouth;
    const lonMin = (zone - 1) * 6 - 180;
    const lonMax = zone * 6 - 180;
    const latMin = isSouth ? -80 : 0;
    const latMax = isSouth ? 0 : 84;

    this.map.addSource('utm-zone', {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]],
        },
      },
    });

    // Chunk grid (skip when zarr-layer handles preview)
    if (!this.opts.globalPreviewUrl) {
      const cs = this.store.meta.chunkShape;
      const s = this.store.meta.shape;
      const nRows = Math.ceil(s[0] / cs[0]);
      const nCols = Math.ceil(s[1] / cs[1]);
      const features: GeoJSON.Feature[] = [];

      for (let ci = 0; ci < nRows; ci++) {
        for (let cj = 0; cj < nCols; cj++) {
          const hasData = this.store.chunkManifest
            ? this.store.chunkManifest.has(`${ci}_${cj}`) : true;
          const corners = this.chunkCorners(ci, cj);
          features.push({
            type: 'Feature',
            properties: { ci, cj, hasData },
            geometry: {
              type: 'Polygon',
              coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
            },
          });
        }
      }

      this.map.addSource('chunk-grid', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
      });

      const gridVis = this.opts.gridVisible ? 'visible' : 'none';

      this.map.addLayer({
        id: 'chunk-grid-lines', type: 'line', source: 'chunk-grid',
        paint: {
          'line-color': ['case', ['get', 'hasData'], '#00e5ff', '#374151'],
          'line-width': ['case', ['get', 'hasData'], 0.5, 0.3],
          'line-opacity': ['case', ['get', 'hasData'], 0.2, 0.1],
        },
        layout: { visibility: gridVis },
      });
    }
    this.map.addLayer({
      id: 'utm-zone-line', type: 'line', source: 'utm-zone',
      paint: { 'line-color': '#39ff14', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [6, 4] },
      layout: { visibility: this.opts.utmBoundaryVisible ? 'visible' : 'none' },
    });
  }

  private removeOverlays(): void {
    const layers = ['chunk-grid-lines', 'utm-zone-line'];
    for (const id of layers) {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map?.getSource('utm-zone')) this.map.removeSource('utm-zone');
    if (this.map?.getSource('chunk-grid')) this.map.removeSource('chunk-grid');
  }

  private addPreviewLayer(): void {
    if (!this.map || !this.opts.globalPreviewUrl) return;

    const previewVar = this.opts.preview === 'pca' ? 'pca_rgb' : 'rgb';

    const layerOpts: Record<string, unknown> = {
        id: `zarr-preview-${Date.now()}`,
        source: this.opts.globalPreviewUrl,
        variable: previewVar,
        selector: { band: [0, 1, 2, 3] },
        clim: [0, 255],
        colormap: ['#000000', '#ffffff'],
        customFrag: `
            float r = band_0 / 255.0;
            float g = band_1 / 255.0;
            float b = band_2 / 255.0;
            float a = band_3 / 255.0;
            fragColor = vec4(r, g, b, a * opacity);
            fragColor.rgb *= fragColor.a;
        `,
        opacity: this.opts.opacity,
        zarrVersion: 3,
        spatialDimensions: { lat: 'lat', lon: 'lon' },
        latIsAscending: false,
    };

    // Provide explicit bounds so zarr-layer doesn't try to load coordinate arrays
    if (this.opts.globalPreviewBounds) {
        layerOpts.bounds = this.opts.globalPreviewBounds;
    }

    layerOpts.onLoadingStateChange = (state: { isLoading: boolean; error?: string }) => {
        if (state.error) {
            this.debug('error', `zarr-layer: ${state.error}`);
        }
    };

    try {
        this.previewLayer = new ZarrLayer(layerOpts as any);
        this.map.addLayer(this.previewLayer as any);
        this.debug('info', `Preview layer added via zarr-layer (${previewVar})`);

        // Remove legacy preview chunk layers — the global preview layer
        // now handles RGB/PCA rendering.  Keep embedding chunks (isPreview=false).
        for (const [key, entry] of this.chunkCache) {
            if (entry.isPreview) {
                this.removeChunkFromMap(key);
            }
        }
    } catch (err) {
        this.debug('error', `Failed to add preview layer: ${(err as Error).message}`);
        this.previewLayer = null;
    }
  }
}
