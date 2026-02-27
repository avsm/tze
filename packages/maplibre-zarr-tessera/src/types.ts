import type { Map as MaplibreMap } from 'maplibre-gl';

export interface ZarrTesseraOptions {
  url: string;
  bands?: [number, number, number];
  opacity?: number;
  preview?: 'rgb' | 'pca' | 'bands';
  maxCached?: number;
  maxLoadPerUpdate?: number;
  concurrency?: number;
  gridVisible?: boolean;
  utmBoundaryVisible?: boolean;
  /** URL for the global EPSG:4326 preview store (used by @carbonplan/zarr-layer) */
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
  embRaw: Uint8Array | null;
  scalesRaw: Uint8Array | null;
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
  bytes?: number; // expected total bytes
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

export interface TileEmbeddings {
  ci: number;
  cj: number;
  emb: Float32Array;      // [h * w * nBands] dequantized float32 embeddings
  scales: Float32Array;   // [h * w] scale values
  width: number;
  height: number;
  nBands: number;
}

export interface EmbeddingAt {
  embedding: Float32Array; // 128-d vector
  ci: number;
  cj: number;
  row: number;             // pixel row within chunk
  col: number;             // pixel col within chunk
}
