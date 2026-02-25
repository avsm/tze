<script lang="ts">
  import { zarrSource } from '../stores/zarr';
  import type { DebugLogEntry, EmbeddingProgress } from '@ucam-eo/maplibre-zarr-tessera';

  let logs = $state<DebugLogEntry[]>([]);
  let expanded = $state(true);
  let logContainer = $state<HTMLDivElement>(undefined!);

  // Embedding fetch progress — driven by 'embedding-progress' event
  let embProgress = $state<EmbeddingProgress | null>(null);

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

  function onEmbeddingProgress(progress: EmbeddingProgress) {
    if (progress.stage === 'done') {
      // Show "done" briefly then clear
      embProgress = progress;
      setTimeout(() => {
        if (embProgress?.stage === 'done') embProgress = null;
      }, 800);
    } else {
      embProgress = progress;
    }
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  function formatBytes(b: number | undefined): string {
    if (!b) return '';
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024).toFixed(0)} KB`;
  }

  // Track source subscription
  let currentSource: typeof $zarrSource = null;

  $effect(() => {
    const src = $zarrSource;
    if (src !== currentSource) {
      if (currentSource) {
        currentSource.off('debug', onDebug);
        currentSource.off('embedding-progress', onEmbeddingProgress);
      }
      if (src) {
        src.on('debug', onDebug);
        src.on('embedding-progress', onEmbeddingProgress);
        logs = [{ time: Date.now(), type: 'info', msg: 'Debug console attached to source' }];
      } else {
        logs = [];
        embProgress = null;
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

<style>
  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  .bar-indeterminate {
    animation: indeterminate 1.2s ease-in-out infinite;
    width: 50%;
  }
</style>

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

  <!-- Embedding fetch progress bar -->
  {#if embProgress}
    <div class="bg-black/90 border-x border-gray-800/60 px-3 py-1.5 flex items-center gap-2">
      <span class="shrink-0 text-[10px] {embProgress.stage === 'done' ? 'text-green-400' : 'text-yellow-400'}">
        {#if embProgress.stage === 'fetching'}
          Fetching embeddings ({embProgress.ci},{embProgress.cj})
        {:else if embProgress.stage === 'rendering'}
          Rendering ({embProgress.ci},{embProgress.cj})
        {:else}
          Ready ({embProgress.ci},{embProgress.cj})
        {/if}
        {#if embProgress.bytes}
          <span class="text-gray-600">{formatBytes(embProgress.bytes)}</span>
        {/if}
      </span>
      <div class="flex-1 h-1.5 bg-gray-900 rounded-full overflow-hidden">
        {#if embProgress.stage === 'fetching'}
          <div class="h-full bg-yellow-400/80 rounded-full bar-indeterminate"></div>
        {:else if embProgress.stage === 'rendering'}
          <div class="h-full bg-green-400/80 rounded-full w-3/4 transition-all duration-300"></div>
        {:else}
          <div class="h-full bg-green-400 rounded-full w-full transition-all duration-300"></div>
        {/if}
      </div>
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
