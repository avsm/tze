# ROI Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-tile double-click embedding loading with an explicit draw-a-region workflow where users draw polygons/rectangles to define ROIs, embeddings load progressively, and analysis tools operate on loaded tiles.

**Architecture:** A new `RoiStrip` component sits above the tool tabs in the sidebar. It controls terra-draw activation and shows loading progress. The "Draw" tool tab is removed. The zarr-source gains a `getChunksInRegion()` method and a `loadChunkBatch()` method. Double-click/long-press embedding triggers are removed. An ROI store manages multiple drawn regions and tracks which chunks belong to each.

**Tech Stack:** Svelte 5, terra-draw, maplibre-gl, zarrita (zarr), TypeScript

---

### Task 1: Add `getChunksInRegion` to zarr-source

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts:737-770`

This task adds a public method that takes a GeoJSON polygon and returns all chunk indices whose bounding boxes intersect it. It reuses the existing `visibleChunkIndices()` pattern but with polygon bounds instead of viewport bounds.

**Step 1: Add the method after `getChunkBoundsLngLat` (around line 444)**

Add this public method to the `ZarrTesseraSource` class, right after `getChunkBoundsLngLat`:

```typescript
  /** Return all chunk indices whose bounding boxes intersect a GeoJSON polygon. */
  getChunksInRegion(polygon: GeoJSON.Polygon): { ci: number; cj: number }[] {
    if (!this.store || !this.proj) return [];
    // Compute bounding box of the polygon in UTM
    const coords = polygon.coordinates[0]; // outer ring
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [lng, lat] of coords) {
      const [e, n] = this.proj.forward(lng, lat);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
    // Convert UTM bounds to chunk index ranges (same math as visibleChunkIndices)
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)));
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)));
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)));
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)));

    const result: { ci: number; cj: number }[] = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        if (this.store.chunkManifest && !this.store.chunkManifest.has(`${ci}_${cj}`)) continue;
        if (!this.embeddingCache.has(this.chunkKey(ci, cj))) {
          result.push({ ci, cj });
        }
      }
    }
    return result;
  }
```

**Step 2: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/maplibre-zarr-tessera build`
Expected: Success

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts
git commit -m "feat: add getChunksInRegion to zarr-source for ROI queries"
```

---

### Task 2: Add `loadChunkBatch` to zarr-source

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts`

Add a public method that loads a batch of chunks sequentially, emitting progress events. The existing `loadFullChunk` is already `async` and public — this wraps it with progress tracking.

**Step 1: Add the method after `getChunksInRegion`**

```typescript
  /** Load a batch of embedding chunks, calling onProgress after each.
   *  Returns the number of chunks successfully loaded. */
  async loadChunkBatch(
    chunks: { ci: number; cj: number }[],
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<number> {
    let loaded = 0;
    const total = chunks.length;
    for (const { ci, cj } of chunks) {
      const key = this.chunkKey(ci, cj);
      if (this.embeddingCache.has(key)) {
        loaded++;
        onProgress?.(loaded, total);
        continue;
      }
      try {
        await this.loadFullChunk(ci, cj);
        loaded++;
      } catch (err) {
        this.debug('error', `Failed to load chunk (${ci},${cj}): ${(err as Error).message}`);
      }
      onProgress?.(loaded, total);
    }
    return loaded;
  }
```

**Step 2: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/maplibre-zarr-tessera build`
Expected: Success

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts
git commit -m "feat: add loadChunkBatch for progressive ROI loading"
```

---

### Task 3: Remove double-click/long-press embedding triggers

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts:93-137` (addTo method)
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts:160-184` (remove method)
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts:148-158` (triggerEmbeddingLoad)

Remove the dblclick handler, long-press handlers, and the `triggerEmbeddingLoad` private method. Also re-enable double-click zoom on the map.

**Step 1: In `addTo()`, remove lines 93-137**

Remove the entire block from `map.doubleClickZoom.disable()` through the `touchmove` addEventListener. This is the block:
```
      map.doubleClickZoom.disable();
      // Double-click to load full embeddings ...
      ...
      canvas.addEventListener('touchmove', this.touchMoveHandler, { passive: true });
