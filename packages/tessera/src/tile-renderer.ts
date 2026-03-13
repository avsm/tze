/**
 * Framework-agnostic tile renderer for TESSERA multiscale RGB Zarr stores.
 *
 * @remarks
 * Renders Web Mercator tiles from equirectangular (plate carrée) Zarr arrays
 * with Mercator correction to prevent tile distortion at low zoom levels.
 *
 * @example
 * ```typescript
 * const renderer = new TesseraTileRenderer('https://example.com/store.zarr', { variable: 'rgb' });
 * const pngBuffer = await renderer.renderTile(2, 1, 1);
 * ```
 *
 * @module
 */
import type { TileRendererOptions } from './types.js';
import * as zarr from 'zarrita';

const TILE_SIZE = 256;

interface PyramidLevel {
  arr: zarr.Array<zarr.DataType>;
  shape: [number, number, number]; // [lat, lon, band]
}

/**
 * Convert a Web Mercator tile coordinate `{z, x, y}` to WGS84 lat/lon bounds.
 *
 * @param z - Zoom level.
 * @param x - Tile column index (0-based).
 * @param y - Tile row index (0-based, north at 0).
 * @returns Bounding box with `west`, `east`, `north`, and `south` in degrees.
 */
export function tileBounds(
  z: number,
  x: number,
  y: number,
): { west: number; east: number; north: number; south: number } {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    south: (180 / Math.PI) * Math.atan(Math.sinh(s)),
  };
}

/**
 * Select the coarsest pyramid level with sufficient resolution for a given zoom.
 *
 * @remarks
 * Levels are ordered coarsest (index 0) to finest (index N-1). The function
 * walks from coarsest to finest and returns the first level whose longitude
 * pixel density is at least half of what is required to render a 256 px tile
 * cleanly. If no level is sufficient, the finest level (index N-1) is returned.
 *
 * Shape convention: `[lat_pixels, lon_pixels, bands]`.
 *
 * @param levels - Array of level descriptors ordered coarsest (0) to finest (N-1).
 * @param z - Web Mercator zoom level.
 * @returns Index into `levels` of the selected level.
 */
export function selectLevel(
  levels: { shape: [number, number, number] }[],
  z: number,
): number {
  const neededPxPerDeg = (TILE_SIZE * (1 << z)) / 360;
  for (let i = 0; i < levels.length; i++) {
    const pxPerDeg = levels[i].shape[1] / 360;
    if (pxPerDeg >= neededPxPerDeg * 0.5) return i;
  }
  return levels.length - 1;
}

/**
 * Renders Web Mercator tiles from a TESSERA multiscale RGB Zarr store.
 *
 * @remarks
 * Opens a multiscale Zarr v3 group containing equirectangular (plate carrée)
 * RGB or RGBA arrays at multiple resolutions. Each call to {@link renderTile}
 * selects the appropriate pyramid level, fetches the required region, applies
 * Mercator correction, and returns a PNG-encoded `ArrayBuffer`.
 *
 * The pyramid cache is keyed per instance and persists across tile requests.
 * Call {@link setVariable} to switch the rendered variable (e.g. from `'rgb'`
 * to `'pca_rgb'`); this clears the cache automatically.
 */
export class TesseraTileRenderer {
  private readonly url: string;
  private variable: string;
  private pyramidCache: Promise<PyramidLevel[]> | null = null;

  /**
   * Create a new tile renderer.
   *
   * @param url - HTTP URL of the Zarr v3 store root.
   * @param options - Optional rendering configuration.
   */
  constructor(url: string, options?: TileRendererOptions) {
    this.url = url;
    this.variable = options?.variable ?? 'rgb';
  }

  /**
   * Render a single Web Mercator tile as a PNG-encoded `ArrayBuffer`.
   *
   * @remarks
   * Applies inverse Mercator projection for each output pixel row so that
   * the rendered tile is geometrically correct at any zoom level.
   * Returns an empty `ArrayBuffer` for tiles with no data intersection.
   *
   * @param z - Zoom level.
   * @param x - Tile column index.
   * @param y - Tile row index.
   * @returns PNG data as an `ArrayBuffer`, or an empty buffer if no data.
   */
  async renderTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
    const levels = await this.getOrOpenPyramid();
    const levelIdx = selectLevel(levels.map(l => ({ shape: l.shape })), z);
    const level = levels[levelIdx];
    const bounds = tileBounds(z, x, y);

