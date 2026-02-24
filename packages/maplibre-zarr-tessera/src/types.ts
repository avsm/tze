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

export interface ZarrTesseraEvents {
  'metadata-loaded': StoreMetadata;
  'chunk-loaded': { ci: number; cj: number };
  'error': Error;
  'loading': { total: number; done: number };
}
