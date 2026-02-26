import * as zarr from 'zarrita';
import type { StoreMetadata } from './types.js';

export interface ZarrStore {
  meta: StoreMetadata;
  embArr: zarr.Array<zarr.DataType>;
  scalesArr: zarr.Array<zarr.DataType>;
  rgbArr: zarr.Array<zarr.DataType> | null;
  pcaArr: zarr.Array<zarr.DataType> | null;
  chunkManifest: Set<string> | null;
}

/**
 * Open a Zarr v3 Tessera embedding store over HTTP.
 * Reads group metadata and opens embeddings, scales, and optional preview arrays.
 */
export async function openStore(url: string): Promise<ZarrStore> {
  const fetchStore = new zarr.FetchStore(url);
  const rootLoc = zarr.root(fetchStore);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const embArr = await zarr.open(rootLoc.resolve('embeddings'), { kind: 'array' });
  const scalesArr = await zarr.open(rootLoc.resolve('scales'), { kind: 'array' });

  const utmZone = attrs.utm_zone as number;
  const epsg = attrs.crs_epsg as number;
  const transform = attrs.transform as [number, number, number, number, number, number];

  if (!utmZone || !transform || !embArr.shape) {
    throw new Error('Missing required store metadata (utm_zone, transform, shape)');
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

/** Fetch a typed-array region from a zarr array using zarrita slicing. */
export async function fetchRegion(
  arr: zarr.Array<zarr.DataType>,
  slices: (null | [number, number])[],
): Promise<{ data: ArrayBufferView; shape: number[] }> {
  const sel = slices.map(s =>
    s === null ? null : zarr.slice(s[0], s[1])
  );
  const chunk = await zarr.get(arr, sel);
  return chunk as { data: ArrayBufferView; shape: number[] };
}