```

**Step 2: In `remove()`, remove the dblclick and touch cleanup**

Remove lines 174-184 (from `if (this.dblclickHandler ...` through `this.longPressTimer = null; }`):
```
    if (this.dblclickHandler && this.map) {
      this.map.off('dblclick', this.dblclickHandler);
    }
    // Clean up mobile long-press handlers
    if (this.map) {
      const canvas = this.map.getCanvasContainer();
      if (this.touchStartHandler) canvas.removeEventListener('touchstart', this.touchStartHandler);
      if (this.touchEndHandler) canvas.removeEventListener('touchend', this.touchEndHandler);
      if (this.touchMoveHandler) canvas.removeEventListener('touchmove', this.touchMoveHandler);
    }
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
```

**Step 3: Remove the `triggerEmbeddingLoad` method (lines 147-158)**

Remove the entire method.

**Step 4: Remove the private member declarations for the handlers**

Search for these in the class field declarations and remove them:
- `private dblclickHandler`
- `private touchStartHandler`
- `private touchEndHandler`
- `private touchMoveHandler`
- `private longPressTimer`
- `private touchStartX`
- `private touchStartY`
- `private clickedChunks`

**Step 5: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/maplibre-zarr-tessera build`
Expected: Success

**Step 6: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts
git commit -m "feat: remove dblclick/longpress embedding triggers (replaced by ROI)"
```

---

### Task 4: Create ROI store

**Files:**
- Modify: `apps/viewer/src/stores/drawing.ts` (rewrite)
- Modify: `apps/viewer/src/stores/tools.ts` (remove 'draw')

Replace the simple drawing store with an ROI store that tracks multiple regions, loading state, and per-region chunk ownership.

**Step 1: Rewrite `apps/viewer/src/stores/drawing.ts`**

Replace the entire file contents with:

```typescript
import { writable, derived, get } from 'svelte/store';
import { zarrSource } from './zarr';

export type DrawMode = 'polygon' | 'rectangle';
export type RoiRegion = {
  id: string;
  feature: GeoJSON.Feature;
  chunkKeys: string[]; // "ci_cj" keys loaded for this region
};

/** Whether terra-draw is currently active for drawing. */
export const roiDrawing = writable(false);

/** Active terra-draw mode (polygon or rectangle). */
export const drawMode = writable<DrawMode>('polygon');

/** All drawn ROI regions. */
export const roiRegions = writable<RoiRegion[]>([]);

/** Loading progress: null when idle. */
export const roiLoading = writable<{ loaded: number; total: number } | null>(null);

/** Total number of embedding tiles loaded across all regions. */
export const roiTileCount = derived(roiRegions, ($regions) => {
  const keys = new Set<string>();
  for (const r of $regions) {
    for (const k of r.chunkKeys) keys.add(k);
  }
  return keys.size;
});

let nextId = 0;

/** Called when terra-draw finishes a shape. Starts loading chunks for the region. */
export async function addRegion(feature: GeoJSON.Feature): Promise<void> {
  const src = get(zarrSource);
  if (!src) return;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const chunks = src.getChunksInRegion(geometry);

  const region: RoiRegion = {
    id: `roi-${nextId++}`,
    feature,
    chunkKeys: [],
  };

  // Add region immediately (shows in UI with 0 tiles)
  roiRegions.update(rs => [...rs, region]);

  if (chunks.length === 0) return;

  // Start progressive loading
  const total = chunks.length;
  roiLoading.set({ loaded: 0, total });

  await src.loadChunkBatch(chunks, (loaded, t) => {
    roiLoading.set({ loaded, total: t });
  });

  // Record which chunks this region owns
  const loadedKeys = chunks.map(c => `${c.ci}_${c.cj}`).filter(k => src.embeddingCache.has(k));
  roiRegions.update(rs =>
    rs.map(r => r.id === region.id ? { ...r, chunkKeys: loadedKeys } : r)
  );

  roiLoading.set(null);
}