    const lonToPx = (lon: number) => ((lon + 180) / 360) * level.shape[1];
    const latToPx = (lat: number) => ((90 - lat) / 180) * level.shape[0];

    const px0 = Math.floor(lonToPx(bounds.west));
    const px1 = Math.ceil(lonToPx(bounds.east));
    const py0 = Math.floor(latToPx(bounds.north));
    const py1 = Math.ceil(latToPx(bounds.south));

    const r0 = Math.max(0, py0);
    const r1 = Math.min(level.shape[0], py1);
    const c0 = Math.max(0, px0);
    const c1 = Math.min(level.shape[1], px1);

    if (r1 <= r0 || c1 <= c0) {
      return new ArrayBuffer(0);
    }

    const result = await zarr.get(level.arr, [
      zarr.slice(r0, r1),
      zarr.slice(c0, c1),
      null,
    ]);

    const rawData = result.data as Uint8Array;
    const src = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    const srcH = r1 - r0;
    const srcW = c1 - c0;
    const nBands = level.shape[2];

    // Render to RGBA tile via canvas and encode as PNG.
    // MapLibre tiles are in Web Mercator but our source data is equirectangular
    // (plate carrée). For each output pixel we compute the actual latitude via
    // the Mercator inverse, then look up the correct row in the source array.
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const out = imgData.data;
    const nTiles = 1 << z;

    for (let ty = 0; ty < TILE_SIZE; ty++) {
      // Mercator Y → latitude for this pixel row
      const mercY = y + (ty + 0.5) / TILE_SIZE;
      const latRad = Math.PI - (2 * Math.PI * mercY) / nTiles;
      const lat = (180 / Math.PI) * Math.atan(Math.sinh(latRad));
      const srcRowF = latToPx(lat) - r0;
      if (srcRowF < 0 || srcRowF >= srcH) continue;
      const srcY = Math.min(srcH - 1, Math.floor(srcRowF));

      for (let tx = 0; tx < TILE_SIZE; tx++) {
        // Longitude is linear in both projections
        const lon = bounds.west + (tx + 0.5) / TILE_SIZE * (bounds.east - bounds.west);
        const srcColF = lonToPx(lon) - c0;
        if (srcColF < 0 || srcColF >= srcW) continue;
        const srcX = Math.min(srcW - 1, Math.floor(srcColF));

        const srcIdx = (srcY * srcW + srcX) * nBands;
        const dstIdx = (ty * TILE_SIZE + tx) * 4;
        out[dstIdx]     = src[srcIdx];
        out[dstIdx + 1] = src[srcIdx + 1];
        out[dstIdx + 2] = src[srcIdx + 2];
        out[dstIdx + 3] = nBands >= 4 ? src[srcIdx + 3] : 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    // Use toDataURL + base64 decode (more compatible than toBlob across browsers)
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * Switch the rendered variable and clear the pyramid cache.
   *
   * @param variable - Zarr array name within each pyramid level (e.g. `'pca_rgb'`).
   */
  setVariable(variable: string): void {
    this.variable = variable;
    this.pyramidCache = null;
  }

  /**
   * Clear the cached pyramid so the next render re-opens the store.
   */
  clearCache(): void {
    this.pyramidCache = null;
  }

  /**
   * Release resources and clear the pyramid cache.
   */
  destroy(): void {
    this.pyramidCache = null;
  }

  private getOrOpenPyramid(): Promise<PyramidLevel[]> {
    if (!this.pyramidCache) {
      this.pyramidCache = this.openPyramid();
    }
    return this.pyramidCache;
  }

  private async openPyramid(): Promise<PyramidLevel[]> {
    const fetchStore = new zarr.FetchStore(this.url);
    const store = new zarr.CoalescingStore(fetchStore);
    const rootLoc = zarr.root(store);
    const group = await zarr.open(rootLoc, { kind: 'group' });
    const attrs = group.attrs as Record<string, unknown>;

    const ms = attrs.multiscales as { layout: { asset: string }[] } | undefined;
    if (!ms?.layout) {
      throw new Error('No multiscales metadata in store');
    }

    const levels: PyramidLevel[] = [];
    for (const entry of ms.layout) {
      const path = `${entry.asset}/${this.variable}`;
      const arr = await zarr.open(rootLoc.resolve(path), { kind: 'array' });
      levels.push({
        arr,
        shape: arr.shape as [number, number, number],
      });
    }
    return levels;
  }
}
