<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { mapInstance } from './stores/map';
  import TopBar from './components/TopBar.svelte';
  import CatalogModal from './components/CatalogModal.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import DebugConsole from './components/DebugConsole.svelte';
  import ToolSwitcher from './components/ToolSwitcher.svelte';
  import type SimilaritySearch from './components/SimilaritySearch.svelte';
  import { zarrSource } from './stores/zarr';
  import { get } from 'svelte/store';
  import { activeClass, classes, addLabel, isClassified } from './stores/classifier';
  import { activeTool } from './stores/tools';
  import { zones, activeZoneId, switchZone } from './stores/stac';
  import { pointInBbox } from './lib/stac';
  import { segmentPolygons, segmentVisible } from './stores/segmentation';

  let mapContainer: HTMLDivElement;
  let labelMarkers: maplibregl.Marker[] = [];
  let similarityRef: SimilaritySearch | undefined = $state();
  let catalogModalOpen = $state(true);

  onMount(() => {
    const map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: 'CartoDB, OSM',
          },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      },
      center: [0, 20],
      zoom: 3,
    });

    map.on('load', () => {
      $mapInstance = map;

      // Add hover highlight layer (initially empty)
      map.addSource('tile-hover', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'tile-hover-fill',
        type: 'fill',
        source: 'tile-hover',
        paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'tile-hover-line',
        type: 'line',
        source: 'tile-hover',
        paint: { 'line-color': '#00e5ff', 'line-width': 1.5, 'line-opacity': 0.5 },
      });

      // Segmentation polygon layers
      map.addSource('segment-polygons', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'segment-polygons-fill',
        type: 'fill',
        source: 'segment-polygons',
        paint: { 'fill-color': '#f97316', 'fill-opacity': 0.3 },
      });
      map.addLayer({
        id: 'segment-polygons-line',
        type: 'line',
        source: 'segment-polygons',
        paint: { 'line-color': '#f97316', 'line-width': 1.5, 'line-opacity': 0.8 },
      });
    });

    // Track hovered chunk to avoid redundant updates
    let hoveredChunkKey = '';

    // Coordinates display + tile hover highlight
    map.on('mousemove', (e) => {
      const coord = document.getElementById('coord-text');
      if (coord) coord.textContent = `${e.lngLat.lng.toFixed(4)}, ${e.lngLat.lat.toFixed(4)}`;

      // Tile hover highlight
      const src = get(zarrSource);
      const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
      if (src && hoverSource) {
        const chunk = src.getChunkAtLngLat(e.lngLat.lng, e.lngLat.lat);
        const key = chunk ? `${chunk.ci}_${chunk.cj}` : '';
        if (key !== hoveredChunkKey) {
          hoveredChunkKey = key;
          if (chunk) {
            const corners = src.getChunkBoundsLngLat(chunk.ci, chunk.cj);
            if (corners) {
              hoverSource.setData({
                type: 'FeatureCollection',
                features: [{
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'Polygon',
                    coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
                  },
                }],
              });
            }
          } else {
            hoverSource.setData({ type: 'FeatureCollection', features: [] });
          }
        }
      }

      // Floating classification tooltip
      const tip = document.getElementById('class-tooltip');
      if (!tip) return;
      if (get(isClassified)) {
        const classifySrc = src ?? get(zarrSource);
        const classId = classifySrc?.getClassificationAt(e.lngLat.lng, e.lngLat.lat) ?? null;

        if (classId != null && classId >= 0) {
          const cls = get(classes).find(c => c.id === classId);
          if (cls) {
            tip.innerHTML = `<span style="background:${cls.color}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls.name}`;
            tip.style.left = `${e.originalEvent.clientX + 12}px`;
            tip.style.top = `${e.originalEvent.clientY - 10}px`;
            tip.style.display = 'flex';
            return;
          }
        } else if (classId === -1) {
          tip.innerHTML = '<span class="inline-block w-2 h-2 rounded-sm bg-gray-500"></span> <i class="text-gray-500">uncertain</i>';
          tip.style.left = `${e.originalEvent.clientX + 12}px`;
          tip.style.top = `${e.originalEvent.clientY - 10}px`;
          tip.style.display = 'flex';
          return;
        }
      }
      tip.style.display = 'none';
    });

    // Clear hover when mouse leaves the map
    map.on('mouseout', () => {
      hoveredChunkKey = '';
      const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
      if (hoverSource) hoverSource.setData({ type: 'FeatureCollection', features: [] });
    });

    // Map click — dispatched based on active tool
    // NOTE: use get() to read stores inside imperative callbacks —
    // the $ prefix only works in Svelte's reactive context.
    map.on('click', (e) => {
      const tool = get(activeTool);
      const src = get(zarrSource);
      if (!src) return;

      if (tool === 'similarity') {
        similarityRef?.handleClick(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      if (tool === 'classifier') {
        const cls = get(activeClass);
        if (!cls) return;

        const embeddings = src.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, 1);
        if (embeddings.length === 0) return;

        for (const emb of embeddings) {
          addLabel([e.lngLat.lng, e.lngLat.lat], emb, cls.id);
        }

        // Add visual marker at click location
        const marker = new maplibregl.Marker({
          color: cls.color,
          scale: 0.5,
        })
          .setLngLat(e.lngLat)
          .addTo(map);
        labelMarkers.push(marker);
      }
    });

    // Auto-switch zone on pan
    map.on('moveend', () => {
      const center = map.getCenter();
      const currentZones = get(zones);
      if (currentZones.length === 0) return;

      for (const zone of currentZones) {
        if (pointInBbox(center.lng, center.lat, zone.bbox)) {
          if (zone.id !== get(activeZoneId)) {
            switchZone(zone.id);
          }
          break;
        }
      }
    });

    return () => { map.remove(); $mapInstance = null; };
  });

  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    if ($activeTool === 'similarity') {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'classifier' && $activeClass) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  });

  // Add/update zone polygon layers when zones change
  $effect(() => {
    const map = $mapInstance;
    const zoneList = $zones;
    if (!map || zoneList.length === 0) return;

    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: zoneList.map(z => ({
        type: 'Feature' as const,
        id: z.id,
        properties: { id: z.id, utmZone: z.utmZone },
        geometry: z.geometry,
      })),
    };

    if (map.getSource('stac-zones')) {
      (map.getSource('stac-zones') as maplibregl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource('stac-zones', { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'stac-zones-line',
        type: 'line',
        source: 'stac-zones',
        paint: {
          'line-color': '#00e5ff',
          'line-opacity': 0,
          'line-width': 1,
          'line-dasharray': [4, 2],
        },
      });
    }
  });

  // Highlight active zone border
  $effect(() => {
    const map = $mapInstance;
    const active = $activeZoneId;
    if (!map || !map.getLayer('stac-zones-line')) return;

    map.setPaintProperty('stac-zones-line', 'line-opacity', [
      'case',
      ['==', ['get', 'id'], active ?? ''],
      0.6,
      0,
    ]);
  });

  // Update segmentation polygon layers when store changes
  $effect(() => {
    const map = $mapInstance;
    const geojson = $segmentPolygons;
    const visible = $segmentVisible;
    if (!map) return;
    const src = map.getSource('segment-polygons') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(geojson);
    const vis = visible ? 'visible' : 'none';
    if (map.getLayer('segment-polygons-fill')) map.setLayoutProperty('segment-polygons-fill', 'visibility', vis);
    if (map.getLayer('segment-polygons-line')) map.setLayoutProperty('segment-polygons-line', 'visibility', vis);
  });
</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Top bar -->
<TopBar onOpenCatalog={() => { catalogModalOpen = true; }} />

<!-- Catalog modal -->
<CatalogModal bind:open={catalogModalOpen} />

<!-- Sidebar -->
<div class="absolute top-12 right-4 w-[240px] max-h-[calc(100vh-4rem)] bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs">
  <LayerSwitcher />
  <ControlPanel />
  <ToolSwitcher bind:similarityRef={similarityRef} />
</div>

<!-- Debug console -->
<DebugConsole />

<!-- Coordinates -->
<div class="absolute bottom-2 right-4 bg-black/70 backdrop-blur-sm
            text-[10px] text-gray-500 font-mono px-2.5 py-1 rounded
            border border-gray-800/40 z-10 tabular-nums">
  <span id="coord-text">--</span>
</div>

<!-- Floating classification tooltip (follows mouse) -->
<div id="class-tooltip"
     class="fixed items-center gap-1.5 bg-black/85 backdrop-blur-sm
            text-[11px] text-gray-200 font-mono px-2 py-1 rounded
            border border-gray-700/50 z-50 pointer-events-none
            shadow-lg shadow-black/40 whitespace-nowrap"
     style="display: none">
</div>
