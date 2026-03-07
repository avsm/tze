<script lang="ts">
  import {
    Search, Crosshair, BoxSelect, Pentagon, Save, FolderOpen, User,
    X, Trash2, Upload, Download, Tags, Scan, ChevronDown,
  } from 'lucide-svelte';
  import { zones, catalogStatus } from '../stores/stac';
  import { metadata, loading } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';
  import { roiDrawing, drawMode, roiRegions, roiLoading, roiTileCount, clearAllRegions, removeRegion, addRegion, type DrawMode } from '../stores/drawing';
  import { activeTool, type ToolId } from '../stores/tools';
  import { simSelectedPixel } from '../stores/similarity';
  import { activeClass } from '../stores/classifier';
  import TutorialDropdown from './TutorialDropdown.svelte';

  interface Props {
    onOpenCatalog: () => void;
  }

  let { onOpenCatalog }: Props = $props();

  // --- Health indicator ---
  const healthColor = $derived(
    $catalogStatus === 'loaded' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]'
    : $catalogStatus === 'loading' ? 'bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.6)]'
    : $catalogStatus === 'error' ? 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
    : 'bg-gray-500'
  );

  // --- Search ---
  interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string];
    type: string;
    class: string;
  }

  let searchQuery = $state('');
  let searchResults = $state<NominatimResult[]>([]);
  let searchOpen = $state(false);
  let searchLoading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchInputEl = $state<HTMLInputElement>(undefined!);
  let locating = $state(false);
  let searchExpanded = $state(false);

  function tryParseCoords(q: string): [number, number] | null {
    const s = q.trim();
    const simple = s.match(/^([+-]?\d+\.?\d*)\s*[,\s]\s*([+-]?\d+\.?\d*)$/);
    if (simple) {
      const lat = parseFloat(simple[1]), lon = parseFloat(simple[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
    }
    const nsew = s.match(/^([NSEW])\s*(\d+\.?\d*)\s*[,\s]\s*([NSEW])\s*(\d+\.?\d*)$/i)
              || s.match(/^(\d+\.?\d*)\s*([NSEW])\s*[,\s]\s*(\d+\.?\d*)\s*([NSEW])$/i);
    if (nsew) {
      let lat: number, lon: number;
      if (/[NSns]/i.test(nsew[1])) {
        lat = parseFloat(nsew[2]) * (/[Ss]/.test(nsew[1]) ? -1 : 1);
        lon = parseFloat(nsew[4]) * (/[Ww]/.test(nsew[3]) ? -1 : 1);
      } else {
        lat = parseFloat(nsew[1]) * (/[Ss]/.test(nsew[2]) ? -1 : 1);
        lon = parseFloat(nsew[3]) * (/[Ww]/.test(nsew[4]) ? -1 : 1);
      }
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
    }
    return null;
  }

  function flyToCoords(lat: number, lon: number) {
    const map = get(mapInstance);
    if (!map) return;
    map.flyTo({ center: [lon, lat], zoom: 14, duration: 1500 });
    searchQuery = '';
    searchResults = [];
    searchOpen = false;
  }

  function debounceSearch(q: string) {
    clearTimeout(debounceTimer);
    if (q.trim().length < 2) {
      searchResults = [];
      searchOpen = false;
      return;
    }
    const coords = tryParseCoords(q.trim());
    if (coords) {
      searchResults = [{
        place_id: -1,
        display_name: `${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`,
        lat: String(coords[0]),
        lon: String(coords[1]),
        boundingbox: [String(coords[0] - 0.01), String(coords[0] + 0.01), String(coords[1] - 0.01), String(coords[1] + 0.01)],
        type: 'coordinate',
        class: 'coordinate',
      }];
      searchOpen = true;
      return;
    }
    debounceTimer = setTimeout(() => fetchResults(q.trim()), 300);
  }

  async function fetchResults(q: string) {
    searchLoading = true;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data: NominatimResult[] = await res.json();
      searchResults = data;
      searchOpen = data.length > 0;
    } catch {
      searchResults = [];
      searchOpen = false;
    } finally {
      searchLoading = false;
    }
  }

  function selectResult(r: NominatimResult) {
    const map = get(mapInstance);
    if (!map) return;
    const [south, north, west, east] = r.boundingbox.map(Number);
    map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 16, duration: 1500 });
    searchQuery = '';
    searchResults = [];
    searchOpen = false;
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      searchQuery = '';
      searchResults = [];
      searchOpen = false;
      searchInputEl?.blur();
    } else if (e.key === 'Enter') {
      const coords = tryParseCoords(searchQuery.trim());
      if (coords) {
        flyToCoords(coords[0], coords[1]);
      } else if (searchResults.length > 0) {
        selectResult(searchResults[0]);
      }
    }
  }

  function closeSearch() { searchOpen = false; }

  function gotoCurrentLocation() {
    if (!navigator.geolocation) return;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = get(mapInstance);
        if (map) map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14, duration: 1500 });
        locating = false;
      },
      () => { locating = false; },
      { timeout: 10000 },
    );
  }

  function formatResult(name: string): string {
    const parts = name.split(', ');
    if (parts.length <= 3) return name;
    return `${parts[0]}, ${parts[1]}, ${parts[parts.length - 1]}`;
  }

  // --- Drawing ---
  function toggleDraw(mode: DrawMode) {
    if ($roiDrawing && $drawMode === mode) {
      $roiDrawing = false;
    } else {
      $drawMode = mode;
      $roiDrawing = true;
    }
  }

  // --- Regions dropdown ---
  let regionsOpen = $state(false);
  let fileInput: HTMLInputElement;

  function featureBbox(feature: GeoJSON.Feature): string {
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    return `${w.toFixed(3)}, ${s.toFixed(3)} \u2192 ${e.toFixed(3)}, ${n.toFixed(3)}`;
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
        if (f.geometry?.type === 'Polygon') await addRegion(f);
      }
    } catch { /* Invalid file */ }
    (e.target as HTMLInputElement).value = '';
  }

  function flyToRegion(feature: GeoJSON.Feature) {
    const map = get(mapInstance);
    if (!map) return;
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 1200 });
  }

  // --- Tool tabs ---
  const tools: { id: ToolId; label: string; icon: typeof Search }[] = [
    { id: 'similarity', label: 'Similar', icon: Search },
    { id: 'classifier', label: 'Classify', icon: Tags },
    { id: 'segmenter',  label: 'Segment', icon: Scan },
  ];

  // --- Contextual status ---
  const status = $derived.by(() => {
    if ($catalogStatus !== 'loaded') return { text: 'Connect to catalog', color: 'text-gray-600' };
    if ($roiDrawing) {
      const hint = $drawMode === 'polygon' ? 'Click to draw polygon' : 'Drag to draw rectangle';
      return { text: hint, color: 'text-term-cyan animate-pulse' };
    }
    if ($roiLoading) return { text: `Loading ${$roiLoading.loaded}/${$roiLoading.total}`, color: 'text-term-cyan' };
    if ($roiTileCount === 0) return { text: 'Draw a region to load embeddings', color: 'text-gray-500' };
    if ($activeTool === 'similarity') {
      return $simSelectedPixel
        ? { text: 'Similarity search active', color: 'text-purple-400' }
        : { text: 'Click pixel to search', color: 'text-gray-400' };
    }
    if ($activeTool === 'classifier') {
      return $activeClass
        ? { text: `Labeling: ${$activeClass.name}`, color: 'text-gray-300' }
        : { text: 'Add classes to label', color: 'text-gray-400' };
    }
    return { text: 'Ready to detect', color: 'text-gray-400' };
  });
