<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css';
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map;

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [0, 20],
      zoom: 3,
    });

    return () => map.remove();
  });
</script>

<div bind:this={mapContainer} id="map"></div>
<p class="absolute top-4 left-4 text-term-cyan font-mono text-sm z-10">TZE</p>
