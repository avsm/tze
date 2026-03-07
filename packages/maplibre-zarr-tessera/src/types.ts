export interface ZarrTesseraOptions {
  url: string;
  bands?: [number, number, number];
  opacity?: number;
  preview?: 'rgb' | 'pca' | 'bands';
  maxCached?: number;
  maxLoadPerUpdate?: number;
  concurrency?: number;
  /** URL for the global EPSG:4326 preview store (served via zarr:// protocol) */
  globalPreviewUrl?: string;
  /** Explicit bounds [west, south, east, north] in EPSG:4326 for the global preview */
  globalPreviewBounds?: [number, number, number, number];
}

export interface StoreMetadata {
  url: string;
  utmZone: number;
  epsg: number;
  transform: [number, number, number, number, number, number];
  shape: [number, number, number];
  chunkShape: [number, number, number];
  nBands: number;
  hasRgb: boolean;
  hasPca: boolean;
  pcaExplainedVariance?: number[];
}

export interface ChunkBounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface UtmBounds {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

export interface CachedChunk {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement | null;
  sourceId: string | null;
  layerId: string | null;
  isPreview: boolean;
}

export type PreviewMode = 'rgb' | 'pca' | 'bands';

export interface DebugLogEntry {
  time: number;
  type: 'fetch' | 'render' | 'overlay' | 'info' | 'error';
  msg: string;
}

export interface EmbeddingProgress {
  ci: number;
  cj: number;
  stage: 'fetching' | 'rendering' | 'done';
  bytes?: number;          // expected total bytes
  bytesLoaded?: number;    // bytes received so far
  chunksCompleted?: number; // zarr chunks fetched
  chunksTotal?: number;     // total zarr chunks to fetch
}

export interface ZarrTesseraEvents {
  'metadata-loaded': StoreMetadata;
  'chunk-loaded': { ci: number; cj: number };
  'embeddings-loaded': { ci: number; cj: number };
  'embedding-progress': EmbeddingProgress;
  'error': Error;
  'loading': { total: number; done: number };
  'debug': DebugLogEntry;
}

/** Contiguous embedding buffer covering a rectangular chunk grid.
 *  Tiles fill into the buffer at computed offsets as they load.
 *  Invalid pixels use NaN in the embedding values. */
export interface EmbeddingRegion {
  ciMin: number; ciMax: number;
  cjMin: number; cjMax: number;
  gridCols: number;  // cjMax - cjMin + 1
  gridRows: number;  // ciMax - ciMin + 1
  tileW: number;     // pixels per tile (cols)
  tileH: number;     // pixels per tile (rows)
  nBands: number;    // embedding dimensions (e.g. 128)
  /** Dequantized embeddings in tile-major, row-major layout.
   *  Length = gridRows * gridCols * tileH * tileW * nBands.
   *  NaN = invalid/nodata pixel. */
  emb: Float32Array;
  /** Per-tile loaded bitmap. 1 = tile present. */
  loaded: Uint8Array;
}

export interface EmbeddingAt {
  embedding: Float32Array; // 128-d vector
  ci: number;
  cj: number;
  row: number;             // pixel row within chunk
  col: number;             // pixel col within chunk
}
