<script lang="ts">
  import { zarrSource } from '../stores/zarr';
  import type { DebugLogEntry } from '@ucam-eo/maplibre-zarr-tessera';

  let logs = $state<DebugLogEntry[]>([]);
  let expanded = $state(true);
  let logContainer: HTMLDivElement;

  const MAX_LOGS = 200;

  const TYPE_COLORS: Record<DebugLogEntry['type'], string> = {
    fetch: 'text-yellow-400',
    render: 'text-green-400',
    overlay: 'text-purple-400',
    info: 'text-gray-500',
    error: 'text-red-400',
  };

  const TYPE_LABELS: Record<DebugLogEntry['type'], string> = {
    fetch: 'FETCH',
    render: 'RENDER',
    overlay: 'LAYER',
    info: 'INFO',
    error: 'ERROR',
  };

  function onDebug(entry: DebugLogEntry) {
    logs = [...logs.slice(-(MAX_LOGS - 1)), entry];
    // Auto-scroll
    requestAnimationFrame(() => {
      if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
    });
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  // Track source subscription
  let currentSource: ReturnType<typeof $zarrSource> = null;

  $effect(() => {
    const src = $zarrSource;
    if (src !== currentSource) {
      if (currentSource) currentSource.off('debug', onDebug);
      if (src) {
        src.on('debug', onDebug);
        logs = [{ time: Date.now(), type: 'info', msg: 'Debug console attached to source' }];
      } else {
        logs = [];
      }
      currentSource = src;
    }
  });

  // Summary stats
  const stats = $derived(() => {
    const counts = { fetch: 0, render: 0, error: 0 };
    for (const l of logs) {
      if (l.type === 'fetch') counts.fetch++;
      else if (l.type === 'render') counts.render++;
      else if (l.type === 'error') counts.error++;
    }
    return counts;
  });
</script>

<div class="absolute bottom-2 left-2 right-[300px] z-10 font-mono select-none"
     style="max-width: calc(100vw - 320px);">
  <!-- Toggle bar -->
  <button
    onclick={() => expanded = !expanded}
    class="flex items-center gap-3 bg-black/85 backdrop-blur-sm text-[10px]
           px-3 py-1.5 rounded-t border border-gray-800/60 border-b-0
           hover:bg-gray-900/90 transition-colors cursor-pointer w-full text-left"
  >
    <span class="text-gray-600">{expanded ? '▼' : '▲'}</span>
    <span class="text-gray-500 uppercase tracking-wider">Debug</span>
    <span class="text-yellow-400/60 tabular-nums">{stats().fetch}F</span>
    <span class="text-green-400/60 tabular-nums">{stats().render}R</span>
    {#if stats().error > 0}
      <span class="text-red-400 tabular-nums">{stats().error}E</span>
    {/if}
    <span class="text-gray-700 ml-auto tabular-nums">{logs.length}</span>
  </button>

  {#if expanded}
    <div
      bind:this={logContainer}
      class="bg-black/90 backdrop-blur-sm border border-gray-800/60
             rounded-b overflow-y-auto text-[10px] leading-relaxed"
      style="max-height: 200px;"
    >
      {#if logs.length === 0}
        <div class="px-3 py-2 text-gray-700 italic">Load a store to see activity...</div>
      {:else}
        {#each logs as entry}
          <div class="px-3 py-0.5 hover:bg-gray-900/50 flex gap-2 whitespace-nowrap overflow-hidden">
            <span class="text-gray-700 tabular-nums shrink-0">{formatTime(entry.time)}</span>
            <span class="{TYPE_COLORS[entry.type]} shrink-0 w-[38px]">{TYPE_LABELS[entry.type]}</span>
            <span class="text-gray-400 truncate">{entry.msg}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
