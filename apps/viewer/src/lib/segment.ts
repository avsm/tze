import * as ort from 'onnxruntime-web';
import type { EmbeddingRegion, ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';

// Configure WASM paths for onnxruntime-web (relative to deploy base)
const base = import.meta.env.BASE_URL;
ort.env.wasm.wasmPaths = `${base}ort-wasm/`;
// Disable multithreading to avoid SharedArrayBuffer requirement (needs COOP/COEP headers)
ort.env.wasm.numThreads = 1;

export interface SegmentResult {
  ci: number;
  cj: number;
  polygons: GeoJSON.Feature<GeoJSON.Polygon>[];
}

interface ModelStats {
  mean: number[];
  std: number[];
}

const PATCH_SIZE = 64;
const STRIDE = 32;
const MIN_AREA_PIXELS = 100; // ~1 hectare at 10m resolution

let cachedSession: ort.InferenceSession | null = null;
let cachedStats: ModelStats | null = null;

/** Per-tile cached probability maps for re-thresholding without re-running inference. */
const probabilityCache = new Map<string, {
  ci: number; cj: number;
  probs: Float32Array; width: number; height: number;
  corners: [[number, number], [number, number], [number, number], [number, number]];
}>();

async function getSession(): Promise<ort.InferenceSession> {
  if (cachedSession) return cachedSession;
  try {
    cachedSession = await ort.InferenceSession.create(`${base}models/solar_unet.onnx`, {
      executionProviders: ['wasm'],
    });
  } catch (err) {
    throw err;
  }
  return cachedSession;
}

async function getStats(): Promise<ModelStats> {
  if (cachedStats) return cachedStats;
  const resp = await fetch(`${base}models/solar_unet_stats.json`);
  if (!resp.ok) throw new Error(`Failed to fetch stats: ${resp.status} ${resp.statusText}`);
  cachedStats = await resp.json();
  return cachedStats!;
}

/**
 * Run solar panel segmentation on all loaded embedding tiles.
 * Caches probability maps so threshold can be adjusted without re-running.
 */
export async function runSolarSegmentation(
  region: EmbeddingRegion,
  source: ZarrTesseraSource,
  threshold = 0.5,
  onProgress?: (done: number, total: number) => void,
): Promise<SegmentResult[]> {
  const [session, stats] = await Promise.all([getSession(), getStats()]);

  const mean = new Float32Array(stats.mean);
  const std = new Float32Array(stats.std);
  const { tileW, tileH, nBands, emb, loaded, gridCols } = region;
  const tilePixels = tileW * tileH;

  // Count total patches across all tiles for progress
  let totalPatches = 0;
  interface TileInfo { tileIdx: number; ci: number; cj: number; patchCount: number; }
  const tileInfos: TileInfo[] = [];

  for (let t = 0; t < loaded.length; t++) {
    if (!loaded[t]) continue;
    const ci = region.ciMin + Math.floor(t / gridCols);
    const cj = region.cjMin + (t % gridCols);
    let count = 0;
    for (let y = 0; y <= tileH - PATCH_SIZE; y += STRIDE) {
      for (let x = 0; x <= tileW - PATCH_SIZE; x += STRIDE) {
        count++;
      }
    }
    tileInfos.push({ tileIdx: t, ci, cj, patchCount: count });
    totalPatches += count;
  }

  let patchesDone = 0;
  let patchesSkipped = 0;
  let patchesInferred = 0;
  onProgress?.(0, totalPatches);

  for (const { tileIdx, ci, cj } of tileInfos) {
    const corners = source.getChunkBoundsLngLat(ci, cj);
    if (!corners) continue;

    const tileBase = tileIdx * tilePixels * nBands;
    const prediction = new Float32Array(tilePixels);
    const count = new Float32Array(tilePixels);
    const inputData = new Float32Array(nBands * PATCH_SIZE * PATCH_SIZE);

    for (let y = 0; y <= tileH - PATCH_SIZE; y += STRIDE) {
      for (let x = 0; x <= tileW - PATCH_SIZE; x += STRIDE) {
        let hasValid = false;
        for (let py = 0; py < PATCH_SIZE && !hasValid; py++) {
          for (let px = 0; px < PATCH_SIZE && !hasValid; px++) {
            const off = tileBase + ((y + py) * tileW + (x + px)) * nBands;
            if (!isNaN(emb[off])) hasValid = true;
          }
        }

        if (!hasValid) {
          patchesDone++;
          patchesSkipped++;
          onProgress?.(patchesDone, totalPatches);
          continue;
        }

        for (let py = 0; py < PATCH_SIZE; py++) {
          for (let px = 0; px < PATCH_SIZE; px++) {
            const srcOff = tileBase + ((y + py) * tileW + (x + px)) * nBands;
            for (let c = 0; c < nBands; c++) {
              const val = emb[srcOff + c];
              inputData[c * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = (val - mean[c]) / std[c];
            }
          }
        }

        const inputTensor = new ort.Tensor('float32', inputData.slice(), [1, nBands, PATCH_SIZE, PATCH_SIZE]);

        try {
          const results = await session.run({ input: inputTensor });
          const output = results.output;
          const outputData = output.data as Float32Array;

          for (let py = 0; py < PATCH_SIZE; py++) {
            for (let px = 0; px < PATCH_SIZE; px++) {
              const outIdx = py * PATCH_SIZE + px;
              const prob = 1 / (1 + Math.exp(-outputData[outIdx]));
              const mapIdx = (y + py) * tileW + (x + px);
              prediction[mapIdx] += prob;
              count[mapIdx] += 1;
            }
          }
          patchesInferred++;
        } catch (err) {
          throw err;
        }

        patchesDone++;
        if (patchesDone % 4 === 0) {
          onProgress?.(patchesDone, totalPatches);
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }

    for (let i = 0; i < tilePixels; i++) {
      if (count[i] > 0) prediction[i] /= count[i];
    }

    const key = `${ci}_${cj}`;
    probabilityCache.set(key, { ci, cj, probs: prediction, width: tileW, height: tileH, corners });
  }

  onProgress?.(totalPatches, totalPatches);

  return rethreshold(threshold);
}

/**
 * Re-polygonize cached probability maps with a new threshold.
 * Does not re-run the model.
 */
export function rethreshold(threshold: number): SegmentResult[] {
  const results: SegmentResult[] = [];

  for (const [, cached] of probabilityCache) {
    const { ci, cj, probs, width, height, corners } = cached;

    // Threshold → binary mask
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      mask[i] = probs[i] >= threshold ? 1 : 0;
    }

    // Polygonize binary mask using connected components
    const polygons = polygonizeMask(mask, width, height, corners);

    results.push({ ci, cj, polygons });
  }

  return results;
}

/** Clear cached probability maps. */
export function clearSegmentation(): void {
  probabilityCache.clear();
}

/** Check if probability maps are cached (model has been run). */
export function hasCachedProbabilities(): boolean {
  return probabilityCache.size > 0;
}

/**
 * Convert a binary mask to GeoJSON polygons via connected component labeling
 * and contour tracing.
 */
function polygonizeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  corners: [[number, number], [number, number], [number, number], [number, number]],
): GeoJSON.Feature<GeoJSON.Polygon>[] {
  // corners: [TL, TR, BR, BL] in [lng, lat]
  const [tl, tr, br, bl] = corners;

  // Bilinear interpolation for pixel → lng/lat
  function pixelToLngLat(px: number, py: number): [number, number] {
    const u = px / width;
    const v = py / height;
    const lng = (1 - u) * (1 - v) * tl[0] + u * (1 - v) * tr[0] + u * v * br[0] + (1 - u) * v * bl[0];
    const lat = (1 - u) * (1 - v) * tl[1] + u * (1 - v) * tr[1] + u * v * br[1] + (1 - u) * v * bl[1];
    return [lng, lat];
  }

  // Connected component labeling
  const labels = new Int32Array(width * height);
  let nextLabel = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0 || labels[idx] !== 0) continue;

      // BFS flood fill
      const label = nextLabel++;
      const queue = [idx];
      labels[idx] = label;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cx = cur % width;
        const cy = (cur - cx) / width;

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (mask[ni] === 1 && labels[ni] === 0) {
            labels[ni] = label;
            queue.push(ni);
          }
        }
      }
    }
  }

  // Collect component areas and bounding boxes
  const areas = new Map<number, number>();
  const components = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (l === 0) continue;
      areas.set(l, (areas.get(l) ?? 0) + 1);
      const bb = components.get(l);
      if (!bb) {
        components.set(l, { minX: x, minY: y, maxX: x, maxY: y });
      } else {
        if (x < bb.minX) bb.minX = x;
        if (x > bb.maxX) bb.maxX = x;
        if (y < bb.minY) bb.minY = y;
        if (y > bb.maxY) bb.maxY = y;
      }
    }
  }

  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  for (const [label, area] of areas) {
    if (area < MIN_AREA_PIXELS) continue;

    const bb = components.get(label)!;

    // Trace outer contour of this component using simple boundary walk
    const contourPixels = traceContour(labels, width, height, label, bb);

    if (contourPixels.length < 3) continue;

    // Convert pixel contour to lng/lat coordinates
    const ring: [number, number][] = contourPixels.map(([px, py]) => pixelToLngLat(px, py));
    ring.push(ring[0]); // close the ring

    features.push({
      type: 'Feature',
      properties: { area_pixels: area, area_ha: area / 100 },
      geometry: {
        type: 'Polygon',
        coordinates: [ring],
      },
    });
  }

  return features;
}

