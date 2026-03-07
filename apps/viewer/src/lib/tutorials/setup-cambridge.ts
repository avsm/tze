import type { TutorialStep } from '../tutorial';
import { get } from 'svelte/store';

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
      if (get(ctx.stores.metadata)) return;
      await ctx.waitForEvent('metadata-loaded', 15000);
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
      'We are fetching one tile\'s worth of per-pixel embeddings to the browser right now — this streams the compressed chunks over the network and decodes them locally.',
    action: async (ctx) => {
      const chunk = ctx.manager.getChunkAtLngLat(0.1218, 52.22);
      if (!chunk) return;
      if (ctx.manager.regionHasTile(chunk.zoneId, chunk.ci, chunk.cj)) return;
      const src = await ctx.manager.getSource(chunk.zoneId);
      const loaded = ctx.waitForEvent('embeddings-loaded', 30000);
      await src.loadFullChunk(chunk.ci, chunk.cj);
      await loaded;
    },
    trigger: { kind: 'action-complete' },
  },
];
