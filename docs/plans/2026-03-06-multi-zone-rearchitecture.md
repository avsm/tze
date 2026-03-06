# Multi-Zone Rearchitecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make UTM zones an invisible implementation detail — the viewport drives tile rendering and analysis works seamlessly across zone boundaries.

**Architecture:** Three-phase approach: (1) Replace `@carbonplan/zarr-layer` with a custom `zarr://` MapLibre protocol handler that serves global RGB tiles as standard raster tiles, fixing 3D perspective skewing. (2) Introduce a `ZarrSourceManager` that lazily manages multiple `ZarrTesseraSource` instances per zone, routing viewport and analysis requests transparently. (3) Adapt analysis tools (similarity, classification) to operate across multiple zones by iterating per-zone `EmbeddingRegion`s while keeping a single unified training/reference set.

**Tech Stack:** MapLibre GL JS (`addProtocol`), zarrita (Zarr v3 reader), TypeScript, Svelte 5

---

## Phase 1: Replace zarr-layer with custom protocol (fixes 3D skewing)

### Task 1: Create the Zarr tile protocol handler

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/zarr-tile-protocol.ts`

The global RGB store at `dl2.geotessera.org/zarr/v1/global_rgb_2025.zarr` is an EPSG:4326 multiscale pyramid:
- 10 levels (0=full res 1.8M x 3.6M, 9=coarsest 3.5K x 7K)
- 512x512x4 uint8 chunks (RGBA), blosc/zstd compressed
- Scale factor doubles each level
- Dimensions: `[lat, lon, band]`, lat is descending (north at row 0)

The protocol handler registers `zarr://` and maps `{z,x,y}` web-mercator tiles to Zarr chunks.

**Step 1: Write the protocol handler**

