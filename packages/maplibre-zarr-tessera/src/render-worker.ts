/** Inline Web Worker code for rendering band data to RGBA.
 *  Bundled as a blob URL at runtime — keep self-contained with no imports.
 *
 *  Both render-rgb and render-emb accept an optional `enhance` boolean.
 *  When false (default during panning), use simple min/max normalisation — fast.
 *  When true (after viewport settles), use percentile stretch + saturation + gamma.
 */

export const WORKER_CODE = `
self.onmessage = function(e) {
  const msg = e.data;
  var enhance = !!msg.enhance;

  if (msg.type === 'render-rgb') {
    const { rgbData, width, height, id } = msg;
    const src = new Uint8Array(rgbData);
    const nPix = width * height;
    const nChannels = src.length / nPix;
    const rgba = new Uint8Array(nPix * 4);

    var nValid = 0;

    if (enhance) {
      // Collect per-channel values for valid pixels
      var valsR = [], valsG = [], valsB = [];
      for (var i = 0; i < nPix; i++) {
        var si = i * nChannels;
        var alpha = nChannels >= 4 ? src[si + 3] : 255;
        if (alpha === 0) continue;
        valsR.push(src[si]);
        valsG.push(src[si + 1]);
        valsB.push(src[si + 2]);
        nValid++;
      }

      if (nValid > 0) {
        function percentile(arr, p) {
          arr.sort(function(a, b) { return a - b; });
          var idx = Math.floor(p * (arr.length - 1));
          return arr[idx];
        }
        var loR = percentile(valsR, 0.02), hiR = percentile(valsR, 0.98);
        var loG = percentile(valsG, 0.02), hiG = percentile(valsG, 0.98);
        var loB = percentile(valsB, 0.02), hiB = percentile(valsB, 0.98);

        var rngR = hiR - loR || 1, rngG = hiG - loG || 1, rngB = hiB - loB || 1;

        for (var i = 0; i < nPix; i++) {
          var si = i * nChannels;
          var pi = i * 4;
          var alpha = nChannels >= 4 ? src[si + 3] : 255;
          if (alpha === 0) { rgba[pi + 3] = 0; continue; }

          var nr = (src[si]     - loR) / rngR;
          var ng = (src[si + 1] - loG) / rngG;
          var nb = (src[si + 2] - loB) / rngB;

          nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
          ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
          nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;

          var lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
          var sat = 1.4;
          nr = lum + (nr - lum) * sat;
          ng = lum + (ng - lum) * sat;
          nb = lum + (nb - lum) * sat;

          nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
          ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
          nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;

          var gamma = 0.85;
          rgba[pi]     = Math.round(Math.pow(nr, gamma) * 255);
          rgba[pi + 1] = Math.round(Math.pow(ng, gamma) * 255);
          rgba[pi + 2] = Math.round(Math.pow(nb, gamma) * 255);
          rgba[pi + 3] = 255;
        }
      }
    } else {
      // Simple passthrough — just copy RGB to RGBA
      for (var i = 0; i < nPix; i++) {
        var si = i * nChannels;
        var pi = i * 4;
        var alpha = nChannels >= 4 ? src[si + 3] : 255;
        if (alpha === 0) { rgba[pi + 3] = 0; continue; }
        rgba[pi]     = src[si];
        rgba[pi + 1] = src[si + 1];
        rgba[pi + 2] = src[si + 2];
        rgba[pi + 3] = 255;
        nValid++;
      }
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
    const scalesBuf = new ArrayBuffer(new Uint8Array(scalesRaw).byteLength);
    new Uint8Array(scalesBuf).set(new Uint8Array(scalesRaw));
    const scalesF32 = new Float32Array(scalesBuf);

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

    if (enhance) {
      // Percentile stretch + saturation + gamma
      var eValsR = new Int8Array(nValid), eValsG = new Int8Array(nValid), eValsB = new Int8Array(nValid);
      var vi = 0;
      for (var i = 0; i < width * height; i++) {
        if (isNaN(scalesF32[i]) || scalesF32[i] === 0) continue;
        var base = i * nBands;
        eValsR[vi] = embInt8[base + bR];
        eValsG[vi] = embInt8[base + bG];
        eValsB[vi] = embInt8[base + bB];
        vi++;
      }

      function percInt8(arr, p) {
        var sorted = Array.from(arr);
        sorted.sort(function(a, b) { return a - b; });
        return sorted[Math.floor(p * (sorted.length - 1))];
      }
      var eLoR = percInt8(eValsR, 0.02), eHiR = percInt8(eValsR, 0.98);
      var eLoG = percInt8(eValsG, 0.02), eHiG = percInt8(eValsG, 0.98);
      var eLoB = percInt8(eValsB, 0.02), eHiB = percInt8(eValsB, 0.98);
      var eRngR = eHiR - eLoR || 1, eRngG = eHiG - eLoG || 1, eRngB = eHiB - eLoB || 1;

      for (var i = 0; i < width * height; i++) {
        var pi = i * 4;
        var scale = scalesF32[i];
        if (isNaN(scale) || scale === 0) { rgba[pi + 3] = 0; continue; }
        var base = i * nBands;

        var nr = (embInt8[base + bR] - eLoR) / eRngR;
        var ng = (embInt8[base + bG] - eLoG) / eRngG;
        var nb = (embInt8[base + bB] - eLoB) / eRngB;

        nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
        ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
        nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;

        var lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        var sat = 1.4;
        nr = lum + (nr - lum) * sat;
        ng = lum + (ng - lum) * sat;
        nb = lum + (nb - lum) * sat;

        nr = nr < 0 ? 0 : nr > 1 ? 1 : nr;
        ng = ng < 0 ? 0 : ng > 1 ? 1 : ng;
        nb = nb < 0 ? 0 : nb > 1 ? 1 : nb;

        var gamma = 0.85;
        rgba[pi]     = Math.round(Math.pow(nr, gamma) * 255);
        rgba[pi + 1] = Math.round(Math.pow(ng, gamma) * 255);
        rgba[pi + 2] = Math.round(Math.pow(nb, gamma) * 255);
        rgba[pi + 3] = 255;
      }
    } else {
      // Simple min/max normalisation — fast
      var rngR = maxR - minR || 1, rngG = maxG - minG || 1, rngB = maxB - minB || 1;

      for (var i = 0; i < width * height; i++) {
        var pi = i * 4;
        var scale = scalesF32[i];
        if (isNaN(scale) || scale === 0) { rgba[pi + 3] = 0; continue; }
        var base = i * nBands;

        rgba[pi]     = Math.round(((embInt8[base + bR] - minR) / rngR) * 255);
        rgba[pi + 1] = Math.round(((embInt8[base + bG] - minG) / rngG) * 255);
        rgba[pi + 2] = Math.round(((embInt8[base + bB] - minB) / rngB) * 255);
        rgba[pi + 3] = 255;
      }
    }
    self.postMessage(
      { type: 'emb-result', id, rgba: rgba.buffer, width, height, nValid,
        embRaw: embRaw, scalesRaw: scalesRaw },
      [rgba.buffer]
    );
  }
};
`;
