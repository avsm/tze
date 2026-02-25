# Browser-Based KNN Classifier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add interactive tile labeling and KNN classification to the TZE viewer using TensorFlow.js, porting the tessera-interactive-map workflow to run entirely in the browser.

**Architecture:** Double-click tiles to fetch full 128-d embeddings into a cache. Click to place labeled training points (extracting the embedding vector at each pixel). Run `@tensorflow-models/knn-classifier` on all loaded tiles to produce per-pixel classification overlays rendered as RGBA canvases on the map.

**Tech Stack:** TensorFlow.js (tfjs-core + webgl backend), @tensorflow-models/knn-classifier, Svelte 5 stores, MapLibre GL JS image sources.

---

## Batch 1: Plugin Infrastructure (embedding cache + coordinate helpers)

### Task 1: Add new types for classification

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/types.ts`
- Modify: `packages/maplibre-zarr-tessera/src/index.ts`

**Step 1: Add types to types.ts**

Add after the `ZarrTesseraEvents` interface (line 67):

```typescript
export interface TileEmbeddings {
  ci: number;
  cj: number;
  emb: Int8Array;         // [h * w * nBands] raw embedding bytes
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
```

Add `'embeddings-loaded'` to `ZarrTesseraEvents`:

```typescript
export interface ZarrTesseraEvents {
  'metadata-loaded': StoreMetadata;
  'chunk-loaded': { ci: number; cj: number };
  'embeddings-loaded': { ci: number; cj: number };
  'error': Error;
  'loading': { total: number; done: number };
  'debug': DebugLogEntry;
}
```

**Step 2: Export new types from index.ts**

Add `TileEmbeddings` and `EmbeddingAt` to the type exports:

```typescript
export type {
  ZarrTesseraOptions,
  StoreMetadata,
  PreviewMode,
  ZarrTesseraEvents,
  DebugLogEntry,
  TileEmbeddings,
  EmbeddingAt,
} from './types.js';
```

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/types.ts packages/maplibre-zarr-tessera/src/index.ts
git commit -m "feat(plugin): add TileEmbeddings and EmbeddingAt types for classification"
```

---

### Task 2: Add embedding cache and coordinate methods to ZarrTesseraSource

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts`

This task adds 3 new public capabilities to `ZarrTesseraSource`:

1. `embeddingCache` — a public `Map<string, TileEmbeddings>` populated when full chunks load
2. `getChunkAtLngLat(lng, lat)` — returns `{ci, cj}` for a map coordinate
3. `getEmbeddingAt(lng, lat)` — returns the 128-d embedding vector at a pixel

**Step 1: Add import for new types**

In `zarr-source.ts` line 3-4, add `TileEmbeddings` and `EmbeddingAt` to the type import:

```typescript
import type {
  ZarrTesseraOptions, StoreMetadata, CachedChunk,
  ChunkBounds, UtmBounds, PreviewMode, ZarrTesseraEvents, DebugLogEntry,
  TileEmbeddings, EmbeddingAt,
} from './types.js';
```

**Step 2: Add embeddingCache field**

Add after `private clickedChunks` (line 22):

```typescript
  /** Cache of raw 128-d embeddings for tiles loaded via double-click. */
  public embeddingCache = new Map<string, TileEmbeddings>();
```

**Step 3: Populate embeddingCache in loadFullChunk()**

In the `loadFullChunk` method (line 155), after the worker returns and the cache is set (around line 193-198), add code to also populate `embeddingCache`. After `this.chunkCache.set(key, { ... })` add:

```typescript
    // Store raw embeddings for classification
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const embInt8 = new Int8Array(result.embRaw as ArrayBuffer);
    const scalesF32 = new Float32Array((result.scalesRaw as ArrayBuffer));
    this.embeddingCache.set(key, {
      ci, cj,
      emb: embInt8,
      scales: scalesF32,
      width: c1 - c0,
      height: r1 - r0,
      nBands: this.store!.meta.nBands,
    });
    this.debug('info', `Embeddings cached for chunk (${ci},${cj}): ${embInt8.length} bytes`);
    this.emit('embeddings-loaded', { ci, cj });
```

Note: `loadFullChunk` already slices `.buffer` on the worker result (lines 195-196 create `new Uint8Array(result.embRaw as ArrayBuffer)`). The worker returns the buffers via transfer. We need the Int8Array view for embeddings and Float32Array view for scales. The `result.embRaw` is the raw ArrayBuffer returned from the worker. Since the worker transfers it back, we need to read it before the chunkCache line consumes it. Place this code **before** the `this.chunkCache.set(key, {...})` line, and use the same buffer references.

Actually, more carefully: the existing code at line 195 does `new Uint8Array(result.embRaw as ArrayBuffer)` for the cache entry. We need to share the same underlying buffer. The cleanest approach: create the typed arrays first, then use them in both places.

Refactor `loadFullChunk` from the worker result onward (replace lines 193-199):

```typescript
    const embBuf = result.embRaw as ArrayBuffer;
    const scalesBuf = result.scalesRaw as ArrayBuffer;
    const embU8 = new Uint8Array(embBuf);
    const scalesU8 = new Uint8Array(scalesBuf);

