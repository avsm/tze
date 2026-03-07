<script lang="ts">
  import { Globe, Layers } from 'lucide-svelte';
  import { mapInstance } from '../stores/map';
  import { sourceManager } from '../stores/zarr';

  const VECTOR_SOURCE_ID = 'vector-overlay-src';
  const VECTOR_LAYER_IDS = [
    'vector-landuse', 'vector-landcover', 'vector-water-fill', 'vector-waterway',
    'vector-water-line', 'vector-aeroway', 'vector-boundary',
    'vector-roads', 'vector-rail', 'vector-paths',
    'vector-buildings', 'vector-road-labels',
    'vector-poi', 'vector-labels',
  ];

  let satelliteOn = $state(true);
  let vectorOverlay = $state(true);

  // Auto-enable vector overlay when map becomes available
  $effect(() => {
    const map = $mapInstance;
    if (map && vectorOverlay && !map.getSource(VECTOR_SOURCE_ID)) {
      addVectorOverlay(map);
      $sourceManager?.raiseAllLayers();
    }
  });

  function toggleSatellite() {
    const map = $mapInstance;
    if (!map) return;
    satelliteOn = !satelliteOn;

    if (satelliteOn) {
      if (map.getLayer('basemap')) map.removeLayer('basemap');
      if (map.getSource('basemap')) map.removeSource('basemap');
      map.addSource('basemap', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Esri, Maxar',
      });
      const layers = map.getStyle().layers;
      const bottomLayerId = layers.length > 0 ? layers[0].id : undefined;
      map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, bottomLayerId);
    } else {
      if (map.getLayer('basemap')) map.removeLayer('basemap');
      if (map.getSource('basemap')) map.removeSource('basemap');
    }
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
    $sourceManager?.raiseAllLayers();
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
      filter: ['in', 'class', 'park', 'cemetery', 'hospital', 'school', 'stadium', 'residential', 'industrial', 'commercial', 'railway'],
      paint: {
        'fill-color': ['match', ['get', 'class'],
          'park', '#50C878',
          'cemetery', '#4A8860',
          'hospital', '#FF6464',
          'school', '#FFC850',
          'stadium', '#C8B464',
          'residential', '#B0A090',
          'industrial', '#A090B0',
          'commercial', '#90A0B0',
          'railway', '#908080',
          '#808080',
        ],
        'fill-opacity': 0.2,
      },
    });

    // Landcover — grass, wood, sand, farmland
    add('vector-landcover', {
      type: 'fill',
      'source-layer': 'landcover',
      filter: ['in', 'class', 'wood', 'grass', 'farmland', 'sand', 'wetland', 'ice', 'rock', 'shrub'],
      paint: {
        'fill-color': ['match', ['get', 'class'],
          'wood', '#3CA050',
          'grass', '#50C864',
          'farmland', '#B4C850',
          'sand', '#DCC88C',
          'wetland', '#50B4C8',
          'ice', '#C8DCFF',
          'rock', '#A0A0A0',
          'shrub', '#70B060',
          '#808080',
        ],
        'fill-opacity': 0.2,
      },
    });

    // Water polygons — filled
    add('vector-water-fill', {
      type: 'fill',
      'source-layer': 'water',
      paint: {
        'fill-color': '#3C8CC8',
        'fill-opacity': 0.12,
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

    // Roads — solid white lines
    add('vector-roads', {
      type: 'line',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'],
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.6)',
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['match', ['get', 'class'], 'motorway', 1.5, 'trunk', 1.2, 'primary', 1, 0.5],
          16, ['match', ['get', 'class'], 'motorway', 4, 'trunk', 3, 'primary', 2.5, 'secondary', 2, 1],
        ],
      },
    });

    // Rail — dashed brown
    add('vector-rail', {
      type: 'line',
      'source-layer': 'transportation',
      filter: ['==', 'class', 'rail'],
      paint: {
        'line-color': 'rgba(200, 160, 120, 0.5)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1.5],
        'line-dasharray': [2, 2],
      },
    });

    // Paths/tracks — dashed faint
    add('vector-paths', {
      type: 'line',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'path', 'track'],
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.25)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1],
        'line-dasharray': [1, 1],
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

</script>

<div class="px-3 py-3 border-b border-gray-800/60">
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Layers</span>
  <div class="mt-2 flex gap-1">
    <button
      onclick={toggleSatellite}
      title="Satellite"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {satelliteOn
               ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Globe size={14} />
    </button>

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

  </div>
</div>
