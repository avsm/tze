# Tessera-Tasks Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract similarity/classification/segmentation algorithms from `apps/viewer` into a reusable `@ucam-eo/tessera-tasks` library package, including bundled ONNX model and ORT WASM vite plugin.

**Architecture:** New `packages/tessera-tasks/` package built with Vite library mode. Exports three analysis modules (similarity, classify, segment) plus a Vite plugin. The viewer app imports from this package instead of local `lib/` files. `ClassDef`/`LabelPoint` types move to tessera-tasks; `segment.ts` module-level cache becomes a `SegmentationSession` class.

**Tech Stack:** TypeScript, Vite (library mode), vitest, TensorFlow.js, ONNX Runtime Web, pnpm workspaces

---

### Task 1: Scaffold `packages/tessera-tasks` package

**Files:**
- Create: `packages/tessera-tasks/package.json`
- Create: `packages/tessera-tasks/tsconfig.json`
- Create: `packages/tessera-tasks/vite.config.ts`
- Create: `packages/tessera-tasks/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@ucam-eo/tessera-tasks",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./vite": {
      "types": "./dist/vite-plugin.d.ts",
      "import": "./dist/vite-plugin.js",
      "require": "./dist/vite-plugin.cjs"
    },
    "./models/*": "./dist/models/*"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "test": "vitest run",
    "check": "tsc --noEmit"
  },
  "peerDependencies": {
    "@tensorflow/tfjs-core": ">=4.0.0",
    "@tensorflow/tfjs-backend-webgl": ">=4.0.0",
    "onnxruntime-web": ">=1.20.0"
  },
  "dependencies": {
    "@ucam-eo/maplibre-zarr-tessera": "workspace:*"
  },
  "devDependencies": {
    "@tensorflow/tfjs-core": "^4.22.0",
    "@tensorflow/tfjs-backend-webgl": "^4.22.0",
    "onnxruntime-web": "^1.24.2",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]
  },
  "include": ["src"]
}
```

**Step 3: Create vite.config.ts**

Two entry points: main library (externalises tfjs/onnx/maplibre-zarr-tessera) and vite-plugin (Node-only, separate entry).

```typescript
import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: './src/index.ts',
        'vite-plugin': './src/vite-plugin.ts',
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        '@ucam-eo/maplibre-zarr-tessera',
        '@tensorflow/tfjs-core',
        '@tensorflow/tfjs-backend-webgl',
        'onnxruntime-web',
        'path',
        'fs',
        'vite',
      ],
    },
  },
  plugins: [
    {
      name: 'copy-models',
      closeBundle() {
        const destDir = path.resolve(__dirname, 'dist/models');
        const srcDir = path.resolve(__dirname, 'models');
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        for (const file of ['solar_unet.onnx', 'solar_unet_stats.json']) {
          const src = path.join(srcDir, file);
          if (existsSync(src)) cpSync(src, path.join(destDir, file));
        }
      },
    },
  ],
});
```

**Step 4: Create empty `src/index.ts`**

```typescript
// @ucam-eo/tessera-tasks — analysis algorithms for TESSERA embeddings
```

**Step 5: Run `pnpm install` from root to wire up workspace**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install`
Expected: Lockfile updates, workspace link created

**Step 6: Commit**

```bash
git add packages/tessera-tasks/
git commit -m "feat: scaffold @ucam-eo/tessera-tasks package"
```

---

### Task 2: Move similarity module into tessera-tasks

**Files:**
- Create: `packages/tessera-tasks/src/similarity.ts`
- Modify: `packages/tessera-tasks/src/index.ts`

**Step 1: Copy similarity.ts**

Copy `apps/viewer/src/lib/similarity.ts` to `packages/tessera-tasks/src/similarity.ts`. No changes needed — it already imports only from `@ucam-eo/maplibre-zarr-tessera`.

**Step 2: Export from index.ts**

```typescript
export {
  computeSimilarityScores,
  renderSimilarityCanvas,
  type SimilarityResult,
} from './similarity.js';
```

**Step 3: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/tessera-tasks build`
Expected: Builds without errors