```typescript
// zarr-tile-protocol.ts
import * as zarr from 'zarrita';

interface ZarrTileSource {
  store: zarr.Array<zarr.DataType>;
  shape: [number, number, number]; // [lat, lon, band]
  chunkShape: [number, number, number];
}

// Cache open stores by URL
const storeCache = new Map<string, Promise<ZarrTileSource[]>>();

/** Open a multiscale Zarr RGB store and return arrays for each pyramid level. */
async function openMultiscale(url: string): Promise<ZarrTileSource[]> {
  const fetchStore = new zarr.FetchStore(url);
  const coalescingStore = new zarr.CoalescingStore(fetchStore);
  const rootLoc = zarr.root(coalescingStore);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  // Read multiscales metadata to find level names
  const multiscales = attrs.multiscales as { datasets: { path: string; scale: number }[] }[] | undefined;
  if (!multiscales?.[0]?.datasets) {
    throw new Error('No multiscales metadata found');
  }

  const levels: ZarrTileSource[] = [];
  for (const ds of multiscales[0].datasets) {
    const arr = await zarr.open(rootLoc.resolve(ds.path), { kind: 'array' });
    levels.push({
      store: arr,
      shape: arr.shape as [number, number, number],
      chunkShape: arr.chunks as [number, number, number],
    });
  }
  return levels;
}

function getOrOpenStore(url: string): Promise<ZarrTileSource[]> {
  let p = storeCache.get(url);
  if (!p) {
    p = openMultiscale(url);
    storeCache.set(url, p);
  }
  return p;
}

/** Convert web-mercator tile {z,x,y} to lat/lon bounds. */
function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
    south: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s))),
  };
}

/** Select appropriate pyramid level for the given zoom. */
function selectLevel(levels: ZarrTileSource[], z: number): ZarrTileSource {
  // Each level doubles resolution. Level 0 = full res (~0.0001 deg/px at equator).
  // At zoom z, we want roughly 256px worth of data.
  // Level 0 has ~3.6M lon pixels for 360 degrees = 10000 px/deg
  // At zoom z, a tile covers 360/(2^z) degrees and is 256px
  // So we need 256 / (360/(2^z)) = 256 * 2^z / 360 px/deg
  // Level i has shape[1] / 360 px/deg. Choose smallest level where px/deg >= needed.
  const neededPxPerDeg = (256 * (1 << z)) / 360;
  for (let i = levels.length - 1; i >= 0; i--) {
    const levelPxPerDeg = levels[i].shape[1] / 360;
    if (levelPxPerDeg >= neededPxPerDeg) return levels[i];
  }
  return levels[0]; // Full resolution fallback
}

const TILE_SIZE = 256;

/**
 * Register the zarr:// tile protocol with MapLibre.
 * Usage: map.addSource('rgb-preview', { type: 'raster', tiles: ['zarr://URL/{z}/{x}/{y}'], tileSize: 256 })
 */
export function registerZarrProtocol(maplibregl: { addProtocol: Function }): void {
  maplibregl.addProtocol('zarr', async (params: { url: string }, abortController: AbortController) => {
    // Parse URL: zarr://STORE_URL/{z}/{x}/{y}
    const url = params.url.replace('zarr://', '');
    const parts = url.split('/');
    const y = parseInt(parts.pop()!);
    const x = parseInt(parts.pop()!);
    const z = parseInt(parts.pop()!);
    const storeUrl = parts.join('/');

    const levels = await getOrOpenStore(storeUrl);
    const level = selectLevel(levels, z);
    const bounds = tileBounds(z, x, y);

    // Map lat/lon bounds to pixel coordinates in this level
    // Longitude: linear mapping [-180, 180] -> [0, shape[1]]
    // Latitude: linear mapping [90, -90] -> [0, shape[0]] (north at row 0, descending)
    const lonToPx = (lon: number) => ((lon + 180) / 360) * level.shape[1];
    const latToPx = (lat: number) => ((90 - lat) / 180) * level.shape[0];

    const px0 = Math.floor(lonToPx(bounds.west));
    const px1 = Math.ceil(lonToPx(bounds.east));
    const py0 = Math.floor(latToPx(bounds.north));
    const py1 = Math.ceil(latToPx(bounds.south));

    // Clamp to array bounds
    const r0 = Math.max(0, py0);
    const r1 = Math.min(level.shape[0], py1);
    const c0 = Math.max(0, px0);
    const c1 = Math.min(level.shape[1], px1);

    if (r1 <= r0 || c1 <= c0) {
      // Empty tile — return transparent PNG
      return { data: new Uint8Array(0) };
    }

    // Fetch the region from Zarr
    const result = await zarr.get(level.store, [
      zarr.slice(r0, r1),
      zarr.slice(c0, c1),
      null, // all bands
    ]);

    const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    const srcH = r1 - r0;
    const srcW = c1 - c0;

    // Render to RGBA ImageData, then encode to PNG via canvas
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const out = imgData.data;

    for (let ty = 0; ty < TILE_SIZE; ty++) {
      // Map tile pixel to source pixel
      const srcY = Math.floor((ty / TILE_SIZE) * srcH);
      for (let tx = 0; tx < TILE_SIZE; tx++) {
        const srcX = Math.floor((tx / TILE_SIZE) * srcW);
        const srcIdx = (srcY * srcW + srcX) * 4; // RGBA interleaved
        const dstIdx = (ty * TILE_SIZE + tx) * 4;
        out[dstIdx]     = data[srcIdx];     // R
        out[dstIdx + 1] = data[srcIdx + 1]; // G
        out[dstIdx + 2] = data[srcIdx + 2]; // B
        out[dstIdx + 3] = data[srcIdx + 3]; // A
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuf = await blob.arrayBuffer();
    return { data: new Uint8Array(arrayBuf) };
  });
}
```

**Note on data layout:** The Zarr store stores data as `[lat, lon, band]` with chunk shape `[512, 512, 4]`. When fetched via `zarr.get()` with `slice(r0,r1), slice(c0,c1), null`, the result is a flat array of `(r1-r0) * (c1-c0) * 4` uint8 values in row-major order with bands interleaved (since the band dimension is contiguous in each chunk). Verify this assumption during implementation — if bands are not interleaved, adjust the pixel copy loop.

**Step 2: Verify build**

Run: `pnpm run build`
Expected: PASS (no consumers yet)

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-tile-protocol.ts
git commit -m "feat: add zarr:// custom tile protocol for MapLibre"
```

---

### Task 2: Replace @carbonplan/zarr-layer with zarr:// protocol in ZarrTesseraSource

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts`
- Modify: `apps/viewer/src/App.svelte` (register protocol on startup)

**Step 1: Register protocol at app startup**

In `apps/viewer/src/App.svelte`, add near the top (after maplibre import):

```typescript
import maplibregl from 'maplibre-gl';
import { registerZarrProtocol } from '@ucam-eo/maplibre-zarr-tessera';
// Register once at module level
registerZarrProtocol(maplibregl);
```

Export `registerZarrProtocol` from the package's `index.ts`.

**Step 2: Replace addPreviewLayer() in zarr-source.ts**

Remove the `import { ZarrLayer } from '@carbonplan/zarr-layer'` import.

