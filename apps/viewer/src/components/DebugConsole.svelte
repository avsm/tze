<script lang="ts">
  import { zarrSource } from '../stores/zarr';
  import type { DebugLogEntry } from '@ucam-eo/maplibre-zarr-tessera';

  let logs = $state<DebugLogEntry[]>([]);
  let visible = $state(false);
  let expanded = $state(true);
  let logContainer = $state<HTMLDivElement>(undefined!);

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
    requestAnimationFrame(() => {
      if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
    });
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  // Track source subscription
  let currentSource: typeof $zarrSource = null;

  $effect(() => {
    const src = $zarrSource;
    if (src !== currentSource) {
      if (currentSource) {
        currentSource.off('debug', onDebug);
      }
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
  const stats = $derived.by(() => {
    const counts = { fetch: 0, render: 0, error: 0 };
    for (const l of logs) {
      if (l.type === 'fetch') counts.fetch++;
      else if (l.type === 'render') counts.render++;
      else if (l.type === 'error') counts.error++;
    }
    return counts;
  });

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  function copyLogs() {
    const text = logs.map(e =>
      `${formatTime(e.time)} ${TYPE_LABELS[e.type].padEnd(6)} ${e.msg}`
    ).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1500);
    });
  }
</script>

<!-- Mobile: discrete toggle button (bottom-left corner) -->
{#if !visible}
  <button
    onclick={() => { visible = true; }}
    class="absolute bottom-2 left-2 z-10 bg-black/70 backdrop-blur-sm
           text-gray-600 hover:text-gray-400 text-[10px] font-mono
           w-7 h-7 hidden sm:flex items-center justify-center rounded
           border border-gray-800/60 hover:border-gray-700 transition-colors
           cursor-pointer select-none"
    title="Show debug console"
  >&gt;_</button>
{:else}
  <div class="hidden sm:block absolute bottom-2 left-2 z-10 font-mono select-none"
       style="right: 260px; max-width: calc(100vw - 280px);">
    <!-- Toggle bar -->
    <button
      onclick={() => expanded = !expanded}
      class="flex items-center gap-3 bg-black/85 backdrop-blur-sm text-[10px]
             px-3 py-1.5 rounded-t border border-gray-800/60 border-b-0
             hover:bg-gray-900/90 transition-colors cursor-pointer w-full text-left"
    >
      <span class="text-gray-600">{expanded ? '▼' : '▲'}</span>
      <span class="text-gray-500 uppercase tracking-wider">Debug</span>
      <span class="text-yellow-400/60 tabular-nums">{stats.fetch}F</span>
      <span class="text-green-400/60 tabular-nums">{stats.render}R</span>
      {#if stats.error > 0}
        <span class="text-red-400 tabular-nums">{stats.error}E</span>
      {/if}
      <span class="text-gray-700 tabular-nums ml-auto">{logs.length}</span>
      <span
        role="button"
        tabindex="0"
        onclick={(e) => { e.stopPropagation(); visible = false; expanded = true; }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); visible = false; expanded = true; }}}
        class="text-gray-700 hover:text-red-400 text-[10px] ml-1 transition-colors cursor-pointer"
        title="Hide debug console"
      >✕</span>
    </button>
    {#if expanded}
      <div class="flex items-center bg-black/90 border-x border-gray-800/60 px-3 py-1">
        <button
          onclick={copyLogs}
          class="px-2 py-0.5 rounded text-[9px] border cursor-pointer
                 {copied ? 'text-green-400 border-green-800' : 'text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'}"
        >{copied ? 'copied!' : 'copy logs'}</button>
        <button
          onclick={() => { logs = []; }}
          class="ml-2 px-2 py-0.5 rounded text-[9px] border cursor-pointer
                 text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600"
        >clear</button>
      </div>
    {/if}

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
{/if}
