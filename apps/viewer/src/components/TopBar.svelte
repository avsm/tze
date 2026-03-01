<script lang="ts">
  import { ChevronDown, Search, Crosshair } from 'lucide-svelte';
  import { zones, activeZoneId, catalogStatus, switchZone } from '../stores/stac';
  import { metadata, loading } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';
  import TutorialDropdown from './TutorialDropdown.svelte';

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
  let searchExpanded = $state(false);

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
            flex items-center px-2 sm:px-4 gap-1.5 sm:gap-3 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-2 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase">TZE</span>
  </div>

  <!-- Tutorial dropdown (left, beside branding) -->
  <TutorialDropdown />

  <!-- Search bar -->
  <div class="relative flex items-center gap-1" data-tutorial="search-bar">
    <!-- Mobile: icon-only search toggle -->
    <button
      class="sm:hidden flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-gray-500 hover:text-term-cyan hover:border-term-cyan/50
             transition-colors"
      onclick={() => { searchExpanded = !searchExpanded; if (searchExpanded) setTimeout(() => searchInputEl?.focus(), 50); }}
      title="Search"
    >
      <Search size={12} />
    </button>
    <div class="relative {searchExpanded ? 'flex' : 'hidden'} sm:flex items-center">
      <Search size={11} class="absolute left-1.5 text-gray-600 pointer-events-none" />
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => debounceSearch(searchQuery)}
        onkeydown={handleSearchKeydown}
        onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
        onblur={() => { if (!searchQuery) searchExpanded = false; }}
        type="text"
        placeholder="Search location..."
        class="w-[160px] sm:w-[220px] h-6 pl-6 pr-2 rounded bg-gray-900/80 border border-term-cyan/30
               text-[11px] text-gray-300 placeholder-gray-600
               focus:border-term-cyan/50 focus:outline-none focus:ring-0
               focus:shadow-[0_0_8px_rgba(0,229,255,0.15)]
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
             text-term-cyan/60 hover:text-term-cyan hover:border-term-cyan/50
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
            <span class="truncate">{formatResult(result.display_name)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Unified zone / status button -->
  <div class="relative">
    <button
      onclick={() => { zoneDropdownOpen = !zoneDropdownOpen; }}
      class="flex items-center gap-1.5 px-2 py-1 rounded
             text-gray-300 hover:bg-gray-800/60 transition-colors"
    >
      <div class="w-2 h-2 rounded-full {healthColor}"></div>
      <span class="text-[11px]">
        {#if activeZone}
          UTM {activeZone.utmZone}
        {:else if $catalogStatus === 'loading'}
          Loading...
        {:else if $catalogStatus === 'error'}
          Error
        {:else}
          Connect
        {/if}
      </span>
      {#if $metadata}
        <span class="hidden sm:inline text-[10px] text-gray-600">EPSG:{$metadata.epsg}</span>
        <span class="hidden sm:inline text-[10px] text-gray-600">{$metadata.nBands}b</span>
        {#if $loading.total > 0}
          <span class="text-[10px] text-term-cyan/60 tabular-nums">{$loading.done}/{$loading.total}</span>
        {/if}
      {/if}
      <ChevronDown size={12} class="text-gray-500" />
    </button>

    {#if zoneDropdownOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={() => { zoneDropdownOpen = false; }}></div>
      <div class="absolute top-full right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[180px] py-1">

        <!-- Zone list -->
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
                         {zone.id === $activeZoneId ? 'bg-green-400' : 'bg-gray-600'}"></span>
            UTM {zone.utmZone}
          </button>
        {/each}

        <!-- Metadata info -->
        {#if $metadata}
          <div class="border-t border-gray-800/60 mt-1 pt-1 px-3 py-1.5">
            <div class="flex flex-col gap-0.5 text-[10px] text-gray-500">
              <span>EPSG:{$metadata.epsg}</span>
              <span>{$metadata.shape[1]} x {$metadata.shape[0]} px</span>
              <span>{$metadata.nBands} bands</span>
            </div>
          </div>
        {/if}

        <!-- Catalog settings -->
        <div class="border-t border-gray-800/60 mt-1 pt-1">
          <button
            onclick={() => { zoneDropdownOpen = false; onOpenCatalog(); }}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800/50
                   transition-colors"
          >
            Catalog Settings...
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
