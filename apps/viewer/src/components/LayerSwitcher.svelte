<script lang="ts">
  import { mapInstance } from '../stores/map';

  const BASEMAPS = [
    { id: 'osm', label: 'Streets', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '&copy; OpenStreetMap' },
    { id: 'satellite', label: 'Satellite', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar' },
    { id: 'terrain', label: 'Terrain', tiles: ['https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png'], attribution: 'Stadia Maps, Stamen' },
    { id: 'dark', label: 'Dark', tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], attribution: 'CartoDB, OSM' },
  ] as const;

  let selected = $state('dark');

  function switchBasemap(id: string) {
    if (!$mapInstance || selected === id) return;
    selected = id;
    const bm = BASEMAPS.find(b => b.id === id)!;

    $mapInstance.setStyle({
      version: 8,
      sources: {
        basemap: {
          type: 'raster', tiles: [...bm.tiles], tileSize: 256, attribution: bm.attribution,
        },
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    });
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Basemap</label>
  <div class="mt-2 flex gap-1">
    {#each BASEMAPS as bm}
      <button
        onclick={() => switchBasemap(bm.id)}
        class="flex-1 text-[10px] font-bold tracking-wider py-1 rounded border transition-all
               {selected === bm.id
                 ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                 : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
      >
        {bm.label}
      </button>
    {/each}
  </div>
</div>
