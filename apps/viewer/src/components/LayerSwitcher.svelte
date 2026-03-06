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
    'vector-landuse', 'vector-landcover', 'vector-water-fill', 'vector-waterway',
    'vector-water-line', 'vector-aeroway', 'vector-boundary',
    'vector-roads', 'vector-buildings', 'vector-road-labels',
    'vector-poi', 'vector-labels',
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

    const add = (id: string, spec: Omit<maplibregl.LayerSpecification, 'id' | 'source'>) => {
      if (!map.getLayer(id)) map.addLayer({ id, source: VECTOR_SOURCE_ID, ...spec } as maplibregl.LayerSpecification);
    };

    // Landuse — parks, forests, residential (subtle fills)
    add('vector-landuse', {
      type: 'fill',
      'source-layer': 'landuse',
      paint: {
        'fill-color': ['match', ['get', 'class'],
          'park', 'rgba(80, 200, 120, 0.12)',
          'cemetery', 'rgba(80, 200, 120, 0.08)',
          'hospital', 'rgba(255, 100, 100, 0.08)',
          'school', 'rgba(255, 200, 80, 0.08)',
          'stadium', 'rgba(200, 180, 100, 0.08)',
          'rgba(0, 0, 0, 0)',
        ],
      },
    });

    // Landcover — grass, wood, sand, farmland
    add('vector-landcover', {
      type: 'fill',
      'source-layer': 'landcover',
      paint: {
        'fill-color': ['match', ['get', 'class'],
          'wood', 'rgba(60, 160, 80, 0.15)',
          'grass', 'rgba(80, 200, 100, 0.10)',
          'farmland', 'rgba(180, 200, 80, 0.08)',
          'sand', 'rgba(220, 200, 140, 0.10)',
          'wetland', 'rgba(80, 180, 200, 0.10)',
          'ice', 'rgba(200, 220, 255, 0.15)',
          'rgba(0, 0, 0, 0)',
        ],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 0.3],
      },
    });

    // Water polygons — filled
    add('vector-water-fill', {
      type: 'fill',
      'source-layer': 'water',
      paint: {
        'fill-color': 'rgba(60, 140, 200, 0.25)',
      },
    });

    // Waterways — rivers, streams, canals
    add('vector-waterway', {
      type: 'line',
      'source-layer': 'waterway',
      paint: {
        'line-color': 'rgba(100, 180, 240, 0.5)',
        'line-width': ['match', ['get', 'class'],
          'river', 2,
          'canal', 1.5,
          'stream', 1,
          0.5,
        ],
      },
    });

    // Water boundaries
    add('vector-water-line', {
      type: 'line',
      'source-layer': 'water',
      paint: {
        'line-color': 'rgba(100, 200, 255, 0.5)',
        'line-width': 1,
      },
    });

    // Aeroways — runways, taxiways
    add('vector-aeroway', {
      type: 'line',
      'source-layer': 'aeroway',
      minzoom: 11,
      paint: {
        'line-color': 'rgba(200, 180, 255, 0.5)',
        'line-width': ['match', ['get', 'class'],
          'runway', 4,
          'taxiway', 2,
          1,
        ],
      },
    });

    // Administrative boundaries
    add('vector-boundary', {
      type: 'line',
      'source-layer': 'boundary',
      filter: ['in', 'admin_level', 2, 4],
      paint: {
        'line-color': 'rgba(200, 160, 255, 0.4)',
        'line-width': ['match', ['get', 'admin_level'], 2, 1.5, 0.8],
        'line-dasharray': [3, 2],
      },
    });

    // Roads — white lines
    add('vector-roads', {
      type: 'line',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path', 'rail', 'track'],
      paint: {
        'line-color': ['match', ['get', 'class'],
          'rail', 'rgba(200, 160, 120, 0.5)',
          'path', 'rgba(255, 255, 255, 0.3)',
          'track', 'rgba(255, 255, 255, 0.25)',
          'rgba(255, 255, 255, 0.6)',
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['match', ['get', 'class'], 'motorway', 1.5, 'trunk', 1.2, 'primary', 1, 'rail', 0.8, 0.5],
          16, ['match', ['get', 'class'], 'motorway', 4, 'trunk', 3, 'primary', 2.5, 'secondary', 2, 'rail', 1.5, 1],
        ],
        'line-dasharray': ['match', ['get', 'class'],
          'rail', ['literal', [2, 2]],
          'path', ['literal', [1, 1]],
          ['literal', [1, 0]],
        ],
      },
    });

    // Buildings — subtle outlines
    add('vector-buildings', {
      type: 'line',
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.35)',
        'line-width': 0.5,
      },
    });

    // Road labels
    add('vector-road-labels', {
      type: 'symbol',
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'text-field': '{name:latin}',
        'text-size': 9,
        'text-font': ['Noto Sans Regular'],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-max-angle': 30,
      },
      paint: {
        'text-color': 'rgba(255, 255, 255, 0.6)',
        'text-halo-color': 'rgba(0, 0, 0, 0.6)',
        'text-halo-width': 1,
      },
    });

    // POI labels — shops, restaurants, etc.
    add('vector-poi', {
      type: 'symbol',
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['<=', 'rank', 20],
      layout: {
        'text-field': '{name:latin}',
        'text-size': 9,
        'text-font': ['Noto Sans Regular'],
        'text-anchor': 'top',
        'text-offset': [0, 0.5],
        'text-max-width': 6,
      },
      paint: {
        'text-color': 'rgba(255, 200, 100, 0.7)',
        'text-halo-color': 'rgba(0, 0, 0, 0.6)',
        'text-halo-width': 1,
      },
    });

    // Place labels — cities, towns, villages
    add('vector-labels', {
      type: 'symbol',
      'source-layer': 'place',
      filter: ['in', 'class', 'city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet'],
      layout: {
        'text-field': '{name:latin}',
        'text-size': ['match', ['get', 'class'], 'city', 14, 'town', 12, 'village', 10, 9],
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
