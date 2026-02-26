import type { Map as MaplibreMap } from 'maplibre-gl';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import type {
  ZarrTesseraOptions, StoreMetadata, CachedChunk,
  ChunkBounds, UtmBounds, PreviewMode, ZarrTesseraEvents, DebugLogEntry,
  TileEmbeddings, EmbeddingAt,
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

  private readonly instanceId = Math.random().toString(36).slice(2, 8);
  private protocolRegistered = false;

  private totalLoaded = 0;
  private clickedChunks = new Set<string>();
  /** Cache of raw 128-d embeddings for tiles loaded via double-click. */
  public embeddingCache = new Map<string, TileEmbeddings>();
  /** Old chunkCache — only used for embedding (full-res, double-clicked) tiles now. */
  private chunkCache = new Map<string, CachedChunk>();
  private listeners = new Map<string, Set<EventCallback<unknown>>>();
  /** Tracks active loading animations per chunk key → animation frame ID. */
  private loadingAnimations = new Map<string, number>();
  /** Chunks currently being fetched (prevents double-click re-triggering). */
  private loadingChunks = new Set<string>();
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
      if (this.store.meta.hasRgbMercator || this.store.meta.hasPcaMercator) {
        const zr = this.store.meta.mercatorZoomRange;
        this.debug('info', `Mercator: zoom ${zr ? zr[0] + '-' + zr[1] : 'none'}, rgb=${this.store.meta.hasRgbMercator} (${this.store.rgbMercatorArrs.size} arrs), pca=${this.store.meta.hasPcaMercator} (${this.store.pcaMercatorArrs.size} arrs)`);
      }
      this.emit('metadata-loaded', this.store.meta);

      // Register custom protocol for preview tiles
      const protocolName = `zarr-${this.instanceId}`;
      addProtocol(protocolName, this.handleTileRequest.bind(this));
      this.protocolRegistered = true;
      this.debug('info', `Protocol registered: ${protocolName}`);

      // Compute zoom range
      const { minzoom, maxzoom } = this.computeZoomRange();

      // Add raster tile source + layer
      map.addSource('zarr-preview', {
        type: 'raster',
        tiles: [`${protocolName}://{z}/{x}/{y}`],
        tileSize: 256,
        minzoom,
        maxzoom,
      });
      map.addLayer({
        id: 'zarr-preview-layer',
        type: 'raster',
        source: 'zarr-preview',
        paint: {
          'raster-opacity': this.opts.opacity,
          'raster-fade-duration': 300,
        },
      });

      // Add overlays
      this.addOverlays();

      // Double-click to load full embeddings for a tile
      map.on('dblclick', (e) => {
        e.preventDefault();
        const chunk = this.getChunkAtLngLat(e.lngLat.lng, e.lngLat.lat);
        if (!chunk) return;
        const key = this.chunkKey(chunk.ci, chunk.cj);
        if (this.embeddingCache.has(key) || this.loadingChunks.has(key)) {
          this.debug('info', `Chunk (${chunk.ci},${chunk.cj}) already ${this.loadingChunks.has(key) ? 'loading' : 'loaded'}`);
          return;
        }
        this.debug('fetch', `Double-click: loading embeddings for chunk (${chunk.ci},${chunk.cj})`);
        this.loadFullChunk(chunk.ci, chunk.cj);
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  remove(): void {
    // Remove raster tile layer + source
    if (this.map) {
      if (this.map.getLayer('zarr-preview-layer')) this.map.removeLayer('zarr-preview-layer');
      if (this.map.getSource('zarr-preview')) this.map.removeSource('zarr-preview');
    }

    // Remove protocol
    if (this.protocolRegistered) {
      removeProtocol(`zarr-${this.instanceId}`);
      this.protocolRegistered = false;
    }

    // Clean up animations
    for (const [, frameId] of this.loadingAnimations) cancelAnimationFrame(frameId);
    this.loadingAnimations.clear();

    // Clean up embedding chunk layers
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);

    this.embeddingCache.clear();
    this.classificationMaps.clear();
    this.loadingChunks.clear();
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
    // Re-render embedding tiles (double-clicked full-res) with new bands
    this.reRenderEmbeddingChunks();
  }

  setOpacity(opacity: number): void {
    this.opts.opacity = opacity;
    if (!this.map) return;
    // Update preview raster layer
    if (this.map.getLayer('zarr-preview-layer')) {
      this.map.setPaintProperty('zarr-preview-layer', 'raster-opacity', opacity);
    }
    // Update embedding chunk layers
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
    this.reloadPreviewSource();
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

    // Re-add the raster tile source+layer if missing
    if (!this.map.getSource('zarr-preview')) {
      const protocolName = `zarr-${this.instanceId}`;
      const { minzoom, maxzoom } = this.computeZoomRange();
      this.map.addSource('zarr-preview', {
        type: 'raster',
        tiles: [`${protocolName}://{z}/{x}/{y}`],
        tileSize: 256,
        minzoom,
        maxzoom,
      });
    }
    if (!this.map.getLayer('zarr-preview-layer')) {
      this.map.addLayer({
        id: 'zarr-preview-layer',
        type: 'raster',
        source: 'zarr-preview',
        paint: {
          'raster-opacity': this.opts.opacity,
          'raster-fade-duration': 300,
        },
      });
    }

    // Re-add overlays (removes first if present)
    this.addOverlays();

    // Re-add cached embedding chunk layers that were on the map
    let reAdded = 0;
    for (const [, entry] of this.chunkCache) {
      if (entry.canvas) {
        entry.sourceId = null;
        entry.layerId = null;
        const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
        entry.sourceId = ids.sourceId;
        entry.layerId = ids.layerId;
        reAdded++;
      }
    }
    this.debug('overlay', `Re-added ${reAdded} cached embedding chunks`);
  }

  /** Load full embedding data for a specific chunk (for band exploration).
   *  Fetches all data in one go, then progressively renders row strips
   *  with a diffusion edge effect. Preview tile stays visible underneath. */
  async loadFullChunk(ci: number, cj: number): Promise<void> {
    if (!this.store || !this.map) return;
    const key = this.chunkKey(ci, cj);
    if (this.loadingChunks.has(key)) return;
    this.loadingChunks.add(key);
    this.clickedChunks.add(key);

    // Stop any scan animation but keep the preview tile underneath
    this.stopLoadingAnimation(ci, cj);

    // Show loading animation immediately while network fetch runs
    this.startLoadingAnimation(ci, cj);

    try {
      const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
      const h = r1 - r0;
      const w = c1 - c0;
      const nBands = this.store.meta.nBands;
      const expectedBytes = w * h * nBands;

      this.debug('fetch', `Loading embeddings (${ci},${cj}): ${w}x${h}x${nBands} = ${(expectedBytes / 1024).toFixed(0)} KB`);
      this.emit('embedding-progress', { ci, cj, stage: 'fetching', bytes: expectedBytes });

      // Single fetch — zarrita caches internal chunks so splitting doesn't help
      const [embView, scalesView] = await Promise.all([
        fetchRegion(this.store.embArr, [[r0, r1], [c0, c1], null]),
        fetchRegion(this.store.scalesArr, [[r0, r1], [c0, c1]]),
      ]);

      // Copy into independent buffers
      const embInt8 = new Int8Array(embView.data.buffer, embView.data.byteOffset,
        embView.data.byteLength).slice();
      const scalesCopy = new Uint8Array(scalesView.data.buffer, scalesView.data.byteOffset,
        scalesView.data.byteLength).slice();
      const scalesF32 = new Float32Array(scalesCopy.buffer);

      this.debug('fetch', `Embeddings fetched (${ci},${cj}), progressive render...`);
      this.emit('embedding-progress', { ci, cj, stage: 'rendering', bytes: expectedBytes });

      // Percentile-based contrast stretch for vivid colours
      const [bR, bG, bB] = this.opts.bands;
      const valsR: number[] = [], valsG: number[] = [], valsB: number[] = [];
      let totalValid = 0;
      for (let i = 0; i < w * h; i++) {
        if (isNaN(scalesF32[i]) || scalesF32[i] === 0) continue;
        const base = i * nBands;
        valsR.push(embInt8[base + bR]);
        valsG.push(embInt8[base + bG]);
        valsB.push(embInt8[base + bB]);
        totalValid++;
      }
      const perc = (arr: number[], p: number) => {
        arr.sort((a, b) => a - b);
        return arr[Math.floor(p * (arr.length - 1))];
      };
      const loR = totalValid > 0 ? perc(valsR, 0.02) : 0, hiR = totalValid > 0 ? perc(valsR, 0.98) : 1;
      const loG = totalValid > 0 ? perc(valsG, 0.02) : 0, hiG = totalValid > 0 ? perc(valsG, 0.98) : 1;
      const loB = totalValid > 0 ? perc(valsB, 0.02) : 0, hiB = totalValid > 0 ? perc(valsB, 0.98) : 1;
      const rangeR = hiR - loR || 1, rangeG = hiG - loG || 1, rangeB = hiB - loB || 1;
      const SAT = 1.4, GAMMA = 0.85;
      const renderPixel = (base: number): [number, number, number] => {
        let nr = (embInt8[base + bR] - loR) / rangeR;
        let ng = (embInt8[base + bG] - loG) / rangeG;
        let nb = (embInt8[base + bB] - loB) / rangeB;
        nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
        ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
        nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;
        const lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        nr = lum + (nr - lum) * SAT; ng = lum + (ng - lum) * SAT; nb = lum + (nb - lum) * SAT;
        nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
        ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
        nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;
        return [
          Math.round(Math.pow(nr, GAMMA) * 255),
          Math.round(Math.pow(ng, GAMMA) * 255),
          Math.round(Math.pow(nb, GAMMA) * 255),
        ];
      };

      // Stop loading animation, set up progressive overlay
      this.stopLoadingAnimation(ci, cj);

      const corners = this.chunkCorners(ci, cj);
      const overlaySourceId = `zarr-prog-src-${key}`;
      const overlayLayerId = `zarr-prog-lyr-${key}`;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;

      if (this.map.getLayer(overlayLayerId)) this.map.removeLayer(overlayLayerId);
      if (this.map.getSource(overlaySourceId)) this.map.removeSource(overlaySourceId);
      this.map.addSource(overlaySourceId, {
        type: 'image', url: canvas.toDataURL('image/png'), coordinates: corners,
      });
      this.map.addLayer({
        id: overlayLayerId, type: 'raster', source: overlaySourceId,
        paint: { 'raster-opacity': this.opts.opacity, 'raster-fade-duration': 0 },
      });
      this.raiseOverlayLayers();

      // Progressive render from in-memory data, yielding each frame
      const STRIP_ROWS = 16;
      const nStrips = Math.ceil(h / STRIP_ROWS);
      const img = ctx.createImageData(w, h);

      const renderStrip = (strip: number) => {
        const rowsLoaded = Math.min((strip + 1) * STRIP_ROWS, h);
        const prevRows = strip * STRIP_ROWS;

        if (totalValid > 0) {
          // Render newly loaded rows
          for (let y = prevRows; y < rowsLoaded; y++) {
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              const pi = i * 4;
              const scale = scalesF32[i];
              if (isNaN(scale) || scale === 0) { img.data[pi + 3] = 0; continue; }
              const [r, g, b] = renderPixel(i * nBands);
              img.data[pi] = r; img.data[pi + 1] = g; img.data[pi + 2] = b; img.data[pi + 3] = 255;
            }
          }

          // Clear diffusion from previous frame
          for (let y = rowsLoaded; y < h; y++) {
            for (let x = 0; x < w; x++) {
              img.data[(y * w + x) * 4 + 3] = 0;
            }
          }

          // Diffusion edge: dissolve noise below the render frontier
          if (rowsLoaded < h) {
            const edgeRows = Math.min(48, h - rowsLoaded);
            for (let dy = 0; dy < edgeRows; dy++) {
              const y = rowsLoaded + dy;
              const prob = Math.pow(1 - dy / edgeRows, 3);
              for (let x = 0; x < w; x++) {
                const hash = ((x * 2654435761) ^ (y * 2246822519) ^ (strip * 13)) >>> 0;
                if ((hash % 1000) / 1000 < prob) {
                  const pi = (y * w + x) * 4;
                  const srcX = Math.min(Math.max(0, x + ((hash >> 8) % 5) - 2), w - 1);
                  const srcI = (rowsLoaded - 1) * w + srcX;
                  if (!isNaN(scalesF32[srcI]) && scalesF32[srcI] !== 0) {
                    const [r, g, b] = renderPixel(srcI * nBands);
                    img.data[pi] = r; img.data[pi + 1] = g; img.data[pi + 2] = b;
                    img.data[pi + 3] = Math.round(255 * prob * prob);
                  }
                }
              }
            }
          }
        }

        ctx.putImageData(img, 0, 0);
        const src = this.map!.getSource(overlaySourceId) as
          { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
        src?.updateImage?.({ url: canvas.toDataURL('image/png'), coordinates: corners });
      };

      // Animate strips via requestAnimationFrame for smooth visual streaming
      await new Promise<void>((resolve) => {
        let strip = 0;
        const step = () => {
          if (!this.map || strip >= nStrips) { resolve(); return; }
          renderStrip(strip);
          strip++;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

      this.debug('render', `Embedding render (${ci},${cj}): ${totalValid} valid pixels`);

      // Remove progressive overlay
      if (this.map!.getLayer(overlayLayerId)) this.map!.removeLayer(overlayLayerId);
      if (this.map!.getSource(overlaySourceId)) this.map!.removeSource(overlaySourceId);

      // Remove old embedding layer if present and replace with final
      const existing = this.chunkCache.get(key);
      if (existing?.sourceId) this.removeChunkFromMap(key);

      let sourceId: string | null = null;
      let layerId: string | null = null;

      if (totalValid > 0) {
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const pi = i * 4;
          if (isNaN(scalesF32[i]) || scalesF32[i] === 0) { rgba[pi + 3] = 0; continue; }
          const [r, g, b] = renderPixel(i * nBands);
          rgba[pi] = r; rgba[pi + 1] = g; rgba[pi + 2] = b; rgba[pi + 3] = 255;
        }
        const finalCanvas = this.rgbaToCanvas(rgba.buffer, w, h);
        ({ sourceId, layerId } = this.addChunkToMap(ci, cj, finalCanvas));
      }

      this.chunkCache.set(key, {
        ci, cj,
        embRaw: new Uint8Array(embInt8.buffer),
        scalesRaw: new Uint8Array(scalesF32.buffer),
        canvas: null, sourceId, layerId,
      });

      // Store typed views for classification
      this.embeddingCache.set(key, {
        ci, cj,
        emb: embInt8,
        scales: scalesF32,
        width: w, height: h,
        nBands,
      });
      this.debug('info', `Embeddings ready (${ci},${cj}): ${(embInt8.byteLength / 1024).toFixed(0)} KB cached`);
      this.emit('embedding-progress', { ci, cj, stage: 'done', bytes: embInt8.byteLength });
      this.emit('embeddings-loaded', { ci, cj });

      // Update embedding highlight border on map
      this.updateEmbeddingHighlights();
    } catch (err) {
      this.stopLoadingAnimation(ci, cj);
      this.debug('error', `Embedding load (${ci},${cj}) failed: ${(err as Error).message}`);
      this.emit('embedding-progress', { ci, cj, stage: 'done', bytes: 0 });
      console.error(`loadFullChunk(${ci},${cj}) failed:`, err);
    } finally {
      this.loadingChunks.delete(key);
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

  /** Extract the 128-d embedding vector at a map coordinate.
   *  Returns null if the chunk's embeddings haven't been loaded. */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null {
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
    const tile = this.embeddingCache.get(key);
    if (!tile) return null;

    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= tile.height || col < 0 || col >= tile.width) return null;

    // Check scale validity
    const pixelIdx = row * tile.width + col;
    const scale = tile.scales[pixelIdx];
    if (!scale || isNaN(scale)) return null;

    // Extract embedding vector
    const nBands = tile.nBands;
    const offset = pixelIdx * nBands;
    const embedding = new Float32Array(nBands);
    for (let b = 0; b < nBands; b++) {
      embedding[b] = tile.emb[offset + b];
    }

    return { embedding, ci, cj, row, col };
  }

  /** Extract embeddings for all valid pixels in a kernel around a map coordinate. */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): EmbeddingAt[] {
    if (!this.store || !this.proj) return [];
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

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
        const key = this.chunkKey(ci, cj);
        const tile = this.embeddingCache.get(key);
        if (!tile) continue;

        const row = gr - ci * cs[0];
        const col = gc - cj * cs[1];
        const pixelIdx = row * tile.width + col;
        const scale = tile.scales[pixelIdx];
        if (!scale || isNaN(scale)) continue;

        const nBands = tile.nBands;
        const offset = pixelIdx * nBands;
        const embedding = new Float32Array(nBands);
        for (let b = 0; b < nBands; b++) {
          embedding[b] = tile.emb[offset + b];
        }
        results.push({ embedding, ci, cj, row, col });
      }
    }
    return results;
  }

  /** Compute the bounding box (in WGS84) of all loaded embedding tiles.
   *  Returns [south, west, north, east] or null if no embeddings loaded. */
  embeddingBoundsLngLat(): [number, number, number, number] | null {
    if (this.embeddingCache.size === 0) return null;
    let south = 90, west = 180, north = -90, east = -180;
    for (const [, tile] of this.embeddingCache) {
      const corners = this.chunkCorners(tile.ci, tile.cj);
      for (const [lng, lat] of corners) {
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lng < west) west = lng;
        if (lng > east) east = lng;
      }
    }
    return [south, west, north, east];
  }

  /** Add or update a classification RGBA canvas as a map layer for a chunk.
   *  Called repeatedly during incremental classification — updates in-place
   *  if the source already exists. */
  addClassificationOverlay(ci: number, cj: number, canvas: HTMLCanvasElement): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);
    const sourceId = `zarr-class-src-${key}`;
    const layerId = `zarr-class-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const dataUrl = canvas.toDataURL('image/png');

    const existingSource = this.map.getSource(sourceId) as
      { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;

    if (existingSource?.updateImage) {
      // Update existing image source in-place (fast path for incremental updates)
      try {
        existingSource.updateImage({ url: dataUrl, coordinates: corners });
      } catch {
        // Source may have been removed (AbortError) — ignore
      }
    } else {
      // First time — create source and layer
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

      this.map.addSource(sourceId, {
        type: 'image', url: dataUrl, coordinates: corners,
      });
      this.map.addLayer({
        id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
      });

      this.raiseOverlayLayers();
      this.debug('overlay', `Classification overlay added for chunk (${ci},${cj})`);
    }
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
    if (!this.map || !this.proj) return;
    const sourceId = 'emb-highlight';
    const layerId = 'emb-highlight-line';

    const features: GeoJSON.Feature[] = [];
    for (const [, tile] of this.embeddingCache) {
      const corners = this.chunkCorners(tile.ci, tile.cj);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
        },
      });
    }

    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };

    if (this.map.getSource(sourceId)) {
      (this.map.getSource(sourceId) as unknown as { setData(d: GeoJSON.FeatureCollection): void }).setData(data);
    } else {
      this.map.addSource(sourceId, { type: 'geojson', data });
      this.map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': '#f59e0b',
          'line-width': 2.5,
          'line-opacity': 0.9,
          'line-dasharray': [3, 2],
        },
      });
    }

    this.raiseOverlayLayers();
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

  private chunkKey(ci: number, cj: number): string {
    return `${ci}_${cj}`;
  }

  // --- addProtocol tile handler ---

  /** Handle a tile request from MapLibre's raster source.
   *  URL format: zarr-{instanceId}://{z}/{x}/{y}[?t=timestamp]
   *  Each tile maps directly to a 256x256 zarr chunk in the mercator pyramid. */
  private async handleTileRequest(
    params: { url: string },
    abortController: AbortController,
  ): Promise<{ data: ArrayBuffer }> {
    const transparent = () => this.encodeRgbaToPng(new Uint8Array(256 * 256 * 4), 256, 256);

    if (!this.store || !this.proj) throw new Error('Store not initialized');

    try {
      // Parse z/x/y from URL
      const urlPath = params.url.split('://')[1]?.split('?')[0];
      if (!urlPath) return { data: await transparent() };
      const parts = urlPath.split('/');
      const z = parseInt(parts[0], 10);
      const x = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);

      // Pick the mercator array for this zoom level
      const mode = this.opts.preview;
      const mercArrs = mode === 'pca'
        ? this.store.pcaMercatorArrs
        : this.store.rgbMercatorArrs;

      // Find best available zoom level (exact or nearest coarser)
      const zoomRange = this.store.meta.mercatorZoomRange;
      if (!zoomRange) return { data: await transparent() };

      let arr: ReturnType<typeof mercArrs.get>;
      let useZ = Math.min(z, zoomRange[1]);
      while (useZ >= zoomRange[0]) {
        arr = mercArrs.get(useZ);
        if (arr) break;
        useZ--;
      }
      if (!arr!) return { data: await transparent() };

      const arrShape = arr.shape as number[];
      const arrH = arrShape[0];
      const arrW = arrShape[1];

      // If tile zoom > array zoom, scale tile coords
      const zoomDiff = z - useZ;
      const scaledX = Math.floor(x / Math.pow(2, zoomDiff));
      const scaledY = Math.floor(y / Math.pow(2, zoomDiff));

      // Read tile offset from array attrs if available,
      // otherwise assume array starts at global tile (0,0).
      const arrAttrs = arr.attrs as Record<string, unknown>;
      const tileOffsetX = (arrAttrs.tile_offset_x as number) ?? 0;
      const tileOffsetY = (arrAttrs.tile_offset_y as number) ?? 0;

      const nTilesX = Math.ceil(arrW / 256);
      const nTilesY = Math.ceil(arrH / 256);
      const ax = scaledX - tileOffsetX;
      const ay = scaledY - tileOffsetY;

      if (ax < 0 || ay < 0 || ax >= nTilesX || ay >= nTilesY) {
        return { data: await transparent() };
      }

      // Fetch the 256x256 chunk
      const r0 = ay * 256;
      const r1 = Math.min(r0 + 256, arrH);
      const c0 = ax * 256;
      const c1 = Math.min(c0 + 256, arrW);

      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const view = await fetchRegion(arr, [[r0, r1], [c0, c1], null]);

      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // Build RGBA tile
      const tileW = 256, tileH = 256;
      const rgba = new Uint8Array(tileW * tileH * 4);
      const src = new Uint8Array(view.data.buffer, view.data.byteOffset, view.data.byteLength);
      const srcH = r1 - r0;
      const srcW = c1 - c0;
      const nCh = view.shape.length >= 3 ? view.shape[2] : 3;

      let painted = 0;
      for (let row = 0; row < srcH; row++) {
        for (let col = 0; col < srcW; col++) {
          const si = (row * srcW + col) * nCh;
          const di = (row * tileW + col) * 4;
          rgba[di]     = src[si];
          rgba[di + 1] = src[si + 1] ?? 0;
          rgba[di + 2] = src[si + 2] ?? 0;
          rgba[di + 3] = (nCh >= 4) ? src[si + 3] : 255;
          if (src[si] || src[si + 1] || src[si + 2]) painted++;
        }
      }

      if (painted === 0) return { data: await transparent() };
      return { data: await this.encodeRgbaToPng(rgba, tileW, tileH) };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      this.debug('error', `Tile render failed: ${(err as Error).message}`);
      return { data: await transparent() };
    }
  }

  /** Encode raw RGBA pixels to PNG ArrayBuffer via OffscreenCanvas. */
  private async encodeRgbaToPng(rgba: Uint8Array, w: number, h: number): Promise<ArrayBuffer> {
    const clamped = new Uint8ClampedArray(w * h * 4);
    clamped.set(rgba);
    const imageData = new ImageData(clamped, w, h);
    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);
    const blob = await offscreen.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  }

  /** Compute zoom range from the mercator pyramid metadata. */
  private computeZoomRange(): { minzoom: number; maxzoom: number } {
    if (!this.store?.meta.mercatorZoomRange) return { minzoom: 0, maxzoom: 18 };
    const [minzoom, maxzoom] = this.store.meta.mercatorZoomRange;
    // Allow MapLibre to overzoom 2 levels beyond stored data
    return { minzoom, maxzoom: Math.min(22, maxzoom + 2) };
  }

  /** Force MapLibre to re-request all preview tiles (e.g. after preview mode change). */
  private reloadPreviewSource(): void {
    if (!this.map) return;
    const src = this.map.getSource('zarr-preview') as
      { setTiles?: (tiles: string[]) => void } | undefined;
    if (src?.setTiles) {
      const protocolName = `zarr-${this.instanceId}`;
      src.setTiles([`${protocolName}://{z}/{x}/{y}?t=${Date.now()}`]);
    }
  }

  /** Get shape/chunkShape/transform metadata (level 0 / full-res). */
  private pyramidMeta(): {
    shape: [number, number, number];
    chunkShape: [number, number, number];
    transform: [number, number, number, number, number, number];
  } {
    return {
      shape: this.store!.meta.shape,
      chunkShape: this.store!.meta.chunkShape,
      transform: this.store!.meta.transform,
    };
  }

  private chunkPixelBounds(ci: number, cj: number): ChunkBounds {
    const pm = this.pyramidMeta();
    const s = pm.shape;
    const cs = pm.chunkShape;
    return {
      r0: ci * cs[0],
      r1: Math.min(ci * cs[0] + cs[0], s[0]),
      c0: cj * cs[1],
      c1: Math.min(cj * cs[1] + cs[1], s[1]),
    };
  }

  private chunkUtmBounds(ci: number, cj: number): UtmBounds {
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const t = this.pyramidMeta().transform;
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

  /** Add an embedding chunk to the map as an image source (for double-clicked tiles). */
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

    // Create the scan canvas
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const renderFrame = (canvas: HTMLCanvasElement, t: number) => {
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);

      // Sweeping scanline band — cyan glow moving top-to-bottom
      const cycle = 3000; // ms per full sweep
      const phase = (t % cycle) / cycle;
      const scanY = phase * h;
      const bandHeight = h * 0.15;

      // Draw the scan band with gaussian-ish falloff
      for (let dy = -bandHeight; dy <= bandHeight; dy++) {
        const y = Math.round(scanY + dy);
        if (y < 0 || y >= h) continue;
        const intensity = Math.exp(-(dy * dy) / (2 * (bandHeight * 0.3) ** 2));
        ctx.fillStyle = `rgba(0, 229, 255, ${0.35 * intensity})`;
        ctx.fillRect(0, y, w, 1);
      }

      // Subtle overall pulse
      const pulse = 0.04 + 0.03 * Math.sin(t / 800);
      ctx.fillStyle = `rgba(0, 229, 255, ${pulse})`;
      ctx.fillRect(0, 0, w, h);

      // Horizontal scan lines for texture (every 4px)
      ctx.fillStyle = 'rgba(0, 229, 255, 0.03)';
      for (let y = 0; y < h; y += 4) {
        ctx.fillRect(0, y, w, 1);
      }
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

    // Animation loop
    const animate = (t: number) => {
      if (!this.map || !this.map.getSource(sourceId)) return;
      try {
        renderFrame(canvas, t);
        const url = canvas.toDataURL('image/png');
        const src = this.map.getSource(sourceId) as
          { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
        src?.updateImage?.({ url, coordinates: corners });
      } catch { return; /* source removed */ }
      this.loadingAnimations.set(key, requestAnimationFrame(animate));
    };
    this.loadingAnimations.set(key, requestAnimationFrame(animate));
  }

  /** Stop and remove loading animation for a tile. */
  private stopLoadingAnimation(ci: number, cj: number): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);
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
   *  Order (bottom→top): raster tiles, embedding chunks, loading anim, classification, emb-highlight, grid lines, UTM */
  private raiseOverlayLayers(): void {
    const style = this.map!.getStyle();
    if (!style?.layers) return;
    // Loading animation overlays above chunk data
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-load-lyr-')) {
        this.map!.moveLayer(layer.id);
      }
    }
    // Classification overlays above loading
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-class-lyr-')) {
        this.map!.moveLayer(layer.id);
      }
    }
    // Highlight, grid lines, UTM on top
    if (this.map!.getLayer('emb-highlight-line')) this.map!.moveLayer('emb-highlight-line');
    if (this.map!.getLayer('chunk-grid-lines')) this.map!.moveLayer('chunk-grid-lines');
    if (this.map!.getLayer('utm-zone-line')) this.map!.moveLayer('utm-zone-line');
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

  /** Re-render embedding (double-clicked) chunks with new band selection. */
  private async reRenderEmbeddingChunks(): Promise<void> {
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
        enhance: true,
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

    // Chunk grid — always show level-0 (full-res) grid (that's what matters for double-click embeddings)
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const nRows = Math.ceil(s[0] / cs[0]);
    const nCols = Math.ceil(s[1] / cs[1]);
    const gridFeatures: GeoJSON.Feature[] = [];

    for (let ci = 0; ci < nRows; ci++) {
      for (let cj = 0; cj < nCols; cj++) {
        const corners = this.chunkCorners(ci, cj);
        gridFeatures.push({
          type: 'Feature',
          properties: { ci, cj },
          geometry: {
            type: 'Polygon',
            coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
          },
        });
      }
    }

    this.map.addSource('chunk-grid', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: gridFeatures },
    });

    const gridVis = this.opts.gridVisible ? 'visible' : 'none';

    this.map.addLayer({
      id: 'chunk-grid-lines', type: 'line', source: 'chunk-grid',
      paint: {
        'line-color': '#00e5ff',
        'line-width': 1,
        'line-opacity': 0.3,
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
    const layers = ['chunk-grid-lines', 'utm-zone-line', 'emb-highlight-line'];
    for (const id of layers) {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map?.getSource('utm-zone')) this.map.removeSource('utm-zone');
    if (this.map?.getSource('chunk-grid')) this.map.removeSource('chunk-grid');
    if (this.map?.getSource('emb-highlight')) this.map.removeSource('emb-highlight');
  }
}
