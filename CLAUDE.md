# TZE — TESSERA Zarr Explorer

Web-based geospatial analysis platform for exploring satellite embedding datasets. Users load per-pixel embeddings (128-d vectors from the TESSERA self-supervised encoder) stored as Zarr arrays, then run similarity search, classification, or segmentation entirely in the browser.

## Monorepo Layout

```
tze/
├── apps/viewer/                    # Svelte 5 + Vite web application
│   ├── src/
│   │   ├── App.svelte              # Root: map init, terra-draw, layer setup
│   │   ├── components/             # UI panels (TopBar, ToolSwitcher, SegmentPanel, etc.)
│   │   ├── stores/                 # Svelte writable/derived stores (zarr, drawing, tools, etc.)
│   │   ├── lib/                    # Analysis algorithms
│   │   │   ├── similarity.ts       # Cosine similarity scoring
│   │   │   ├── classify.ts         # k-NN classification (TensorFlow.js WebGL)
│   │   │   ├── segment.ts          # UNet segmentation (ONNX Runtime WASM)
│   │   │   ├── stac.ts             # STAC catalog discovery
│   │   │   └── tutorials/          # Interactive tutorial definitions
│   │   └── main.ts
│   └── public/
│       ├── models/                 # ONNX model + stats for segmentation
│       └── ort-wasm/               # ONNX Runtime WASM files (copied by vite plugin)
├── packages/maplibre-zarr-tessera/ # Reusable MapLibre integration library
│   └── src/
│       ├── zarr-source.ts          # Per-zone source: chunk cache, rendering, embedding storage
│       ├── source-manager.ts       # Multi-zone routing, aggregation, event forwarding
│       ├── zarr-reader.ts          # Opens Zarr v3 stores, fetches arrays
│       ├── zarr-tile-protocol.ts   # Custom zarr:// MapLibre protocol
│       ├── projection.ts           # UTM <-> WGS84 (proj4)
│       └── types.ts                # EmbeddingRegion, StoreMetadata, ZoneDescriptor
└── scripts/                        # Utility scripts (model conversion, etc.)
```

## Tech Stack

- **Svelte 5** (runes: `$state`, `$derived`, `$effect`, `$props`)
- **Vite 6**, **TypeScript 5.7**, **TailwindCSS 4**
- **MapLibre GL 4.7** with custom `zarr://` tile protocol
- **Terra-draw** for polygon/rectangle ROI drawing
- **TensorFlow.js** (WebGL backend) for GPU-accelerated k-NN
- **ONNX Runtime Web** (WASM) for neural network inference
- **zarrita** (custom fork, `coalesce` branch) for Zarr v3 HTTP reads
- **pnpm** workspaces, build order: maplibre-zarr-tessera → viewer

## Commands

```bash
pnpm dev          # Dev server (proxies /zarr → localhost:9999)
pnpm build        # Build library then viewer
pnpm test         # Run vitest across all packages
pnpm check        # TypeScript check
```

## Data Flow

1. **STAC catalog** → zone discovery (UTM zones with Zarr URLs)
2. **ZarrSourceManager** lazily opens per-zone `ZarrTesseraSource` instances
3. User draws ROI → `getChunksInRegion()` → `loadChunkBatch()` fetches embeddings
4. **EmbeddingRegion**: contiguous `Float32Array` per zone, NaN for invalid pixels, `loaded` bitmap
5. Analysis tools read from EmbeddingRegion to produce overlays/polygons

## Analysis Tools

**Similarity** — Click a pixel, compute cosine similarity against all loaded embeddings, render heatmap overlay. UMAP projection shows embedding clusters.

**Classification** — Define classes, label training pixels (manual or OSM import), run batched k-NN on GPU, render per-pixel class map.

**Segmentation** — Slide 64×64 patches (stride 32) across the full embedding region, run ONNX UNet model, threshold probability maps into GeoJSON polygons. Patches span across tile boundaries (tiles are 4×4 px chunks).

## Key Conventions

- **Coordinate systems**: WGS84 (map) ↔ UTM (Zarr store). `UtmProjection` handles conversion.
- **Chunk indices**: 0-based `(ci, cj)` in the tile grid. Zone-prefixed keys: `"zoneId:ci_cj"`.
- **EmbeddingRegion layout**: tiles stored in row-major order, each tile is `tileH × tileW × nBands` floats. Global pixel `(gy, gx)` maps to tile `(gy/tileH, gx/tileW)` with local offset.
- **Store pattern**: Svelte `writable`/`derived` stores in `src/stores/`. Use `get()` (not `$store`) inside `$effect` bodies to avoid unwanted reactive subscriptions.
- **Tool transitions**: `$activeTool` store drives which panel is shown. ToolSwitcher `$effect` handles side effects (hide/show segment polygons, clear overlays, restore similarity).
- **ORT WASM**: Custom vite plugin copies WASM files to `public/ort-wasm/` and serves `.mjs` files via raw middleware to bypass Vite's module transform.
- **Tutorials**: `TutorialDef` with steps (action + trigger). Actions manipulate stores/map; triggers are `click` or `action-complete`.
