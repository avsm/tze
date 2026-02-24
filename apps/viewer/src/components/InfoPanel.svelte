<script lang="ts">
  import { metadata, loading } from '../stores/zarr';
</script>

{#if $metadata}
  <div class="px-4 py-3 text-[10px] space-y-1">
    <div class="flex justify-between"><span class="text-gray-600">Zone</span><span class="text-gray-400">{$metadata.utmZone}</span></div>
    <div class="flex justify-between"><span class="text-gray-600">EPSG</span><span class="text-gray-400">EPSG:{$metadata.epsg}</span></div>
    <div class="flex justify-between">
      <span class="text-gray-600">Grid</span>
      <span class="text-gray-400">
        {$metadata.shape[1]}x{$metadata.shape[0]}px
        ({($metadata.shape[1] * $metadata.transform[0] / 1000).toFixed(0)}x{($metadata.shape[0] * $metadata.transform[0] / 1000).toFixed(0)}km)
      </span>
    </div>
    <div class="flex justify-between"><span class="text-gray-600">Bands</span><span class="text-term-cyan/60 tabular-nums">{$metadata.nBands}</span></div>
    {#if $loading.total > 0}
      <div class="flex justify-between"><span class="text-gray-600">Loading</span><span class="text-term-cyan tabular-nums">{$loading.done}/{$loading.total}</span></div>
    {/if}
  </div>
{/if}
