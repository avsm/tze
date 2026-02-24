import { writable } from 'svelte/store';
import type { Map as MaplibreMap } from 'maplibre-gl';

export const mapInstance = writable<MaplibreMap | null>(null);