**Step 4: Commit**

```bash
git add packages/tessera-tasks/src/similarity.ts packages/tessera-tasks/src/index.ts
git commit -m "feat(tessera-tasks): add similarity module"
```

---

### Task 3: Move classification module into tessera-tasks

**Files:**
- Create: `packages/tessera-tasks/src/classify.ts`
- Modify: `packages/tessera-tasks/src/index.ts`

**Step 1: Copy classify.ts and extract types**

Copy `apps/viewer/src/lib/classify.ts` to `packages/tessera-tasks/src/classify.ts`.

Change the import line:
```typescript
// BEFORE:
import type { LabelPoint, ClassDef } from '../stores/classifier';

// AFTER: define types locally in this file
```

Add the type definitions at the top of the file (after the existing imports):

```typescript
export interface ClassDef {
  name: string;
  color: string;
  id: number;
}

export type LabelSource = 'human' | 'osm';

export interface LabelPoint {
  lngLat: [number, number];
  ci: number;
  cj: number;
  row: number;
  col: number;
  classId: number;
  embedding: Float32Array;
  source: LabelSource;
}
```

Remove the old import of `LabelPoint, ClassDef` from `'../stores/classifier'`.

**Step 2: Update index.ts exports**

Add to `packages/tessera-tasks/src/index.ts`:

```typescript
export {
  classifyTiles,
  type ClassDef,
  type LabelSource,
  type LabelPoint,
  type ClassificationResult,
  type ClassifyProgress,
  type OnBatchUpdate,
} from './classify.js';
```

**Step 3: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/tessera-tasks build`
Expected: Builds without errors

**Step 4: Commit**

```bash
git add packages/tessera-tasks/src/classify.ts packages/tessera-tasks/src/index.ts
git commit -m "feat(tessera-tasks): add classification module with ClassDef/LabelPoint types"
```

---

### Task 4: Move segmentation module into tessera-tasks as SegmentationSession

**Files:**
- Create: `packages/tessera-tasks/src/segment.ts`
- Copy: `apps/viewer/public/models/` → `packages/tessera-tasks/models/`
- Modify: `packages/tessera-tasks/src/index.ts`

**Step 1: Copy model files**

```bash
mkdir -p packages/tessera-tasks/models
cp apps/viewer/public/models/solar_unet.onnx packages/tessera-tasks/models/
cp apps/viewer/public/models/solar_unet_stats.json packages/tessera-tasks/models/
```

**Step 2: Create segment.ts with SegmentationSession class**

Copy `apps/viewer/src/lib/segment.ts` to `packages/tessera-tasks/src/segment.ts` and refactor:

1. Remove module-level `import.meta.env.BASE_URL` usage — accept paths via constructor/method params
2. Convert module-level `cachedSession`, `cachedStats`, `probabilityCache` into instance fields on a `SegmentationSession` class
3. Move `runSolarSegmentation` → `SegmentationSession.run()`
4. Move `rethreshold` → `SegmentationSession.rethreshold()`
5. Move `clearSegmentation` → `SegmentationSession.clear()`
6. Move `hasCachedProbabilities` → `SegmentationSession.hasCachedProbabilities` getter
7. Keep `polygonizeMask` and `traceContour` as private module-level helpers (unchanged)
8. The ORT WASM path configuration (`ort.env.wasm.wasmPaths`, `ort.env.wasm.numThreads`) should be set in `run()` before creating the session, using a `wasmPaths` option

The class constructor accepts an options object:

```typescript
export interface SegmentationSessionOptions {
  modelUrl: string;      // URL to solar_unet.onnx
  statsUrl: string;      // URL to solar_unet_stats.json
  wasmPaths?: string;    // ORT WASM path prefix (default: undefined = ORT default)
}

