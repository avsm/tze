<script lang="ts">
  import { onMount } from 'svelte';
  import { loadCatalog } from '../lib/stac';
  import {
    catalogUrl, zones, activeZoneId, catalogStatus, catalogError, switchZone,
  } from '../stores/stac';
  import { status, globalPreviewUrl } from '../stores/zarr';

  let urlInput = $state('');

  onMount(() => {
    urlInput = $catalogUrl;
    fetchCatalog();
  });

  async function fetchCatalog() {
    const url = urlInput.trim();
    if (!url) return;

    $catalogUrl = url;
    $catalogStatus = 'loading';
    $catalogError = '';
    $zones = [];
    $activeZoneId = null;
    $status = 'Loading catalog...';

    try {
      const result = await loadCatalog(url);
      $zones = result.zones;
      $globalPreviewUrl = result.globalPreviewUrl ?? '';
      $catalogStatus = 'loaded';
      $status = `${result.zones.length} zones discovered${result.globalPreviewUrl ? ' (global preview available)' : ''}`;
    } catch (err) {
      $catalogStatus = 'error';
      $catalogError = (err as Error).message;
      $status = `Catalog error: ${(err as Error).message}`;
    }
  }

  function handleZoneClick(zoneId: string) {
    switchZone(zoneId);
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">STAC Catalog</span>
  <div class="flex gap-1.5 mt-1.5">
    <input
      type="text"
      bind:value={urlInput}
      placeholder="https://host/catalog.json"
      onkeydown={(e) => e.key === 'Enter' && fetchCatalog()}
      class="flex-1 bg-gray-950 border border-gray-700/60 rounded px-2 py-1.5
             text-gray-300 text-[11px] focus:border-term-cyan/60 focus:outline-none
             focus:shadow-[0_0_8px_rgba(0,229,255,0.15)] transition-all
             placeholder-gray-700"
    />
    <button
      onclick={fetchCatalog}
      disabled={$catalogStatus === 'loading'}
      class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
             px-3 py-1.5 rounded tracking-wider transition-all
             hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
             disabled:opacity-50"
    >
      {$catalogStatus === 'loading' ? '...' : 'LOAD'}
    </button>
  </div>

  <!-- Status -->
  <div class="mt-1.5 text-[10px] text-gray-600 truncate">
    {#if $catalogStatus === 'loading'}
      Loading catalog...
    {:else if $catalogStatus === 'error'}
      <span class="text-red-400">{$catalogError}</span>
    {:else if $catalogStatus === 'loaded'}
      {$zones.length} zones discovered
    {:else}
      Ready
    {/if}
  </div>

  <!-- Zone list -->
  {#if $zones.length > 0}
    <div class="mt-2 space-y-0.5">
      {#each $zones as zone}
        <button
          onclick={() => handleZoneClick(zone.id)}
          class="flex items-center gap-2 w-full text-left px-2 py-1 rounded
                 transition-colors text-[11px]
                 {zone.id === $activeZoneId
                   ? 'bg-term-cyan/10 text-term-cyan'
                   : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900/50'}"
        >
          <span class="w-1.5 h-1.5 rounded-full flex-shrink-0
                       {zone.id === $activeZoneId ? 'bg-term-cyan shadow-[0_0_4px_rgba(0,229,255,0.6)]' : 'bg-gray-700'}"></span>
          <span class="font-mono">UTM {zone.utmZone}</span>
          {#if zone.id === $activeZoneId}
            <span class="ml-auto text-[9px] bg-term-cyan/20 text-term-cyan px-1.5 py-0.5 rounded tracking-wider">
              LOADED
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