    this.chunkCache.set(key, {
      ci, cj,
      embRaw: embU8,
      scalesRaw: scalesU8,
      canvas, sourceId, layerId, isPreview: false,
    });

    // Store typed views for classification
    this.embeddingCache.set(key, {
      ci, cj,
      emb: new Int8Array(embBuf),
      scales: new Float32Array(scalesBuf),
      width: w, height: h,
      nBands: this.store!.meta.nBands,
    });
    this.debug('info', `Embeddings cached for chunk (${ci},${cj})`);
    this.emit('embeddings-loaded', { ci, cj });
```

**Step 4: Add getChunkAtLngLat() method**

Add as a new public method after `loadFullChunk()`:

```typescript
  /** Given a map coordinate, return the chunk indices containing that point, or null. */
  getChunkAtLngLat(lng: number, lat: number): { ci: number; cj: number } | null {
    if (!this.store || !this.proj) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const col = Math.floor((e - originE) / px);
    const row = Math.floor((originN - n) / px);
    if (col < 0 || col >= s[1] || row < 0 || row >= s[0]) return null;

    const ci = Math.floor(row / cs[0]);
    const cj = Math.floor(col / cs[1]);
    return { ci, cj };
  }
```

**Step 5: Add getEmbeddingAt() method**

Add after `getChunkAtLngLat()`:

```typescript
  /** Extract the 128-d embedding vector at a map coordinate.
   *  Returns null if the chunk's embeddings haven't been loaded. */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null {
    if (!this.store || !this.proj) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const globalCol = Math.floor((e - originE) / px);
    const globalRow = Math.floor((originN - n) / px);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;

    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    const key = this.chunkKey(ci, cj);
    const tile = this.embeddingCache.get(key);
    if (!tile) return null;

    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= tile.height || col < 0 || col >= tile.width) return null;

    // Check scale validity
    const pixelIdx = row * tile.width + col;
    const scale = tile.scales[pixelIdx];
    if (!scale || isNaN(scale)) return null;

    // Extract embedding vector
    const nBands = tile.nBands;
    const offset = pixelIdx * nBands;
    const embedding = new Float32Array(nBands);
    for (let b = 0; b < nBands; b++) {
      embedding[b] = tile.emb[offset + b];
    }

    return { embedding, ci, cj, row, col };
  }