export class SegmentationSession {
  private opts: SegmentationSessionOptions;
  private session: ort.InferenceSession | null = null;
  private stats: ModelStats | null = null;
  private probabilityCache = new Map<string, { ... }>();

  constructor(opts: SegmentationSessionOptions) { this.opts = opts; }

  async run(region, source, threshold?, onProgress?): Promise<SegmentResult[]> { ... }
  rethreshold(threshold: number): SegmentResult[] { ... }
  clear(): void { ... }
  get hasCachedProbabilities(): boolean { ... }
}
```

Move the ORT config (`ort.env.wasm.wasmPaths`, `ort.env.wasm.numThreads = 1`) into the `run()` method, before creating the inference session, using `this.opts.wasmPaths`.

**Step 3: Update index.ts exports**

Add to `packages/tessera-tasks/src/index.ts`:

```typescript
export {
  SegmentationSession,
  type SegmentationSessionOptions,
  type SegmentResult,
} from './segment.js';
```

**Step 4: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/tessera-tasks build`
Expected: Builds without errors, `dist/models/` contains ONNX files

**Step 5: Commit**

```bash
git add packages/tessera-tasks/src/segment.ts packages/tessera-tasks/src/index.ts packages/tessera-tasks/models/
git commit -m "feat(tessera-tasks): add segmentation module as SegmentationSession class"
```

---

### Task 5: Move ORT WASM vite plugin into tessera-tasks

**Files:**
- Create: `packages/tessera-tasks/src/vite-plugin.ts`

**Step 1: Create vite-plugin.ts**

Extract the `ortWasmPlugin` from `apps/viewer/vite.config.ts` into a standalone module. Generalise directory resolution: instead of hardcoding `__dirname`, resolve relative to the consuming app's root (Vite provides this).

```typescript
import path from 'path';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import type { Plugin } from 'vite';

export function ortWasmPlugin(): Plugin {
  let destDir: string;

  return {
    name: 'tessera-tasks-ort-wasm',
    configResolved(config) {
      destDir = path.resolve(config.root, 'public/ort-wasm');
    },
    buildStart() {
      // Find onnxruntime-web dist relative to this file or via require.resolve
      const ortEntry = require.resolve('onnxruntime-web');
      const srcDir = path.resolve(path.dirname(ortEntry), 'dist');
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      for (const file of [
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.jsep.mjs',
      ]) {
        const src = path.join(srcDir, file);
        if (existsSync(src)) cpSync(src, path.join(destDir, file));
      }
    },
    configureServer(server) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = req.url?.split('?')[0];
        if (url?.startsWith('/ort-wasm/') && url.endsWith('.mjs')) {
          const filePath = path.join(destDir, path.basename(url));
          if (existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(readFileSync(filePath));
            return;
          }
        }
        next();
      });
    },
  };
}
```

Note: `require.resolve` works in Node CJS but not ESM. Since this runs in Vite's Node context, use `import.meta.resolve` or `createRequire`. The actual approach: use `createRequire(import.meta.url).resolve('onnxruntime-web')` to find the ORT package, then navigate to its `dist/` directory.