/** Remove a single region. Evict its exclusive tiles from the embedding cache. */
export function removeRegion(regionId: string): void {
  const regions = get(roiRegions);
  const target = regions.find(r => r.id === regionId);
  if (!target) return;

  // Find keys owned exclusively by this region
  const otherKeys = new Set<string>();
  for (const r of regions) {
    if (r.id !== regionId) {
      for (const k of r.chunkKeys) otherKeys.add(k);
    }
  }
  const exclusiveKeys = target.chunkKeys.filter(k => !otherKeys.has(k));

  // Evict exclusive tiles
  const src = get(zarrSource);
  if (src) {
    for (const k of exclusiveKeys) {
      src.embeddingCache.delete(k);
    }
    src.clearClassificationOverlays();
  }

  roiRegions.update(rs => rs.filter(r => r.id !== regionId));
}

/** Clear all regions and the entire embedding cache. */
export function clearAllRegions(): void {
  const src = get(zarrSource);
  if (src) {
    src.embeddingCache.clear();
    src.clearClassificationOverlays();
  }
  roiRegions.set([]);
  roiLoading.set(null);
}
```

**Step 2: Remove 'draw' from tools store**

In `apps/viewer/src/stores/tools.ts`, change:
```typescript
export type ToolId = 'similarity' | 'classifier' | 'segmenter' | 'draw';
```
to:
```typescript
export type ToolId = 'similarity' | 'classifier' | 'segmenter';
```

**Step 3: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build 2>&1 | tail -5`

This will likely have errors in files that still reference 'draw' — that's expected, we fix them in the next tasks.

**Step 4: Commit**

```bash
git add apps/viewer/src/stores/drawing.ts apps/viewer/src/stores/tools.ts
git commit -m "feat: ROI store with multi-region support, remove draw tool type"
```

---

### Task 5: Create RoiStrip component

**Files:**
- Create: `apps/viewer/src/components/RoiStrip.svelte`

This component lives above the tool tabs. It shows:
- Draw button (polygon/rectangle toggle)
- Loading progress bar
- Region badges with delete buttons
- Clear all button
- Tile count summary

**Step 1: Create the component**

Create `apps/viewer/src/components/RoiStrip.svelte`:

```svelte
<script lang="ts">
  import { Pencil, Square, X, Plus, Trash2 } from 'lucide-svelte';
  import { roiDrawing, drawMode, roiRegions, roiLoading, roiTileCount, clearAllRegions, removeRegion, type DrawMode } from '../stores/drawing';

  const modes: { id: DrawMode; icon: typeof Pencil; tip: string }[] = [
    { id: 'polygon',   icon: Pencil, tip: 'Polygon' },
    { id: 'rectangle', icon: Square, tip: 'Rectangle' },
  ];

  function startDrawing(mode: DrawMode) {
    $drawMode = mode;
    $roiDrawing = true;
  }

  function cancelDrawing() {
    $roiDrawing = false;
  }
</script>

<div class="px-3 py-2.5 border-b border-gray-800/60 space-y-2">
  {#if $roiDrawing}
    <!-- Drawing state -->
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-term-cyan animate-pulse">
        {$drawMode === 'polygon' ? 'Click to draw polygon...' : 'Drag to draw rectangle...'}
      </span>
      <button
        onclick={cancelDrawing}
        class="text-[9px] text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >Cancel</button>
    </div>
  {:else if $roiRegions.length === 0}
    <!-- Idle state — no regions -->
    <div class="flex items-center gap-1.5">
      <span class="text-[10px] text-gray-500 flex-1">Select region</span>
      {#each modes as m}
        <button
          onclick={() => startDrawing(m.id)}
          class="flex items-center gap-1 text-[10px] text-gray-400 hover:text-term-cyan
                 px-2 py-1.5 rounded border border-gray-700/60 hover:border-term-cyan/40 transition-all"
          title={m.tip}
        >
          <m.icon size={11} />
          {m.tip}
        </button>
      {/each}
    </div>
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region on the map to load embeddings for analysis.
    </div>
  {:else}
    <!-- Has regions -->
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-gray-400">
        {$roiRegions.length} region{$roiRegions.length !== 1 ? 's' : ''} &middot; {$roiTileCount} tiles
      </span>
      <div class="flex items-center gap-1">
        {#each modes as m}
          <button
            onclick={() => startDrawing(m.id)}
            class="text-gray-500 hover:text-term-cyan p-1 rounded
                   border border-gray-700/60 hover:border-term-cyan/40 transition-all"
            title="Add {m.tip.toLowerCase()}"
          >
            <Plus size={10} />
          </button>
        {/each}
        <button
          onclick={clearAllRegions}
          class="text-gray-500 hover:text-red-400 p-1 rounded
                 border border-gray-700/60 hover:border-red-400/40 transition-all"
          title="Clear all regions"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>

    <!-- Region badges -->
    <div class="flex flex-wrap gap-1">
      {#each $roiRegions as region}
        <span class="inline-flex items-center gap-1 text-[9px] text-gray-400
                     bg-gray-800/60 px-1.5 py-0.5 rounded border border-gray-700/40">
          {region.chunkKeys.length} tiles
          <button
            onclick={() => removeRegion(region.id)}
            class="text-gray-600 hover:text-red-400 transition-colors"
            title="Remove region"
          >
            <X size={8} />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <!-- Loading progress bar -->
  {#if $roiLoading}
    <div class="space-y-1">
      <div class="flex justify-between text-[9px]">
        <span class="text-term-cyan">Loading embeddings...</span>
        <span class="text-gray-500">{$roiLoading.loaded}/{$roiLoading.total}</span>
      </div>
      <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-term-cyan/70 rounded-full transition-all duration-300"
          style="width: {($roiLoading.loaded / $roiLoading.total) * 100}%"
        ></div>
      </div>
    </div>
  {/if}
</div>
```

