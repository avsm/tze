import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';
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

/** Callback fired after each GPU chunk with the updated canvas and class map. */
export type OnBatchUpdate = (ci: number, cj: number, canvas: HTMLCanvasElement, classMap: Int16Array, width: number, height: number) => void;

/** L2-normalise rows of a 2D tensor */
function l2Normalise(x: tf.Tensor2D): tf.Tensor2D {
  const sqSum = tf.sum(tf.square(x), 1, true);
  const norms = tf.sqrt(tf.add(sqSum, 1e-12));
  const result = tf.div(x, norms) as tf.Tensor2D;
  sqSum.dispose();
  norms.dispose();
  return result;
}

/**
 * Classify all pixels in loaded tiles using batched KNN on the GPU.
 */
export async function classifyTiles(
  region: EmbeddingRegion,
  labelPoints: LabelPoint[],
  classDefs: ClassDef[],
  k: number,
  confidenceThreshold: number,
  onProgress?: (p: ClassifyProgress) => void,
  onBatchUpdate?: OnBatchUpdate,
): Promise<ClassificationResult[]> {
  await tf.ready();

  const colorMap = new Map<number, [number, number, number]>();
  for (const cls of classDefs) {
    const hex = cls.color.replace('#', '');
    colorMap.set(cls.id, [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ]);
  }

  const nTrain = labelPoints.length;
  const dim = labelPoints[0].embedding.length;
  const trainFlat = new Float32Array(nTrain * dim);
  const trainLabels = new Int32Array(nTrain);
  for (let i = 0; i < nTrain; i++) {
    trainFlat.set(labelPoints[i].embedding, i * dim);
    trainLabels[i] = labelPoints[i].classId;
  }

  const trainRaw = tf.tensor2d(trainFlat, [nTrain, dim]);
  const trainNormed = l2Normalise(trainRaw);
  const trainNormedT = tf.transpose(trainNormed) as tf.Tensor2D;
  trainRaw.dispose();

  const results: ClassificationResult[] = [];
  const { tileW, tileH, nBands, emb, loaded, gridCols } = region;
  const tilePixels = tileW * tileH;

  // Count tiles and valid pixels for progress
  let tilesTotal = 0;
  let totalValidPixels = 0;
  for (let t = 0; t < loaded.length; t++) {
    if (!loaded[t]) continue;
    tilesTotal++;
    const base = t * tilePixels * nBands;
    for (let i = 0; i < tilePixels; i++) {
      if (!isNaN(emb[base + i * nBands])) totalValidPixels++;
    }
  }

  let tilesDone = 0;
  let pixelsDone = 0;
  onProgress?.({ tilesDone: 0, tilesTotal, pixelsDone: 0, pixelsTotal: totalValidPixels });

  const GPU_CHUNK = 4096;

  for (let t = 0; t < loaded.length; t++) {
    if (!loaded[t]) continue;
    const ci = region.ciMin + Math.floor(t / gridCols);
    const cj = region.cjMin + (t % gridCols);
    const tileBase = t * tilePixels * nBands;

    const rgba = new Uint8ClampedArray(tilePixels * 4);
    const classMap = new Int16Array(tilePixels).fill(-2);
    let classified = 0;
    let uncertain = 0;
    let total = 0;

    const canvas = document.createElement('canvas');
    canvas.width = tileW;
    canvas.height = tileH;
    const ctx = canvas.getContext('2d')!;

    // Collect valid pixel indices
    const validIndices: number[] = [];
    for (let i = 0; i < tilePixels; i++) {
      if (!isNaN(emb[tileBase + i * nBands])) {
        total++;
        validIndices.push(i);
      }
    }
    const nValid = validIndices.length;
    const chunkBuf = new Float32Array(GPU_CHUNK * nBands);

    for (let chunkStart = 0; chunkStart < nValid; chunkStart += GPU_CHUNK) {
      const chunkEnd = Math.min(chunkStart + GPU_CHUNK, nValid);
      const chunkSize = chunkEnd - chunkStart;

      // Fill chunk buffer directly from region
      for (let i = 0; i < chunkSize; i++) {
        const srcOff = tileBase + validIndices[chunkStart + i] * nBands;
        const dstOff = i * nBands;
        for (let b = 0; b < nBands; b++) chunkBuf[dstOff + b] = emb[srcOff + b];
      }

      const queries = tf.tensor2d(chunkBuf.subarray(0, chunkSize * nBands), [chunkSize, nBands]);
      const qNormed = l2Normalise(queries);
      const similarity = tf.matMul(qNormed, trainNormedT);
      const effectiveK = Math.min(k, nTrain);
      const { indices: topkIdx } = tf.topk(similarity, effectiveK);
      const idxData = await topkIdx.data();

      const votes = new Map<number, number>();
      for (let i = 0; i < chunkSize; i++) {
        const pixelIdx = validIndices[chunkStart + i];
        const rgbaIdx = pixelIdx * 4;

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
          classMap[pixelIdx] = -1;
          uncertain++;
        }
      }

      queries.dispose();
      qNormed.dispose();
      similarity.dispose();
      topkIdx.dispose();

      const imgData = ctx.createImageData(tileW, tileH);
      imgData.data.set(rgba);
      ctx.putImageData(imgData, 0, 0);
      onBatchUpdate?.(ci, cj, canvas, classMap, tileW, tileH);

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