```

**Step 6: Add getEmbeddingsInKernel() method**

Add after `getEmbeddingAt()`. This supports kernel-sized labeling (NxN pixels around a click):

```typescript
  /** Extract embeddings for all valid pixels in a kernel around a map coordinate. */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): EmbeddingAt[] {
    if (!this.store || !this.proj) return [];
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const centerCol = Math.floor((e - originE) / px);
    const centerRow = Math.floor((originN - n) / px);
    const radius = Math.floor((kernelSize - 1) / 2);
    const results: EmbeddingAt[] = [];

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const gr = centerRow + dr;
        const gc = centerCol + dc;
        if (gr < 0 || gr >= s[0] || gc < 0 || gc >= s[1]) continue;

        const ci = Math.floor(gr / cs[0]);
        const cj = Math.floor(gc / cs[1]);
        const key = this.chunkKey(ci, cj);
        const tile = this.embeddingCache.get(key);
        if (!tile) continue;

        const row = gr - ci * cs[0];
        const col = gc - cj * cs[1];
        const pixelIdx = row * tile.width + col;
        const scale = tile.scales[pixelIdx];
        if (!scale || isNaN(scale)) continue;

        const nBands = tile.nBands;
        const offset = pixelIdx * nBands;
        const embedding = new Float32Array(nBands);
        for (let b = 0; b < nBands; b++) {
          embedding[b] = tile.emb[offset + b];
        }
        results.push({ embedding, ci, cj, row, col });
      }
    }
    return results;
  }
```

**Step 7: Add dblclick handler in addTo()**

In the `addTo()` method, after the `moveend` listener (line 64-65), add a `dblclick` handler:

```typescript
      // Double-click to load full embeddings for a tile
      map.on('dblclick', (e) => {
        e.preventDefault();
        const chunk = this.getChunkAtLngLat(e.lngLat.lng, e.lngLat.lat);
        if (!chunk) return;
        const key = this.chunkKey(chunk.ci, chunk.cj);
        if (this.embeddingCache.has(key)) {
          this.debug('info', `Chunk (${chunk.ci},${chunk.cj}) embeddings already loaded`);
          return;
        }
        this.debug('fetch', `Double-click: loading embeddings for chunk (${chunk.ci},${chunk.cj})`);
        this.loadFullChunk(chunk.ci, chunk.cj);
      });
```

**Step 8: Add classification overlay methods**

Add after `getEmbeddingsInKernel()`:

```typescript
  /** Add a classification RGBA canvas as a map layer for a chunk. */
  addClassificationOverlay(ci: number, cj: number, canvas: HTMLCanvasElement): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);
    const sourceId = `zarr-class-src-${key}`;
    const layerId = `zarr-class-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const dataUrl = canvas.toDataURL('image/png');

    // Remove existing classification overlay for this chunk
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
    });

    // Keep grid/UTM overlays on top
    if (this.map.getLayer('chunk-grid-lines')) this.map.moveLayer('chunk-grid-lines');
    if (this.map.getLayer('utm-zone-line')) this.map.moveLayer('utm-zone-line');
    this.debug('overlay', `Classification overlay added for chunk (${ci},${cj})`);
  }

  /** Remove all classification overlays from the map. */
  clearClassificationOverlays(): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    const classLayers = style.layers.filter(l => l.id.startsWith('zarr-class-lyr-'));
    for (const layer of classLayers) {
      this.map.removeLayer(layer.id);
      const srcId = layer.id.replace('zarr-class-lyr-', 'zarr-class-src-');
      if (this.map.getSource(srcId)) this.map.removeSource(srcId);
    }
    this.debug('overlay', 'Cleared all classification overlays');
  }

  /** Set opacity on all classification overlay layers. */
  setClassificationOpacity(opacity: number): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-class-lyr-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', opacity);
      }
    }
  }
```

**Step 9: Clean up embeddingCache in remove()**

In the `remove()` method (line 75), add `this.embeddingCache.clear()` before `this.chunkCache.clear()`:

```typescript
    this.embeddingCache.clear();
```