**Step 2: Commit**

```bash
git add apps/viewer/src/components/RoiStrip.svelte
git commit -m "feat: RoiStrip component for ROI drawing and loading progress"
```

---

### Task 6: Wire RoiStrip into ToolSwitcher, remove Draw tab

**Files:**
- Modify: `apps/viewer/src/components/ToolSwitcher.svelte`
- Delete: `apps/viewer/src/components/DrawPanel.svelte`

**Step 1: Update ToolSwitcher**

In `apps/viewer/src/components/ToolSwitcher.svelte`:

1. Remove the `DrawPanel` import and `PenTool` icon import:
```typescript
// Remove these:
import { Search, Tags, Scan, PenTool } from 'lucide-svelte';
import DrawPanel from './DrawPanel.svelte';
```
Replace with:
```typescript
import { Search, Tags, Scan } from 'lucide-svelte';
import RoiStrip from './RoiStrip.svelte';
```

2. Remove the `draw` entry from the `tools` array:
```typescript
  const tools: { id: ToolId; label: string; icon: typeof Search }[] = [
    { id: 'similarity', label: 'Similar', icon: Search },
    { id: 'classifier', label: 'Classify', icon: Tags },
    { id: 'segmenter',  label: 'Segment', icon: Scan },
  ];
```

3. Remove the `DrawPanel` conditional in the template. Find:
```svelte
    {:else if $activeTool === 'draw'}
      <DrawPanel />
```
And remove those two lines.

4. Add `<RoiStrip />` above the tool tabs. Find the `<div class="flex border-b border-gray-800/60">` that contains the tab buttons and add `<RoiStrip />` before it:
```svelte
  <RoiStrip />

  <!-- Tool tabs -->
  <div class="flex border-b border-gray-800/60">
```

**Step 2: Delete DrawPanel**

```bash
rm apps/viewer/src/components/DrawPanel.svelte
```

**Step 3: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build 2>&1 | tail -5`

This may still fail due to App.svelte references to 'draw' — that's fixed in the next task.

**Step 4: Commit**

```bash
git add apps/viewer/src/components/ToolSwitcher.svelte
git rm apps/viewer/src/components/DrawPanel.svelte
git commit -m "feat: replace Draw tab with RoiStrip above tool tabs"
```

---

### Task 7: Update App.svelte — rewire terra-draw for ROI

**Files:**
- Modify: `apps/viewer/src/App.svelte`

This is the largest change. We need to:
1. Replace `drawMode, drawnFeatures` imports with ROI store imports
2. Change terra-draw activation from tool-based to `roiDrawing`-based
3. Wire finish event to `addRegion()` instead of `drawnFeatures.update()`
4. Remove the 'draw' cursor branch
5. Update instruction text references

**Step 1: Update imports**

Find:
```typescript
  import { drawMode, drawnFeatures } from './stores/drawing';