</script>

<input bind:this={fileInput} type="file" accept=".geojson,.json" class="hidden" onchange={handleFileImport} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute top-0 left-0 right-0 h-9 z-20
            bg-black/85 backdrop-blur-xl border-b border-gray-800/60
            flex items-center px-2 sm:px-3 gap-1 sm:gap-2 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-1.5 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase hidden sm:inline">TZE</span>
  </div>

  <!-- Tutorial dropdown (desktop) -->
  <div class="hidden sm:block"><TutorialDropdown /></div>

  <div class="w-px h-4 bg-gray-700/40 hidden sm:block"></div>

  <!-- Drawing tools -->
  <div class="flex items-center gap-0.5">
    {#each [
      { mode: 'rectangle' as DrawMode, icon: BoxSelect, tip: 'Rectangle' },
      { mode: 'polygon' as DrawMode, icon: Pentagon, tip: 'Polygon' },
    ] as tool}
      {@const isActive = $roiDrawing && $drawMode === tool.mode}
      {@const isSelected = $drawMode === tool.mode && !$roiDrawing}
      <button
        onclick={() => toggleDraw(tool.mode)}
        class="flex items-center justify-center w-6 h-6 rounded
               border transition-all
               {isActive
                 ? 'text-term-cyan border-term-cyan/60 bg-term-cyan/10 shadow-[0_0_6px_rgba(0,229,255,0.15)]'
                 : isSelected
                   ? 'text-term-cyan/50 border-term-cyan/25 bg-term-cyan/5'
                   : 'text-gray-500 border-gray-700/60 hover:text-gray-400 hover:border-gray-600'}"
        title={tool.tip}
      >
        <tool.icon size={13} />
      </button>
    {/each}
  </div>

  <div class="w-px h-4 bg-gray-700/40"></div>

  <!-- Task tabs -->
  <div class="flex items-center gap-0.5" data-tutorial="tool-switcher">
    {#each tools as tool}
      <button
        onclick={() => { $activeTool = tool.id; }}
        class="flex items-center gap-1 px-1.5 h-6 rounded text-[10px]
               border transition-all
               {$activeTool === tool.id
                 ? 'text-term-cyan border-term-cyan/40 bg-term-cyan/5'
                 : 'text-gray-600 border-transparent hover:text-gray-400'}"
      >
        <tool.icon size={11} />
        <span class="hidden md:inline">{tool.label}</span>
      </button>
    {/each}
  </div>

  <!-- Status (spacer) -->
  <div class="flex-1 flex items-center justify-center min-w-0 gap-2">
    <span class="text-[10px] truncate {status.color}">{status.text}</span>
    {#if $roiLoading}
      <div class="w-12 h-1 bg-gray-800 rounded-full overflow-hidden shrink-0">
        <div class="h-full bg-term-cyan/70 rounded-full transition-all"
          style="width: {($roiLoading.loaded / $roiLoading.total) * 100}%"></div>
      </div>
    {/if}
  </div>

  <!-- Search -->
  <div class="relative flex items-center gap-0.5" data-tutorial="search-bar">
    <button
      class="sm:hidden flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-gray-500 hover:text-term-cyan hover:border-term-cyan/50 transition-colors"
      onclick={() => { searchExpanded = !searchExpanded; if (searchExpanded) setTimeout(() => searchInputEl?.focus(), 50); }}
      title="Search"
    >
      <Search size={12} />
    </button>
    <div class="relative {searchExpanded ? 'flex' : 'hidden'} sm:flex items-center">
      <Search size={11} class="absolute left-1.5 text-gray-500 pointer-events-none" />
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => debounceSearch(searchQuery)}
        onkeydown={handleSearchKeydown}
        onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
        onblur={() => { if (!searchQuery) searchExpanded = false; }}
        type="text"
        placeholder="Search or lat, lon..."
        class="w-[140px] sm:w-[180px] h-6 pl-6 pr-2 rounded
               bg-gray-900/90 border border-gray-600/50
               text-[11px] text-gray-200 placeholder-gray-500
               focus:border-term-cyan/60 focus:outline-none focus:ring-0
               focus:shadow-[0_0_8px_rgba(0,229,255,0.15)]
               transition-colors font-mono"
      />
      {#if searchLoading}
        <div class="absolute right-1.5 w-3 h-3 border border-term-cyan/40 border-t-term-cyan rounded-full animate-spin"></div>
      {/if}
    </div>

    <button
      onclick={gotoCurrentLocation}
      disabled={locating}
      class="hidden sm:flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-term-cyan/60 hover:text-term-cyan hover:border-term-cyan/50
             disabled:opacity-40 transition-colors"
      title="Go to current location"
    >
      <Crosshair size={12} class={locating ? 'animate-pulse' : ''} />
    </button>

    {#if searchOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" onclick={closeSearch}></button>
      <div class="absolute top-full right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[240px] py-1">
        {#each searchResults as result}
          <button
            onclick={() => result.class === 'coordinate'
              ? flyToCoords(parseFloat(result.lat), parseFloat(result.lon))
              : selectResult(result)}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800/50
                   transition-colors"
          >
            {#if result.class === 'coordinate'}
              <Crosshair size={11} class="shrink-0 text-term-cyan/60" />
              <span class="text-term-cyan/80">Jump to {result.display_name}</span>
            {:else}
              <span class="truncate">{formatResult(result.display_name)}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Regions dropdown -->
  <div class="relative">
    <button
      onclick={() => { regionsOpen = !regionsOpen; }}
      class="flex items-center gap-1 px-1.5 h-6 rounded text-[10px]
             border border-gray-700/60 transition-all
             {$roiRegions.length > 0
               ? 'text-gray-300 hover:border-gray-500'
               : 'text-gray-600 hover:text-gray-400 hover:border-gray-600'}"
    >
      {#if $roiRegions.length > 0}
        <span class="tabular-nums">{$roiRegions.length}</span>
        <span class="hidden sm:inline">region{$roiRegions.length !== 1 ? 's' : ''}</span>
        {#if $roiTileCount > 0}
          <span class="text-gray-600 hidden md:inline">&middot; {$roiTileCount}t</span>
        {/if}
      {:else}
        <span class="hidden sm:inline">Regions</span>
        <span class="sm:hidden text-gray-600">0</span>
      {/if}
      <ChevronDown size={9} class="text-gray-600" />
    </button>

    {#if regionsOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" onclick={() => { regionsOpen = false; }}></button>
      <div class="absolute top-full right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[260px] p-2 space-y-2">

        {#if $roiRegions.length === 0}
          <div class="text-[10px] text-gray-600 px-1 py-2 text-center">
            No regions yet. Use the draw tools to select an area.
          </div>
        {:else}
          <div class="space-y-1 max-h-[200px] overflow-y-auto">
            {#each $roiRegions as region, i}
              <div class="flex items-start gap-1.5 text-[9px] bg-gray-800/40 rounded px-2 py-1.5 border border-gray-700/30
                          hover:border-term-cyan/30 hover:bg-gray-800/60 transition-all cursor-pointer"
                   role="button" tabindex="0"
                   onclick={() => flyToRegion(region.feature)}
                   onkeydown={(e) => { if (e.key === 'Enter') flyToRegion(region.feature); }}>
                <div class="flex-1 min-w-0">
                  <div class="text-gray-400 font-medium">Region {i + 1}</div>
                  <div class="text-gray-600 truncate" title={featureBbox(region.feature)}>
                    {featureBbox(region.feature)}
                  </div>
                  <div class="text-gray-600">{region.chunkKeys.length} tiles</div>
                </div>
                <button
                  onclick={(e) => { e.stopPropagation(); removeRegion(region.id); }}
                  class="text-gray-600 hover:text-red-400 transition-colors mt-0.5 shrink-0"
                  title="Remove region"
                >
                  <X size={10} />
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="flex items-center gap-1 pt-1 border-t border-gray-800/60">
          <button
            onclick={() => { fileInput.click(); }}
            class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
                   border border-gray-700/60 hover:border-term-cyan/40 transition-all"
          >
            <Upload size={9} /> Import
          </button>
          {#if $roiRegions.length > 0}
            <button
              onclick={exportGeoJSON}
              class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
                     border border-gray-700/60 hover:border-term-cyan/40 transition-all"
            >
              <Download size={9} /> Export
            </button>
            <div class="flex-1"></div>
            <button
              onclick={() => { clearAllRegions(); }}
              class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-red-400 px-1.5 py-1 rounded
                     border border-gray-700/60 hover:border-red-400/40 transition-all"
            >
              <Trash2 size={9} /> Clear
            </button>
          {/if}
        </div>

        {#if $roiLoading}
          <div class="space-y-1 pt-1 border-t border-gray-800/60">
            <div class="flex justify-between text-[9px]">
              <span class="text-term-cyan">Loading...</span>
              <span class="text-gray-500 tabular-nums">{$roiLoading.loaded}/{$roiLoading.total}</span>
            </div>
            <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
              <div class="h-full bg-term-cyan/70 rounded-full"
                style="width: {($roiLoading.loaded / $roiLoading.total) * 100}%"></div>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="w-px h-4 bg-gray-700/40 hidden sm:block"></div>

  <!-- Save / Load / Login -->
  <div class="hidden sm:flex items-center gap-0.5">
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Save project">
      <Save size={12} />
    </button>
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Load project">
      <FolderOpen size={12} />
    </button>
    <div class="w-px h-4 bg-gray-700/40 mx-0.5"></div>
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Login">
      <User size={12} />
    </button>
  </div>

  <!-- Catalog status -->
  <button
    onclick={onOpenCatalog}
    class="flex items-center gap-1 px-1.5 py-1 rounded
           text-gray-300 hover:bg-gray-800/60 transition-colors shrink-0"
    title="Catalog settings"
  >
    <div class="w-1.5 h-1.5 rounded-full {healthColor}"></div>
    <span class="text-[10px] hidden sm:inline">
      {#if $catalogStatus === 'loaded'}
        {$zones.length}z
      {:else if $catalogStatus === 'loading'}
        ...
      {:else if $catalogStatus === 'error'}
        Err
      {:else}
        --
      {/if}
    </span>
    {#if $metadata && $loading.total > 0}
      <span class="text-[10px] text-term-cyan/60 tabular-nums hidden sm:inline">{$loading.done}/{$loading.total}</span>
    {/if}
  </button>
</div>
