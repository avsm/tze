import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import type { TileEmbeddings } from '@ucam-eo/maplibre-zarr-tessera';
import type { LabelPoint, ClassDef } from '../stores/classifier';

export interface ClassificationResult {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement;
  /** Per-pixel class ID map (width*height). -1 = unclassified/uncertain, -2 = nodata. */
  classMap: Int16Array;
  stats: { total: number; classified: number; uncertain: number };
}

export interface ClassifyProgress {
  tilesDone: number;
  tilesTotal: number;
  pixelsDone: number;
  pixelsTotal: number;
}

/** Callback fired after each GPU chunk with the updated canvas. */
export type OnBatchUpdate = (ci: number, cj: number, canvas: HTMLCanvasElement) => void;

/** L2-normalise rows of a 2D tensor: x / ||x||₂  (functional API only) */
function l2Normalise(x: tf.Tensor2D): tf.Tensor2D {
  const sqSum = tf.sum(tf.square(x), 1, true);   // [M, 1]
  const norms = tf.sqrt(tf.add(sqSum, 1e-12));    // avoid div-by-zero
  const result = tf.div(x, norms) as tf.Tensor2D;
  sqSum.dispose();
  norms.dispose();
  return result;
}

/**
 * Classify all pixels in loaded tiles using batched KNN on the GPU.
 *
 * Builds a [M, D] query matrix and a [N, D] training matrix, computes cosine
 * similarity via a single matMul, then topk for k-nearest — ~1 GPU call per
 * chunk of 8192 pixels instead of one per pixel.
 */
export async function classifyTiles(
  embeddingCache: Map<string, TileEmbeddings>,
  labelPoints: LabelPoint[],
  classDefs: ClassDef[],
  k: number,
  confidenceThreshold: number,
  onProgress?: (p: ClassifyProgress) => void,
  onBatchUpdate?: OnBatchUpdate,
): Promise<ClassificationResult[]> {
  await tf.ready();

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

  // Build training matrix [N, D] and label array [N]
  const nTrain = labelPoints.length;
  const dim = labelPoints[0].embedding.length;
  const trainFlat = new Float32Array(nTrain * dim);
  const trainLabels = new Int32Array(nTrain);
  for (let i = 0; i < nTrain; i++) {
    trainFlat.set(labelPoints[i].embedding, i * dim);
    trainLabels[i] = labelPoints[i].classId;
  }

  // Normalise training vectors for cosine similarity (keep on GPU)
  const trainRaw = tf.tensor2d(trainFlat, [nTrain, dim]);
  const trainNormed = l2Normalise(trainRaw);
  // Precompute transpose [D, N] to reuse across all chunks
  const trainNormedT = tf.transpose(trainNormed) as tf.Tensor2D;
  trainRaw.dispose();

  const results: ClassificationResult[] = [];

  // Count total valid pixels across all tiles for progress
  const tilesTotal = embeddingCache.size;
  let tilesDone = 0;
  let totalValidPixels = 0;
  let pixelsDone = 0;

  for (const [, tile] of embeddingCache) {
    for (let i = 0; i < tile.width * tile.height; i++) {
      const s = tile.scales[i];
      if (s && !isNaN(s) && s !== 0) totalValidPixels++;
    }
  }

  onProgress?.({ tilesDone: 0, tilesTotal, pixelsDone: 0, pixelsTotal: totalValidPixels });

  // Process tiles in GPU chunks to bound memory and allow UI updates
  const GPU_CHUNK = 8192;

  for (const [, tile] of embeddingCache) {
    const { ci, cj, emb, scales, width, height, nBands } = tile;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const classMap = new Int16Array(width * height).fill(-2); // -2 = nodata
    let classified = 0;
    let uncertain = 0;
    let total = 0;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    // Collect valid pixel indices and build query vectors
    const validIndices: number[] = [];
    const queryFlat = new Float32Array(width * height * nBands); // over-allocated
    let nValid = 0;

    for (let i = 0; i < width * height; i++) {
      const scale = scales[i];
      if (!scale || isNaN(scale) || scale === 0) continue;
      total++;
      const srcOff = i * nBands;
      const dstOff = nValid * nBands;
      for (let b = 0; b < nBands; b++) queryFlat[dstOff + b] = emb[srcOff + b];
      validIndices.push(i);
      nValid++;
    }

    // Process valid pixels in GPU-sized chunks
    for (let chunkStart = 0; chunkStart < nValid; chunkStart += GPU_CHUNK) {
      const chunkEnd = Math.min(chunkStart + GPU_CHUNK, nValid);
      const chunkSize = chunkEnd - chunkStart;

      // Build query tensor for this chunk [chunkSize, D]
      const querySlice = queryFlat.subarray(chunkStart * nBands, chunkEnd * nBands);
      const queries = tf.tensor2d(querySlice, [chunkSize, nBands]);

      // Normalise queries for cosine similarity
      const qNormed = l2Normalise(queries);

      // Cosine similarity: qNormed @ trainNormedT → [chunkSize, N]
      const similarity = tf.matMul(qNormed, trainNormedT);

      // Top-k most similar training points
      const effectiveK = Math.min(k, nTrain);
      const { indices: topkIdx } = tf.topk(similarity, effectiveK);

      // Read indices back to CPU for voting
      const idxData = await topkIdx.data();

      // Vote and assign colours — reuse a single Map to avoid per-pixel allocation
      const votes = new Map<number, number>();
      for (let i = 0; i < chunkSize; i++) {
        const pixelIdx = validIndices[chunkStart + i];
        const rgbaIdx = pixelIdx * 4;

        // Count votes among k nearest
        votes.clear();
        for (let j = 0; j < effectiveK; j++) {
          const trainIdx = idxData[i * effectiveK + j];
          const label = trainLabels[trainIdx];
          votes.set(label, (votes.get(label) || 0) + 1);
        }

        let bestLabel = -1, bestCount = 0;
        for (const [label, count] of votes) {
          if (count > bestCount) { bestLabel = label; bestCount = count; }
        }
        const confidence = bestCount / effectiveK;

        if (confidence >= confidenceThreshold) {
          const color = colorMap.get(bestLabel) ?? [128, 128, 128];
          rgba[rgbaIdx] = color[0];
          rgba[rgbaIdx + 1] = color[1];
          rgba[rgbaIdx + 2] = color[2];
          rgba[rgbaIdx + 3] = 200;
          classMap[pixelIdx] = bestLabel;
          classified++;
        } else {
          rgba[rgbaIdx] = 128;
          rgba[rgbaIdx + 1] = 128;
          rgba[rgbaIdx + 2] = 128;
          rgba[rgbaIdx + 3] = 80;
          classMap[pixelIdx] = -1; // uncertain
          uncertain++;
        }
      }

      // Dispose GPU tensors
      queries.dispose();
      qNormed.dispose();
      similarity.dispose();
      topkIdx.dispose();

      // Update canvas and report progress
      const imgData = ctx.createImageData(width, height);
      imgData.data.set(rgba);
      ctx.putImageData(imgData, 0, 0);
      onBatchUpdate?.(ci, cj, canvas);

      pixelsDone += chunkSize;
      onProgress?.({ tilesDone, tilesTotal, pixelsDone, pixelsTotal: totalValidPixels });
      await new Promise(r => setTimeout(r, 0));
    }

    results.push({ ci, cj, canvas, classMap, stats: { total, classified, uncertain } });
    tilesDone++;
    onProgress?.({ tilesDone, tilesTotal, pixelsDone, pixelsTotal: totalValidPixels });
  }

  trainNormed.dispose();
  trainNormedT.dispose();
  return results;
}
