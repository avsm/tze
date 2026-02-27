<script lang="ts">
  import { ChevronDown, Database, MapPin, Search, Crosshair } from 'lucide-svelte';
  import { zones, activeZoneId, catalogStatus, switchZone } from '../stores/stac';
  import { metadata, loading } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';

  interface Props {
    onOpenCatalog: () => void;
  }

  let { onOpenCatalog }: Props = $props();
  let zoneDropdownOpen = $state(false);

  const activeZone = $derived($zones.find(z => z.id === $activeZoneId));

  const healthColor = $derived(
    $catalogStatus === 'loaded' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]'
    : $catalogStatus === 'loading' ? 'bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.6)]'
    : $catalogStatus === 'error' ? 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
    : 'bg-gray-500'
  );

  const healthLabel = $derived(
    $catalogStatus === 'loaded' ? 'Connected'
    : $catalogStatus === 'loading' ? 'Loading...'
    : $catalogStatus === 'error' ? 'Error'
    : 'Idle'
  );

  function handleZoneClick(zoneId: string) {
    switchZone(zoneId);
    zoneDropdownOpen = false;
  }

  // --- Search ---
  interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string]; // [south, north, west, east]
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

  function debounceSearch(q: string) {
    clearTimeout(debounceTimer);
    if (q.trim().length < 2) {
      searchResults = [];
      searchOpen = false;
      return;
    }
    debounceTimer = setTimeout(() => fetchResults(q.trim()), 300);
  }

  async function fetchResults(q: string) {
    searchLoading = true;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: { 'Accept-Language': 'en' },
      });
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
    map.fitBounds([[west, south], [east, north]], {
      padding: 40,
      maxZoom: 16,
      duration: 1500,
    });
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
    } else if (e.key === 'Enter' && searchResults.length > 0) {
      selectResult(searchResults[0]);
    }
  }

  function closeSearch() {
    searchOpen = false;
  }

  function gotoCurrentLocation() {
    if (!navigator.geolocation) return;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = get(mapInstance);
        if (map) {
          map.flyTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 14,
            duration: 1500,
          });
        }
        locating = false;
      },
      () => { locating = false; },
      { timeout: 10000 },
    );
  }

  function formatResult(name: string): string {
    // Shorten long display names: keep first two parts and last part
    const parts = name.split(', ');
    if (parts.length <= 3) return name;
    return `${parts[0]}, ${parts[1]}, ${parts[parts.length - 1]}`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute top-0 left-0 right-0 h-9 z-20
            bg-black/85 backdrop-blur-xl border-b border-gray-800/60
            flex items-center px-4 gap-3 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-2 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase">TZE</span>
  </div>

  <!-- Zone dropdown -->
  <div class="relative">
    <button
      onclick={() => { zoneDropdownOpen = !zoneDropdownOpen; }}
      disabled={$zones.length === 0}
      class="flex items-center gap-1.5 px-2 py-1 rounded
             text-gray-300 hover:bg-gray-800/60 transition-colors
             disabled:opacity-40 disabled:cursor-default"
    >
      <MapPin size={12} class="text-term-cyan" />
      <span class="text-[11px]">
        {activeZone ? `UTM ${activeZone.utmZone}` : 'No zone'}
      </span>
      <ChevronDown size={12} class="text-gray-500" />
    </button>

    {#if zoneDropdownOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={() => { zoneDropdownOpen = false; }}></div>
      <div class="absolute top-full left-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[140px] py-1">
        {#each $zones as zone}
          <button
            onclick={() => handleZoneClick(zone.id)}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] transition-colors
                   {zone.id === $activeZoneId
                     ? 'text-term-cyan bg-term-cyan/10'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
          >
            <span class="w-1.5 h-1.5 rounded-full shrink-0
                         {zone.id === $activeZoneId ? 'bg-term-cyan' : 'bg-gray-600'}"></span>
            UTM {zone.utmZone}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Metadata pills (visible when a zone is loaded) -->
  {#if $metadata}
    <div class="flex items-center gap-2 text-[10px] text-gray-500">
      <span class="text-gray-600">EPSG:{$metadata.epsg}</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-600">{$metadata.shape[1]}x{$metadata.shape[0]}px</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-600">{$metadata.nBands}b</span>
      {#if $loading.total > 0}
        <span class="text-gray-700">|</span>
        <span class="text-term-cyan/60 tabular-nums">{$loading.done}/{$loading.total}</span>
      {/if}
    </div>
  {/if}

  <!-- Search bar -->
  <div class="relative flex items-center gap-1">
    <div class="relative flex items-center">
      <Search size={11} class="absolute left-1.5 text-gray-600 pointer-events-none" />
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => debounceSearch(searchQuery)}
        onkeydown={handleSearchKeydown}
        onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
        type="text"
        placeholder="Search location..."
        class="w-[160px] h-6 pl-6 pr-2 rounded bg-gray-900/80 border border-gray-700/60
               text-[11px] text-gray-300 placeholder-gray-600
               focus:border-term-cyan/50 focus:outline-none focus:ring-0
               transition-colors font-mono"
      />
      {#if searchLoading}
        <div class="absolute right-1.5 w-3 h-3 border border-term-cyan/40 border-t-term-cyan rounded-full animate-spin"></div>
      {/if}
    </div>

    <!-- Current location button -->
    <button
      onclick={gotoCurrentLocation}
      disabled={locating}
      class="flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-gray-500 hover:text-term-cyan hover:border-term-cyan/50
             disabled:opacity-40 transition-colors"
      title="Go to current location"
    >
      <Crosshair size={12} class={locating ? 'animate-pulse' : ''} />
    </button>

    <!-- Search results dropdown -->
    {#if searchOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={closeSearch}></div>
      <div class="absolute top-full left-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[240px] py-1">
        {#each searchResults as result}
          <button
            onclick={() => selectResult(result)}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800/50
                   transition-colors"
          >
            <MapPin size={10} class="text-gray-600 shrink-0" />
            <span class="truncate">{formatResult(result.display_name)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Health indicator -->
  <div class="flex items-center gap-1.5">
    <div class="w-2 h-2 rounded-full {healthColor}"></div>
    <span class="text-[10px] text-gray-500">{healthLabel}</span>
  </div>

  <!-- Catalog button -->
  <button
    onclick={onOpenCatalog}
    class="flex items-center gap-1.5 px-2 py-1 rounded
           text-gray-400 hover:text-term-cyan hover:bg-gray-800/60 transition-colors"
    title="Open catalog connection"
  >
    <Database size={13} />
  </button>
</div>
