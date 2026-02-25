import type { Map as MaplibreMap, LngLatBoundsLike } from 'maplibre-gl';
import type {
  ZarrTesseraOptions, StoreMetadata, CachedChunk,
  ChunkBounds, UtmBounds, PreviewMode, ZarrTesseraEvents, DebugLogEntry,
} from './types.js';
import { UtmProjection } from './projection.js';
import { openStore, fetchRegion, type ZarrStore } from './zarr-reader.js';
import { WorkerPool } from './worker-pool.js';

type EventCallback<T> = (data: T) => void;

export class ZarrTesseraSource {
  private opts: Required<ZarrTesseraOptions>;
  private map: MaplibreMap | null = null;
  private store: ZarrStore | null = null;
  private proj: UtmProjection | null = null;
  private workerPool: WorkerPool | null = null;
  private chunkCache = new Map<string, CachedChunk>();
  private currentAbort: AbortController | null = null;
  private autoZoomNext = true;
  private totalLoaded = 0;
  private clickedChunks = new Set<string>();
  private moveHandler: (() => void) | null = null;
  private listeners = new Map<string, Set<EventCallback<unknown>>>();

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
    };
  }

  // --- Public API ---

  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
    this.workerPool = new WorkerPool(
      Math.min(navigator.hardwareConcurrency || 4, 8)
    );

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

      // Fly to store bounds
      this.flyToStoreBounds();

      // Listen for viewport changes
      this.moveHandler = () => this.updateVisibleChunks();
      map.on('moveend', this.moveHandler);

      // Start initial load after fly animation
      setTimeout(() => this.updateVisibleChunks(), 1800);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  remove(): void {
    if (this.moveHandler && this.map) {
      this.map.off('moveend', this.moveHandler);
    }
    this.currentAbort?.abort();
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
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
    for (const [, entry] of this.chunkCache) {
      if (entry.layerId && this.map?.getLayer(entry.layerId)) {
        this.map.setPaintProperty(entry.layerId, 'raster-opacity', opacity);
      }
    }
  }

  setPreview(mode: PreviewMode): void {
    this.opts.preview = mode;
    // Clear cache and reload with new preview mode
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
    this.chunkCache.clear();
    this.updateVisibleChunks();
  }

  setGridVisible(visible: boolean): void {
    this.opts.gridVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['chunk-grid-nodata', 'chunk-grid-data', 'chunk-grid-lines']) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  setUtmBoundaryVisible(visible: boolean): void {
    this.opts.utmBoundaryVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['utm-zone-fill', 'utm-zone-line']) {
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

    // Re-add cached chunk layers that were on the map
    for (const [, entry] of this.chunkCache) {
      if (entry.canvas) {
        // Remove stale refs
        entry.sourceId = null;
        entry.layerId = null;
        const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
        entry.sourceId = ids.sourceId;
        entry.layerId = ids.layerId;
      }
    }
    this.debug('overlay', `Re-added ${this.chunkCache.size} cached chunks`);
  }

  /** Load full embedding data for a specific chunk (for band exploration). */
  async loadFullChunk(ci: number, cj: number): Promise<void> {
    if (!this.store || !this.workerPool || !this.map) return;
    const key = this.chunkKey(ci, cj);
    this.clickedChunks.add(key);

    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const h = r1 - r0;
    const w = c1 - c0;

    const [embView, scalesView] = await Promise.all([
      fetchRegion(this.store.embArr, [[r0, r1], [c0, c1], null]),
      fetchRegion(this.store.scalesArr, [[r0, r1], [c0, c1]]),
    ]);

    const embBuf = new Int8Array(
      embView.data.buffer, embView.data.byteOffset, embView.data.byteLength,
    ).slice().buffer;
    const scalesBuf = new Uint8Array(
      new Float32Array(scalesView.data.buffer, scalesView.data.byteOffset, scalesView.data.byteLength).buffer,
    ).slice().buffer;

    const result = await this.workerPool.dispatch({
      type: 'render-emb', embRaw: embBuf, scalesRaw: scalesBuf,
      width: w, height: h, nBands: this.store.meta.nBands, bands: this.opts.bands,
    }, [embBuf, scalesBuf]);

    const entry = this.chunkCache.get(key);
    if (entry?.sourceId) this.removeChunkFromMap(key);

    let canvas: HTMLCanvasElement | null = null;
    let sourceId: string | null = null;
    let layerId: string | null = null;

    if ((result.nValid as number) > 0) {
      canvas = this.rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
      ({ sourceId, layerId } = this.addChunkToMap(ci, cj, canvas));
    }

    this.chunkCache.set(key, {
      ci, cj,
      embRaw: new Uint8Array(result.embRaw as ArrayBuffer),
      scalesRaw: new Uint8Array(result.scalesRaw as ArrayBuffer),
      canvas, sourceId, layerId, isPreview: false,
    });
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

    // Keep overlays on top
    if (this.map!.getLayer('chunk-grid-lines')) this.map!.moveLayer('chunk-grid-lines');
    if (this.map!.getLayer('utm-zone-line')) this.map!.moveLayer('utm-zone-line');

    return { sourceId, layerId };
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

      if (usePreview && !this.clickedChunks.has(key)) {
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

        if (this.autoZoomNext) {
          this.autoZoomNext = false;
          const corners = this.chunkCorners(ci, cj);
          const lngs = corners.map(c => c[0]);
          const lats = corners.map(c => c[1]);
          this.map!.fitBounds([
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ] as LngLatBoundsLike, { padding: 40, duration: 1000 });
        }
      }

      this.chunkCache.set(key, {
        ci, cj,
        embRaw: (result.embRaw as ArrayBuffer) ? new Uint8Array(result.embRaw as ArrayBuffer) : null,
        scalesRaw: (result.scalesRaw as ArrayBuffer) ? new Uint8Array(result.scalesRaw as ArrayBuffer) : null,
        canvas, sourceId, layerId, isPreview: usePreview,
      });
      this.totalLoaded++;
      this.debug('render', `Chunk (${ci},${cj}): ${(result.nValid as number)} valid px, preview=${usePreview}`);
      this.emit('chunk-loaded', { ci, cj });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.debug('error', `Chunk (${ci},${cj}) failed: ${(err as Error).message}`);
      console.warn(`Failed to load chunk (${ci},${cj}):`, err);
      this.chunkCache.set(key, {
        ci, cj, embRaw: null, scalesRaw: null,
        canvas: null, sourceId: null, layerId: null, isPreview: false,
      });
    }
  }

  private async reRenderChunks(): Promise<void> {
    if (!this.workerPool || !this.store) return;
    const tasks: Promise<void>[] = [];

    for (const [key, entry] of this.chunkCache) {
      if (!entry.embRaw) continue;
      const wasOnMap = !!entry.sourceId;
      if (wasOnMap) this.removeChunkFromMap(key);

      const { r0, r1, c0, c1 } = this.chunkPixelBounds(entry.ci, entry.cj);
      const h = r1 - r0;
      const w = c1 - c0;
      const embCopy = entry.embRaw.slice().buffer;
      const scalesCopy = entry.scalesRaw!.slice().buffer;

      const task = this.workerPool.dispatch({
        type: 'render-emb', embRaw: embCopy, scalesRaw: scalesCopy,
        width: w, height: h, nBands: this.store.meta.nBands, bands: this.opts.bands,
      }, [embCopy, scalesCopy]).then((result) => {
        entry.embRaw = new Uint8Array(result.embRaw as ArrayBuffer);
        entry.scalesRaw = new Uint8Array(result.scalesRaw as ArrayBuffer);
        if ((result.nValid as number) > 0) {
          entry.canvas = this.rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
          if (wasOnMap) {
            const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
            entry.sourceId = ids.sourceId;
            entry.layerId = ids.layerId;
          }
        } else {
          entry.canvas = null;
        }
      });
      tasks.push(task);
    }
    await Promise.all(tasks);
  }

  private flyToStoreBounds(): void {
    if (!this.store || !this.map || !this.proj) return;
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const w = this.store.meta.shape[1], h = this.store.meta.shape[0];

    const corners = [
      this.proj.inverse(originE, originN),
      this.proj.inverse(originE + w * px, originN),
      this.proj.inverse(originE + w * px, originN - h * px),
      this.proj.inverse(originE, originN - h * px),
    ];
    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    this.map.fitBounds([
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ] as LngLatBoundsLike, { padding: 40, duration: 1500 });
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

    this.map.addLayer({
      id: 'utm-zone-fill', type: 'fill', source: 'utm-zone',
      paint: { 'fill-color': '#39ff14', 'fill-opacity': 0.03 },
      layout: { visibility: this.opts.utmBoundaryVisible ? 'visible' : 'none' },
    });

    // Chunk grid
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
      id: 'chunk-grid-nodata', type: 'fill', source: 'chunk-grid',
      filter: ['==', ['get', 'hasData'], false],
      paint: { 'fill-color': '#374151', 'fill-opacity': 0.15 },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'chunk-grid-data', type: 'fill', source: 'chunk-grid',
      filter: ['==', ['get', 'hasData'], true],
      paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.04 },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'chunk-grid-lines', type: 'line', source: 'chunk-grid',
      paint: {
        'line-color': ['case', ['get', 'hasData'], '#00e5ff', '#374151'],
        'line-width': ['case', ['get', 'hasData'], 1, 0.5],
        'line-opacity': ['case', ['get', 'hasData'], 0.4, 0.2],
      },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'utm-zone-line', type: 'line', source: 'utm-zone',
      paint: { 'line-color': '#39ff14', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [6, 4] },
      layout: { visibility: this.opts.utmBoundaryVisible ? 'visible' : 'none' },
    });
  }

  private removeOverlays(): void {
    const layers = ['chunk-grid-nodata', 'chunk-grid-data', 'chunk-grid-lines', 'utm-zone-fill', 'utm-zone-line'];
    for (const id of layers) {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map?.getSource('utm-zone')) this.map.removeSource('utm-zone');
    if (this.map?.getSource('chunk-grid')) this.map.removeSource('chunk-grid');
  }
}