Replace the `addPreviewLayer()` method (currently lines 1779-1835) with:

```typescript
private addPreviewLayer(): void {
  if (!this.map || !this.opts.globalPreviewUrl) return;

  const sourceId = 'zarr-global-preview-src';
  const layerId = 'zarr-global-preview-lyr';

  // Remove existing preview
  if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
  if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

  this.map.addSource(sourceId, {
    type: 'raster',
    tiles: [`zarr://${this.opts.globalPreviewUrl}/{z}/{x}/{y}`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 14,
  });

  this.map.addLayer({
    id: layerId,
    type: 'raster',
    source: sourceId,
    paint: {
      'raster-opacity': this.opts.opacity,
      'raster-fade-duration': 200,
    },
  });

  this.previewLayerId = layerId;
  this.debug('info', 'Global preview added via zarr:// protocol');
  this.raiseOverlayLayers();
}
```

**Step 3: Update previewLayer references throughout zarr-source.ts**

The old code stored `this.previewLayer` as a ZarrLayer instance. Change to storing `this.previewLayerId: string | null` instead. Update:

- `remove()`: Use `this.map.removeLayer(this.previewLayerId)` + `this.map.removeSource('zarr-global-preview-src')`
- `setOpacity()`: Use `this.map.setPaintProperty(this.previewLayerId, 'raster-opacity', opacity)`
- `setPreview()`: Remove the `this.previewLayer.setVariable()` call. Instead, remove and re-add the source with the new variable path. (The zarr:// protocol URL would encode rgb vs pca_rgb — either as a query param or path segment.)
- `updateVisibleChunks()`: Change `if (this.previewLayer) return` to `if (this.previewLayerId) return`
- `raiseOverlayLayers()`: Update to use `this.previewLayerId` for layer ordering

**Step 4: Handle RGB vs PCA preview switching**

The zarr:// URL currently encodes the store URL but not the variable name. Options:
- (a) Encode as query param: `zarr://URL?var=pca_rgb/{z}/{x}/{y}` — parse in protocol handler
- (b) Include variable in path: The global store has `rgb` and `pca_rgb` as top-level arrays. The protocol handler opens the root group and reads the specified array.

Recommended: Pass the variable as a path suffix: `zarr://BASE_URL/rgb/{z}/{x}/{y}` vs `zarr://BASE_URL/pca_rgb/{z}/{x}/{y}`. The protocol handler splits the variable name from the path.

Update the protocol handler URL parsing accordingly.

**Step 5: Verify build and test 3D perspective**

Run: `pnpm run build`
Test manually: Open app, tilt map (Ctrl+drag or two-finger drag on mobile). The RGB preview should now tilt correctly with the base map.

**Step 6: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts apps/viewer/src/App.svelte
git commit -m "feat: replace @carbonplan/zarr-layer with zarr:// protocol tiles"
```

---

### Task 3: Remove @carbonplan/zarr-layer dependency

**Files:**
- Modify: `packages/maplibre-zarr-tessera/package.json`
- Verify: No other imports of `@carbonplan/zarr-layer`, `proj4`, `delaunator`, `@developmentseed/raster-reproject`

**Step 1: Remove from package.json**

```bash
cd packages/maplibre-zarr-tessera
pnpm remove @carbonplan/zarr-layer
```

**Step 2: Verify no remaining references**

```bash
grep -r "carbonplan" packages/ apps/
grep -r "zarr-layer" packages/ apps/
```

Expected: No matches (or only in this plan doc / comments).

**Step 3: Build and verify**

Run: `pnpm run build`
Expected: PASS. Bundle size should decrease (removes proj4, delaunator, raster-reproject).

**Step 4: Commit**

```bash
git add packages/maplibre-zarr-tessera/package.json pnpm-lock.yaml
git commit -m "chore: remove @carbonplan/zarr-layer dependency"
```

---

## Phase 2: Multi-Zone Source Manager

### Task 4: Create ZarrSourceManager

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/source-manager.ts`
- Modify: `packages/maplibre-zarr-tessera/src/index.ts` (export)

The manager lazily creates `ZarrTesseraSource` instances per zone. It:
- Takes the full `ZoneDescriptor[]` list and globalPreviewUrl at construction
- Opens zone sources on demand when the viewport or an ROI overlaps them
- Routes `getEmbeddingAt(lng, lat)` to the correct zone
- Routes `getChunksInRegion(polygon)` across zones, returning zone-tagged chunks
- Manages the global preview layer (one instance, shared)