**Step 10: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts
git commit -m "feat(plugin): add embedding cache, coordinate lookup, and classification overlay API"
```

---

## Batch 2: TensorFlow.js Dependencies + Classifier Store

### Task 3: Install TensorFlow.js dependencies

**Files:**
- Modify: `apps/viewer/package.json`

**Step 1: Install packages**

```bash
cd apps/viewer
pnpm add @tensorflow/tfjs-core @tensorflow/tfjs-backend-webgl @tensorflow-models/knn-classifier
```

**Step 2: Verify**

```bash
pnpm build
```

Should complete without errors. If there are type issues with TF.js, add `"skipLibCheck": true` to `apps/viewer/tsconfig.json`.

**Step 3: Commit**

```bash
git add apps/viewer/package.json ../../pnpm-lock.yaml
git commit -m "deps(viewer): add TensorFlow.js and KNN classifier"
```

---

### Task 4: Create classifier store

**Files:**
- Create: `apps/viewer/src/stores/classifier.ts`

This store manages all labeling + classification state.

**Step 1: Create the store**

```typescript
import { writable, derived, get } from 'svelte/store';
import type { EmbeddingAt } from '@ucam-eo/maplibre-zarr-tessera';

export interface ClassDef {
  name: string;
  color: string;  // hex color
  id: number;
}

export interface LabelPoint {
  lngLat: [number, number];
  ci: number;
  cj: number;
  row: number;
  col: number;
  classId: number;
  embedding: Float32Array;
}

// --- Stores ---
export const classes = writable<ClassDef[]>([]);
export const labels = writable<LabelPoint[]>([]);
export const activeClassName = writable<string | null>(null);
export const kernelSize = writable(1);
export const kValue = writable(5);
export const confidenceThreshold = writable(0.5);
export const classificationOpacity = writable(0.7);
export const isClassified = writable(false);

// Next class ID counter
let nextClassId = 0;

// --- Derived ---
export const activeClass = derived(
  [classes, activeClassName],
  ([$classes, $name]) => $classes.find(c => c.name === $name) ?? null
);

export const labelCounts = derived(labels, ($labels) => {
  const counts = new Map<number, number>();
  for (const l of $labels) {
    counts.set(l.classId, (counts.get(l.classId) ?? 0) + 1);
  }
  return counts;
});

// --- Actions ---
export function addClass(name: string, color: string): void {
  const id = nextClassId++;
  classes.update(cs => [...cs, { name, color, id }]);
  activeClassName.set(name);
}

export function removeClass(name: string): void {
  classes.update(cs => cs.filter(c => c.name !== name));
  labels.update(ls => {
    const cls = get(classes);
    const removed = cls.find(c => c.name === name);
    if (!removed) return ls;
    return ls.filter(l => l.classId !== removed.id);
  });
  activeClassName.update(n => n === name ? null : n);
}

export function addLabel(
  lngLat: [number, number],
  embeddingAt: EmbeddingAt,
  classId: number,
): void {
  labels.update(ls => [...ls, {
    lngLat,
    ci: embeddingAt.ci,
    cj: embeddingAt.cj,
    row: embeddingAt.row,
    col: embeddingAt.col,
    classId,
    embedding: embeddingAt.embedding,
  }]);
}

export function removeLabel(index: number): void {
  labels.update(ls => ls.filter((_, i) => i !== index));
}

export function clearLabels(): void {
  labels.set([]);
  isClassified.set(false);
}

export function exportLabelsJson(): string {
  const cs = get(classes);
  const ls = get(labels);
  return JSON.stringify({
    classes: cs,
    labels: ls.map(l => ({
      lngLat: l.lngLat,
      ci: l.ci, cj: l.cj,
      row: l.row, col: l.col,
      classId: l.classId,
      // embedding not exported — re-fetched on import
    })),
    k: get(kValue),
    confidenceThreshold: get(confidenceThreshold),
  }, null, 2);
}
```

**Step 2: Commit**

```bash
git add apps/viewer/src/stores/classifier.ts
git commit -m "feat(viewer): add classifier store for labeling and classification state"
```

---

### Task 5: Create KNN classification runner

**Files:**
- Create: `apps/viewer/src/lib/classify.ts`

This module wraps TF.js KNN classifier. It runs classification on the main thread (KNN on 128-d embeddings is fast enough).

**Step 1: Create the module**

```typescript
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import * as knnClassifier from '@tensorflow-models/knn-classifier';
import type { TileEmbeddings } from '@ucam-eo/maplibre-zarr-tessera';
import type { LabelPoint, ClassDef } from '../stores/classifier';

