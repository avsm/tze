import { writable } from 'svelte/store';
import type { ZarrTesseraSource, StoreMetadata } from '@ucam-eo/maplibre-zarr-tessera';

export const zarrSource = writable<ZarrTesseraSource | null>(null);
export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.8);
export const preview = writable<'rgb' | 'pca' | 'bands'>('rgb');
export const loading = writable({ total: 0, done: 0 });
export const status = writable('Ready');
export const gridVisible = writable(true);
export const utmBoundaryVisible = writable(true);

// Recent stores (persisted to localStorage)
const STORAGE_KEY = 'tze-recent-stores';
const MAX_RECENT = 10;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

export const recentStores = writable<string[]>(loadRecent());

export function addRecentStore(url: string): void {
  recentStores.update(stores => {
    const filtered = stores.filter(s => s !== url);
    const updated = [url, ...filtered].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  });
}
