import { writable } from 'svelte/store';

export const segmentPolygons = writable<GeoJSON.FeatureCollection>({
  type: 'FeatureCollection',
  features: [],
});

export const segmentVisible = writable(true);
