<script lang="ts">
  import { onMount } from 'svelte';
  import { loadCatalog, pointInBbox } from '../lib/stac';
  import {
    catalogUrl, zones, catalogStatus, catalogError, initManager,
  } from '../stores/stac';
  import { mapInstance } from '../stores/map';
  import { status, globalPreviewUrl, globalPreviewBounds } from '../stores/zarr';

  interface Props {
    open: boolean;
  }

  let { open = $bindable(true) }: Props = $props();
  let urlInput = $state('');

  onMount(() => {
    urlInput = $catalogUrl;
    fetchCatalog();
  });

  $effect(() => {
    if ($catalogStatus === 'loaded') {
      open = false;
    }
  });

  async function fetchCatalog() {
    const url = urlInput.trim();
    if (!url) return;

    $catalogUrl = url;
    $catalogStatus = 'loading';
    $catalogError = '';
    $zones = [];
    $status = 'Loading catalog...';

    try {
      const result = await loadCatalog(url);
      $zones = result.zones;
      $globalPreviewUrl = result.globalPreviewUrl ?? '';
      $globalPreviewBounds = result.globalBounds;
      $catalogStatus = 'loaded';
      $status = `${result.zones.length} zones discovered${result.globalPreviewUrl ? ' (global preview available)' : ''}`;

      // Initialize the multi-zone source manager
      const map = $mapInstance;
      if (map && result.zones.length > 0) {
        const center = map.getCenter();
        // Find the zone under the current map center for initial load
        let initialZoneId: string | undefined;
        for (const zone of result.zones) {
          if (pointInBbox(center.lng, center.lat, zone.bbox)) {
            initialZoneId = zone.id;
            break;
          }
        }
        await initManager(initialZoneId ?? result.zones[0].id);
      }
    } catch (err) {
      $catalogStatus = 'error';
      $catalogError = (err as Error).message;
      $status = `Catalog error: ${(err as Error).message}`;
    }
  }
</script>

{#if open}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onkeydown={(e) => e.key === 'Escape' && (open = false)}
  >
    <!-- Modal -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-gray-950 border border-gray-700/80 rounded-lg shadow-2xl shadow-cyan-900/30
             w-[420px] max-w-[90vw] font-mono text-gray-300 text-xs"
      onmousedown={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="px-5 py-4 border-b border-gray-800/60">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
          <h2 class="text-term-cyan text-sm font-bold tracking-[0.2em] uppercase">Connect Catalog</h2>
        </div>
        <p class="text-gray-600 text-[10px] mt-0.5 tracking-wider">STAC catalog URL</p>
      </div>

      <!-- Body -->
      <div class="px-5 py-4">
        <div class="flex gap-2">
          <input
            type="text"
            bind:value={urlInput}
            placeholder="https://host/catalog.json"
            onkeydown={(e) => e.key === 'Enter' && fetchCatalog()}
            class="flex-1 bg-gray-900 border border-gray-700/60 rounded px-3 py-2
                   text-gray-300 text-[12px] focus:border-term-cyan/60 focus:outline-none
                   focus:shadow-[0_0_8px_rgba(0,229,255,0.15)] transition-all
                   placeholder-gray-700"
          />
          <button
            onclick={fetchCatalog}
            disabled={$catalogStatus === 'loading'}
            class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[11px]
                   px-4 py-2 rounded tracking-wider transition-all
                   hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
                   disabled:opacity-50"
          >
            {$catalogStatus === 'loading' ? '...' : 'CONNECT'}
          </button>
        </div>

        <!-- Status -->
        <div class="mt-3 text-[11px]">
          {#if $catalogStatus === 'loading'}
            <span class="text-yellow-400">Connecting...</span>
          {:else if $catalogStatus === 'error'}
            <span class="text-red-400">{$catalogError}</span>
          {:else if $catalogStatus === 'loaded'}
            <span class="text-green-400">{$zones.length} zones discovered</span>
          {:else}
            <span class="text-gray-600">Enter a STAC catalog URL to connect</span>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
