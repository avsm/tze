import type { TutorialStep } from '../tutorial';
import { addRegion } from '../../stores/drawing';

/** Shared setup steps: fly to Cambridge, wait for zone, explain tiles, load embeddings. */
export const cambridgeSetupSteps: TutorialStep[] = [
  {
    id: 'fly-to-cambridge',
    title: 'Navigate to Cambridge',
    description: 'Flying to Cambridge where we have pre-processed satellite data...',
    action: async (ctx) => {
      await ctx.flyTo({ center: [0.1218, 52.22], zoom: 11, duration: 2000 });
    },
    trigger: { kind: 'action-complete' },
  },
  {
    id: 'wait-zone',
    title: 'Loading Zone Data',
    description: 'Waiting for the zone metadata and tile grid to load...',
    action: async (ctx) => {
      await ctx.ensureZoneAt(0.1218, 52.22);
    },
    trigger: { kind: 'action-complete' },
  },
  {
    id: 'explain-tiles',
    title: 'Tile Grid',
    description:
      'The map is now showing a grid of tiles. Each tile is a chunk of the Zarr dataset.\n' +
      'Hover over tiles to see their outlines. Draw a region to load the pixel embeddings for those tiles.\n' +
      'Embeddings are dense feature vectors extracted by a neural network from each pixel.',
    highlight: '#map',
    arrow: 'none',
    trigger: { kind: 'click' },
  },
  {
    id: 'load-embeddings',
    title: 'Loading Embeddings',
    description:
      'Tessera embeddings are stored as Zarr arrays on a remote server.\n' +
      'We are fetching a region of per-pixel embeddings to the browser — this streams the compressed chunks over the network and decodes them locally.',
    action: async (ctx) => {
      const center = ctx.manager.getChunkAtLngLat(0.1218, 52.22);
      if (!center) return;

      // Build a rectangle polygon covering a 7×7 grid around the center chunk
      const buf = 3;
      const tlCorners = ctx.manager.getChunkBoundsLngLat(center.zoneId, center.ci - buf, center.cj - buf);
      const brCorners = ctx.manager.getChunkBoundsLngLat(center.zoneId, center.ci + buf, center.cj + buf);
      if (!tlCorners || !brCorners) return;

      const west = tlCorners[0][0], north = tlCorners[0][1];
      const east = brCorners[2][0], south = brCorners[2][1];

      const feature: GeoJSON.Feature = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[west, north], [east, north], [east, south], [west, south], [west, north]]],
        },
      };

      await addRegion(feature);

      // Zoom to fit the loaded region with some breathing room
      ctx.map.fitBounds([[west, south], [east, north]], { padding: 120, duration: 1500 });
    },
    trigger: { kind: 'action-complete' },
  },
];
