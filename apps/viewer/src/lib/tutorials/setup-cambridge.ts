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
      // If metadata is already loaded (e.g. from a previous tutorial), skip waiting
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
      'Hover over tiles to see their outlines. Double-click loads the pixel embeddings for that tile.\n' +
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
      if (!ctx.zarrSource) return;
      const chunk = ctx.zarrSource.getChunkAtLngLat(0.1218, 52.22);
      if (!chunk) return;
      // If this chunk's embeddings are already loaded, skip
      const key = `${chunk.ci},${chunk.cj}`;
      if (ctx.zarrSource.embeddingCache.has(key)) return;
      const loaded = ctx.waitForEvent('embeddings-loaded', 30000);
      await ctx.zarrSource.loadFullChunk(chunk.ci, chunk.cj);
      await loaded;
    },
    trigger: { kind: 'action-complete' },
  },
];
