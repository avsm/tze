import { writable, get } from 'svelte/store';
import { ZarrSourceManager } from '@ucam-eo/maplibre-zarr-tessera';
import type { ZoneDescriptor } from '../lib/stac';
import { mapInstance } from './map';
import { sourceManager, metadata, bands, opacity, preview, loading, status, globalPreviewUrl, globalPreviewBounds } from './zarr';

export const catalogUrl = writable('https://dl2.geotessera.org/zarr/v1/catalog.json');
export const zones = writable<ZoneDescriptor[]>([]);
export const catalogStatus = writable<'idle' | 'loading' | 'loaded' | 'error'>('idle');
export const catalogError = writable<string>('');

/** Initialize the multi-zone source manager. */
export async function initManager(initialZoneId?: string): Promise<void> {
  const allZones = get(zones);
  const map = get(mapInstance);
  if (!map || allZones.length === 0) return;

  const oldManager = get(sourceManager);
  if (oldManager) oldManager.remove();

  status.set('Initializing...');

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const manager = new ZarrSourceManager(
      allZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
      {
        bands: get(bands),
        opacity: get(opacity),
        preview: get(preview),
        globalPreviewUrl: get(globalPreviewUrl),
        globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
        maxCached: mobile ? 4 : undefined,
      },
    );

    manager.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    manager.on('loading', (p) => loading.set(p));
    manager.on('error', (err) => status.set(`Error: ${err.message}`));

    await manager.addTo(map);
    sourceManager.set(manager);

    if (initialZoneId) {
      const zone = allZones.find(z => z.id === initialZoneId);
      if (zone) await manager.getSource(zone.id);
    }

    catalogStatus.set('loaded');
    status.set('Ready');
  } catch (err) {
    status.set(`Error: ${(err as Error).message}`);
  }
}
