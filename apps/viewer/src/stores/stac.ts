import { writable, derived, get } from 'svelte/store';
import { SourceManager } from '@ucam-eo/tessera';
import { MaplibreTesseraManager, clearZarrProtocolCache } from '@ucam-eo/maplibre-tessera';
import type { ZoneDescriptor } from '../lib/stac';
import { pointInBbox } from '../lib/stac';
import { mapInstance } from './map';
import { sourceManager, displayManager, metadata, bands, opacity, preview, loading, status, globalPreviewUrl, globalPreviewBounds } from './zarr';
import { clearAllRegions } from './drawing';
import { simSelectedPixel, simScores, simRefEmbedding } from './similarity';
import { labels, isClassified } from './classifier';
import { segmentPolygons } from './segmentation';

export const catalogUrl = writable('https://dl2.geotessera.org/zarr/v1/catalog.json');
export const catalogStatus = writable<'idle' | 'loading' | 'loaded' | 'error'>('idle');
export const catalogError = writable<string>('');

/** All zones across all years, as returned by loadCatalog */
export const allZones = writable<ZoneDescriptor[]>([]);

/** Years discovered in the catalog, sorted ascending */
export const availableYears = writable<string[]>([]);

/** Currently active year */
export const activeYear = writable<string>('');

/** Per-year global preview URLs */
export const globalPreviewUrls = writable<Record<string, string>>({});

/** Zones filtered to the active year */
export const zones = derived(
  [allZones, activeYear],
  ([$allZones, $activeYear]) =>
    $activeYear ? $allZones.filter(z => z.id.endsWith(`_${$activeYear}`)) : $allZones
);

/** Initialize the multi-zone source manager. */
export async function initManager(initialZoneId?: string): Promise<void> {
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldDisplay = get(displayManager);
  if (oldDisplay) oldDisplay.remove();

  status.set('Initializing...');
  console.log('[initManager] Starting with', filteredZones.length, 'zones, initialZone:', initialZoneId);

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const sm = new SourceManager(
      filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
      {
        maxCached: mobile ? 4 : undefined,
      },
    );

    const dm = new MaplibreTesseraManager(sm, {
      bands: get(bands),
      opacity: get(opacity),
      preview: get(preview),
      globalPreviewUrl: get(globalPreviewUrl),
      globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
    });

    sm.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    sm.on('loading', (p) => loading.set(p));
    sm.on('error', (err) => status.set(`Error: ${err.message}`));

    await dm.addTo(map);
    sourceManager.set(sm);
    displayManager.set(dm);

    if (initialZoneId) {
      const zone = filteredZones.find(z => z.id === initialZoneId);
      if (zone) await dm.getDisplaySource(zone.id);
    }

    catalogStatus.set('loaded');
    status.set('Ready');
    console.log('[initManager] Complete, manager ready');
  } catch (err) {
    console.error('[initManager] Failed:', err);
    status.set(`Error: ${(err as Error).message}`);
  }
}

/** Switch active year: updates preview URL and reinitializes the source manager. */
export async function switchYear(year: string): Promise<void> {
  const years = get(availableYears);
  if (!years.includes(year) || year === get(activeYear)) return;

  activeYear.set(year);

  // Clear analysis state — embeddings are year-specific
  clearAllRegions();
  simSelectedPixel.set(null);
  simRefEmbedding.set(null);
  simScores.set(new Map());
  labels.set([]);
  isClassified.set(false);
  segmentPolygons.set({ type: 'FeatureCollection', features: [] });

  // Update global preview URL for this year
  const urls = get(globalPreviewUrls);
  globalPreviewUrl.set(urls[year] ?? '');

  // Reinitialize the source manager with the new year's zones
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldDisplay = get(displayManager);
  if (oldDisplay) oldDisplay.remove();

  status.set(`Switching to ${year}...`);

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const sm = new SourceManager(
      filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
      {
        maxCached: mobile ? 4 : undefined,
      },
    );

    const dm = new MaplibreTesseraManager(sm, {
      bands: get(bands),
      opacity: get(opacity),
      preview: get(preview),
      globalPreviewUrl: get(globalPreviewUrl),
      globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
    });

    sm.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    sm.on('loading', (p) => loading.set(p));
    sm.on('error', (err) => status.set(`Error: ${err.message}`));

    // Clear stale pyramid cache from previous year's tiles
    clearZarrProtocolCache();

    await dm.addTo(map);
    sourceManager.set(sm);
    displayManager.set(dm);

    // Eagerly open the zone the user is looking at so the preview layer appears immediately
    const center = map.getCenter();
    let initialZone = filteredZones.find(z => pointInBbox(center.lng, center.lat, z.bbox));
    if (!initialZone) initialZone = filteredZones[0];
    if (initialZone) await dm.getDisplaySource(initialZone.id);

    status.set(`${year} ready`);
  } catch (err) {
    status.set(`Error: ${(err as Error).message}`);
  }
}