```
Replace with:
```typescript
  import { drawMode, roiDrawing, addRegion } from './stores/drawing';
```

Also, `simEmbeddingTileCount` is still used for the UMAP cloud. Keep that import. But we can also import `roiTileCount` for any future use:
```typescript
  import { roiTileCount } from './stores/drawing';
```

**Step 2: Update terra-draw finish handler**

Find the `draw.on('finish', ...)` in `map.on('load')`:
```typescript
      draw.on('finish', (id: string | number, ctx: { action: string }) => {
        if (ctx.action === 'draw') {
          const feat = draw.getSnapshotFeature(id);
          if (feat) {
            drawnFeatures.update(fs => [...fs, feat as GeoJSON.Feature]);
          }
        }
      });
```
Replace with:
```typescript
      draw.on('finish', (id: string | number, ctx: { action: string }) => {
        if (ctx.action === 'draw') {
          const feat = draw.getSnapshotFeature(id);
          if (feat) {
            addRegion(feat as GeoJSON.Feature);
            roiDrawing.set(false);
          }
        }
      });
```

**Step 3: Replace the terra-draw activation/deactivation effect**

Find the `$effect` that checks `$activeTool === 'draw'`:
```typescript
  // Activate/deactivate terra-draw based on active tool + draw mode
  $effect(() => {
    const draw = terraDraw;
    if (!draw) return;
    const tool = $activeTool;
    const mode = $drawMode;
    if (tool === 'draw') {
      if (!draw.enabled) {
        draw.start();
        // Restore previously drawn features
        const feats = get(drawnFeatures);
        if (feats.length > 0) {
          draw.addFeatures(feats as any);
        }
      }
      draw.setMode(mode);
    } else {
      if (draw.enabled) {
        draw.stop();
      }
    }
  });
```
Replace with:
```typescript
  // Activate/deactivate terra-draw based on roiDrawing store
  $effect(() => {
    const draw = terraDraw;
    if (!draw) return;
    const drawing = $roiDrawing;
    const mode = $drawMode;
    if (drawing) {
      if (!draw.enabled) draw.start();
      draw.setMode(mode);
    } else {
      if (draw.enabled) draw.stop();
    }
  });
```

**Step 4: Remove the drawnFeatures clearing effect**

Find and remove entirely:
```typescript
  // Clear terra-draw features when drawnFeatures is emptied (e.g. Clear button)
  $effect(() => {
    const feats = $drawnFeatures;
    const draw = terraDraw;
    if (draw && feats.length === 0) {
      draw.clear();
    }
  });
