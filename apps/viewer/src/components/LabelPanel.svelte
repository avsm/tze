<script lang="ts">
  import { zarrSource, metadata } from '../stores/zarr';
  import {
    classes, labels, activeClassName, activeClass,
    kValue, confidenceThreshold, classificationOpacity, isClassified,
    labelCounts, addClass, removeClass, clearLabels,
  } from '../stores/classifier';
  import { classifyTiles, type ClassifyProgress } from '../lib/classify';
  interface Props {
    onOpenOsm?: () => void;
  }

  let { onOpenOsm }: Props = $props();

  let newClassName = $state('');
  let newClassColor = $state('#3b82f6');
  let isClassifying = $state(false);
  let classifyProgress = $state<ClassifyProgress | null>(null);

  const hasEnoughLabels = $derived(() => {
    const uniqueClasses = new Set($labels.map(l => l.classId));
    return $labels.length >= 2 && uniqueClasses.size >= 2;
  });

  function handleAddClass() {
    const name = newClassName.trim();
    if (!name || $classes.some(c => c.name === name)) return;
    addClass(name, newClassColor);
    newClassName = '';
    const colors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];
    const idx = $classes.length % colors.length;
    newClassColor = colors[idx];
  }

  function selectClass(name: string) {
    $activeClassName = $activeClassName === name ? null : name;
  }

  async function runClassification() {
    const source = $zarrSource;
    if (!source || isClassifying) return;
    isClassifying = true;
    classifyProgress = null;

    const allLabels = $labels;
    const allClasses = $classes;

    // Diagnostic: log what the classifier receives
    const byClass = new Map<number, number>();
    for (const l of allLabels) byClass.set(l.classId, (byClass.get(l.classId) ?? 0) + 1);
    console.log('[classify] classes:', allClasses.map(c => `${c.name}(id=${c.id})`));
    console.log('[classify] labels:', allLabels.length, 'across classes:', [...byClass.entries()].map(([id, n]) => `id=${id}:${n}`));

    try {
      source.clearClassificationOverlays();
      const opacity = $classificationOpacity;
      const results = await classifyTiles(
        source.embeddingCache,
        allLabels,
        allClasses,
        $kValue,
        $confidenceThreshold,
        (p) => { classifyProgress = p; },
        (ci, cj, canvas, classMap, w, h) => {
          source.addClassificationOverlay(ci, cj, canvas);
          source.setClassificationOpacity(opacity);
          source.setClassificationMap(ci, cj, classMap, w, h);
          $isClassified = true;
        },
      );

      void results; // class maps already stored incrementally above
    } finally {
      isClassifying = false;
      classifyProgress = null;
    }
  }

  function handleClear() {
    $zarrSource?.clearClassificationOverlays();
    $isClassified = false;
  }

  function updateClassificationOpacity(val: number) {
    $classificationOpacity = val;
    $zarrSource?.setClassificationOpacity(val);
  }
</script>

