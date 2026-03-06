import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';

/** Per-tile cached similarity data with normalised scores. */
export interface TileSimilarity {
  ci: number;
  cj: number;
  width: number;
  height: number;
  /** Per-pixel normalised similarity in 0..1. NaN = invalid pixel. */
  scores: Float32Array;
  /** Reusable canvas for flicker-free updates. */
  canvas: HTMLCanvasElement;
}

export interface SimilarityOverlay {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement;
}

/**
 * Compute cosine similarity of every pixel in the region to a reference
 * embedding. Scores are normalised to 0..1 based on observed min/max.
 */
export async function computeSimilarityScores(
  region: EmbeddingRegion,
  refEmbedding: Float32Array,
): Promise<TileSimilarity[]> {
  const D = refEmbedding.length;
  const { tileW, tileH, nBands, emb, loaded, gridCols } = region;
  const tilePixels = tileW * tileH;

  // Pre-normalise reference vector
  let refNormSq = 0;
  for (let b = 0; b < D; b++) refNormSq += refEmbedding[b] * refEmbedding[b];
  const refScale = 1 / Math.sqrt(refNormSq + 1e-12);
  const ref = new Float32Array(D);
  for (let b = 0; b < D; b++) ref[b] = refEmbedding[b] * refScale;

  // First pass: compute raw cosine similarities per tile
  interface RawTile {
    ci: number; cj: number;
    scores: Float32Array;
  }
  const rawTiles: RawTile[] = [];
  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (let t = 0; t < loaded.length; t++) {
    if (!loaded[t]) continue;
    const ci = region.ciMin + Math.floor(t / gridCols);
    const cj = region.cjMin + (t % gridCols);
    const scores = new Float32Array(tilePixels);
    scores.fill(NaN);

    const base = t * tilePixels * nBands;
    for (let i = 0; i < tilePixels; i++) {
      const off = base + i * nBands;
      if (isNaN(emb[off])) continue;

      let dot = 0, qSq = 0;
      for (let b = 0; b < D; b++) {
        const v = emb[off + b];
        dot += v * ref[b];
        qSq += v * v;
      }
      const cos = dot / Math.sqrt(qSq + 1e-12);
      scores[i] = cos;
      if (cos < globalMin) globalMin = cos;
      if (cos > globalMax) globalMax = cos;
    }
    rawTiles.push({ ci, cj, scores });
  }

  // Second pass: normalise to 0..1
  const range = globalMax - globalMin;
  const results: TileSimilarity[] = [];

  for (const raw of rawTiles) {
    const { scores } = raw;
    if (range > 0) {
      for (let i = 0; i < scores.length; i++) {
        if (!isNaN(scores[i])) scores[i] = (scores[i] - globalMin) / range;
      }
    } else {
      for (let i = 0; i < scores.length; i++) {
        if (!isNaN(scores[i])) scores[i] = 0.5;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = tileW;
    canvas.height = tileH;

    results.push({
      ci: raw.ci, cj: raw.cj,
      width: tileW, height: tileH,
      scores, canvas,
    });
  }

  return results;
}

/**
 * Render cached normalised similarity scores into overlay canvases.
 */
export function renderSimilarityOverlays(
  tiles: TileSimilarity[],
  threshold: number,
  onTileDone?: (r: SimilarityOverlay) => void,
): SimilarityOverlay[] {
  const results: SimilarityOverlay[] = [];

  for (const tile of tiles) {
    const { ci, cj, width, height, scores, canvas } = tile;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const rgba = imgData.data;

    for (let i = 0; i < width * height; i++) {
      const s = scores[i];
      if (isNaN(s)) continue;

      if (s >= threshold) {
        const rgbaIdx = i * 4;
        rgba[rgbaIdx]     = 0;
        rgba[rgbaIdx + 1] = 229;
        rgba[rgbaIdx + 2] = 255;
        rgba[rgbaIdx + 3] = 180;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const result: SimilarityOverlay = { ci, cj, canvas };
    results.push(result);
    onTileDone?.(result);
  }

  return results;
}
