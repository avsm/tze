import { writable, derived, get } from 'svelte/store';
import { zarrSource } from './zarr';

export type DrawMode = 'polygon' | 'rectangle';
export type RoiRegion = {
  id: string;
  feature: GeoJSON.Feature;
  chunkKeys: string[]; // "ci_cj" keys loaded for this region
};

/** Whether terra-draw is currently active for drawing. */
export const roiDrawing = writable(false);

/** Active terra-draw mode (polygon or rectangle). */
export const drawMode = writable<DrawMode>('rectangle');

/** All drawn ROI regions. */
export const roiRegions = writable<RoiRegion[]>([]);

/** Loading progress: null when idle. */
export const roiLoading = writable<{ loaded: number; total: number } | null>(null);

/** Total number of embedding tiles loaded across all regions. */
export const roiTileCount = derived(roiRegions, ($regions) => {
  const keys = new Set<string>();
  for (const r of $regions) {
    for (const k of r.chunkKeys) keys.add(k);
  }
  return keys.size;
});

let nextId = 0;

/** Called when terra-draw finishes a shape. Starts loading chunks for the region. */
export async function addRegion(feature: GeoJSON.Feature): Promise<void> {
  const src = get(zarrSource);
  if (!src) return;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const chunks = src.getChunksInRegion(geometry);

  const region: RoiRegion = {
    id: `roi-${nextId++}`,
    feature,
    chunkKeys: [],
  };

  // Add region immediately (shows in UI with 0 tiles)
  roiRegions.update(rs => [...rs, region]);

  if (chunks.length === 0) return;

  // Start region-wide loading animation
  src.startRegionAnimation(geometry, chunks);

  // Start progressive loading
  const total = chunks.length;
  roiLoading.set({ loaded: 0, total });

  let prevLoaded = 0;
  await src.loadChunkBatch(chunks, (loaded, t) => {
    roiLoading.set({ loaded, total: t });
    // Mark newly loaded tiles on the animation
    if (loaded > prevLoaded) {
      // We know which tile just loaded from the chunks array
      for (let i = prevLoaded; i < loaded && i < chunks.length; i++) {
        src.updateRegionAnimation(loaded, t, chunks[i].ci, chunks[i].cj);
      }
      prevLoaded = loaded;
    }
  });

  // Stop animation and re-render tiles
  src.stopRegionAnimation();
  src.recolorAllChunks();

  // Record which chunks this region owns
  const loadedKeys = chunks
    .filter(c => src.regionHasTile(c.ci, c.cj))
    .map(c => `${c.ci}_${c.cj}`);
  roiRegions.update(rs =>
    rs.map(r => r.id === region.id ? { ...r, chunkKeys: loadedKeys } : r)
  );

  roiLoading.set(null);
}

/** Remove a single region. Evict its exclusive tiles from the embedding cache. */
export function removeRegion(regionId: string): void {
  const regions = get(roiRegions);
  const target = regions.find(r => r.id === regionId);
  if (!target) return;

  // Find keys owned exclusively by this region
  const otherKeys = new Set<string>();
  for (const r of regions) {
    if (r.id !== regionId) {
      for (const k of r.chunkKeys) otherKeys.add(k);
    }
  }
  const exclusiveKeys = target.chunkKeys.filter(k => !otherKeys.has(k));

  // Evict exclusive tiles from region
  const src = get(zarrSource);
  if (src && src.embeddingRegion) {
    const region = src.embeddingRegion;
    for (const k of exclusiveKeys) {
      const [ciStr, cjStr] = k.split('_');
      const ci = parseInt(ciStr), cj = parseInt(cjStr);
      if (ci >= region.ciMin && ci <= region.ciMax && cj >= region.cjMin && cj <= region.cjMax) {
        const t = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
        const base = t * region.tileW * region.tileH * region.nBands;
        const len = region.tileW * region.tileH * region.nBands;
        for (let i = 0; i < len; i++) region.emb[base + i] = NaN;
        region.loaded[t] = 0;
      }
    }
    src.clearClassificationOverlays();
  }

  roiRegions.update(rs => rs.filter(r => r.id !== regionId));
}

/** Clear all regions and the entire embedding cache. */
export function clearAllRegions(): void {
  const src = get(zarrSource);
  if (src) {
    src.embeddingRegion = null;
    src.clearClassificationOverlays();
  }
  roiRegions.set([]);
  roiLoading.set(null);
}
