/** Inline Web Worker code for rendering band data to RGBA.
 *  Bundled as a blob URL at runtime — keep self-contained with no imports.
 */

export const WORKER_CODE = `
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'render-rgb') {
    const { rgbData, width, height, id } = msg;
    const src = new Uint8Array(rgbData);
    const rgba = new Uint8Array(width * height * 4);
    let nValid = 0;
    for (let i = 0; i < width * height; i++) {
      const si = i * 4;
      rgba[si]     = src[si];
      rgba[si + 1] = src[si + 1];
      rgba[si + 2] = src[si + 2];
      rgba[si + 3] = src[si + 3];
      if (src[si + 3] > 0) nValid++;
    }
    self.postMessage(
      { type: 'rgb-result', id, rgba: rgba.buffer, width, height, nValid },
      [rgba.buffer]
    );
    return;
  }

  if (msg.type === 'render-emb') {
    const { embRaw, scalesRaw, width, height, nBands, bands, id } = msg;
    const embInt8 = new Int8Array(embRaw);
    const scalesF32 = new Float32Array(scalesRaw);

    const [bR, bG, bB] = bands;
    let minR = 127, maxR = -128, minG = 127, maxG = -128, minB = 127, maxB = -128;
    let nValid = 0;

    for (let i = 0; i < width * height; i++) {
      if (isNaN(scalesF32[i]) || scalesF32[i] === 0) continue;
      const base = i * nBands;
      const vr = embInt8[base + bR];
      const vg = embInt8[base + bG];
      const vb = embInt8[base + bB];
      if (vr < minR) minR = vr; if (vr > maxR) maxR = vr;
      if (vg < minG) minG = vg; if (vg > maxG) maxG = vg;
      if (vb < minB) minB = vb; if (vb > maxB) maxB = vb;
      nValid++;
    }

    const rgba = new Uint8Array(width * height * 4);
    if (nValid === 0 || (maxR === minR && maxG === minG && maxB === minB)) {
      self.postMessage(
        { type: 'emb-result', id, rgba: rgba.buffer, width, height, nValid: 0,
          embRaw: embRaw, scalesRaw: scalesRaw },
        [rgba.buffer]
      );
      return;
    }

    const rangeR = maxR - minR || 1;
    const rangeG = maxG - minG || 1;
    const rangeB = maxB - minB || 1;

    for (let i = 0; i < width * height; i++) {
      const pi = i * 4;
      const scale = scalesF32[i];
      if (isNaN(scale) || scale === 0) { rgba[pi + 3] = 0; continue; }
      const base = i * nBands;
      rgba[pi]     = Math.max(0, Math.min(255, ((embInt8[base + bR] - minR) / rangeR) * 255));
      rgba[pi + 1] = Math.max(0, Math.min(255, ((embInt8[base + bG] - minG) / rangeG) * 255));
      rgba[pi + 2] = Math.max(0, Math.min(255, ((embInt8[base + bB] - minB) / rangeB) * 255));
      rgba[pi + 3] = 255;
    }
    self.postMessage(
      { type: 'emb-result', id, rgba: rgba.buffer, width, height, nValid,
        embRaw: embRaw, scalesRaw: scalesRaw },
      [rgba.buffer]
    );
  }
};
`;