**Step 1: Write the manager**

```typescript
// source-manager.ts
import type { ZoneDescriptor } from './types.js'; // re-export from stac types
import { ZarrTesseraSource } from './zarr-source.js';
import type { ZarrTesseraOptions, EmbeddingRegion, StoreMetadata } from './types.js';

export interface ManagedChunk {
  zoneId: string;
  ci: number;
  cj: number;
}

export class ZarrSourceManager {
  private zones: ZoneDescriptor[];
  private sources = new Map<string, ZarrTesseraSource>();
  private map: maplibregl.Map | null = null;
  private baseOpts: Omit<ZarrTesseraOptions, 'url'>;

  constructor(zones: ZoneDescriptor[], opts: Omit<ZarrTesseraOptions, 'url'>) {
    this.zones = zones;
    this.baseOpts = opts;
  }

  /** Attach to map and set up the global preview layer. */
  async addTo(map: maplibregl.Map): Promise<void> {
    this.map = map;
    // Global preview is handled by zarr:// protocol — added via addPreviewLayer
    // No per-zone sources opened yet; they're opened on demand.
  }

  /** Find which zone(s) a point falls in. */
  zonesAtPoint(lng: number, lat: number): ZoneDescriptor[] {
    return this.zones.filter(z => pointInBbox(lng, lat, z.bbox));
  }

  /** Find which zone(s) a polygon overlaps. */
  zonesForPolygon(polygon: GeoJSON.Polygon): ZoneDescriptor[] {
    return this.zones.filter(z => polygonOverlapsBbox(polygon, z.bbox));
  }

  /** Get or lazily open a ZarrTesseraSource for a zone. */
  async getSource(zoneId: string): Promise<ZarrTesseraSource> {
    let src = this.sources.get(zoneId);
    if (src) return src;

    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone) throw new Error(`Unknown zone: ${zoneId}`);

    src = new ZarrTesseraSource({
      ...this.baseOpts,
      url: zone.zarrUrl,
      // Don't add preview layer per-zone — global preview handles RGB
      globalPreviewUrl: undefined,
    });
    await src.addTo(this.map!);
    this.sources.set(zoneId, src);
    return src;
  }

  /** Get chunks across all relevant zones for a polygon ROI. */
  async getChunksInRegion(polygon: GeoJSON.Polygon): Promise<ManagedChunk[]> {
    const zones = this.zonesForPolygon(polygon);
    const allChunks: ManagedChunk[] = [];

    for (const zone of zones) {
      const src = await this.getSource(zone.id);
      const chunks = src.getChunksInRegion(polygon);
      for (const { ci, cj } of chunks) {
        allChunks.push({ zoneId: zone.id, ci, cj });
      }
    }
    return allChunks;
  }

  /** Get embedding at a point, routing to the correct zone. */
  async getEmbeddingAt(lng: number, lat: number): Promise<{ zoneId: string; embedding: Float32Array; ci: number; cj: number; row: number; col: number } | null> {
    const zones = this.zonesAtPoint(lng, lat);
    for (const zone of zones) {
      const src = this.sources.get(zone.id);
      if (!src) continue;
      const result = src.getEmbeddingAt(lng, lat);
      if (result) return { zoneId: zone.id, ...result };
    }
    return null;
  }

  /** Get all embedding regions across zones. */
  getEmbeddingRegions(): Map<string, EmbeddingRegion> {
    const regions = new Map<string, EmbeddingRegion>();
    for (const [zoneId, src] of this.sources) {
      if (src.embeddingRegion) regions.set(zoneId, src.embeddingRegion);
    }
    return regions;
  }

  /** Total loaded tile count across all zones. */
  totalTileCount(): number {
    let n = 0;
    for (const src of this.sources.values()) {
      n += src.regionTileCount();
    }
    return n;
  }

  /** Remove all sources and cleanup. */
  remove(): void {
    for (const src of this.sources.values()) {
      src.remove();
    }
    this.sources.clear();
    this.map = null;
  }
}
```

**Note:** `pointInBbox` and `polygonOverlapsBbox` helpers already exist in `stac.ts` — factor them out to a shared utility or re-implement in the manager module.

**Step 2: Verify build**