**Step 2: Verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm -F @ucam-eo/tessera-tasks build`
Expected: Both `dist/index.js` and `dist/vite-plugin.js` emitted

**Step 3: Commit**

```bash
git add packages/tessera-tasks/src/vite-plugin.ts
git commit -m "feat(tessera-tasks): add ORT WASM vite plugin"
```

---

### Task 6: Add tessera-tasks dependency to viewer and update build scripts

**Files:**
- Modify: `apps/viewer/package.json`
- Modify: `package.json` (root — build order)

**Step 1: Add workspace dependency to viewer**

In `apps/viewer/package.json`, add to dependencies:
```json
"@ucam-eo/tessera-tasks": "workspace:*"
```

Move `@tensorflow/tfjs-core`, `@tensorflow/tfjs-backend-webgl`, and `onnxruntime-web` from viewer's dependencies to the viewer's dependencies (they remain as peer deps are satisfied by the app). Actually, keep them in viewer since tessera-tasks declares them as peerDependencies.

**Step 2: Update root build script**

In root `package.json`, update the build script to include tessera-tasks in the chain:

```json
"build": "pnpm -F @ucam-eo/maplibre-zarr-tessera build && pnpm -F @ucam-eo/tessera-tasks build && pnpm -F viewer build"
```

**Step 3: Add resolve alias for tessera-tasks in viewer's vite.config.ts**

In `apps/viewer/vite.config.ts`, add a resolve alias (same pattern as the maplibre-zarr-tessera alias) so dev mode uses source TypeScript:

```typescript
'@ucam-eo/tessera-tasks': path.resolve(
  __dirname, '../../packages/tessera-tasks/src/index.ts'
),
```

**Step 4: Run `pnpm install`**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install`

**Step 5: Commit**

```bash
git add apps/viewer/package.json package.json pnpm-lock.yaml
git commit -m "chore: wire up tessera-tasks dependency and build order"
```

---

### Task 7: Update viewer imports — similarity

**Files:**
- Modify: `apps/viewer/src/components/SimilaritySearch.svelte` (line 6)
- Modify: `apps/viewer/src/stores/similarity.ts` (line 2)
- Modify: `apps/viewer/src/lib/umap-subsample.ts` (line 2)
- Modify: `apps/viewer/src/lib/tutorial.ts` (line 6 — SimilarityResult import)

**Step 1: Update each import**

In every file that imports from `'../lib/similarity'` or `'./similarity'` (within `lib/`), change to:
```typescript
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';
// or for functions:
import { computeSimilarityScores, renderSimilarityCanvas } from '@ucam-eo/tessera-tasks';
```

Specific changes:

`apps/viewer/src/components/SimilaritySearch.svelte:6`:
```typescript
// BEFORE:
import { computeSimilarityScores, renderSimilarityCanvas } from '../lib/similarity';
// AFTER:
import { computeSimilarityScores, renderSimilarityCanvas } from '@ucam-eo/tessera-tasks';
```

`apps/viewer/src/stores/similarity.ts:2`:
```typescript
// BEFORE:
import type { SimilarityResult } from '../lib/similarity';
// AFTER:
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';
```

`apps/viewer/src/lib/umap-subsample.ts:2`:
```typescript
// BEFORE:
import type { SimilarityResult } from './similarity';
// AFTER:
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';
```

`apps/viewer/src/lib/tutorial.ts:6`:
```typescript
// BEFORE:
import type { SimilarityResult } from './similarity';
// AFTER:
import type { SimilarityResult } from '@ucam-eo/tessera-tasks';
```

**Step 2: Delete old file**

```bash
rm apps/viewer/src/lib/similarity.ts
```

**Step 3: Verify TypeScript**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: No errors

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: use tessera-tasks for similarity imports"
```

---

### Task 8: Update viewer imports — classification

**Files:**
- Modify: `apps/viewer/src/stores/classifier.ts` — remove `ClassDef`, `LabelPoint`, `LabelSource` type definitions, import from tessera-tasks
- Modify: `apps/viewer/src/components/LabelPanel.svelte` (line 8)
- Modify: `apps/viewer/src/lib/tutorial.ts` (line 7)

**Step 1: Update stores/classifier.ts**

Remove the `ClassDef`, `LabelSource`, and `LabelPoint` interface/type definitions (lines 4-21). Replace with:

```typescript
import type { ClassDef, LabelSource, LabelPoint } from '@ucam-eo/tessera-tasks';
export type { ClassDef, LabelSource, LabelPoint };
```

This re-exports the types so other store/component files that import from `'../stores/classifier'` continue to work without changes for the store-level imports. The type definitions now live in tessera-tasks.

**Step 2: Update LabelPanel.svelte**

```typescript
// BEFORE:
import { classifyTiles, type ClassifyProgress } from '../lib/classify';
// AFTER:
import { classifyTiles, type ClassifyProgress } from '@ucam-eo/tessera-tasks';
```

**Step 3: Update tutorial.ts**

```typescript
// BEFORE:
import type { ClassDef, LabelPoint } from '../stores/classifier';
// AFTER:
import type { ClassDef, LabelPoint } from '@ucam-eo/tessera-tasks';
```

**Step 4: Delete old file**

```bash
rm apps/viewer/src/lib/classify.ts
```

**Step 5: Verify TypeScript**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: No errors

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: use tessera-tasks for classification imports"
```

