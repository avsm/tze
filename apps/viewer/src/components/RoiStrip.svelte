<script lang="ts">
  import { Pentagon, BoxSelect, X, Plus, Trash2, Download, Upload } from 'lucide-svelte';
  import { roiDrawing, drawMode, roiRegions, roiLoading, roiTileCount, clearAllRegions, removeRegion, addRegion, type DrawMode } from '../stores/drawing';

  const modes: { id: DrawMode; icon: typeof BoxSelect; tip: string }[] = [
    { id: 'rectangle', icon: BoxSelect,  tip: 'Rectangle' },
    { id: 'polygon',   icon: Pentagon,   tip: 'Polygon' },
  ];

  let fileInput: HTMLInputElement;

  function startDrawing(mode: DrawMode) {
    $drawMode = mode;
    $roiDrawing = true;
  }

  function cancelDrawing() {
    $roiDrawing = false;
  }

  /** Compute bounding box [west, south, east, north] from a GeoJSON feature. */
  function featureBbox(feature: GeoJSON.Feature): string {
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    return `${w.toFixed(4)}, ${s.toFixed(4)} - ${e.toFixed(4)}, ${n.toFixed(4)}`;
  }

  function exportGeoJSON() {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: $roiRegions.map(r => r.feature),
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regions.geojson';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importGeoJSON() {
    fileInput.click();
  }

  async function handleFileImport(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const features: GeoJSON.Feature[] = [];
      if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
        features.push(...data.features);
      } else if (data.type === 'Feature') {
        features.push(data);
      }
      for (const f of features) {
        if (f.geometry?.type === 'Polygon') {
          await addRegion(f);
        }
      }
    } catch {
      // Invalid file — ignore
    }
    // Reset so the same file can be re-imported
    (e.target as HTMLInputElement).value = '';
  }
</script>

<input
  bind:this={fileInput}
  type="file"
  accept=".geojson,.json"
  class="hidden"
  onchange={handleFileImport}
/>

<div class="px-3 py-2.5 border-b border-gray-800/60 space-y-2">
  <div class="flex items-center gap-1.5">
    <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em] flex-1">Regions</span>

    {#if $roiRegions.length > 0}
      <button
        onclick={importGeoJSON}
        class="text-gray-500 hover:text-term-cyan p-1 rounded
               border border-gray-700/60 hover:border-term-cyan/40 transition-all"
        title="Import GeoJSON"
      >
        <Upload size={10} />
      </button>
      <button
        onclick={exportGeoJSON}
        class="text-gray-500 hover:text-term-cyan p-1 rounded
               border border-gray-700/60 hover:border-term-cyan/40 transition-all"
        title="Export GeoJSON"
      >
        <Download size={10} />
      </button>
      <div class="w-px h-4 bg-gray-800/60"></div>
      {#each modes as m}
        <button
          onclick={() => startDrawing(m.id)}
          class="text-gray-500 hover:text-term-cyan p-1 rounded
                 border border-gray-700/60 hover:border-term-cyan/40 transition-all"
          title="Add {m.tip.toLowerCase()}"
        >
          <Plus size={10} />
        </button>
      {/each}
      <button
        onclick={clearAllRegions}
        class="text-gray-500 hover:text-red-400 p-1 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
        title="Clear all regions"
      >
        <Trash2 size={10} />
      </button>
    {/if}
  </div>

  {#if $roiDrawing}
    <!-- Drawing state -->
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-term-cyan animate-pulse">
        {$drawMode === 'polygon' ? 'Click to draw polygon...' : 'Drag to draw rectangle...'}
      </span>
      <button
        onclick={cancelDrawing}
        class="text-[9px] text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >Cancel</button>
    </div>
  {:else if $roiRegions.length === 0}
    <!-- Empty state — prompt to select -->
    <div class="rounded border border-dashed border-gray-700/60 p-3 space-y-2.5">
      <div class="text-[10px] text-gray-500 text-center leading-relaxed">
        Draw a region on the map to load<br/>embeddings for analysis.
      </div>
      <div class="flex justify-center gap-1.5">
        {#each modes as m}
          <button
            onclick={() => startDrawing(m.id)}
            class="flex items-center gap-1 text-[10px] text-gray-400 hover:text-term-cyan
                   px-2.5 py-1.5 rounded border border-gray-700/60 hover:border-term-cyan/40 transition-all"
            title={m.tip}
          >
            <m.icon size={11} />
            {m.tip}
          </button>
        {/each}
      </div>
      <div class="flex justify-center">
        <button
          onclick={importGeoJSON}
          class="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          <Upload size={9} />
          Import GeoJSON
        </button>
      </div>
    </div>
  {:else}
    <!-- Region list -->
    <div class="space-y-1">
      <div class="text-[10px] text-gray-400">
        {$roiRegions.length} region{$roiRegions.length !== 1 ? 's' : ''} &middot; {$roiTileCount} tiles
      </div>
      {#each $roiRegions as region, i}
        <div class="flex items-start gap-1.5 text-[9px] bg-gray-800/40 rounded px-2 py-1.5 border border-gray-700/30">
          <div class="flex-1 min-w-0">
            <div class="text-gray-400 font-medium">Region {i + 1}</div>
            <div class="text-gray-600 truncate" title={featureBbox(region.feature)}>
              {featureBbox(region.feature)}
            </div>
            <div class="text-gray-600">{region.chunkKeys.length} tiles</div>
          </div>
          <button
            onclick={() => removeRegion(region.id)}
            class="text-gray-600 hover:text-red-400 transition-colors mt-0.5 shrink-0"
            title="Remove region"
          >
            <X size={10} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Loading progress bar -->
  {#if $roiLoading}
    <div class="space-y-1">
      <div class="flex justify-between text-[9px]">
        <span class="text-term-cyan">Loading embeddings...</span>
        <span class="text-gray-500">{$roiLoading.loaded}/{$roiLoading.total}</span>
      </div>
      <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-term-cyan/70 rounded-full transition-all duration-300"
          style="width: {($roiLoading.loaded / $roiLoading.total) * 100}%"
        ></div>
      </div>
    </div>
  {/if}
</div>