/**
 * Trace the outer contour of a labeled component using boundary pixel extraction.
 * Returns an ordered list of boundary pixel coordinates.
 */
function traceContour(
  labels: Int32Array,
  width: number,
  height: number,
  label: number,
  bb: { minX: number; minY: number; maxX: number; maxY: number },
): [number, number][] {
  // Find boundary pixels — pixels of this label adjacent to background or edge
  const boundary: [number, number][] = [];

  for (let y = bb.minY; y <= bb.maxY; y++) {
    for (let x = bb.minX; x <= bb.maxX; x++) {
      if (labels[y * width + x] !== label) continue;

      let isBoundary = false;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        isBoundary = true;
      } else {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = (y + dy) * width + (x + dx);
          if (labels[ni] !== label) { isBoundary = true; break; }
        }
      }

      if (isBoundary) boundary.push([x, y]);
    }
  }

  if (boundary.length === 0) return [];

  // Order boundary pixels using nearest-neighbor chain for a rough contour
  const ordered: [number, number][] = [boundary[0]];
  const used = new Set<number>([0]);

  for (let i = 1; i < boundary.length; i++) {
    const [cx, cy] = ordered[ordered.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let j = 0; j < boundary.length; j++) {
      if (used.has(j)) continue;
      const dx = boundary[j][0] - cx;
      const dy = boundary[j][1] - cy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }

    if (bestIdx === -1) break;
    used.add(bestIdx);
    ordered.push(boundary[bestIdx]);
  }

  // Simplify: subsample for large contours to reduce polygon complexity
  if (ordered.length > 200) {
    const step = Math.ceil(ordered.length / 200);
    const simplified: [number, number][] = [];
    for (let i = 0; i < ordered.length; i += step) {
      simplified.push(ordered[i]);
    }
    return simplified;
  }

  return ordered;
}