<div class="space-y-3" data-tutorial="label-panel">

  {#if $classes.length > 0}
    <div class="space-y-1">
      {#each $classes as cls}
        {@const count = $labelCounts.get(cls.id) ?? 0}
        <button
          onclick={() => selectClass(cls.name)}
          class="flex items-center gap-2 w-full text-left px-2 py-1 rounded transition-all
                 {$activeClassName === cls.name
                   ? 'bg-gray-800/80 border border-term-cyan/40'
                   : 'hover:bg-gray-900/50 border border-transparent'}"
        >
          <span class="w-3 h-3 rounded-sm shrink-0" style="background: {cls.color}"></span>
          <span class="text-[11px] text-gray-300 truncate flex-1">{cls.name}</span>
          <span class="text-[10px] text-gray-600 tabular-nums">{count}</span>
          <span
            role="button"
            tabindex="0"
            onclick={(e) => { e.stopPropagation(); removeClass(cls.name); }}
            onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); removeClass(cls.name); }}}
            class="text-gray-700 hover:text-red-400 text-[10px] transition-colors cursor-pointer"
          >x</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="flex gap-1.5 items-center">
    <input
      type="text"
      bind:value={newClassName}
      placeholder="Class name"
      onkeydown={(e) => e.key === 'Enter' && handleAddClass()}
      class="flex-1 bg-gray-950 border border-gray-700/60 rounded px-2 py-1
             text-gray-300 text-[11px] focus:border-term-cyan/60 focus:outline-none
             transition-all placeholder-gray-700"
    />
    <input
      type="color"
      bind:value={newClassColor}
      class="w-6 h-6 rounded border border-gray-700/60 cursor-pointer bg-transparent"
    />
    <button
      onclick={handleAddClass}
      class="text-[10px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
             border border-gray-700/60 hover:border-term-cyan/40 transition-all"
    >+</button>
  </div>

  {#if $activeClass}
    <div class="text-[10px] text-gray-500">
      Labeling: <span class="text-gray-300" style="color: {$activeClass.color}">{$activeClass.name}</span>
      <span class="text-gray-700"> — click map to label</span>
    </div>
  {:else if $classes.length > 0}
    <div class="text-[10px] text-gray-600 italic">Select a class to start labeling</div>
  {/if}

  <button
    onclick={() => onOpenOsm?.()}
    data-tutorial="label-panel-osm"
    class="w-full text-[10px] font-bold py-1.5 rounded border transition-all
           bg-gray-900 text-gray-400 border-gray-700/60 hover:border-term-cyan/50 hover:text-term-cyan"
  >IMPORT FROM OSM</button>

  <div class="flex items-center gap-1.5">
    <span class="text-gray-600 text-[10px] w-6">k</span>
    <input type="range" min="1" max="15" bind:value={$kValue}
           class="flex-1 h-1 min-w-0" />
    <span class="text-gray-500 text-[10px] tabular-nums w-4 text-right">{$kValue}</span>
  </div>

  <div class="flex items-center gap-1.5">
    <span class="text-gray-600 text-[10px] shrink-0">Conf</span>
    <input type="range" min="0" max="100" value={Math.round($confidenceThreshold * 100)}
           oninput={(e) => $confidenceThreshold = parseInt((e.target as HTMLInputElement).value) / 100}
           class="flex-1 h-1 min-w-0" />
    <span class="text-gray-500 text-[10px] tabular-nums w-7 text-right">{$confidenceThreshold.toFixed(2)}</span>
  </div>

  {#if $isClassified}
    <div class="flex items-center gap-1.5">
      <span class="text-gray-600 text-[10px] shrink-0">Cls α</span>
      <input type="range" min="0" max="100" value={Math.round($classificationOpacity * 100)}
             oninput={(e) => updateClassificationOpacity(parseInt((e.target as HTMLInputElement).value) / 100)}
             class="flex-1 h-1 min-w-0" />
      <span class="text-gray-500 text-[10px] tabular-nums w-7 text-right">{$classificationOpacity.toFixed(2)}</span>
    </div>

  {/if}

  <div class="space-y-1.5">
    <div class="flex gap-1.5">
      <button
        onclick={runClassification}
        disabled={!hasEnoughLabels() || isClassifying}
        class="flex-1 bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
               px-3 py-1.5 rounded tracking-wider transition-all
               hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
               disabled:opacity-40 disabled:pointer-events-none"
      >
        {isClassifying ? 'CLASSIFYING...' : 'CLASSIFY'}
      </button>
      <button
        onclick={handleClear}
        class="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >CLEAR</button>
    </div>

    {#if classifyProgress}
      {@const pct = classifyProgress.pixelsTotal > 0
        ? Math.round((classifyProgress.pixelsDone / classifyProgress.pixelsTotal) * 100)
        : 0}
      <div class="space-y-0.5">
        <div class="flex justify-between text-[9px] text-gray-500 tabular-nums">
          <span>Tile {classifyProgress.tilesDone}/{classifyProgress.tilesTotal}</span>
          <span>{classifyProgress.pixelsDone.toLocaleString()} / {classifyProgress.pixelsTotal.toLocaleString()} px ({pct}%)</span>
        </div>
        <div class="h-1.5 bg-gray-900 rounded-full overflow-hidden">
          <div class="h-full bg-term-cyan rounded-full transition-all duration-150"
               style="width: {pct}%"></div>
        </div>
      </div>
    {/if}
  </div>

  <div class="text-[9px] text-gray-700 leading-relaxed">
    Double-click tile to load embeddings, then click to label.
    Needs 2+ points in 2+ classes to classify.
  </div>
</div>
