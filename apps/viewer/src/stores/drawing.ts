import { writable, derived, get } from 'svelte/store';
import { sourceManager, displayManager } from './zarr';
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
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (!sm) return;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const managedChunks = await sm.getChunksInRegion(geometry);

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
  if (dm) {
    for (const [zoneId, chunks] of byZone) {
      dm.startRegionAnimation(zoneId, geometry, chunks);
    }
  }

  // Load per zone with progress tracking (throttled to one update per frame)
  const total = managedChunks.length;
  roiLoading.set({ loaded: 0, total });
  let globalLoaded = 0;
  let rafId = 0;

  for (const [zoneId, chunks] of byZone) {
    const displaySrc = dm ? await dm.getDisplaySource(zoneId) : null;
    const baseLoaded = globalLoaded;
    if (displaySrc) {
      await displaySrc.loadChunkBatch(chunks, (loaded, _t, ci, cj) => {
        globalLoaded = baseLoaded + loaded;
        if (dm) dm.updateRegionAnimation(zoneId, loaded, chunks.length, ci, cj);
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            roiLoading.set({ loaded: globalLoaded, total });
          });
        }
      });
    }
    // Cancel any pending rAF and flush final count before next zone
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    roiLoading.set({ loaded: globalLoaded, total });
  }

  // Cancel any trailing rAF so it doesn't overwrite the null below
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

  // Stop all animations and re-render
  if (dm) {
    dm.stopRegionAnimation();
    dm.recolorAllChunks();
  }

  // Record which chunks this region owns (zone-prefixed keys)
  const loadedKeys: string[] = [];
  for (const { zoneId, ci, cj } of managedChunks) {
    if (sm.regionHasTile(zoneId, ci, cj)) {
      loadedKeys.push(`${zoneId}:${ci}_${cj}`);
    }
  }
  roiRegions.update(rs =>
    rs.map(r => r.id === region.id ? { ...r, chunkKeys: loadedKeys } : r)
  );

  roiLoading.set(null);
  simEmbeddingTileCount.set(sm.totalTileCount());
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
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (sm) {
    for (const k of exclusiveKeys) {
      // Parse "zoneId:ci_cj"
      const colonIdx = k.indexOf(':');
      const zoneId = k.substring(0, colonIdx);
      const [ciStr, cjStr] = k.substring(colonIdx + 1).split('_');
      const ci = parseInt(ciStr), cj = parseInt(cjStr);

      const src = sm.getOpenSource(zoneId);
      if (!src) continue;

      src.evictTile(ci, cj);

      // If zone has no loaded tiles, clear its region entirely
      if (src.tileCount === 0) {
        src.clearRegion();
      }
    }

    if (dm) dm.clearClassificationOverlays();
    simEmbeddingTileCount.set(sm.totalTileCount());
  }

  roiRegions.update(rs => rs.filter(r => r.id !== regionId));
}

/** Clear all regions and the entire embedding cache. */
export function clearAllRegions(): void {
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (sm) {
    for (const src of sm.getActiveSources().values()) {
      src.clearRegion();
    }
    if (dm) dm.clearClassificationOverlays();
  }
  roiRegions.set([]);
  roiLoading.set(null);
}
