// @ucam-eo/tessera — core TESSERA embedding access library

export { TesseraSource } from './tessera-source.js';
export { SourceManager } from './source-manager.js';
export { EventEmitter } from './event-emitter.js';
export { UtmProjection } from './projection.js';
export { TesseraTileRenderer } from './tile-renderer.js';

// @internal — used by map plugins, not intended for public consumption
export { openStore, fetchRegion } from './zarr-reader.js';

export type { GeoJsonPolygon, LoadChunksOptions } from './tessera-source.js';

export type {
  TesseraOptions,
  StoreMetadata,
  ChunkRef,
  ManagedChunk,
  EmbeddingRegion,
  EmbeddingAt,
  ZoneDescriptor,
  EmbeddingProgress,
  DebugLogEntry,
  UtmBounds,
  TesseraEvents,
  TileRendererOptions,
} from './types.js';
