import type { EmbeddingRegion } from '@ucam-eo/tessera';

/** Create an RGBA canvas from a raw buffer. */
export function rgbaToCanvas(rgba: ArrayBuffer, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(new Uint8Array(rgba));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Render embedding bands from a region to a single canvas.
 * Uses global min/max normalization across all loaded tiles.
 *
 * @returns The rendered canvas, or null if no valid pixels.
 */
export function renderRegionCanvas(
  region: EmbeddingRegion,
  bands: [number, number, number],
): HTMLCanvasElement | null {
  const [bR, bG, bB] = bands;
  const { nBands, tileW, tileH, emb, loaded, gridCols, gridRows } = region;
  const tilePixels = tileW * tileH;

  // First pass: global min/max across all loaded tiles
  let gMinR = Infinity, gMaxR = -Infinity;
  let gMinG = Infinity, gMaxG = -Infinity;
  let gMinB = Infinity, gMaxB = -Infinity;
  const nTiles = loaded.length;
  for (let t = 0; t < nTiles; t++) {
    if (!loaded[t]) continue;
    const base = t * tilePixels * nBands;
    for (let i = 0; i < tilePixels; i++) {
      const off = base + i * nBands;
      if (isNaN(emb[off])) continue;
      const vr = emb[off + bR], vg = emb[off + bG], vb = emb[off + bB];
      if (vr < gMinR) gMinR = vr; if (vr > gMaxR) gMaxR = vr;
      if (vg < gMinG) gMinG = vg; if (vg > gMaxG) gMaxG = vg;
      if (vb < gMinB) gMinB = vb; if (vb > gMaxB) gMaxB = vb;
    }
  }

  if (!isFinite(gMinR)) return null;
  const rangeR = gMaxR - gMinR || 1, rangeG = gMaxG - gMinG || 1, rangeB = gMaxB - gMinB || 1;

  // Second pass: render all tiles into a single region-wide canvas
  const W = gridCols * tileW;
  const H = gridRows * tileH;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(W, H);
  const rgba = imgData.data;

  for (let t = 0; t < nTiles; t++) {
    if (!loaded[t]) continue;
    const tileRow = Math.floor(t / gridCols);
    const tileCol = t % gridCols;
    const base = t * tilePixels * nBands;
    const pixelY0 = tileRow * tileH;
    const pixelX0 = tileCol * tileW;

    for (let py = 0; py < tileH; py++) {
      for (let px = 0; px < tileW; px++) {
        const i = py * tileW + px;
        const off = base + i * nBands;
        if (isNaN(emb[off])) continue;
        const outIdx = ((pixelY0 + py) * W + (pixelX0 + px)) * 4;
        rgba[outIdx]     = Math.max(0, Math.min(255, ((emb[off + bR] - gMinR) / rangeR) * 255));
        rgba[outIdx + 1] = Math.max(0, Math.min(255, ((emb[off + bG] - gMinG) / rangeG) * 255));
        rgba[outIdx + 2] = Math.max(0, Math.min(255, ((emb[off + bB] - gMinB) / rangeB) * 255));
        rgba[outIdx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}
