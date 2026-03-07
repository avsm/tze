import type { TutorialDef } from '../tutorial';
import { addRegion } from '../../stores/drawing';

const TESSERA_DIAGRAM = `<svg viewBox="0 0 490 380" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;">
  <rect width="490" height="380" rx="6" fill="#0a0a0e" stroke="#374151" stroke-width="0.5" opacity="0.9"/>

  <!-- Title -->
  <a href="https://arxiv.org/abs/2506.20380" target="_blank" rel="noopener">
    <text x="245" y="24" text-anchor="middle" fill="#00e5ff" font-size="14" font-family="monospace" font-weight="bold" text-decoration="underline" style="cursor:pointer">TESSERA \u2014 How Embeddings Are Made</text>
  </a>
  <line x1="30" y1="34" x2="460" y2="34" stroke="#1e293b" stroke-width="0.5"/>

  <!-- ===== Sentinel-2 box ===== -->
  <rect x="16" y="46" width="130" height="108" rx="5" fill="#0f172a" stroke="#4b5563" stroke-width="0.6"/>
  <text x="81" y="64" text-anchor="middle" fill="#f59e0b" font-size="12" font-family="monospace" font-weight="bold">Sentinel-2</text>
  <text x="81" y="78" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="monospace">optical \u2022 13 bands</text>
  <g transform="translate(26,88)">
    <rect x="0" y="0"  width="66" height="5" rx="1.5" fill="#065f46" opacity="0.6"/>
    <rect x="0" y="7"  width="66" height="5" rx="1.5" fill="#0d9488" opacity="0.5"/>
    <rect x="0" y="14" width="66" height="5" rx="1.5" fill="#14b8a6" opacity="0.7"/>
    <rect x="0" y="21" width="66" height="5" rx="1.5" fill="#0d9488" opacity="0.6"/>
    <rect x="0" y="28" width="66" height="5" rx="1.5" fill="#065f46" opacity="0.8"/>
    <rect x="0" y="35" width="66" height="5" rx="1.5" fill="#065f46" opacity="0.5"/>
    <text x="72" y="7"  fill="#9ca3af" font-size="8" font-family="monospace">Jan</text>
    <text x="72" y="21" fill="#9ca3af" font-size="8" font-family="monospace">Jun</text>
    <text x="72" y="35" fill="#9ca3af" font-size="8" font-family="monospace">Dec</text>
  </g>
  <text x="81" y="146" text-anchor="middle" fill="#6b7280" font-size="8" font-family="monospace">~100 passes/yr</text>

  <!-- ===== Sentinel-1 box ===== -->
  <rect x="16" y="162" width="130" height="108" rx="5" fill="#0f172a" stroke="#4b5563" stroke-width="0.6"/>
  <text x="81" y="180" text-anchor="middle" fill="#f59e0b" font-size="12" font-family="monospace" font-weight="bold">Sentinel-1</text>
  <text x="81" y="194" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="monospace">SAR \u2022 microwave</text>
  <g transform="translate(26,204)">
    <rect x="0" y="0"  width="66" height="5" rx="1.5" fill="#312e81" opacity="0.7"/>
    <rect x="0" y="7"  width="66" height="5" rx="1.5" fill="#4338ca" opacity="0.5"/>
    <rect x="0" y="14" width="66" height="5" rx="1.5" fill="#6366f1" opacity="0.6"/>
    <rect x="0" y="21" width="66" height="5" rx="1.5" fill="#4338ca" opacity="0.7"/>
    <rect x="0" y="28" width="66" height="5" rx="1.5" fill="#312e81" opacity="0.5"/>
    <rect x="0" y="35" width="66" height="5" rx="1.5" fill="#312e81" opacity="0.6"/>
    <text x="72" y="7"  fill="#9ca3af" font-size="8" font-family="monospace">Jan</text>
    <text x="72" y="21" fill="#9ca3af" font-size="8" font-family="monospace">Jun</text>
    <text x="72" y="35" fill="#9ca3af" font-size="8" font-family="monospace">Dec</text>
  </g>
  <text x="81" y="256" text-anchor="middle" fill="#6b7280" font-size="8" font-family="monospace">~100 passes/yr</text>
  <text x="81" y="266" text-anchor="middle" fill="#6b7280" font-size="7" font-family="monospace">sees through clouds</text>

  <!-- ===== Arrows to encoder ===== -->
  <line x1="152" y1="100" x2="180" y2="170" stroke="#00e5ff" stroke-width="1.2" opacity="0.6" marker-end="url(#arr)"/>
  <line x1="152" y1="216" x2="180" y2="186" stroke="#00e5ff" stroke-width="1.2" opacity="0.6" marker-end="url(#arr)"/>

  <!-- ===== Self-supervised encoder ===== -->
  <rect x="182" y="120" width="150" height="148" rx="6" fill="#0f172a" stroke="#00e5ff" stroke-width="0.7" opacity="0.85"/>
  <text x="257" y="140" text-anchor="middle" fill="#00e5ff" font-size="12" font-family="monospace" font-weight="bold">Self-Supervised</text>
  <text x="257" y="155" text-anchor="middle" fill="#00e5ff" font-size="12" font-family="monospace" font-weight="bold">Encoder</text>
  <text x="257" y="170" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="monospace">(Barlow Twins)</text>

  <!-- Two branches -->
  <g transform="translate(200,180)">
    <rect x="0"  y="0" width="48" height="18" rx="3" fill="#1e293b" stroke="#00e5ff" stroke-width="0.5"/>
    <text x="24" y="13" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">view A</text>
    <rect x="62" y="0" width="48" height="18" rx="3" fill="#1e293b" stroke="#00e5ff" stroke-width="0.5"/>
    <text x="86" y="13" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">view B</text>
    <text x="55" y="32" text-anchor="middle" fill="#6b7280" font-size="8" font-family="monospace">random temporal samples</text>
    <rect x="16" y="40" width="78" height="18" rx="3" fill="#1e293b" stroke="#f59e0b" stroke-width="0.5"/>
    <text x="55" y="53" text-anchor="middle" fill="#f59e0b" font-size="9" font-family="monospace">cross-correlation</text>
    <text x="55" y="70" text-anchor="middle" fill="#6b7280" font-size="8" font-family="monospace">no labels needed</text>
  </g>

  <!-- ===== Arrow to output ===== -->
  <line x1="338" y1="194" x2="360" y2="194" stroke="#00e5ff" stroke-width="1.5" marker-end="url(#arr)"/>

  <!-- ===== Embedding output ===== -->
  <rect x="362" y="72" width="114" height="240" rx="6" fill="#0f172a" stroke="#4b5563" stroke-width="0.6"/>
  <text x="419" y="92" text-anchor="middle" fill="#00e5ff" font-size="12" font-family="monospace" font-weight="bold">Embedding</text>
  <text x="419" y="106" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="monospace">per 10m\u00b2 pixel</text>

  <!-- Vector bars (top set) -->
  <g transform="translate(374,116)">
    <rect x="0"  y="2"  width="5" height="22" rx="1.5" fill="#00e5ff" opacity="0.9"/>
    <rect x="8"  y="6"  width="5" height="18" rx="1.5" fill="#00e5ff" opacity="0.7"/>
    <rect x="16" y="0"  width="5" height="24" rx="1.5" fill="#00e5ff" opacity="0.8"/>
    <rect x="24" y="9"  width="5" height="15" rx="1.5" fill="#00e5ff" opacity="0.6"/>
    <rect x="32" y="3"  width="5" height="21" rx="1.5" fill="#00e5ff" opacity="0.75"/>
    <rect x="40" y="12" width="5" height="12" rx="1.5" fill="#00e5ff" opacity="0.5"/>
    <rect x="48" y="1"  width="5" height="23" rx="1.5" fill="#00e5ff" opacity="0.85"/>
    <rect x="56" y="7"  width="5" height="17" rx="1.5" fill="#00e5ff" opacity="0.65"/>
    <rect x="64" y="10" width="5" height="14" rx="1.5" fill="#00e5ff" opacity="0.55"/>
    <rect x="72" y="0"  width="5" height="24" rx="1.5" fill="#00e5ff" opacity="0.8"/>
    <rect x="80" y="5"  width="5" height="19" rx="1.5" fill="#00e5ff" opacity="0.7"/>
    <rect x="88" y="14" width="5" height="10" rx="1.5" fill="#00e5ff" opacity="0.45"/>
  </g>
  <text x="419" y="152" text-anchor="middle" fill="#6b7280" font-size="9" font-family="monospace">\u2026</text>
  <!-- Vector bars (bottom set) -->
  <g transform="translate(374,160)">
    <rect x="0"  y="5"  width="5" height="19" rx="1.5" fill="#00e5ff" opacity="0.75"/>
    <rect x="8"  y="10" width="5" height="14" rx="1.5" fill="#00e5ff" opacity="0.6"/>
    <rect x="16" y="0"  width="5" height="24" rx="1.5" fill="#00e5ff" opacity="0.9"/>
    <rect x="24" y="7"  width="5" height="17" rx="1.5" fill="#00e5ff" opacity="0.65"/>
    <rect x="32" y="13" width="5" height="11" rx="1.5" fill="#00e5ff" opacity="0.5"/>
    <rect x="40" y="2"  width="5" height="22" rx="1.5" fill="#00e5ff" opacity="0.85"/>
    <rect x="48" y="8"  width="5" height="16" rx="1.5" fill="#00e5ff" opacity="0.55"/>
    <rect x="56" y="0"  width="5" height="24" rx="1.5" fill="#00e5ff" opacity="0.8"/>
    <rect x="64" y="6"  width="5" height="18" rx="1.5" fill="#00e5ff" opacity="0.7"/>
    <rect x="72" y="12" width="5" height="12" rx="1.5" fill="#00e5ff" opacity="0.5"/>
    <rect x="80" y="3"  width="5" height="21" rx="1.5" fill="#00e5ff" opacity="0.75"/>
    <rect x="88" y="1"  width="5" height="23" rx="1.5" fill="#00e5ff" opacity="0.9"/>
  </g>

  <text x="419" y="200" text-anchor="middle" fill="#00e5ff" font-size="13" font-family="monospace" font-weight="bold">128 dim</text>
  <text x="419" y="214" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="monospace">int8 values</text>

  <!-- Properties list -->
  <text x="419" y="234" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 annual summary</text>
  <text x="419" y="248" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 global coverage</text>
  <text x="419" y="262" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 downloadable</text>
  <text x="419" y="276" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 stored as Zarr</text>
  <text x="419" y="290" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 label-efficient</text>
  <text x="419" y="304" text-anchor="middle" fill="#d1d5db" font-size="9" font-family="monospace">\u2022 preserve temporal signal</text>

  <!-- ===== Bottom bar: summary ===== -->
  <rect x="16" y="320" width="458" height="48" rx="5" fill="#0f172a" opacity="0.7"/>

  <!-- Pixel grid -->
  <g transform="translate(26,328)">
    <rect x="0"  y="0"  width="12" height="12" fill="#134e4a" stroke="#0d9488" stroke-width="0.5" opacity="0.7"/>
    <rect x="12" y="0"  width="12" height="12" fill="#1e3a5f" stroke="#0d9488" stroke-width="0.5" opacity="0.6"/>
    <rect x="24" y="0"  width="12" height="12" fill="#134e4a" stroke="#0d9488" stroke-width="0.5" opacity="0.8"/>
    <rect x="0"  y="12" width="12" height="12" fill="#1e3a5f" stroke="#0d9488" stroke-width="0.5" opacity="0.6"/>
    <rect x="12" y="12" width="12" height="12" fill="#134e4a" stroke="#0d9488" stroke-width="0.5" opacity="0.9"/>
    <rect x="24" y="12" width="12" height="12" fill="#1e3a5f" stroke="#0d9488" stroke-width="0.5" opacity="0.5"/>
  </g>

  <line x1="66" y1="346" x2="80" y2="346" stroke="#6b7280" stroke-width="0.7" marker-end="url(#arr2)"/>

  <text x="88" y="340" fill="#d1d5db" font-size="10" font-family="monospace">Each 10m\u00b2 pixel \u2192 128-d vector from a full year of S1+S2.</text>
  <text x="88" y="356" fill="#d1d5db" font-size="10" font-family="monospace">Self-supervised \u2014 no human labels needed to train.</text>

  <!-- Defs -->
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6" fill="none" stroke="#00e5ff" stroke-width="1"/>
    </marker>
    <marker id="arr2" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
      <path d="M0,0 L6,2.5 L0,5" fill="none" stroke="#6b7280" stroke-width="0.7"/>
    </marker>
  </defs>
</svg>`;

