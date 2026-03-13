import { writable } from 'svelte/store';
import type { SourceManager, StoreMetadata } from '@ucam-eo/tessera';
import type { MaplibreTesseraManager } from '@ucam-eo/maplibre-tessera';

/** Core data manager — embedding queries, zone routing, events. */
export const sourceManager = writable<SourceManager | null>(null);

/** MapLibre display manager — layers, overlays, animations. */
export const displayManager = writable<MaplibreTesseraManager | null>(null);

export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.6);
export const preview = writable<'rgb' | 'bands'>('rgb');
export const loading = writable({ total: 0, done: 0 });
export const status = writable('Ready');
export const globalPreviewUrl = writable<string>('');
export const globalPreviewBounds = writable<[number, number, number, number] | null>(null);
