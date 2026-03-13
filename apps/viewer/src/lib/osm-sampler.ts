/** Point-in-polygon testing and embedding sampling for OSM polygons. */

import type { TesseraSource } from '@ucam-eo/tessera';
import type { OsmCategory } from './overpass';
import type { EmbeddingAt } from '@ucam-eo/tessera';

export interface SampledLabel {
  lngLat: [number, number];
  embeddingAt: EmbeddingAt;
}

export interface SampleProgress {
  categoryIndex: number;
  categoryTotal: number;
  categoryName: string;
  samplesCollected: number;
}

const IS_MOBILE = typeof navigator !== 'undefined' &&
  (/iPhone|iPad|Android/i.test(navigator.userAgent) || window.innerWidth < 640);
const MAX_SAMPLES_PER_POLYGON = IS_MOBILE ? 8 : 20;
const MAX_SAMPLES_PER_CATEGORY = IS_MOBILE ? 60 : 200;

/** Ray-casting point-in-polygon test. ring is [lng, lat][] (closed or open). */
function pointInPolygon(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Compute bbox of a ring. Returns [minLng, minLat, maxLng, maxLat]. */
function ringBbox(ring: [number, number][]): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Compute sampling stride for a polygon based on its area relative to desired sample count. */
function computeStride(
  minLng: number, minLat: number, maxLng: number, maxLat: number,
  maxSamples: number,
): [number, number] {
  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;
  // Aim for sqrt(maxSamples) steps in each dimension
  const steps = Math.max(3, Math.ceil(Math.sqrt(maxSamples * 2)));
  return [dLng / steps, dLat / steps];
}

/** Sample embeddings from pixels falling within OSM category polygons.
 *  Returns a Map from tag to sampled labels. */
export async function sampleOsmCategories(
  source: TesseraSource,
  categories: OsmCategory[],
  onProgress?: (p: SampleProgress) => void,
): Promise<Map<string, SampledLabel[]>> {
  const result = new Map<string, SampledLabel[]>();

  for (let ci = 0; ci < categories.length; ci++) {
    const cat = categories[ci];
    const samples: SampledLabel[] = [];

    for (const ring of cat.polygons) {
      if (samples.length >= MAX_SAMPLES_PER_CATEGORY) break;

      const [minLng, minLat, maxLng, maxLat] = ringBbox(ring);
      const [strideLng, strideLat] = computeStride(
        minLng, minLat, maxLng, maxLat,
        MAX_SAMPLES_PER_POLYGON,
      );
      let polygonSamples = 0;

      for (let lat = minLat + strideLat / 2; lat < maxLat; lat += strideLat) {
        for (let lng = minLng + strideLng / 2; lng < maxLng; lng += strideLng) {
          if (polygonSamples >= MAX_SAMPLES_PER_POLYGON) break;
          if (samples.length >= MAX_SAMPLES_PER_CATEGORY) break;

          if (!pointInPolygon(lng, lat, ring)) continue;

          const emb = source.getEmbeddingAt(lng, lat);
          if (!emb) continue;

          samples.push({ lngLat: [lng, lat], embeddingAt: emb });
          polygonSamples++;
        }
        if (polygonSamples >= MAX_SAMPLES_PER_POLYGON) break;
        if (samples.length >= MAX_SAMPLES_PER_CATEGORY) break;
      }
    }

    if (samples.length > 0) {
      result.set(cat.tag, samples);
    }

    // Release polygon geometry to free Overpass response memory
    cat.polygons = [];

    onProgress?.({
      categoryIndex: ci + 1,
      categoryTotal: categories.length,
      categoryName: cat.displayName,
      samplesCollected: samples.length,
    });

    // Yield to event loop between categories
    await new Promise(r => setTimeout(r, 0));
  }

  return result;
}
