import type { TutorialStep } from '../tutorial';

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
      'We are fetching a small region of per-pixel embeddings to the browser — this streams the compressed chunks over the network and decodes them locally.',
    action: async (ctx) => {
      const center = ctx.manager.getChunkAtLngLat(0.1218, 52.22);
      if (!center) return;
      const src = await ctx.manager.getSource(center.zoneId);

      // Build a 3×3 grid of tiles around the center chunk
      const buf = 1;
      const chunks: { ci: number; cj: number }[] = [];
      for (let di = -buf; di <= buf; di++) {
        for (let dj = -buf; dj <= buf; dj++) {
          chunks.push({ ci: center.ci + di, cj: center.cj + dj });
        }
      }

      await src.loadChunkBatch(chunks);
      ctx.stores.simEmbeddingTileCount.set(ctx.manager.totalTileCount());

      // Zoom to fit the loaded region
      const bounds = src.embeddingBoundsLngLat();
      if (bounds) {
        ctx.map.fitBounds(
          [[bounds[1], bounds[0]], [bounds[3], bounds[2]]],
          { padding: 40, duration: 1500 },
        );
      }
    },
    trigger: { kind: 'action-complete' },
  },
];