Run: `pnpm run build`
Expected: PASS (no consumers yet)

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/source-manager.ts
git commit -m "feat: add ZarrSourceManager for multi-zone routing"
```

---

### Task 5: Wire up ZarrSourceManager in stores

**Files:**
- Modify: `apps/viewer/src/stores/stac.ts` — replace `switchZone()` with manager lifecycle
- Modify: `apps/viewer/src/stores/zarr.ts` — add `sourceManager` store alongside `zarrSource`
- Modify: `apps/viewer/src/stores/drawing.ts` — use manager for multi-zone chunk loading

**Step 1: Update stac.ts**

Replace `switchZone()` with `initManager()`:

```typescript
export async function initManager(): Promise<void> {
  const allZones = get(zones);
  const map = get(mapInstance);
  if (!map || allZones.length === 0) return;

  const oldManager = get(sourceManager);
  if (oldManager) oldManager.remove();

  const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
  const manager = new ZarrSourceManager(allZones, {
    bands: get(bands),
    opacity: get(opacity),
    preview: get(preview),
    globalPreviewUrl: get(globalPreviewUrl),
    globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
    maxCached: mobile ? 4 : undefined,
  });

  await manager.addTo(map);
  sourceManager.set(manager);
  catalogStatus.set('loaded');
}
```

Keep `switchZone()` temporarily as a compatibility shim that opens a specific zone's source via the manager — to be removed once all consumers use the manager directly.

**Step 2: Update zarr.ts**

Add new store:

```typescript
export const sourceManager = writable<ZarrSourceManager | null>(null);
```

Gradually migrate consumers from `zarrSource` to `sourceManager`. During transition, `zarrSource` can be a derived store that returns the "primary" source (first active zone's source, or null).

**Step 3: Update drawing.ts**

Change `addRegion()` to use the manager:

```typescript
export async function addRegion(feature: GeoJSON.Feature): Promise<void> {
  const manager = get(sourceManager);
  if (!manager) return;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const chunks = await manager.getChunksInRegion(geometry);
  // chunks are now ManagedChunk[] with zoneId

  // Group by zone for loading
  const byZone = new Map<string, { ci: number; cj: number }[]>();
  for (const { zoneId, ci, cj } of chunks) {
    let arr = byZone.get(zoneId);
    if (!arr) { arr = []; byZone.set(zoneId, arr); }
    arr.push({ ci, cj });
  }

  // Load per zone
  for (const [zoneId, zoneChunks] of byZone) {
    const src = await manager.getSource(zoneId);
    await src.loadChunkBatch(zoneChunks, onProgress);
  }

  // Record chunk keys with zone prefix
  const loadedKeys = chunks.map(c => `${c.zoneId}_${c.ci}_${c.cj}`);
  // ...
}
```

**Step 4: Commit**

```bash
git commit -m "feat: wire ZarrSourceManager into stores and drawing"
```

---

### Task 6: Remove zone UI from TopBar and App.svelte

**Files:**
- Modify: `apps/viewer/src/components/TopBar.svelte` — remove zone dropdown
- Modify: `apps/viewer/src/App.svelte` — remove auto-zone-switch on moveend, remove zone polygon layer

**Step 1: TopBar.svelte**

Remove the zone dropdown button and its associated state (`zoneDropdownOpen`, `handleZoneClick`, the dropdown markup). Keep the STAC health indicator and metadata display but show aggregate info (e.g., total zones loaded) instead of a single active zone.

Replace the zone button with a simpler status display:

```html
<span class="text-[11px] text-gray-400">
  {$zones.length} zones
