import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';
import type { TileSimilarity } from './similarity';

export interface SubsampleResult {
  embeddings: Float32Array; // N * nBands flat
  scores: Float32Array;     // N scores
  refIndex: number;         // index of reference pixel in the subsample
  count: number;            // N
  nBands: number;
}

const MAX_POINTS = 5000;
const NUM_BINS = 10;

/**
 * Stratified subsample of embeddings, weighted by similarity score bins.
 * Always includes the reference pixel.
 */
export function subsampleEmbeddings(
  region: EmbeddingRegion,
  cachedScores: TileSimilarity[],
  refEmbedding: Float32Array,
  refPixel: { ci: number; cj: number; row: number; col: number },
): SubsampleResult {
  const scoreMap = new Map<string, TileSimilarity>();
  for (const ts of cachedScores) {
    scoreMap.set(`${ts.ci}_${ts.cj}`, ts);
  }

  interface PointRef {
    tileIdx: number;
    pixelIdx: number;
    score: number;
  }

  const bins: PointRef[][] = Array.from({ length: NUM_BINS }, () => []);
  let refPoint: PointRef | null = null;
  const nBands = region.nBands;
  const tilePixels = region.tileW * region.tileH;

  for (let t = 0; t < region.loaded.length; t++) {
    if (!region.loaded[t]) continue;
    const ci = region.ciMin + Math.floor(t / region.gridCols);
    const cj = region.cjMin + (t % region.gridCols);
    const key = `${ci}_${cj}`;
    const ts = scoreMap.get(key);
    if (!ts) continue;

    for (let i = 0; i < tilePixels; i++) {
      const score = ts.scores[i];
      if (Number.isNaN(score)) continue;

      const row = Math.floor(i / region.tileW);
      const col = i % region.tileW;

      if (ci === refPixel.ci && cj === refPixel.cj &&
          row === refPixel.row && col === refPixel.col) {
        refPoint = { tileIdx: t, pixelIdx: i, score };
        continue;
      }

      const bin = Math.min(Math.floor(score * NUM_BINS), NUM_BINS - 1);
      bins[bin].push({ tileIdx: t, pixelIdx: i, score });
    }
  }

  const budget = MAX_POINTS - 1;
  const totalAvailable = bins.reduce((s, b) => s + b.length, 0);
  const sampleCount = Math.min(budget, totalAvailable);
  const selected: PointRef[] = [];

  if (totalAvailable <= budget) {
    for (const bin of bins) selected.push(...bin);
  } else {
    const allocations = bins.map(b =>
      Math.floor((b.length / totalAvailable) * sampleCount)
    );
    let remainder = sampleCount - allocations.reduce((a, b) => a + b, 0);
    for (let i = 0; remainder > 0 && i < NUM_BINS; i++) {
      if (allocations[i] < bins[i].length) {
        allocations[i]++;
        remainder--;
      }
    }
    for (let b = 0; b < NUM_BINS; b++) {
      const bin = bins[b];
      const n = allocations[b];
      if (n >= bin.length) {
        selected.push(...bin);
      } else {
        for (let i = bin.length - 1; i >= bin.length - n; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bin[i], bin[j]] = [bin[j], bin[i]];
        }
        selected.push(...bin.slice(bin.length - n));
      }
    }
  }

  const N = selected.length + (refPoint ? 1 : 0);
  const embeddings = new Float32Array(N * nBands);
  const scores = new Float32Array(N);
  let refIndex = -1;

  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    const offset = (p.tileIdx * tilePixels + p.pixelIdx) * nBands;
    embeddings.set(region.emb.subarray(offset, offset + nBands), i * nBands);
    scores[i] = p.score;
  }

  if (refPoint) {
    refIndex = selected.length;
    const offset = (refPoint.tileIdx * tilePixels + refPoint.pixelIdx) * nBands;
    embeddings.set(region.emb.subarray(offset, offset + nBands), refIndex * nBands);
    scores[refIndex] = refPoint.score;
  } else {
    refIndex = selected.length > 0 ? N - 1 : 0;
    if (selected.length === 0) {
      const e = new Float32Array(nBands);
      e.set(refEmbedding);
      return { embeddings: e, scores: new Float32Array([1.0]), refIndex: 0, count: 1, nBands };
    }
  }

  return { embeddings, scores, refIndex, count: N, nBands };
}

/**
 * Uniform random subsample of embeddings (no similarity scores needed).
 */
export function subsampleUniform(
  region: EmbeddingRegion,
): SubsampleResult {
  interface PointRef { tileIdx: number; pixelIdx: number; }
  const all: PointRef[] = [];
  const nBands = region.nBands;
  const tilePixels = region.tileW * region.tileH;

  for (let t = 0; t < region.loaded.length; t++) {
    if (!region.loaded[t]) continue;
    const base = t * tilePixels * nBands;
    for (let i = 0; i < tilePixels; i++) {
      if (!isNaN(region.emb[base + i * nBands])) {
        all.push({ tileIdx: t, pixelIdx: i });
      }
    }
  }

  if (all.length === 0) {
    return { embeddings: new Float32Array(0), scores: new Float32Array(0), refIndex: -1, count: 0, nBands: nBands || 128 };
  }

  const n = Math.min(MAX_POINTS, all.length);
  for (let i = all.length - 1; i >= all.length - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const selected = all.slice(all.length - n);

  const embeddings = new Float32Array(n * nBands);
  const scores = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const p = selected[i];
    const offset = (p.tileIdx * tilePixels + p.pixelIdx) * nBands;
    embeddings.set(region.emb.subarray(offset, offset + nBands), i * nBands);
  }

  return { embeddings, scores, refIndex: -1, count: n, nBands };
}
