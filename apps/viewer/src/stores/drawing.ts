import { writable, derived, get } from 'svelte/store';
import { sourceManager } from './zarr';
import { simEmbeddingTileCount } from './similarity';

export type DrawMode = 'polygon' | 'rectangle';
export type RoiRegion = {
  id: string;
  feature: GeoJSON.Feature;
  chunkKeys: string[]; // "zoneId:ci_cj" keys loaded for this region
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
  const manager = get(sourceManager);
  if (!manager) return;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const managedChunks = await manager.getChunksInRegion(geometry);

  const region: RoiRegion = {
    id: `roi-${nextId++}`,
    feature,
    chunkKeys: [],
  };

  // Add region immediately (shows in UI with 0 tiles)
  roiRegions.update(rs => [...rs, region]);

  if (managedChunks.length === 0) return;

  // Group chunks by zone for loading
  const byZone = new Map<string, { ci: number; cj: number }[]>();
  for (const { zoneId, ci, cj } of managedChunks) {
    let arr = byZone.get(zoneId);
    if (!arr) { arr = []; byZone.set(zoneId, arr); }
    arr.push({ ci, cj });
  }

  // Start animations per zone
  for (const [zoneId, chunks] of byZone) {
    const src = manager.getOpenSource(zoneId);
    src?.startRegionAnimation(geometry, chunks);
  }

  // Load per zone with progress tracking (throttled to one update per frame)
  const total = managedChunks.length;
  roiLoading.set({ loaded: 0, total });
  let globalLoaded = 0;
  let rafId = 0;

  for (const [zoneId, chunks] of byZone) {
    const src = await manager.getSource(zoneId);
    const baseLoaded = globalLoaded;
    await src.loadChunkBatch(chunks, (loaded, _t) => {
      globalLoaded = baseLoaded + loaded;
      src.updateRegionAnimation(loaded, chunks.length, chunks[Math.min(loaded - 1, chunks.length - 1)]?.ci, chunks[Math.min(loaded - 1, chunks.length - 1)]?.cj);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          roiLoading.set({ loaded: globalLoaded, total });
        });
      }
    });
    // Cancel any pending rAF and flush final count before next zone
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    roiLoading.set({ loaded: globalLoaded, total });
  }

  // Cancel any trailing rAF so it doesn't overwrite the null below
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

  // Stop all animations and re-render
  manager.stopRegionAnimation();
  manager.recolorAllChunks();

  // Record which chunks this region owns (zone-prefixed keys)
  const loadedKeys: string[] = [];
  for (const { zoneId, ci, cj } of managedChunks) {
    if (manager.regionHasTile(zoneId, ci, cj)) {
      loadedKeys.push(`${zoneId}:${ci}_${cj}`);
    }
  }
  roiRegions.update(rs =>
    rs.map(r => r.id === region.id ? { ...r, chunkKeys: loadedKeys } : r)
  );

  roiLoading.set(null);
  simEmbeddingTileCount.set(manager.totalTileCount());
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

  // Evict exclusive tiles from their zone's region buffer
  const manager = get(sourceManager);
  if (manager) {
    for (const k of exclusiveKeys) {
      // Parse "zoneId:ci_cj"
      const colonIdx = k.indexOf(':');
      const zoneId = k.substring(0, colonIdx);
      const [ciStr, cjStr] = k.substring(colonIdx + 1).split('_');
      const ci = parseInt(ciStr), cj = parseInt(cjStr);

      const src = manager.getOpenSource(zoneId);
      if (!src?.embeddingRegion) continue;

      const region = src.embeddingRegion;
      if (ci >= region.ciMin && ci <= region.ciMax && cj >= region.cjMin && cj <= region.cjMax) {
        const t = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
        const base = t * region.tileW * region.tileH * region.nBands;
        const len = region.tileW * region.tileH * region.nBands;
        for (let i = 0; i < len; i++) region.emb[base + i] = NaN;
        region.loaded[t] = 0;
      }

      // If zone has no loaded tiles, clear its region entirely
      if (src.regionTileCount() === 0) {
        src.embeddingRegion = null;
      }
    }

    manager.clearClassificationOverlays();
    simEmbeddingTileCount.set(manager.totalTileCount());
  }

  roiRegions.update(rs => rs.filter(r => r.id !== regionId));
}

/** Clear all regions and the entire embedding cache. */
export function clearAllRegions(): void {
  const manager = get(sourceManager);
  if (manager) {
    for (const src of manager.getActiveSources().values()) {
      src.embeddingRegion = null;
    }
    manager.clearClassificationOverlays();
  }
  roiRegions.set([]);
  roiLoading.set(null);
}
