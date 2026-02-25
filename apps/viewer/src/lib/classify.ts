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

    // Collect valid pixels
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
    const BATCH = 256;
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