---

### Task 9: Update viewer imports — segmentation (SegmentationSession)

**Files:**
- Modify: `apps/viewer/src/components/SegmentPanel.svelte`
- Delete: `apps/viewer/src/lib/segment.ts`

**Step 1: Update SegmentPanel.svelte**

Replace the module-level function imports with a `SegmentationSession` instance.

```typescript
// BEFORE:
import {
  runSolarSegmentation,
  rethreshold,
  clearSegmentation,
  hasCachedProbabilities,
} from '../lib/segment';

// AFTER:
import { SegmentationSession } from '@ucam-eo/tessera-tasks';

const segSession = new SegmentationSession({
  modelUrl: `${import.meta.env.BASE_URL}models/solar_unet.onnx`,
  statsUrl: `${import.meta.env.BASE_URL}models/solar_unet_stats.json`,
  wasmPaths: `${import.meta.env.BASE_URL}ort-wasm/`,
});
```

Then update call sites:
- `runSolarSegmentation(region, source, threshold, onProgress)` → `segSession.run(region, source, threshold, onProgress)`
- `rethreshold(threshold)` → `segSession.rethreshold(threshold)`
- `clearSegmentation()` → `segSession.clear()`
- `hasCachedProbabilities()` → `segSession.hasCachedProbabilities`

Read the full `SegmentPanel.svelte` to identify all call sites and update each one.

**Step 2: Delete old file**

```bash
rm apps/viewer/src/lib/segment.ts
```

**Step 3: Keep model files in viewer's public/ directory**

The model files stay in `apps/viewer/public/models/` since they're served via HTTP at runtime. They're also bundled in the tessera-tasks package dist for other consumers.

**Step 4: Verify TypeScript**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: No errors

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: use SegmentationSession from tessera-tasks"
```

---

### Task 10: Update viewer vite.config.ts — use ortWasmPlugin from tessera-tasks

**Files:**
- Modify: `apps/viewer/vite.config.ts`

**Step 1: Replace inline plugin**

```typescript
// BEFORE:
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';

function ortWasmPlugin() { ... }

export default defineConfig({
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
  ...
});

// AFTER:
import { ortWasmPlugin } from '@ucam-eo/tessera-tasks/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
  ...
});
```

Remove the `fs` imports if they're no longer used by anything else in the file.

**Step 2: Verify dev server starts**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm dev`
Expected: Dev server starts, ORT WASM files copied to public/ort-wasm/

**Step 3: Commit**

```bash
git add apps/viewer/vite.config.ts
git commit -m "refactor: use ortWasmPlugin from tessera-tasks"
```

---

### Task 11: Full build verification and cleanup

**Files:**
- Verify: no remaining imports from deleted files
- Verify: full build chain works

**Step 1: Check for stale imports**

Run: `grep -r "from.*lib/similarity\|from.*lib/classify\|from.*lib/segment" apps/viewer/src/`
Expected: No matches

**Step 2: Full build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm build`
Expected: All three packages build successfully

**Step 3: TypeScript check**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: No errors

**Step 4: Run tests**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm test`
Expected: All tests pass

**Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "chore: cleanup after tessera-tasks extraction"
```