</span>
```

**Step 2: App.svelte**

Remove the `moveend` zone auto-switch handler (lines 367-381).
Remove the `stac-zones` GeoJSON layer and associated code (lines 432-478).
Remove `activeZoneId` import and usage.

**Step 3: Verify build and test**

Run: `pnpm run build`
Test: Pan around — no zone switching, no zone polygons. RGB preview tiles load everywhere.

**Step 4: Commit**

```bash
git commit -m "feat: remove zone UI — UTM zones are now an implementation detail"
```

---

## Phase 3: Cross-Zone Analysis

### Task 7: Adapt similarity search for multi-zone

**Files:**
- Modify: `apps/viewer/src/lib/similarity.ts`
- Modify: `apps/viewer/src/components/SimilaritySearch.svelte`

**Step 1: Update computeSimilarityScores**

Change signature from:

```typescript
function computeSimilarityScores(region: EmbeddingRegion, refEmbedding: Float32Array): SimilarityResult
```

To:

```typescript
function computeSimilarityScores(
  regions: Map<string, EmbeddingRegion>,
  refEmbedding: Float32Array
): Map<string, SimilarityResult>
```

The function iterates each zone's region independently, computing cosine similarity against the same reference embedding. The reference embedding is zone-agnostic (it's a feature vector from the shared model).

**Step 2: Update renderSimilarityCanvas**

Change to return one canvas per zone:

```typescript
function renderSimilarityCanvas(
  results: Map<string, SimilarityResult>,
  threshold: number
): Map<string, HTMLCanvasElement>
```

**Step 3: Update SimilaritySearch.svelte**

- Get regions from manager: `manager.getEmbeddingRegions()`
- Get reference embedding: `manager.getEmbeddingAt(lng, lat)` — returns zone-tagged result
- Compute per-zone: `computeSimilarityScores(regions, refEmbedding)`
- Render per-zone: `renderSimilarityCanvas(results, threshold)`
- Push overlays per-zone: For each `[zoneId, canvas]`, call `manager.getSource(zoneId).setSimilarityOverlay(canvas)`

**Step 4: Commit**

```bash
git commit -m "feat: cross-zone similarity search"
```

---

### Task 8: Adapt classification for multi-zone

**Files:**
- Modify: `apps/viewer/src/lib/classify.ts`
- Modify: `apps/viewer/src/stores/classifier.ts`
- Modify: `apps/viewer/src/components/LabelPanel.svelte`

**Step 1: Add zoneId to LabelPoint**

In `classifier.ts`, update the `LabelPoint` interface:

```typescript
export interface LabelPoint {
  zoneId: string;    // NEW: which zone this label came from
  ci: number;
  cj: number;
  row: number;
  col: number;
  embedding: Float32Array;
  lngLat: [number, number];
}
```

Update `addLabel()` to accept and store `zoneId`.

**Step 2: Update classifyTiles signature**

Change from single region to multi-region:

```typescript
function classifyTiles(
  regions: Map<string, EmbeddingRegion>,
  labelPoints: LabelPoint[],
  classDefs: ClassDef[],
  k: number,
  confidenceThreshold: number,
  onProgress?: (loaded: number, total: number) => void,
  onBatchUpdate?: (zoneId: string, ci: number, cj: number, canvas: HTMLCanvasElement, classMap: Int16Array, w: number, h: number) => void,
): Promise<void>
```

The training set is built once from all labels (embeddings are model-global, CRS-agnostic). Then iterate each zone's region and classify its tiles.

**Step 3: Update LabelPanel.svelte**

- Get regions from manager
- Pass all regions to `classifyTiles()`
- Route overlay callbacks to the correct zone's source

**Step 4: Commit**

```bash
git commit -m "feat: cross-zone classification"
```

---

### Task 9: Update removeRegion for multi-zone

**Files:**
- Modify: `apps/viewer/src/stores/drawing.ts`

**Step 1: Update RoiRegion type**

```typescript
export type RoiRegion = {
  id: string;
  feature: GeoJSON.Feature;
  chunkKeys: string[]; // "zoneId_ci_cj" format
};
```

**Step 2: Update removeRegion**

Parse zone from chunk keys: `const [zoneId, ciStr, cjStr] = k.split('_')`.
Route eviction to the correct zone's source via the manager.
After eviction, if a zone's source has no loaded tiles, clear its embeddingRegion.

**Step 3: Commit**

```bash
git commit -m "feat: multi-zone region eviction"
```

---

## Verification Checklist

After all tasks are complete:

1. **3D perspective:** Tilt the map — RGB preview tiles transform correctly with the base map
2. **Multi-zone rendering:** Pan across UTM zone boundaries — tiles load from both zones seamlessly
3. **Cross-zone ROI:** Draw a polygon spanning two zones — embeddings load from both
4. **Cross-zone similarity:** Click a reference pixel in zone A — similarity scores show in both zones
5. **Cross-zone classification:** Labels in zone A, classify tiles in zone A+B — classification covers both
6. **No zone UI:** TopBar shows no zone dropdown. No zone polygon overlays. No auto-zone switching.
7. **Build:** `pnpm run build` passes with no errors
8. **Bundle size:** Should decrease (removed @carbonplan/zarr-layer, proj4, delaunator dependencies)

---

## Migration Notes

- `zarrSource` store is kept as a compatibility shim during transition but should be removed once all consumers use `sourceManager`
- `activeZoneId` store is removed — zones are an implementation detail
- `switchZone()` is removed — the manager handles zone lifecycle automatically
- The `ZarrTesseraSource` class remains largely unchanged — it still manages one zone. The manager composes multiple instances.
- Embedding vectors are model-global (same Clay/DINO model everywhere), so cross-zone similarity/classification is mathematically valid without any normalization.
