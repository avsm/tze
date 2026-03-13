export { ZarrTesseraSource } from './zarr-source.js';
export { ZarrSourceManager } from './source-manager.js';
export { registerZarrProtocol, clearZarrProtocolCache } from './zarr-tile-protocol.js';
export { MaplibreTesseraSource } from './maplibre-source.js';
export { MaplibreTesseraManager } from './maplibre-manager.js';

// Types that live in the local maplibre-tessera package
export type { PreviewMode, MaplibreDisplayOptions, CachedChunk } from './types.js';

// ZarrTesseraOptions and ZarrTesseraEvents are defined in zarr-source.ts
export type { ZarrTesseraOptions, ZarrTesseraEvents } from './zarr-source.js';

// Re-export core types from @ucam-eo/tessera so consumers of @ucam-eo/maplibre-tessera
// can still find them here (backward compatibility).
export type {
  StoreMetadata,
  EmbeddingRegion,
  EmbeddingAt,
  EmbeddingProgress,
  DebugLogEntry,
  TesseraOptions,
  TesseraEvents,
  UtmBounds,
  ChunkBounds,
  ChunkRef,
} from '@ucam-eo/tessera';

export type { ZoneInfo, ManagedChunk } from './source-manager.js';
