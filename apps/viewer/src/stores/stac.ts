import { writable, get } from 'svelte/store';
import { ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';
import type { ZoneDescriptor } from '../lib/stac';
import { mapInstance } from './map';
import { zarrSource, metadata, bands, opacity, preview, loading, status, globalPreviewUrl } from './zarr';

export const catalogUrl = writable('https://dl2.geotessera.org/zarr/v0/catalog.json');
export const zones = writable<ZoneDescriptor[]>([]);
export const activeZoneId = writable<string | null>(null);
export const catalogStatus = writable<'idle' | 'loading' | 'loaded' | 'error'>('idle');
export const catalogError = writable<string>('');

/**
 * Switch the active zarr source to a different zone.
 * Used by both StoreSelector (manual click) and App.svelte (auto-switch on pan).
 */
export async function switchZone(zoneId: string): Promise<void> {
  const zone = get(zones).find(z => z.id === zoneId);
  if (!zone || zoneId === get(activeZoneId)) return;

  const map = get(mapInstance);
  if (!map) return;

  // Remove old source
  const oldSource = get(zarrSource);
  if (oldSource) {
    oldSource.remove();
    zarrSource.set(null);
    metadata.set(null);
  }

  status.set(`Loading zone ${zone.utmZone}...`);

  try {
    const source = new ZarrTesseraSource({
      url: zone.zarrUrl,
      bands: get(bands),
      opacity: get(opacity),
      preview: get(preview),
      globalPreviewUrl: get(globalPreviewUrl),
    });

    source.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    source.on('loading', (p) => loading.set(p));
    source.on('error', (err) => status.set(`Error: ${err.message}`));

    await source.addTo(map);
    zarrSource.set(source);
    activeZoneId.set(zoneId);
  } catch (err) {
    status.set(`Error: ${(err as Error).message}`);
  }
}
