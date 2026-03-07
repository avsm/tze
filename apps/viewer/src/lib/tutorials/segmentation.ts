import type { TutorialDef } from '../tutorial';
import { clearSegmentation } from '../segment';
import { segmentPolygons } from '../../stores/segmentation';
import { addRegion } from '../../stores/drawing';

export const segmentationTutorial: TutorialDef = {
  id: 'segmentation',
  name: 'Segmentation',
  description: 'Detect solar panels in satellite imagery using a UNet model on tile embeddings',
  steps: [
    {
      id: 'intro',
      title: 'Segmentation',
      description:
        'This tutorial shows how to detect features in satellite imagery using segmentation.\n' +
        'We\'ll use a UNet neural network that runs entirely in your browser to find solar panel installations from TESSERA embeddings.\n' +
        'Let\'s fly to an area east of Cambridge with solar farms visible in the satellite imagery.',
      trigger: { kind: 'click' },
    },
    {
      id: 'reset-state',
      title: 'Preparing Workspace',
      description: 'Clearing previous state...',
      action: async (ctx) => {
        // Clear similarity state
        ctx.stores.simScores.set(new Map());
        ctx.stores.simRefEmbedding.set(null);
        ctx.stores.simSelectedPixel.set(null);
        ctx.stores.simThreshold.set(0.5);
        // Clear classifier state
        ctx.stores.classes.set([]);
        ctx.stores.labels.set([]);
        ctx.stores.isClassified.set(false);
        ctx.manager.clearClassificationOverlays();
        // Clear previous segmentation state
        clearSegmentation();
        segmentPolygons.set({ type: 'FeatureCollection', features: [] });
        await new Promise((r) => setTimeout(r, 300));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'switch-satellite',
      title: 'Satellite View',
      description: 'Switching to satellite basemap for a clearer view of the ground...',
      action: async (ctx) => {
        ctx.switchBasemap('satellite');
        await new Promise((r) => setTimeout(r, 500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'fly-to-area',
      title: 'Navigate to Target',
      description: 'Flying to an area just east of Cambridge where solar farms are visible...',
      action: async (ctx) => {
        await ctx.flyTo({ center: [0.30, 52.27], zoom: 12, duration: 2500 });
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'wait-zone',
      title: 'Loading Zone Data',
      description: 'Waiting for the zone metadata and tile grid to load...',
      action: async (ctx) => {
        await ctx.ensureZoneAt(0.30, 52.27);
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-segmentation',
      title: 'What Is Segmentation?',
      description:
        'Segmentation assigns a label to every pixel in an image — unlike classification which labels whole tiles.\n' +
        'Our UNet model slides a 64x64 patch window across the tile embeddings with a 32-pixel stride.\n' +
        'For each patch, the model predicts the probability that each pixel contains a solar panel.\n' +
        'Overlapping predictions are averaged, then thresholded to produce binary masks and GeoJSON polygons.',
      trigger: { kind: 'click' },
    },
    {
      id: 'load-tile',
      title: 'Loading Tile Embeddings',
      description:
        'Downloading a small region of per-pixel embeddings.\n' +
        'Each pixel has a 128-dimensional embedding vector — the model uses these as input features instead of raw spectral bands.',
      action: async (ctx) => {
        const center = ctx.manager.getChunkAtLngLat(0.30, 52.27);
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
    {
      id: 'switch-to-segment',
      title: 'Segment Tool',
      description:
        'Switching to the Segment panel where you can choose a detection model and run inference.\n' +
        'Solar Panels is the currently available detector — more models can be added to the dropdown.',
      highlight: '[data-tutorial="tool-switcher"]',
      arrow: 'left',
      action: async (ctx) => {
        ctx.stores.activeTool.set('segmenter');
        await new Promise((r) => setTimeout(r, 500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'run-detection',
      title: 'Running Detection',
      description:
        'Running the UNet model on embedding patches — this may take a moment.\n' +
        'The model runs in ONNX Runtime (WebAssembly) entirely in your browser.\n' +
        'No data leaves your machine.\n' +
        'Watch the progress bar in the Segment panel.',
      highlight: '[data-tutorial="segment-panel"]',
      arrow: 'left',
      action: async (ctx) => {
        // Click the detect button so the SegmentPanel's own progress bar shows
        const btn = document.querySelector<HTMLButtonElement>('[data-tutorial="segment-detect-btn"]');
        if (btn && !btn.disabled) {
          btn.click();
          // Wait for detection to finish — poll button text
          await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              const b = document.querySelector<HTMLButtonElement>('[data-tutorial="segment-detect-btn"]');
              if (b && !b.textContent?.includes('DETECTING')) {
                clearInterval(interval);
                resolve();
              }
            }, 500);
            // Safety timeout
            setTimeout(() => { clearInterval(interval); resolve(); }, 120000);
          });
        }
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'show-results',
      title: 'Detection Results',
      description:
        'Reducing the embedding overlay so the satellite imagery is clearer.\n' +
        'The orange polygons are pulsing to show the detected solar panel installations.',
      action: async (ctx) => {
        ctx.manager.setOpacity(0.15);

        // Pulse the segment polygon layers 3 times
        const map = ctx.map;
        if (map.getLayer('segment-polygons-fill')) {
          for (let i = 0; i < 3; i++) {
            map.setPaintProperty('segment-polygons-fill', 'fill-opacity', 0.6);
            map.setPaintProperty('segment-polygons-line', 'line-opacity', 1);
            map.setPaintProperty('segment-polygons-line', 'line-width', 3);
            await new Promise((r) => setTimeout(r, 500));
            map.setPaintProperty('segment-polygons-fill', 'fill-opacity', 0.2);
            map.setPaintProperty('segment-polygons-line', 'line-opacity', 0.6);
            map.setPaintProperty('segment-polygons-line', 'line-width', 1.5);
            await new Promise((r) => setTimeout(r, 500));
          }
          // Settle on visible but not overpowering
          map.setPaintProperty('segment-polygons-fill', 'fill-opacity', 0.3);
          map.setPaintProperty('segment-polygons-line', 'line-opacity', 0.8);
          map.setPaintProperty('segment-polygons-line', 'line-width', 1.5);
        }
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-results',
      title: 'Inspecting Results',
      description:
        'Orange polygons on the map show detected solar panel installations.\n' +
        'Each polygon was traced from the binary probability mask after thresholding.\n' +
        'You can adjust the threshold slider to be more or less sensitive — lower values find more candidates, higher values are more strict.\n' +
        'Zoom into the satellite imagery to verify the detections against the visible panels.',
      highlight: '#map',
      arrow: 'none',
      trigger: { kind: 'click' },
    },
    {
      id: 'summary',
      title: 'Tutorial Complete',
      description:
        'You\'ve learned the segmentation workflow:\n' +
        '1. Load tile embeddings from Zarr\n' +
        '2. Run a UNet detection model in the browser (ONNX/WASM)\n' +
        '3. Inspect and threshold the results\n\n' +
        'The model uses the same 128-d TESSERA embeddings as Similarity Search and Classification.\n' +
        'Try the other tutorials to explore those workflows!',
      trigger: { kind: 'click' },
    },
  ],
};