export interface ClassificationResult {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement;
  stats: { total: number; classified: number; uncertain: number };
}

/** Classify all pixels in loaded tiles using KNN on labeled embeddings. */
export async function classifyTiles(
  embeddingCache: Map<string, TileEmbeddings>,
  labelPoints: LabelPoint[],
  classDefs: ClassDef[],
  k: number,
  confidenceThreshold: number,
): Promise<ClassificationResult[]> {
  await tf.ready();

  const classifier = knnClassifier.create();

  // Build class color lookup
  const colorMap = new Map<number, [number, number, number]>();
  for (const cls of classDefs) {
    const hex = cls.color.replace('#', '');
    colorMap.set(cls.id, [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ]);
  }

  // Add training examples
  for (const lp of labelPoints) {
    const tensor = tf.tensor1d(Array.from(lp.embedding));
    classifier.addExample(tensor, lp.classId);
    tensor.dispose();
  }

  const results: ClassificationResult[] = [];

  for (const [, tile] of embeddingCache) {
    const { ci, cj, emb, scales, width, height, nBands } = tile;
    const rgba = new Uint8ClampedArray(width * height * 4);
    let classified = 0;
    let uncertain = 0;
    let total = 0;

    // Process pixels in batches to avoid tensor leak
    const BATCH = 256;
    const validIndices: number[] = [];
    const validEmbeddings: number[][] = [];

    for (let i = 0; i < width * height; i++) {
      const scale = scales[i];
      if (!scale || isNaN(scale) || scale === 0) continue;
      total++;
      const offset = i * nBands;
      const vec: number[] = new Array(nBands);
      for (let b = 0; b < nBands; b++) vec[b] = emb[offset + b];
      validIndices.push(i);
      validEmbeddings.push(vec);
    }

    // Classify in batches
    for (let b = 0; b < validIndices.length; b += BATCH) {
      const batchEnd = Math.min(b + BATCH, validIndices.length);
      const batchPromises: Promise<{ classIndex: number; confidences: Record<string, number> }>[] = [];

      for (let j = b; j < batchEnd; j++) {
        const tensor = tf.tensor1d(validEmbeddings[j]);
        batchPromises.push(
          classifier.predictClass(tensor, k).then(pred => {
            tensor.dispose();
            return pred;
          })
        );
      }

      const predictions = await Promise.all(batchPromises);

      for (let j = 0; j < predictions.length; j++) {
        const pred = predictions[j];
        const pixelIdx = validIndices[b + j];
        const classId = parseInt(pred.label ?? String(pred.classIndex));
        const confidence = pred.confidences[classId] ?? 0;
        const rgbaIdx = pixelIdx * 4;

        if (confidence >= confidenceThreshold) {
          const color = colorMap.get(classId) ?? [128, 128, 128];
          rgba[rgbaIdx] = color[0];
          rgba[rgbaIdx + 1] = color[1];
          rgba[rgbaIdx + 2] = color[2];
          rgba[rgbaIdx + 3] = 200;
          classified++;
        } else {
          // Uncertain: grey with lower alpha
          rgba[rgbaIdx] = 128;
          rgba[rgbaIdx + 1] = 128;
          rgba[rgbaIdx + 2] = 128;
          rgba[rgbaIdx + 3] = 80;
          uncertain++;
        }
      }
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);

    results.push({ ci, cj, canvas, stats: { total, classified, uncertain } });
  }

  classifier.dispose();
  return results;
}
```

**Step 2: Commit**

```bash
git add apps/viewer/src/lib/classify.ts
git commit -m "feat(viewer): add KNN classification runner using TensorFlow.js"
```

---

## Batch 3: UI Components

### Task 6: Create LabelPanel component

**Files:**
- Create: `apps/viewer/src/components/LabelPanel.svelte`

**Step 1: Create the component**

```svelte
<script lang="ts">
  import { zarrSource, metadata } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import {
    classes, labels, activeClassName, activeClass, kernelSize,
    kValue, confidenceThreshold, classificationOpacity, isClassified,
    labelCounts, addClass, removeClass, clearLabels,
  } from '../stores/classifier';
  import { classifyTiles } from '../lib/classify';

  let newClassName = $state('');
  let newClassColor = $state('#3b82f6');
  let isClassifying = $state(false);
  let expanded = $state(true);

  const enabled = $derived(!!$metadata);
  const hasEnoughLabels = $derived(() => {
    const uniqueClasses = new Set($labels.map(l => l.classId));
    return $labels.length >= 2 && uniqueClasses.size >= 2;
  });

  function handleAddClass() {
    const name = newClassName.trim();
    if (!name || $classes.some(c => c.name === name)) return;
    addClass(name, newClassColor);
    newClassName = '';
    // Rotate to next default color
    const colors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];
    const idx = $classes.length % colors.length;
    newClassColor = colors[idx];
  }

  function selectClass(name: string) {
    $activeClassName = $activeClassName === name ? null : name;
  }

  async function runClassification() {
    const source = $zarrSource;
    if (!source || isClassifying) return;
    isClassifying = true;

    try {
      source.clearClassificationOverlays();
      const results = await classifyTiles(
        source.embeddingCache,
        $labels,
        $classes,
        $kValue,
        $confidenceThreshold,
      );

      for (const r of results) {
        source.addClassificationOverlay(r.ci, r.cj, r.canvas);
      }
      source.setClassificationOpacity($classificationOpacity);
      $isClassified = true;
    } finally {
      isClassifying = false;
    }
  }

  function handleClear() {
    $zarrSource?.clearClassificationOverlays();
    $isClassified = false;
  }

  function updateClassificationOpacity(val: number) {
    $classificationOpacity = val;
    $zarrSource?.setClassificationOpacity(val);
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>

  <!-- Header toggle -->
  <button onclick={() => expanded = !expanded}
          class="flex items-center gap-2 w-full text-left cursor-pointer">
    <span class="text-gray-600 text-[10px]">{expanded ? '▼' : '▶'}</span>
    <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Classifier</span>
    {#if $labels.length > 0}
      <span class="text-gray-600 text-[10px] ml-auto tabular-nums">{$labels.length} pts</span>
    {/if}
  </button>

  {#if expanded}
    <div class="mt-2 space-y-3">

      <!-- Class list -->
      {#if $classes.length > 0}
        <div class="space-y-1">
          {#each $classes as cls}
            {@const count = $labelCounts.get(cls.id) ?? 0}
            <button
              onclick={() => selectClass(cls.name)}
              class="flex items-center gap-2 w-full text-left px-2 py-1 rounded transition-all
                     {$activeClassName === cls.name
                       ? 'bg-gray-800/80 border border-term-cyan/40'
                       : 'hover:bg-gray-900/50 border border-transparent'}"
            >
              <span class="w-3 h-3 rounded-sm shrink-0" style="background: {cls.color}"></span>
              <span class="text-[11px] text-gray-300 truncate flex-1">{cls.name}</span>
              <span class="text-[10px] text-gray-600 tabular-nums">{count}</span>
              <button
                onclick|stopPropagation={() => removeClass(cls.name)}
                class="text-gray-700 hover:text-red-400 text-[10px] transition-colors"
              >x</button>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Add class -->
      <div class="flex gap-1.5 items-center">
        <input
          type="text"
          bind:value={newClassName}
          placeholder="Class name"
          onkeydown={(e) => e.key === 'Enter' && handleAddClass()}
          class="flex-1 bg-gray-950 border border-gray-700/60 rounded px-2 py-1
                 text-gray-300 text-[11px] focus:border-term-cyan/60 focus:outline-none
                 transition-all placeholder-gray-700"
        />
        <input
          type="color"
          bind:value={newClassColor}
          class="w-6 h-6 rounded border border-gray-700/60 cursor-pointer bg-transparent"
        />
        <button
          onclick={handleAddClass}
          class="text-[10px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
                 border border-gray-700/60 hover:border-term-cyan/40 transition-all"
        >+</button>
      </div>

      <!-- Active class indicator -->
      {#if $activeClass}
        <div class="text-[10px] text-gray-500">
          Labeling: <span class="text-gray-300" style="color: {$activeClass.color}">{$activeClass.name}</span>
          <span class="text-gray-700"> — click map to label</span>
        </div>
      {:else if $classes.length > 0}
        <div class="text-[10px] text-gray-600 italic">Select a class to start labeling</div>
      {/if}

      <!-- Kernel size -->
      <div>
        <span class="text-gray-600 text-[10px]">Kernel</span>
        <div class="flex gap-1 mt-1">
          {#each [1, 3, 5, 7, 9] as size}
            <button
              onclick={() => $kernelSize = size}
              class="flex-1 text-[10px] font-bold py-0.5 rounded border transition-all
                     {$kernelSize === size
                       ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                       : 'bg-gray-950 text-gray-600 border-gray-700/60 hover:text-gray-400'}"
            >{size}</button>
          {/each}
        </div>
      </div>

      <!-- k value -->
      <div class="flex items-center gap-2">
        <span class="text-gray-600 text-[10px] w-6">k</span>
        <input type="range" min="1" max="15" bind:value={$kValue}
               class="flex-1 h-1" />
        <span class="text-gray-500 text-[10px] tabular-nums w-4 text-right">{$kValue}</span>
      </div>

      <!-- Confidence threshold -->
      <div class="flex items-center gap-2">
        <span class="text-gray-600 text-[10px] shrink-0">Conf</span>
        <input type="range" min="0" max="100" value={Math.round($confidenceThreshold * 100)}
               oninput={(e) => $confidenceThreshold = parseInt((e.target as HTMLInputElement).value) / 100}
               class="flex-1 h-1" />
        <span class="text-gray-500 text-[10px] tabular-nums w-8 text-right">{$confidenceThreshold.toFixed(2)}</span>
      </div>

      <!-- Classification opacity (shown when classified) -->
      {#if $isClassified}
        <div class="flex items-center gap-2">
          <span class="text-gray-600 text-[10px] shrink-0">Cls α</span>
          <input type="range" min="0" max="100" value={Math.round($classificationOpacity * 100)}
                 oninput={(e) => updateClassificationOpacity(parseInt((e.target as HTMLInputElement).value) / 100)}
                 class="flex-1 h-1" />
          <span class="text-gray-500 text-[10px] tabular-nums w-8 text-right">{$classificationOpacity.toFixed(2)}</span>
        </div>
      {/if}

      <!-- Actions -->
      <div class="flex gap-1.5">
        <button
          onclick={runClassification}
          disabled={!hasEnoughLabels() || isClassifying}
          class="flex-1 bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
                 px-3 py-1.5 rounded tracking-wider transition-all
                 hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
                 disabled:opacity-40 disabled:pointer-events-none"
        >
          {isClassifying ? 'CLASSIFYING...' : 'CLASSIFY'}
        </button>
        <button
          onclick={handleClear}
          class="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
                 border border-gray-700/60 hover:border-red-400/40 transition-all"
        >CLEAR</button>
      </div>

      <!-- Help text -->
      <div class="text-[9px] text-gray-700 leading-relaxed">
        Double-click tile to load embeddings, then click to label.
        Needs 2+ points in 2+ classes to classify.
      </div>
    </div>
  {/if}
</div>
```

**Step 2: Commit**

```bash
git add apps/viewer/src/components/LabelPanel.svelte
git commit -m "feat(viewer): add LabelPanel component for class management and classification controls"
```

---

### Task 7: Wire up LabelPanel and map click handlers in App.svelte

**Files:**
- Modify: `apps/viewer/src/App.svelte`

**Step 1: Add imports**

Add LabelPanel import and classifier store imports to the `<script>` block:

```typescript
  import LabelPanel from './components/LabelPanel.svelte';
  import { activeClass, kernelSize, addLabel, labels, classes } from './stores/classifier';
  import type { LabelPoint } from './stores/classifier';
```

**Step 2: Add label marker state and click handler**

Add after the imports, before `let mapContainer`:

```typescript
  let labelMarkers: maplibregl.Marker[] = $state([]);
```

Add after the `onMount` block's `map.on('load', ...)` handler (after line 33), inside the `onMount`:

```typescript
    // Map click for labeling
    map.on('click', (e) => {
      const src = $zarrSource;
      const cls = $activeClass;
      if (!src || !cls) return;

      const embeddings = src.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, $kernelSize);
      if (embeddings.length === 0) return;

      for (const emb of embeddings) {
        addLabel([e.lngLat.lng, e.lngLat.lat], emb, cls.id);
      }

      // Add visual marker at click location
      const marker = new maplibregl.Marker({
        color: cls.color,
        scale: 0.5,
      })
        .setLngLat(e.lngLat)
        .addTo(map);
      labelMarkers.push(marker);
    });
```

**Step 3: Add LabelPanel to the control panel layout**

In the template, add `<LabelPanel />` after `<ControlPanel />` (line 63):

```svelte
  <ControlPanel />
  <LabelPanel />
  <InfoPanel />
```

**Step 4: Update cursor when labeling is active**

Add an `$effect` in the `<script>` block to change cursor style:

```typescript
  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    canvas.style.cursor = $activeClass ? 'crosshair' : '';
  });
```

**Step 5: Commit**

```bash
git add apps/viewer/src/App.svelte
git commit -m "feat(viewer): wire up map click labeling and LabelPanel in App"
```

---

## Batch 4: Polish and Integration

### Task 8: Add scrollable control panel

The control panel is getting tall. Make it scrollable.

**Files:**
- Modify: `apps/viewer/src/App.svelte`

**Step 1: Add max-height and overflow to the control panel container**

Change the control panel `<div>` (around line 48) to add scroll:

```svelte
<div class="absolute top-4 right-4 w-[280px] max-h-[calc(100vh-2rem)] bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs">
```

The key change: add `max-h-[calc(100vh-2rem)]` and change `overflow-hidden` to `overflow-y-auto`.

**Step 2: Commit**

```bash
git add apps/viewer/src/App.svelte
git commit -m "fix(viewer): make control panel scrollable for small viewports"
```

---

### Task 9: Build verification and manual test

**Step 1: Build the project**

```bash
cd /path/to/tze
pnpm build
```

Expected: clean build, no type errors.

**Step 2: Run dev server**

```bash
cd apps/viewer
pnpm dev
```

**Step 3: Manual smoke test**

1. Load a Zarr store URL
2. Double-click a tile → should see "Embeddings cached" in debug console
3. Add two classes (e.g. "Water" blue, "Land" green)
4. Select "Water", click on water pixels → colored markers appear
5. Select "Land", click on land pixels → markers appear
6. Click CLASSIFY → tiles should show colored overlay
7. Adjust confidence slider → grey/colored distribution changes
8. Click CLEAR → overlays removed

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(viewer): browser-based KNN tile classification with TF.js

Complete labeling workflow:
- Double-click tiles to load 128-d embeddings
- Click to place labeled training points with kernel support
- KNN classification via @tensorflow-models/knn-classifier
- Per-tile classification overlay with confidence threshold"
```

---

## Summary

| Batch | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Plugin types + embedding cache + coordinate methods + dblclick handler |
| 2 | 3-5 | TF.js deps + classifier store + KNN runner |
| 3 | 6-7 | LabelPanel UI + App.svelte wiring |
| 4 | 8-9 | Scrollable panel + build verify + smoke test |

Total: 9 tasks, ~4 batches. Each batch produces a working, committable state.