```

**Step 5: Remove 'draw' from cursor effect**

Find:
```typescript
    if ($activeTool === 'draw') {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'similarity') {
```
Replace with:
```typescript
    if ($roiDrawing) {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'similarity') {
```

**Step 6: Update the UMAP visibility**

The UMAP cloud uses `$simEmbeddingTileCount > 0` — this still works since `simEmbeddingTileCount` is updated from the `embeddings-loaded` event in SimilaritySearch.svelte. No change needed.

**Step 7: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build`
Expected: Success (all 'draw' references removed)

**Step 8: Commit**

```bash
git add apps/viewer/src/App.svelte
git commit -m "feat: rewire terra-draw for ROI workflow, remove draw tool"
```

---

### Task 8: Update help text in SimilaritySearch and SegmentPanel

**Files:**
- Modify: `apps/viewer/src/components/SimilaritySearch.svelte:100-103`
- Modify: `apps/viewer/src/components/SegmentPanel.svelte` (wherever it references double-click)

The instruction text currently says "Double-click a tile to load embeddings". Update to reference the ROI workflow.

**Step 1: Update SimilaritySearch help text**

Find (around line 100-103):
```svelte
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Double-click a tile to load embeddings, then click any pixel to find similar ones.
    </div>
```
Replace with:
```svelte
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region above to load embeddings, then click any pixel to find similar ones.
    </div>
```

**Step 2: Update SegmentPanel help text**

Search for any "double-click" or "Double-click" text in SegmentPanel and update similarly to reference drawing a region.

**Step 3: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build`
Expected: Success

**Step 4: Commit**

```bash
git add apps/viewer/src/components/SimilaritySearch.svelte apps/viewer/src/components/SegmentPanel.svelte
git commit -m "docs: update help text to reference ROI drawing workflow"
```

---

### Task 9: Display ROI region polygons on the map

**Files:**
- Modify: `apps/viewer/src/App.svelte`

Add a reactive `$effect` that syncs drawn ROI regions to a map GeoJSON layer, so users can see the boundaries of their selected regions.

**Step 1: Import roiRegions**

Add `roiRegions` to the import from `'./stores/drawing'`:
```typescript
  import { drawMode, roiDrawing, roiRegions, addRegion } from './stores/drawing';
```

**Step 2: Add a source + layer in `map.on('load')`**

After the segment polygon layers, before the terra-draw init, add:
```typescript
      // ROI region outlines
      map.addSource('roi-regions', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'roi-regions-fill',
        type: 'fill',
        source: 'roi-regions',
        paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'roi-regions-line',
        type: 'line',
        source: 'roi-regions',
        paint: { 'line-color': '#00e5ff', 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [4, 2] },
      });
```

**Step 3: Add reactive effect to sync regions**

Add after the existing segment polygon effect:
```typescript
  // Sync ROI regions to map overlay
  $effect(() => {
    const map = $mapInstance;
    const regions = $roiRegions;
    if (!map) return;
    const src = map.getSource('roi-regions') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: regions.map(r => r.feature),
      });
    }
  });
```

**Step 4: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build`
Expected: Success

**Step 5: Commit**

```bash
git add apps/viewer/src/App.svelte
git commit -m "feat: display ROI region boundaries on map"
```

---

### Task 10: Disable tool panels when no embeddings loaded

**Files:**
- Modify: `apps/viewer/src/components/ToolSwitcher.svelte`

Currently `enabled` is derived from `!!$metadata`. Add a check that at least one embedding tile is loaded.

**Step 1: Update the enabled check**

In ToolSwitcher.svelte, find:
```typescript
  const enabled = $derived(!!$metadata);
```

Import `roiTileCount`:
```typescript
  import { roiTileCount } from '../stores/drawing';
```

Update:
```typescript
  const hasMetadata = $derived(!!$metadata);
  const hasTiles = $derived($roiTileCount > 0);
```

Then in the template, the tab buttons should remain clickable (so you can switch tabs while waiting for tiles to load), but the tool panel content should show a message when no tiles are loaded. Find:
```svelte
<div class="transition-opacity" data-tutorial="tool-switcher"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
```
Replace with:
```svelte
<div class="transition-opacity" data-tutorial="tool-switcher"
     class:opacity-40={!hasMetadata} class:pointer-events-none={!hasMetadata}>
```

**Step 2: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build`
Expected: Success

**Step 3: Commit**

```bash
git add apps/viewer/src/components/ToolSwitcher.svelte
git commit -m "feat: tool panel gated on metadata, tiles loaded for analysis"
```

---

### Task 11: Final build verification and cleanup

**Files:**
- All changed files

**Step 1: Full build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm run build`
Expected: Success with no errors (a11y warnings are pre-existing and acceptable)

**Step 2: Check for stale references**

Search for any remaining references to the old patterns:
```bash
grep -rn "double.click\|dblclick\|longpress\|long.press\|DrawPanel\|'draw'" apps/viewer/src/ --include="*.ts" --include="*.svelte" | grep -v node_modules | grep -v '.d.ts'
```

Expected: No matches except possibly in comments, tutorial text, or terra-draw library imports.

**Step 3: Check for unused imports**

Verify `drawnFeatures` is not imported anywhere (it was removed from the store):
```bash
grep -rn "drawnFeatures" apps/viewer/src/ --include="*.ts" --include="*.svelte"
```

Expected: No matches.

**Step 4: Commit any final fixes**

If any cleanup was needed, commit with:
```bash
git commit -am "chore: cleanup stale references from ROI migration"
```
