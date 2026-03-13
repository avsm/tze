# TZE — TESSERA Zarr Explorer

Web-based geospatial analysis platform for exploring satellite embedding datasets. Users load per-pixel embeddings (128-d vectors from the TESSERA self-supervised encoder) stored as Zarr arrays, then run similarity search, classification, or segmentation entirely in the browser.

Deployed at `tze.geotessera.org` via GitHub Pages (push to `main` triggers build + deploy).

## Monorepo Layout

```
tze/
├── apps/viewer/                    # Svelte 5 + Vite 8 web application
│   ├── src/
│   │   ├── App.svelte              # Root: map init, terra-draw, layer setup
│   │   ├── components/             # UI panels (TopBar, ToolSwitcher, SegmentPanel, etc.)
│   │   ├── stores/                 # Svelte writable/derived stores (zarr, drawing, tools, etc.)
│   │   ├── lib/
│   │   │   ├── stac.ts             # STAC catalog discovery → ZoneDescriptor[]
│   │   │   ├── osm-sampler.ts      # OSM Overpass training data import
│   │   │   ├── umap-subsample.ts   # UMAP dimensionality reduction (web worker)
│   │   │   └── tutorials/          # Interactive tutorial definitions
│   │   └── main.ts
│   └── public/
│       ├── CNAME                   # tze.geotessera.org (GitHub Pages)
│       ├── models/                 # ONNX model + stats for segmentation
│       └── ort-wasm/               # ONNX Runtime WASM files (copied by vite plugin)
├── packages/tessera/               # Core data-access library (framework-agnostic)
│   └── src/
│       ├── tessera-source.ts       # Per-zone source: store opening, chunk loading, embedding queries
│       ├── source-manager.ts       # Multi-zone routing, aggregation, event forwarding
│       ├── tile-renderer.ts        # TesseraTileRenderer for canvas-based rendering
│       ├── zarr-reader.ts          # Opens Zarr v3 stores, fetches arrays
│       ├── projection.ts           # UTM ↔ WGS84 (proj4)
│       ├── event-emitter.ts        # Minimal typed event emitter
│       └── types.ts                # EmbeddingRegion, StoreMetadata, ZoneDescriptor, etc.
├── packages/tessera-tasks/         # Analysis algorithms (depends on tessera only)
│   └── src/
│       ├── index.ts                # Lightweight entry: similarity + types (no heavy deps)
│       ├── similarity.ts           # Cosine similarity scoring
│       ├── classify.ts             # k-NN classification (TensorFlow.js, lazy-loaded)
│       ├── segment.ts              # UNet segmentation (ONNX Runtime, lazy-loaded)
│       ├── classification-store.ts # Per-tile classification map storage + lookup
│       └── vite-plugin.ts          # ortWasmPlugin() for ONNX Runtime WASM file handling
├── packages/maplibre-tessera/      # MapLibre display plugin (composition over tessera)
│   └── src/
│       ├── maplibre-source.ts      # Per-zone display: layers, overlays, animations
│       ├── maplibre-manager.ts     # Multi-zone display routing
│       ├── chunk-renderer.ts       # Pure functions: rgbaToCanvas, renderRegionCanvas
│       ├── worker-pool.ts          # Web Worker pool for parallel tile rendering
│       ├── render-worker.ts        # Worker code for RGB/embedding rendering
│       ├── region-loading-animation.ts # ROI loading animation
│       ├── zarr-tile-protocol.ts   # Custom zarr:// MapLibre protocol
│       └── types.ts                # PreviewMode, MaplibreDisplayOptions, CachedChunk
├── packages/leaflet-tessera/       # Leaflet display plugin (uses TesseraTileRenderer)
│   └── src/
│       └── tessera-tile-layer.ts   # TesseraTileLayer extending L.GridLayer
├── packages/openlayers-tessera/    # OpenLayers display plugin (uses TesseraTileRenderer)
│   └── src/
│       └── tessera-tile-source.ts  # TesseraTileSource extending ol/source/XYZ
├── .changeset/                     # Changesets config for npm publishing
├── .github/workflows/deploy.yml    # CI: build on PR, deploy to GitHub Pages on main
└── scripts/                        # Utility scripts (model conversion, etc.)
```

## Package Architecture

```
@ucam-eo/tessera (data)
  ├── @ucam-eo/tessera-tasks (analysis)
  ├── @ucam-eo/maplibre-tessera (display — MapLibre)
  ├── @ucam-eo/leaflet-tessera (display — Leaflet)
  └── @ucam-eo/openlayers-tessera (display — OpenLayers)
```