const TESSERA_DIAGRAM_OBJ = {
  title: 'TESSERA Embedding Pipeline',
  url: 'https://arxiv.org/abs/2506.20380',
  html: TESSERA_DIAGRAM,
};

export const understandingEmbeddings: TutorialDef = {
  id: 'understanding-embeddings',
  name: 'Understanding Embeddings',
  description: 'Fly to Cambridge, load embeddings, explore similarity and UMAP',
  steps: [
    {
      id: 'intro',
      title: 'Embeddings',
      description:
        'This tutorial will walk you through the embedding workflow.\n' +
        'You will learn how TZE uses per-pixel embeddings to find similar regions in satellite imagery.\n' +
        'Let\'s start by navigating to a zone with data.',
      trigger: { kind: 'click' },
    },
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
        'Next we\'ll download one tile\'s embeddings \u2014 while that loads, a diagram will explain how they\'re produced.',
      highlight: '#map',
      arrow: 'none',
      trigger: { kind: 'click' },
    },
    {
      id: 'load-embeddings',
      title: 'Downloading Embeddings',
      description:
        'Streaming a small region of embedding tiles from the server.\n' +
        'The diagram shows how TESSERA produces these: Sentinel-1 (radar) and Sentinel-2 (optical) time series from hundreds of satellite passes over a year are fed through a self-supervised encoder trained with Barlow Twins.\n' +
        'No human labels are needed \u2014 the model learns by comparing random temporal views of the same pixel.\n' +
        'The result is a 128-dimensional int8 vector per 10m\u00b2 pixel, available globally as downloadable Zarr arrays.',
      diagram: TESSERA_DIAGRAM_OBJ,
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
    {
      id: 'explain-embeddings',
      title: 'What Do Embeddings Capture?',
      description:
        'Each embedding encodes the full spectral and temporal signature of a 10m\u00b2 area over a year \u2014 seasonal changes, surface texture, moisture from radar.\n' +
        'A field that greens in spring and turns golden in autumn gets a very different embedding from evergreen forest, even if a single snapshot looks similar.\n' +
        'Similar land cover (rooftops, grassland, water) clusters together in this 128-d space, making search, classification, and segmentation straightforward.',
      diagram: TESSERA_DIAGRAM_OBJ,
      trigger: { kind: 'click' },
    },
    {
      id: 'run-similarity',
      title: 'Similarity Search',
      description: 'Switching to Similarity Search and clicking a reference pixel...',
      action: async (ctx) => {
        ctx.stores.activeTool.set('similarity');
        await new Promise((r) => setTimeout(r, 500));
        ctx.similarityClick(0.1218, 52.22);
        await new Promise((r) => setTimeout(r, 1500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-umap',
      title: 'UMAP Visualization',
      description:
        'The UMAP window projects the high-dimensional embeddings down to 2D.\n' +
        'Each dot is a pixel. Similar pixels cluster together.\n' +
        'The highlighted point is your reference pixel, and the colors show cosine similarity.\n' +
        'Drag and resize the window to explore the embedding space.',
      highlight: '[data-tutorial="umap-cloud"]',
      arrow: 'left',
      spotlight: true,
      trigger: { kind: 'click' },
    },
    {
      id: 'threshold-explain',
      title: 'What Is the Threshold?',
      description:
        'Every pixel in the loaded tile has a cosine-similarity score to your reference pixel — a number from 0 (completely different) to 1 (identical).\n\n' +
        'The threshold slider sets a cutoff: only pixels whose score is above the threshold light up on the map.\n\n' +
        'A low value like 0.2 is permissive — it highlights a wide range of loosely related land cover.\n' +
        'A high value like 0.8 is strict — only the closest spectral-temporal matches survive.',
      highlight: '[data-tutorial="umap-threshold"]',
      arrow: 'left',
      trigger: { kind: 'click' },
    },
    {
      id: 'threshold-sweep-low',
      title: 'Low Threshold — Wide Net',
      description:
        'Setting the threshold to 0.2, then slowly raising it.\n' +
        'At 0.2 almost everything lights up — the overlay covers most of the tile because the cutoff is so permissive.\n' +
        'As we raise it, notice regions dropping away — those pixels are less similar to your reference.',
      highlight: '[data-tutorial="umap-threshold"]',
      arrow: 'left',
      action: async (ctx) => {
        ctx.stores.simThreshold.set(0.2);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.stores.simThreshold.set(0.3);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.stores.simThreshold.set(0.4);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.stores.simThreshold.set(0.5);
        await new Promise((r) => setTimeout(r, 1200));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'threshold-sweep-high',
      title: 'High Threshold — Strict Match',
      description:
        'Now pushing the threshold higher.\n' +
        'At 0.6–0.7 the overlay shrinks to tight clusters — only areas with very similar seasonal patterns, surface texture, and spectral response remain.\n' +
        'At 0.8 just a handful of pixels survive. These are near-identical to your reference in embedding space.',
      highlight: '[data-tutorial="umap-threshold"]',
      arrow: 'left',
      action: async (ctx) => {
        ctx.stores.simThreshold.set(0.6);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.stores.simThreshold.set(0.7);
        await new Promise((r) => setTimeout(r, 1500));
        ctx.stores.simThreshold.set(0.8);
        await new Promise((r) => setTimeout(r, 2000));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'threshold-settle',
      title: 'Finding the Sweet Spot',
      description:
        'Bringing the threshold back to a balanced value.\n\n' +
        'In practice you tune the threshold for your task:\n' +
        '• Mapping crop types? A moderate value (~0.5) captures fields with similar growing cycles.\n' +
        '• Finding exact duplicates of a rooftop material? Push it high (~0.8).\n' +
        '• Exploratory survey? Keep it low (~0.3) and scan for patterns.\n\n' +
        'The threshold is the bridge between raw embedding similarity and a useful map overlay.',
      highlight: '[data-tutorial="umap-threshold"]',
      arrow: 'left',
      action: async (ctx) => {
        ctx.stores.simThreshold.set(0.7);
        await new Promise((r) => setTimeout(r, 1000));
        ctx.stores.simThreshold.set(0.6);
        await new Promise((r) => setTimeout(r, 1000));
        ctx.stores.simThreshold.set(0.5);
        await new Promise((r) => setTimeout(r, 800));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'summary',
      title: 'Tutorial Complete',
      description:
        'You\'ve learned the core embedding workflow:\n' +
        '1. Load tiles to fetch per-pixel embeddings from Zarr\n' +
        '2. Click a reference pixel for similarity search\n' +
        '3. Use the threshold slider to filter the overlay\n' +
        '4. Explore the UMAP projection of the embedding space\n\n' +
        'The TESSERA embeddings are described in Feng et al. (arxiv.org/abs/2506.20380).\n' +
        'Try the Classify and Segment tools next to build on these concepts!',
      trigger: { kind: 'click' },
    },
  ],
};
