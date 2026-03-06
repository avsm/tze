<script lang="ts">
  import { Map as MapIcon, Globe, Moon, Grid3x3, Square, Layers } from 'lucide-svelte';
  import { mapInstance } from '../stores/map';
  import { zarrSource, gridVisible, utmBoundaryVisible } from '../stores/zarr';

  const BASEMAPS = [
    { id: 'osm', label: 'Streets', icon: MapIcon, tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '&copy; OpenStreetMap' },
    { id: 'satellite', label: 'Satellite', icon: Globe, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar' },
    { id: 'dark', label: 'Dark', icon: Moon, tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], attribution: 'CartoDB, OSM' },
  ] as const;

  const VECTOR_SOURCE_ID = 'vector-overlay-src';
  const VECTOR_LAYER_IDS = [
    'vector-roads', 'vector-buildings', 'vector-water-line', 'vector-labels',
  ];

  let selected = $state('osm');
  let vectorOverlay = $state(true);

  // Auto-enable vector overlay when map becomes available
  $effect(() => {
    const map = $mapInstance;
    if (map && vectorOverlay && !map.getSource(VECTOR_SOURCE_ID)) {
      addVectorOverlay(map);
    }
  });

  function switchBasemap(id: string) {
    const map = $mapInstance;
    if (!map || selected === id) return;
    selected = id;
    const bm = BASEMAPS.find(b => b.id === id)!;

    if (map.getLayer('basemap')) map.removeLayer('basemap');
    if (map.getSource('basemap')) map.removeSource('basemap');

    map.addSource('basemap', {
      type: 'raster',
      tiles: [...bm.tiles],
      tileSize: 256,
      attribution: bm.attribution,
    });
    // Insert basemap at the very bottom of the layer stack
    const layers = map.getStyle().layers;
    const bottomLayerId = layers.length > 0 ? layers[0].id : undefined;
    map.addLayer(
      { id: 'basemap', type: 'raster', source: 'basemap' },
      bottomLayerId,
    );
  }

  function toggleVectorOverlay() {
    const map = $mapInstance;
    if (!map) return;
    vectorOverlay = !vectorOverlay;

    if (vectorOverlay) {
      addVectorOverlay(map);
    } else {
      removeVectorOverlay(map);
    }
  }

  function addVectorOverlay(map: maplibregl.Map) {
    // Ensure glyphs URL is set (required for text labels)
    const style = map.getStyle();
    if (!style.glyphs) {
      style.glyphs = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
      map.setStyle(style, { diff: true });
    }

    if (!map.getSource(VECTOR_SOURCE_ID)) {
      map.addSource(VECTOR_SOURCE_ID, {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '&copy; OpenFreeMap, OpenMapTiles, OSM',
      });
    }

    // Roads — white lines
    if (!map.getLayer('vector-roads')) {
      map.addLayer({
        id: 'vector-roads',
        type: 'line',
        source: VECTOR_SOURCE_ID,
        'source-layer': 'transportation',
        filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path'],
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.6)',
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['match', ['get', 'class'], 'motorway', 1.5, 'trunk', 1.2, 'primary', 1, 0.5],
            16, ['match', ['get', 'class'], 'motorway', 4, 'trunk', 3, 'primary', 2.5, 'secondary', 2, 1],
          ],
        },
      });
    }

    // Buildings — subtle outlines
    if (!map.getLayer('vector-buildings')) {
      map.addLayer({
        id: 'vector-buildings',
        type: 'line',
        source: VECTOR_SOURCE_ID,
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.35)',
          'line-width': 0.5,
        },
      });
    }

    // Water boundaries
    if (!map.getLayer('vector-water-line')) {
      map.addLayer({
        id: 'vector-water-line',
        type: 'line',
        source: VECTOR_SOURCE_ID,
        'source-layer': 'water',
        paint: {
          'line-color': 'rgba(100, 200, 255, 0.5)',
          'line-width': 1,
        },
      });
    }

    // Place labels
    if (!map.getLayer('vector-labels')) {
      map.addLayer({
        id: 'vector-labels',
        type: 'symbol',
        source: VECTOR_SOURCE_ID,
        'source-layer': 'place',
        filter: ['in', 'class', 'city', 'town', 'village', 'suburb', 'neighbourhood'],
        layout: {
          'text-field': '{name:latin}',
          'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 10],
          'text-font': ['Noto Sans Regular'],
          'text-anchor': 'center',
          'text-max-width': 8,
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-color': 'rgba(0, 0, 0, 0.7)',
          'text-halo-width': 1.5,
        },
      });
    }
  }

  function removeVectorOverlay(map: maplibregl.Map) {
    for (const id of VECTOR_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(VECTOR_SOURCE_ID)) map.removeSource(VECTOR_SOURCE_ID);
  }

  function toggleGrid() {
    $gridVisible = !$gridVisible;
    $zarrSource?.setGridVisible($gridVisible);
  }

  function toggleUtm() {
    $utmBoundaryVisible = !$utmBoundaryVisible;
    $zarrSource?.setUtmBoundaryVisible($utmBoundaryVisible);
  }
</script>

<div class="px-3 py-3 border-b border-gray-800/60">
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Layers</span>
  <div class="mt-2 flex gap-1">
    {#each BASEMAPS as bm}
      <button
        onclick={() => switchBasemap(bm.id)}
        title={bm.label}
        class="w-7 h-7 flex items-center justify-center rounded border transition-all
               {selected === bm.id
                 ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                 : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
      >
        <bm.icon size={14} />
      </button>
    {/each}

    <div class="w-px bg-gray-800/60 mx-0.5"></div>

    <button
      onclick={toggleVectorOverlay}
      title="Vector overlay"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {vectorOverlay
               ? 'bg-term-cyan/15 text-term-cyan border-term-cyan/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Layers size={14} />
    </button>

    <button
      onclick={toggleGrid}
      title="Chunk grid"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {$gridVisible
               ? 'bg-term-cyan/15 text-term-cyan border-term-cyan/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Grid3x3 size={14} />
    </button>
    <button
      onclick={toggleUtm}
      title="UTM boundary"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {$utmBoundaryVisible
               ? 'bg-green-400/15 text-green-400 border-green-400/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Square size={14} />
    </button>
  </div>
</div>
