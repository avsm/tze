<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { mapInstance } from './stores/map';
  import StoreSelector from './components/StoreSelector.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import BandMapper from './components/BandMapper.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import DebugConsole from './components/DebugConsole.svelte';
  import LabelPanel from './components/LabelPanel.svelte';
  import { zarrSource } from './stores/zarr';
  import { get } from 'svelte/store';
  import { activeClass, kernelSize, addLabel } from './stores/classifier';

  let mapContainer: HTMLDivElement;
  let labelMarkers: maplibregl.Marker[] = [];

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

    map.on('load', () => { $mapInstance = map; });

    // Coordinates display
    map.on('mousemove', (e) => {
      const coord = document.getElementById('coord-text');
      if (coord) coord.textContent = `${e.lngLat.lng.toFixed(4)}, ${e.lngLat.lat.toFixed(4)}`;
    });

    // Map click for labeling
    // NOTE: use get() to read stores inside imperative callbacks —
    // the $ prefix only works in Svelte's reactive context.
    map.on('click', (e) => {
      const src = get(zarrSource);
      const cls = get(activeClass);
      if (!src || !cls) return;

      const ks = get(kernelSize);
      const embeddings = src.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, ks);
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
    });

    return () => { map.remove(); $mapInstance = null; };
  });

  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    canvas.style.cursor = $activeClass ? 'crosshair' : '';
  });
</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Control panel -->
<div class="absolute top-4 right-4 w-[280px] max-h-[calc(100vh-2rem)] bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs">
  <!-- Header -->
  <div class="px-4 py-3 border-b border-gray-800/60">
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
      <h1 class="text-term-cyan text-sm font-bold tracking-[0.2em] uppercase">TZE</h1>
    </div>
    <p class="text-gray-600 text-[10px] mt-0.5 tracking-wider">TESSERA ZARR EXPLORER</p>
  </div>

  <StoreSelector />
  <LayerSwitcher />
  <BandMapper />
  <ControlPanel />
  <LabelPanel />
  <InfoPanel />
</div>

<!-- Debug console -->
<DebugConsole />

<!-- Coordinates -->
<div class="absolute bottom-2 right-4 bg-black/70 backdrop-blur-sm
            text-[10px] text-gray-500 font-mono px-2.5 py-1 rounded
            border border-gray-800/40 z-10 tabular-nums">
  <span id="coord-text">--</span>
</div>
