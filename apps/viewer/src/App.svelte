<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { registerZarrProtocol } from '@ucam-eo/maplibre-zarr-tessera';
  import { mapInstance } from './stores/map';

  // Register zarr:// tile protocol once at module load
  registerZarrProtocol(maplibregl);
  import TopBar from './components/TopBar.svelte';
  import CatalogModal from './components/CatalogModal.svelte';
  import OsmImport from './components/OsmImport.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import DebugConsole from './components/DebugConsole.svelte';
  import ToolSwitcher from './components/ToolSwitcher.svelte';
  import type SimilaritySearch from './components/SimilaritySearch.svelte';
  import { sourceManager } from './stores/zarr';
  import { get } from 'svelte/store';
  import { activeClass, classes, labels, addLabel, removeLabel, isClassified } from './stores/classifier';
  import { activeTool } from './stores/tools';
  import { zones } from './stores/stac';
  import { pointInBbox } from './lib/stac';
  import { segmentPolygons, segmentVisible } from './stores/segmentation';
  import UmapCloud from './components/UmapCloud.svelte';
  import TutorialOverlay from './components/TutorialOverlay.svelte';
  import { simEmbeddingTileCount, simSelectedPixel } from './stores/similarity';
  import { registerAllTutorials } from './lib/tutorials/index';
  import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw';
  import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
  import { drawMode, roiDrawing, roiRegions, addRegion } from './stores/drawing';

  let mapContainer: HTMLDivElement;
  let similarityRef: SimilaritySearch | undefined = $state();
  let terraDraw: TerraDraw | undefined = $state();
  let catalogModalOpen = $state(true);
  let osmModalOpen = $state(false);
  let osmAutoImport = $state(false);
  let sidebarOpen = $state(false);

  const BASEMAP_TILES: Record<string, { tiles: string[]; attribution: string }> = {
    satellite: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar' },
  };

  function switchBasemap(id: 'osm' | 'satellite' | 'dark') {
    const map = $mapInstance;
    if (!map) return;
    const bm = BASEMAP_TILES[id];
    if (!bm) return;
    if (map.getLayer('basemap')) map.removeLayer('basemap');
    if (map.getSource('basemap')) map.removeSource('basemap');
    map.addSource('basemap', { type: 'raster', tiles: [...bm.tiles], tileSize: 256, attribution: bm.attribution });
    const layers = map.getStyle().layers;
    const bottomLayerId = layers.length > 0 ? layers[0].id : undefined;
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, bottomLayerId);
  }

  onMount(() => {
    registerAllTutorials();

    const map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {},
        layers: [],
      },
      center: [-0.12, 51.51],
      zoom: 6,
      preserveDrawingBuffer: true,
    });

    map.on('load', () => {
      $mapInstance = map;

      // Add hover highlight layers (initially empty)
      map.addSource('tile-hover', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Semi-transparent fill so the tile stands out
      map.addLayer({
        id: 'tile-hover-fill',
        type: 'fill',
        source: 'tile-hover',
        paint: {
          'fill-color': '#000000',
          'fill-opacity': 0.15,
          'fill-opacity-transition': { duration: 200 },
        },
      });
      // Thick black outer stroke
      map.addLayer({
        id: 'tile-hover-line-outer',
        type: 'line',
        source: 'tile-hover',
        paint: {
          'line-color': '#000000',
          'line-width': 5,
          'line-opacity': 0.8,
          'line-opacity-transition': { duration: 200 },
        },
      });
      // Thin cyan inner stroke
      map.addLayer({
        id: 'tile-hover-line',
        type: 'line',
        source: 'tile-hover',
        paint: {
          'line-color': '#00e5ff',
          'line-width': 2,
          'line-opacity': 0.9,
          'line-opacity-transition': { duration: 200 },
        },
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

      // Label pixel polygons (classification training labels)
      map.addSource('label-pixels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'label-pixels-fill',
        type: 'fill',
        source: 'label-pixels',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.7,
        },
      });
      map.addLayer({
        id: 'label-pixels-line',
        type: 'line',
        source: 'label-pixels',
        paint: {
          'line-color': '#ffffff',
          'line-width': 1,
          'line-opacity': 0.8,
        },
      });

      // ROI region outlines
      map.addSource('roi-regions', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'roi-regions-fill',
        type: 'fill',
        source: 'roi-regions',
        paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'roi-regions-line',
        type: 'line',
        source: 'roi-regions',
        paint: { 'line-color': '#00e5ff', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [4, 2] },
      });

      // Similarity reference pixel marker
      map.addSource('sim-ref-marker', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Outer ring
      map.addLayer({
        id: 'sim-ref-marker-ring',
        type: 'circle',
        source: 'sim-ref-marker',
        paint: {
          'circle-radius': 10,
          'circle-color': 'transparent',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });
      // Inner dot
      map.addLayer({
        id: 'sim-ref-marker-dot',
        type: 'circle',
        source: 'sim-ref-marker',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#00e5ff',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      // Terra-draw for polygon/rectangle drawing
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, lib: maplibregl }),
        modes: [new TerraDrawPolygonMode(), new TerraDrawRectangleMode()],
      });
      terraDraw = draw;
      draw.on('finish', (id: string | number, ctx: { action: string }) => {
        if (ctx.action === 'draw') {
          const feat = draw.getSnapshotFeature(id);
          if (feat) {
            addRegion(feat as GeoJSON.Feature);
            roiDrawing.set(false);
          }
        }
      });
    });

    // Track hovered chunk to avoid redundant updates
    let hoveredChunkKey = '';
    let hoverFadeTimer: ReturnType<typeof setTimeout> | undefined;

    // Coordinates display + tile hover highlight
    map.on('mousemove', (e) => {
      const coord = document.getElementById('coord-text');
      if (coord) coord.textContent = `${e.lngLat.lng.toFixed(4)}, ${e.lngLat.lat.toFixed(4)}`;

      // Tile hover highlight
      const mgr = get(sourceManager);
      const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
      if (mgr && hoverSource) {
        const chunk = mgr.getChunkAtLngLat(e.lngLat.lng, e.lngLat.lat);
        const key = chunk ? `${chunk.zoneId}:${chunk.ci}_${chunk.cj}` : '';
        if (key !== hoveredChunkKey) {
          hoveredChunkKey = key;
          if (chunk) {
            const corners = mgr.getChunkBoundsLngLat(chunk.zoneId, chunk.ci, chunk.cj);
            if (corners) {
              // Cancel any pending fade-out clear
              clearTimeout(hoverFadeTimer);
              // Restore full opacity
              map.setPaintProperty('tile-hover-fill', 'fill-opacity', 0.15);
              map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0.8);
              map.setPaintProperty('tile-hover-line', 'line-opacity', 0.9);
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
            // Moved off tiles — fade out
            map.setPaintProperty('tile-hover-fill', 'fill-opacity', 0);
            map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0);
            map.setPaintProperty('tile-hover-line', 'line-opacity', 0);
            clearTimeout(hoverFadeTimer);
            hoverFadeTimer = setTimeout(() => {
              hoverSource.setData({ type: 'FeatureCollection', features: [] });
            }, 250);
          }
        }
      }

      // Floating tooltip: classification pixels + label markers
      const tip = document.getElementById('class-tooltip');
      if (!tip) return;
      const tipX = e.originalEvent.clientX + 12;
      const tipY = e.originalEvent.clientY - 10;

      // Check classification pixel under cursor
      const classId = mgr?.getClassificationAt(e.lngLat.lng, e.lngLat.lat) ?? null;

      if (classId != null && classId >= 0) {
        const cls = get(classes).find(c => c.id === classId);
        if (cls) {
          tip.innerHTML = `<span style="background:${cls.color}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls.name}`;
          tip.style.left = `${tipX}px`;
          tip.style.top = `${tipY}px`;
          tip.style.display = 'flex';
          return;
        }
      } else if (classId === -1) {
        tip.innerHTML = '<span class="inline-block w-2 h-2 rounded-sm bg-gray-500"></span> <i class="text-gray-500">uncertain</i>';
        tip.style.left = `${tipX}px`;
        tip.style.top = `${tipY}px`;
        tip.style.display = 'flex';
        return;
      }

      // Check if cursor is on a label pixel
      const allLabels = get(labels);
      if (allLabels.length > 0 && mgr) {
        const emb = mgr.getEmbeddingAt(e.lngLat.lng, e.lngLat.lat);
        if (emb) {
          const lp = allLabels.find(l => l.ci === emb.ci && l.cj === emb.cj && l.row === emb.row && l.col === emb.col);
          if (lp) {
            const allClasses = get(classes);
            const cls = allClasses.find(c => c.id === lp.classId);
            const srcTag = lp.source === 'osm'
              ? ' <span class="text-gray-500">osm</span>'
              : ' <span class="text-gray-500">manual</span>';
            tip.innerHTML = `<span style="background:${cls?.color ?? '#888'}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls?.name ?? '?'}${srcTag}`;
            tip.style.left = `${tipX}px`;
            tip.style.top = `${tipY}px`;
            tip.style.display = 'flex';
            return;
          }
        }
      }

      tip.style.display = 'none';
    });

    // Fade out hover when mouse leaves the map
    map.on('mouseout', () => {
      hoveredChunkKey = '';
      // Fade opacity to 0 via transitions
      map.setPaintProperty('tile-hover-fill', 'fill-opacity', 0);
      map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0);
      map.setPaintProperty('tile-hover-line', 'line-opacity', 0);
      // Clear data after the transition completes
      clearTimeout(hoverFadeTimer);
      hoverFadeTimer = setTimeout(() => {
        const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
        if (hoverSource) hoverSource.setData({ type: 'FeatureCollection', features: [] });
      }, 250);
    });

    // Map click — dispatched based on active tool
    // NOTE: use get() to read stores inside imperative callbacks —
    // the $ prefix only works in Svelte's reactive context.
    map.on('click', (e) => {
      const tool = get(activeTool);
      const mgr = get(sourceManager);
      if (!mgr) return;

      if (tool === 'similarity') {
        similarityRef?.handleClick(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      if (tool === 'classifier') {
        // Check if there's already a label at this pixel — if so, remove it
        const emb0 = mgr.getEmbeddingAt(e.lngLat.lng, e.lngLat.lat);
        if (emb0) {
          const removed = removeLabel(emb0.ci, emb0.cj, emb0.row, emb0.col);
          if (removed) return;
        }

        // No existing label — add one (requires active class)
        const cls = get(activeClass);
        if (!cls) return;

        const embeddings = mgr.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, 1);
        if (embeddings.length === 0) return;

        for (const emb of embeddings) {
          addLabel([e.lngLat.lng, e.lngLat.lat], emb, cls.id);
        }
      }
    });

    // Lazily open zone sources as the user pans into new zones
    map.on('moveend', () => {
      const mgr = get(sourceManager);
      if (!mgr) return;
      const center = map.getCenter();
      const currentZones = get(zones);
      for (const zone of currentZones) {
        if (pointInBbox(center.lng, center.lat, zone.bbox)) {
          if (!mgr.getOpenSource(zone.id)) {
            mgr.getSource(zone.id);
          }
          break;
        }
      }
    });

    return () => { map.remove(); $mapInstance = null; };
  });

  // Activate/deactivate terra-draw based on roiDrawing store
  $effect(() => {
    const draw = terraDraw;
    if (!draw) return;
    const drawing = $roiDrawing;
    const mode = $drawMode;
    if (drawing) {
      if (!draw.enabled) draw.start();
      draw.setMode(mode);
    } else {
      if (draw.enabled) draw.stop();
    }
  });

  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    if ($roiDrawing) {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'similarity') {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'classifier' && $activeClass) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  });

  // Update similarity reference pixel marker
  $effect(() => {
    const map = $mapInstance;
    const pixel = $simSelectedPixel;
    if (!map) return;
    const src = map.getSource('sim-ref-marker') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (pixel) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [pixel.lng, pixel.lat] }, properties: {} }],
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  });

  // Zone polygon layers removed — UTM zones are now an implementation detail

  // Sync label pixel polygons reactively — only visible on classifier tab
  $effect(() => {
    const map = $mapInstance;
    const allLabels = $labels;
    const allClasses = $classes;
    const tool = $activeTool;
    const mgr = $sourceManager;
    if (!map) return;

    const src = map.getSource('label-pixels') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    // Only show labels on the classifier tab
    if (tool !== 'classifier' || !mgr) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    // Build classId → color lookup
    const colorMap = new Map<number, string>();
    for (const cls of allClasses) colorMap.set(cls.id, cls.color);

    // Build polygon features for each label — one pixel-sized square per label
    const features: GeoJSON.Feature[] = [];
    for (const lp of allLabels) {
      const corners = mgr.getPixelBoundsLngLat(lp.ci, lp.cj, lp.row, lp.col);
      if (!corners) continue;
      const color = colorMap.get(lp.classId) ?? '#888888';
      features.push({
        type: 'Feature',
        properties: { color },
        geometry: {
          type: 'Polygon',
          coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
        },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
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

  // Sync ROI regions to map overlay
  $effect(() => {
    const map = $mapInstance;
    const regions = $roiRegions;
    if (!map) return;
    const src = map.getSource('roi-regions') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: regions.map(r => r.feature),
      });
    }
  });
</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Top bar -->
<TopBar onOpenCatalog={() => { catalogModalOpen = true; }} />

<!-- Catalog modal -->
<CatalogModal bind:open={catalogModalOpen} />

<!-- OSM import modal -->
<OsmImport bind:open={osmModalOpen} autoImport={osmAutoImport} />

<!-- Sidebar (bottom sheet on mobile, side panel on desktop) -->
<div class="fixed bottom-0 left-0 right-0 w-full max-h-[60vh]
            sm:absolute sm:top-12 sm:right-4 sm:left-auto sm:bottom-auto sm:w-[240px] sm:max-h-[calc(100vh-4rem)]
            bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-t-lg sm:rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs
            transition-transform duration-300
            pb-[env(safe-area-inset-bottom)]
            {sidebarOpen ? 'translate-y-0' : 'translate-y-[calc(100%-2.5rem)]'}
            sm:translate-y-0">
  <!-- Mobile drag handle -->
  <button
    class="sm:hidden flex items-center justify-center w-full py-1.5 text-gray-500"
    onclick={() => { sidebarOpen = !sidebarOpen; }}
  >
    <span class="text-[10px] tracking-wider uppercase">{sidebarOpen ? '▼ Tools' : '▲ Tools'}</span>
  </button>
  <LayerSwitcher />
  <ControlPanel />
  <ToolSwitcher bind:similarityRef={similarityRef} onOpenOsm={() => { osmModalOpen = true; }} />
</div>

<!-- UMAP floating window (outside sidebar to avoid backdrop-filter clipping) -->
<UmapCloud visible={$activeTool === 'similarity' && $simEmbeddingTileCount > 0} />

<!-- Tutorial overlay -->
<TutorialOverlay {similarityRef} onOpenOsm={(opts) => { osmAutoImport = opts?.autoImport ?? false; osmModalOpen = true; }} onCloseOsm={() => { osmModalOpen = false; osmAutoImport = false; }} onSwitchBasemap={switchBasemap} />

<!-- Debug console -->
<DebugConsole />

<!-- Coordinates (desktop only — no mousemove on mobile) -->
<div class="hidden sm:block absolute bottom-2 right-4 bg-black/70 backdrop-blur-sm
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
