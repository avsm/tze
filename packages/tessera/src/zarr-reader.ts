import * as zarr from 'zarrita';
import type { StoreMetadata } from './types.js';

/**
 * Opened Zarr v3 store with discovered arrays and metadata.
 *
 * @remarks
 * Returned by {@link openStore}. Contains zarrita array handles
 * ready for slicing/fetching.
 *
 * @internal — Consumers should use TesseraSource rather than
 * accessing this directly.
 */
export interface ZarrStore {
  /** Parsed store metadata. */
  meta: StoreMetadata;

  /** The main embeddings array (int8, shape `[H, W, nBands]`). */
  embArr: zarr.Array<zarr.DataType>;

  /** Per-pixel dequantisation scales (float32, shape `[H, W]`). */
  scalesArr: zarr.Array<zarr.DataType>;

  /** Pre-rendered RGB preview array, if present. */
  rgbArr: zarr.Array<zarr.DataType> | null;

  /** PCA-projected RGB preview array, if present. */
  pcaArr: zarr.Array<zarr.DataType> | null;

  /**
   * Set of existing chunk keys (e.g. `"3_7"`), loaded from
   * `_chunk_manifest.json` if available. Used to skip 404s for
   * sparse stores.
   */
  chunkManifest: Set<string> | null;
}

/**
 * Open a TESSERA Zarr v3 store over HTTP.
 *
 * @param url - Store root URL.
 * @returns Opened store with array handles and metadata.
 *
 * @remarks
 * Uses zarrita's FetchStore + CoalescingStore for efficient HTTP
 * range requests. Reads group attributes for CRS, transform, and
 * array discovery.
 */
export async function openStore(url: string): Promise<ZarrStore> {
  const fetchStore = new zarr.FetchStore(url);
  const store = new zarr.CoalescingStore(fetchStore);
  const rootLoc = zarr.root(store);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const embArr = await zarr.open(rootLoc.resolve('embeddings'), { kind: 'array' });
  const scalesArr = await zarr.open(rootLoc.resolve('scales'), { kind: 'array' });

  const utmZone = attrs.utm_zone as number;
  const projCode = attrs['proj:code'] as string | undefined;
  const epsg = projCode ? parseInt(projCode.split(':')[1], 10) : (attrs.crs_epsg as number);
  const transform = (attrs['spatial:transform'] ?? attrs.transform) as [number, number, number, number, number, number];

  if (!utmZone || !transform || !embArr.shape) {
    throw new Error('Missing required store metadata (utm_zone, spatial:transform, shape)');
  }

  // Try optional preview arrays
  let rgbArr: zarr.Array<zarr.DataType> | null = null;
  let pcaArr: zarr.Array<zarr.DataType> | null = null;
  let hasRgb = false;
  let hasPca = false;

  try {
    rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' });
    hasRgb = true;
  } catch { /* no rgb preview */ }

  try {
    pcaArr = await zarr.open(rootLoc.resolve('pca_rgb'), { kind: 'array' });
    hasPca = true;
  } catch { /* no pca preview */ }

  // Try chunk manifest
  let chunkManifest: Set<string> | null = null;
  try {
    const resp = await fetch(`${url}/_chunk_manifest.json`);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.chunks) {
        chunkManifest = new Set(
          (data.chunks as [number, number][]).map(([ci, cj]) => `${ci}_${cj}`)
        );
      }
      if (data?.has_rgb !== undefined) hasRgb = data.has_rgb;
      if (data?.has_pca_rgb !== undefined) hasPca = data.has_pca_rgb;

      // Re-open arrays if manifest says they exist but we didn't find them
      if (hasRgb && !rgbArr) {
        try { rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' }); } catch { hasRgb = false; }
      }
      if (hasPca && !pcaArr) {
        try { pcaArr = await zarr.open(rootLoc.resolve('pca_rgb'), { kind: 'array' }); } catch { hasPca = false; }
      }
    }
  } catch { /* no manifest */ }

  const meta: StoreMetadata = {
    url,
    utmZone,
    epsg,
    transform,
    shape: embArr.shape as [number, number, number],
    chunkShape: embArr.chunks as [number, number, number],
    nBands: (embArr.shape[2] as number) || 128,
    hasRgb,
    hasPca,
    pcaExplainedVariance: attrs.pca_explained_variance as number[] | undefined,
  };

  return { meta, embArr, scalesArr, rgbArr, pcaArr, chunkManifest };
}

/**
 * Fetch a sliced region from a Zarr array.
 *
 * @param arr - A zarrita array handle.
 * @param slices - Per-axis slice: `[start, end]` or `null` for full axis.
 * @param opts - Optional configuration.
 * @param opts.onProgress - Optional progress callback (bytes loaded).
 * @returns Raw typed array and shape.
 */
export async function fetchRegion(
  arr: zarr.Array<zarr.DataType>,
  slices: (null | [number, number])[],
  opts?: { onProgress?: zarr.ProgressCallback },
): Promise<{ data: ArrayBufferView; shape: number[] }> {
  const sel = slices.map(s =>
    s === null ? null : zarr.slice(s[0], s[1])
  );
  const chunk = await zarr.get(arr, sel, {
    onProgress: opts?.onProgress,
  });
  return chunk as { data: ArrayBufferView; shape: number[] };
}
