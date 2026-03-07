import { writable } from 'svelte/store';
import type { StoreMetadata, ZarrSourceManager } from '@ucam-eo/maplibre-zarr-tessera';

export const sourceManager = writable<ZarrSourceManager | null>(null);
export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.6);
export const preview = writable<'rgb' | 'pca' | 'bands'>('rgb');
export const loading = writable({ total: 0, done: 0 });
export const status = writable('Ready');
export const globalPreviewUrl = writable<string>('');
export const globalPreviewBounds = writable<[number, number, number, number] | null>(null);
