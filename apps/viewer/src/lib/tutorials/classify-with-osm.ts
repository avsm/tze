import type { TutorialDef } from '../tutorial';
import { get } from 'svelte/store';
import { classifyTiles } from '../classify';
import { cambridgeSetupSteps } from './setup-cambridge';

export const classifyWithOsm: TutorialDef = {
  id: 'classify-with-osm',
  name: 'Classify with Labels',
  description: 'Import training labels from OpenStreetMap and run a k-NN classifier on tile embeddings',
  steps: [
    {
      id: 'intro',
      title: 'Classification',
      description:
        'This tutorial shows how to classify land cover using per-pixel embeddings.\n' +
        'You can label pixels manually by clicking the map, but for a quick demo we\'ll import training labels automatically from OpenStreetMap.\n' +
        'OSM polygons (forests, water, residential areas, etc.) become ground truth for a k-nearest-neighbour classifier that runs entirely in your browser on the GPU.',
      trigger: { kind: 'click' },
    },
    {
      id: 'reset-state',
      title: 'Preparing Workspace',
      description: 'Clearing previous state and switching to the Classifier tab...',
      action: async (ctx) => {
        // Clear similarity state from a previous tutorial
        ctx.stores.simScores.set([]);
        ctx.stores.simRefEmbedding.set(null);
        ctx.stores.simSelectedPixel.set(null);
        ctx.stores.simThreshold.set(0.5);
        // Clear classifier state
        ctx.stores.classes.set([]);
        ctx.stores.labels.set([]);
        ctx.stores.isClassified.set(false);
        // Clear classification overlays on the map
        if (ctx.zarrSource) {
          ctx.zarrSource.clearClassificationOverlays();
        }
        // Switch to classifier tab
        ctx.stores.activeTool.set('classifier');
        await new Promise((r) => setTimeout(r, 300));
      },
      trigger: { kind: 'action-complete' },
    },
    ...cambridgeSetupSteps,
    {
      id: 'switch-to-classifier',
      title: 'Classifier Tool',
      description:
        'Switching to the Classifier panel.\n' +
        'This is where you define land-cover classes, label training pixels, and run the classifier.\n' +
        'Normally you would click the map to place manual labels — but we\'ll use OSM data instead.',
      highlight: '[data-tutorial="tool-switcher"]',
      arrow: 'left',
      action: async (ctx) => {
        ctx.stores.activeTool.set('classifier');
        await new Promise((r) => setTimeout(r, 500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'open-osm',
      title: 'Import from OSM',
      description:
        'The IMPORT FROM OSM button queries the Overpass API for land-cover polygons (forests, water, residential, etc.) within the loaded tile area.\n' +
        'It then samples pixel embeddings that fall inside each polygon to create training labels.\n' +
        'We\'ll open the dialog and automatically import all available categories.',
      highlight: '[data-tutorial="label-panel-osm"]',
      arrow: 'left',
      trigger: { kind: 'click' },
    },
    {
      id: 'wait-osm-import',
      title: 'Importing Labels',
      description:
        'Querying the Overpass API for OSM features — this can take a moment depending on the server.\n' +
        'Once features are found, labels are automatically sampled from the embeddings.',
      action: async (ctx) => {
        // Open modal with autoImport so it auto-clicks IMPORT after Overpass returns
        ctx.openOsmModal({ autoImport: true });

        // Wait for labels to appear — poll until we have at least 2 classes with labels
        const timeout = 120000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const labs = get(ctx.stores.labels);
          const cls = get(ctx.stores.classes);
          const uniqueClasses = new Set(labs.map(l => l.classId));
          if (labs.length >= 4 && uniqueClasses.size >= 2 && cls.length >= 2) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        // Close the modal once done
        ctx.closeOsmModal();
        await new Promise((r) => setTimeout(r, 500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-labels',
      title: 'Training Labels',
      description:
        'Colored dots on the map show the imported training labels.\n' +
        'Each dot is a pixel whose embedding was sampled from inside an OSM polygon.\n' +
        'Small dots = OSM labels, larger dots = manual labels.\n' +
        'The classifier will use these to learn what each land-cover class "looks like" in embedding space.',
      highlight: '#map',
      arrow: 'none',
      trigger: { kind: 'click' },
    },
    {
      id: 'run-classification',
      title: 'Running Classifier',
      description:
        'Running k-nearest-neighbour classification on the GPU.\n' +
        'For each pixel, the classifier finds the k closest training labels in embedding space and votes on the class.\n' +
        'This runs entirely in your browser using TensorFlow.js WebGL.',
      highlight: '[data-tutorial="label-panel"]',
      arrow: 'left',
      action: async (ctx) => {
        if (!ctx.zarrSource) return;
        const allLabels = get(ctx.stores.labels);
        const allClasses = get(ctx.stores.classes);
        if (allLabels.length < 2 || allClasses.length < 2) return;

        const k = get(ctx.stores.kValue);
        const confidence = get(ctx.stores.confidenceThreshold);
        const opacity = get(ctx.stores.classificationOpacity);

        ctx.zarrSource.clearClassificationOverlays();

        await classifyTiles(
          ctx.zarrSource.embeddingCache,
          allLabels,
          allClasses,
          k,
          confidence,
          undefined,
          (ci, cj, canvas, classMap, w, h) => {
            ctx.zarrSource!.addClassificationOverlay(ci, cj, canvas);
            ctx.zarrSource!.setClassificationOpacity(opacity);
            ctx.zarrSource!.setClassificationMap(ci, cj, classMap, w, h);
            ctx.stores.isClassified.set(true);
          },
        );
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-results',
      title: 'Classification Results',
      description:
        'The colored overlay shows the predicted land-cover class for each pixel.\n' +
        'Grey areas are "uncertain" — the classifier\'s confidence was below the threshold.\n' +
        'You can adjust the confidence slider and opacity to refine the visualization.\n' +
        'Try adding manual labels in under-represented areas to improve accuracy.',
      highlight: '#map',
      arrow: 'none',
      trigger: { kind: 'click' },
    },
    {
      id: 'summary',
      title: 'Tutorial Complete',
      description:
        'You\'ve learned the classification workflow:\n' +
        '1. Load tile embeddings from Zarr\n' +
        '2. Import training labels from OSM (or place them manually)\n' +
        '3. Run k-NN classification on the GPU\n' +
        '4. Inspect and refine the results\n\n' +
        'The classifier runs entirely in the browser — no server round-trips needed.\n' +
        'Try the Similarity Search tutorial to explore the embedding space!',
      trigger: { kind: 'click' },
    },
  ],
};
