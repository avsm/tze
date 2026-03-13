// @ucam-eo/tessera — core TESSERA embedding access library

export { EventEmitter } from './event-emitter.js';
export { UtmProjection } from './projection.js';

// @internal — used by map plugins, not intended for public consumption
export { openStore, fetchRegion } from './zarr-reader.js';

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