- **tessera**: Framework-agnostic data access. `TesseraSource` handles store opening, chunk loading with dequantisation, embedding queries, coordinate conversions. `SourceManager` routes across UTM zones. `TesseraTileRenderer` provides canvas-based tile rendering for display plugins. No map framework code.
- **tessera-tasks**: Analysis algorithms (similarity, classification, segmentation). Depends only on tessera. Heavy deps (TensorFlow.js, ONNX Runtime) are optional peer dependencies, loaded via separate entry points (`@ucam-eo/tessera-tasks/classify`, `@ucam-eo/tessera-tasks/segment`). `ClassificationStore` manages per-tile classification results with zone-scoped keys. Exports `ortWasmPlugin()` for Vite (`@ucam-eo/tessera-tasks/vite`).
- **maplibre-tessera**: MapLibre display plugin. `MaplibreTesseraSource` wraps `TesseraSource` via composition (`readonly source: TesseraSource`). Owns MapLibre layers, canvas rendering, loading animations, overlays. `MaplibreTesseraManager` wraps `SourceManager` for multi-zone display routing.
- **leaflet-tessera**: Leaflet display plugin. `TesseraTileLayer` extends `L.GridLayer`, uses `TesseraTileRenderer` from core tessera.
- **openlayers-tessera**: OpenLayers display plugin. `TesseraTileSource` extends `ol/source/XYZ`, uses `TesseraTileRenderer` from core tessera.

The viewer holds separate stores: `sourceManager` (data: SourceManager) and `displayManager` (display: MaplibreTesseraManager).

## Tech Stack

- **Svelte 5** (runes: `$state`, `$derived`, `$effect`, `$props`)
- **Vite 8** (Rolldown bundler), **TypeScript 5.7**, **TailwindCSS 4** (insiders, for Vite 8 compat)
- **MapLibre GL 4.7** with custom `zarr://` tile protocol
- **Terra-draw** for polygon/rectangle ROI drawing
- **TensorFlow.js** (WebGL backend) for GPU-accelerated k-NN — lazy-loaded via `import()`
- **ONNX Runtime Web** (WASM) for neural network inference — lazy-loaded via `import()`
- **zarrita** (custom fork, pinned to SHA `9fd3970`) for Zarr v3 HTTP reads
- **pnpm** workspaces, build order: tessera → maplibre-tessera → tessera-tasks → viewer
- **Changesets** for versioning and npm publishing (`pnpm changeset`, `pnpm release`)

## Commands

```bash
pnpm dev          # Dev server (proxies /zarr → localhost:9999)
pnpm build        # Build all packages then viewer
pnpm test         # Run vitest across all packages
pnpm check        # TypeScript check across all packages
pnpm changeset    # Create a changeset for publishing
pnpm release      # Build + publish to npm via changesets
```

## Data Flow

1. **STAC catalog** → zone discovery (UTM zones with Zarr URLs, fully resolved)
2. **SourceManager** lazily opens per-zone `TesseraSource` instances
3. **MaplibreTesseraManager** creates per-zone `MaplibreTesseraSource` display wrappers
4. User draws ROI → `getChunksInRegion()` → `loadChunks()` fetches embeddings
5. **EmbeddingRegion**: contiguous `Float32Array` per zone, NaN for invalid pixels, `loaded` bitmap
6. Analysis tools (tessera-tasks) read from EmbeddingRegion to produce overlays/polygons

## Analysis Tools

**Similarity** — Click a pixel, compute cosine similarity against all loaded embeddings, render heatmap overlay. UMAP projection shows embedding clusters.

**Classification** — Define classes, label training pixels (manual or OSM import), run batched k-NN on GPU, render per-pixel class map. Classification data stored in `ClassificationStore` (tessera-tasks), display overlays managed by maplibre-tessera. TensorFlow.js loaded on demand via `import('@ucam-eo/tessera-tasks/classify')`.

**Segmentation** — Slide 64×64 patches (stride 32) across the full embedding region, run ONNX UNet model, threshold probability maps into GeoJSON polygons. Patches span across tile boundaries (tiles are 4×4 px chunks). ONNX Runtime loaded on demand via `import('@ucam-eo/tessera-tasks/segment')`.

## Key Conventions

- **Coordinate systems**: WGS84 (map) ↔ UTM (Zarr store). `UtmProjection` handles conversion.
- **Chunk indices**: 0-based `(ci, cj)` in the tile grid. Zone-prefixed keys: `"zoneId:ci_cj"`.
- **EmbeddingRegion layout**: tiles stored in row-major order, each tile is `tileH × tileW × nBands` floats. Global pixel `(gy, gx)` maps to tile `(gy/tileH, gx/tileW)` with local offset.
- **Store pattern**: Svelte `writable`/`derived` stores in `src/stores/`. Use `get()` (not `$store`) inside `$effect` bodies to avoid unwanted reactive subscriptions.
- **Dual manager pattern**: `sourceManager` store for data operations, `displayManager` store for display operations. Data types import from `@ucam-eo/tessera`, display types from `@ucam-eo/maplibre-tessera`.
- **Code splitting**: Heavy ML deps lazy-loaded via dynamic `import()`. Main entry (`@ucam-eo/tessera-tasks`) re-exports only types from heavy modules, not values.
- **Tool transitions**: `$activeTool` store drives which panel is shown. ToolSwitcher `$effect` handles side effects (hide/show segment polygons, clear overlays, restore similarity).
- **ORT WASM**: `ortWasmPlugin()` from `@ucam-eo/tessera-tasks/vite` copies WASM files to `public/ort-wasm/` and serves `.mjs` files via raw middleware to bypass Vite's module transform.
- **Dev aliases**: Viewer's `vite.config.ts` aliases workspace packages to their `src/` entry points for HMR. Sub-entry points (`/classify`, `/segment`) need explicit aliases.
- **Tutorials**: `TutorialDef` with steps (action + trigger). Actions manipulate stores/map; triggers are `click` or `action-complete`.
