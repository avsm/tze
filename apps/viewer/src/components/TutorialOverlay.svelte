<script lang="ts">
  import { X, GripHorizontal } from 'lucide-svelte';
  import { get } from 'svelte/store';
  import { untrack } from 'svelte';
  import {
    activeTutorial,
    currentStep,
    currentStepIndex,
    totalSteps,
    stepActionRunning,
    nextStep,
    endTutorial,
  } from '../stores/tutorial';
  import { mapInstance } from '../stores/map';
  import { sourceManager, displayManager, metadata } from '../stores/zarr';
  import { activeTool } from '../stores/tools';
  import { simThreshold, simScores, simRefEmbedding, simSelectedPixel, simEmbeddingTileCount } from '../stores/similarity';
  import { classes, labels, isClassified, classificationOpacity, kValue, confidenceThreshold } from '../stores/classifier';
  import type { TutorialContext, ArrowDirection } from '../lib/tutorial';
  import type SimilaritySearch from './SimilaritySearch.svelte';

  interface Props {
    similarityRef?: SimilaritySearch;
    onOpenOsm?: (opts?: { autoImport?: boolean }) => void;
    onCloseOsm?: () => void;
    onSwitchBasemap?: (id: 'osm' | 'satellite' | 'dark') => void;
  }
  let { similarityRef, onOpenOsm, onCloseOsm, onSwitchBasemap }: Props = $props();

  // Card position — default top-left, user-draggable
  let cardEl: HTMLDivElement | undefined = $state();
  let cardX = $state(16);
  let cardY = $state(48); // below TopBar
  let userDragged = $state(false);

  // Diagram panel position
  let diagramX = $state(-1); // -1 = auto-position
  let diagramY = $state(48);
  let diagramDragState: { startX: number; startY: number; origX: number; origY: number } | null = null;

  function startDiagramDrag(e: MouseEvent) {
    e.preventDefault();
    diagramDragState = { startX: e.clientX, startY: e.clientY, origX: diagramX, origY: diagramY };
  }

  // Highlight state
  let highlightRect = $state<DOMRect | null>(null);
  let rafId = 0;

  // Drag state
  let dragState: { startX: number; startY: number; origX: number; origY: number } | null = null;

  // Track which step we last launched an action for
  let lastActionStepId = '';

  function startDrag(e: MouseEvent) {
    e.preventDefault();
    dragState = { startX: e.clientX, startY: e.clientY, origX: cardX, origY: cardY };
  }

  // Global drag listeners (card + diagram panel)
  $effect(() => {
    if (!$activeTutorial) return;
    const onMove = (e: MouseEvent) => {
      if (dragState) {
        e.preventDefault();
        cardX = dragState.origX + (e.clientX - dragState.startX);
        cardY = dragState.origY + (e.clientY - dragState.startY);
        userDragged = true;
      }
      if (diagramDragState) {
        e.preventDefault();
        diagramX = diagramDragState.origX + (e.clientX - diagramDragState.startX);
        diagramY = diagramDragState.origY + (e.clientY - diagramDragState.startY);
      }
    };
    const onUp = () => { dragState = null; diagramDragState = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  });

  /** Build context object for tutorial step actions. */
  function buildContext(): TutorialContext | null {
    const map = get(mapInstance);
    const mgr = get(sourceManager);
    const dm = get(displayManager);
    if (!map || !mgr) return null;

    return {
      map,
      manager: mgr,
      display: dm ?? undefined,
      stores: {
        activeTool,
        simThreshold,
        sourceManager,
        metadata,
        simScores,
        simRefEmbedding,
        simSelectedPixel,
        simEmbeddingTileCount,
        classes,
        labels,
        isClassified,
        classificationOpacity,
        kValue,
        confidenceThreshold,
      },
      flyTo(opts) {
        return new Promise<void>((resolve) => {
          map.flyTo({
            center: opts.center,
            zoom: opts.zoom ?? 14,
            duration: opts.duration ?? 2000,
          });
          map.once('moveend', () => resolve());
        });
      },
      waitForEvent(event: string, timeout = 30000) {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            (mgr as any).off(event, handler);
            resolve();
          }, timeout);
          const handler = () => {
            clearTimeout(timer);
            resolve();
          };
          (mgr as any).on(event, handler);
        });
      },
      async ensureZoneAt(lng: number, lat: number) {
        const zones = mgr.zonesAtPoint(lng, lat);
        for (const zone of zones) {
          await mgr.getSource(zone.id);
        }
      },
      similarityClick(lng: number, lat: number) {
        similarityRef?.handleClick(lng, lat);
      },
      openOsmModal(opts) {
        onOpenOsm?.(opts);
      },
      closeOsmModal() {
        onCloseOsm?.();
      },
      switchBasemap(id: 'osm' | 'satellite' | 'dark') {
        onSwitchBasemap?.(id);
      },
    };
  }

  /** Update highlight rect via RAF loop. */
  function startPositionLoop() {
    cancelAnimationFrame(rafId);

    function tick() {
      const step = get(currentStep);
      if (!step) {
        highlightRect = null;
        return;
      }

      if (step.highlight) {
        const el = document.querySelector(step.highlight);
        highlightRect = el ? el.getBoundingClientRect() : null;
      } else {
        highlightRect = null;
      }

      // Auto-position card only if user hasn't dragged it
      if (cardEl && !userDragged) {
        const cardW = cardEl.offsetWidth;
        const cardH = cardEl.offsetHeight;
        const margin = 16;

        // Default: top-left
        let x = margin;
        let y = 48;

        // If we have a highlight with an arrow, position relative to it
        const dir: ArrowDirection = step.arrow ?? 'none';
        if (highlightRect && dir !== 'none') {
          const cx = highlightRect.left + highlightRect.width / 2;
          const cy = highlightRect.top + highlightRect.height / 2;
          const arrowGap = 12;

          switch (dir) {
            case 'top':
              x = cx - cardW / 2;
              y = highlightRect.top - cardH - arrowGap;
              break;
            case 'bottom':
              x = cx - cardW / 2;
              y = highlightRect.bottom + arrowGap;
              break;
            case 'left':
              x = highlightRect.left - cardW - arrowGap;
              y = cy - cardH / 2;
              break;
            case 'right':
              x = highlightRect.right + arrowGap;
              y = cy - cardH / 2;
              break;
          }
        }

        // Clamp to viewport
        cardX = Math.max(margin, Math.min(window.innerWidth - cardW - margin, x));
        cardY = Math.max(margin, Math.min(window.innerHeight - cardH - margin, y));
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
  }

  /** Execute the action for a step (called outside reactive context). */
  async function executeStepAction(stepId: string) {
    const step = get(currentStep);
    if (!step || step.id !== stepId || !step.action) return;

    const ctx = buildContext();
    if (!ctx) { stepActionRunning.set(false); return; }

    const delay = step.delay ?? 0;
    const trigger = step.trigger ?? { kind: 'click' as const };

    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    if (get(currentStep)?.id !== stepId) return;

    try {
      await step.action(ctx);
    } catch {
      // If action fails, don't block the tutorial
    }

    if (get(currentStep)?.id !== stepId) return;

    stepActionRunning.set(false);

    if (trigger.kind === 'action-complete') {
      lastActionStepId = ''; // allow next step
      nextStep();
    }
  }

  // React to step changes: start positioning + kick off actions
  $effect(() => {
    const step = $currentStep;
    const tut = $activeTutorial;

    if (!tut || !step) {
      cancelAnimationFrame(rafId);
      highlightRect = null;
      lastActionStepId = '';
      userDragged = false;
      diagramX = -1;
      return;
    }

    // Auto-position diagram panel when step has one — bottom-left, flush
    if (step.diagram && diagramX < 0) {
      diagramX = 0;
      diagramY = window.innerHeight; // will be clamped by CSS bottom:0
    } else if (!step.diagram) {
      diagramX = -1;
    }

    // Reset auto-position on step change (unless user has dragged)
    untrack(() => startPositionLoop());

    // Kick off action if this is a new step
    const stepId = step.id;
    if (stepId !== lastActionStepId) {
      lastActionStepId = stepId;

      if (step.action) {
        queueMicrotask(() => {
          stepActionRunning.set(true);
          executeStepAction(stepId);
        });
      } else if (step.trigger?.kind === 'timeout') {
        const ms = step.trigger.ms;
        const timer = setTimeout(() => {
          lastActionStepId = '';
          nextStep();
        }, ms);
        return () => { clearTimeout(timer); cancelAnimationFrame(rafId); };
      }
    }

    return () => cancelAnimationFrame(rafId);
  });

  // SVG spotlight mask path
  const spotlightPath = $derived.by(() => {
    if (!highlightRect || !$currentStep?.spotlight) return '';
    const pad = 6;
    const r = 4;
    const x = highlightRect.left - pad;
    const y = highlightRect.top - pad;
    const w = highlightRect.width + pad * 2;
    const h = highlightRect.height + pad * 2;
    return `M0,0 H${window.innerWidth} V${window.innerHeight} H0 Z ` +
      `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} ` +
      `V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} ` +
      `H${x + r} Q${x},${y + h} ${x},${y + h - r} ` +
      `V${y + r} Q${x},${y} ${x + r},${y} Z`;
  });

  // Arrow SVG points
  const arrowPoints = $derived.by(() => {
    if (!highlightRect || !cardEl || !$currentStep?.arrow || $currentStep.arrow === 'none') return null;
    const dir = $currentStep.arrow;
    const hx = highlightRect.left + highlightRect.width / 2;
    const hy = highlightRect.top + highlightRect.height / 2;
    const cw = cardEl.offsetWidth;
    const ch = cardEl.offsetHeight;

    let fromX: number, fromY: number;
    switch (dir) {
      case 'top':
        fromX = cardX + cw / 2;
        fromY = cardY + ch;
        break;
      case 'bottom':
        fromX = cardX + cw / 2;
        fromY = cardY;
        break;
      case 'left':
        fromX = cardX + cw;
        fromY = cardY + ch / 2;
        break;
      case 'right':
        fromX = cardX;
        fromY = cardY + ch / 2;
        break;
      default:
        return null;
    }

    return { x1: fromX, y1: fromY, x2: hx, y2: hy };
  });

  function handleNext() {
    if (get(stepActionRunning)) return;
    lastActionStepId = '';
    nextStep();
  }

  function handleEnd() {
    lastActionStepId = '';
    endTutorial();
  }

  const isLastStep = $derived($currentStepIndex === $totalSteps - 1);
  const triggerKind = $derived($currentStep?.trigger?.kind ?? 'click');
  const showNext = $derived(triggerKind === 'click' && !$stepActionRunning);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if $activeTutorial && $currentStep}
  <!-- Spotlight overlay -->
  {#if $currentStep.spotlight && spotlightPath}
    <svg class="fixed inset-0 z-[55] pointer-events-none" width="100%" height="100%">
      <path d={spotlightPath} fill="rgba(0,0,0,0.6)" fill-rule="evenodd" />
    </svg>
  {/if}

  <!-- Highlight ring -->
  {#if highlightRect}
    <div
      class="fixed z-[56] border-2 border-term-cyan rounded pointer-events-none"
      style:left="{highlightRect.left - 4}px"
      style:top="{highlightRect.top - 4}px"
      style:width="{highlightRect.width + 8}px"
      style:height="{highlightRect.height + 8}px"
      style="animation: pulse 2s ease-in-out infinite;"
    ></div>
  {/if}

  <!-- Arrow -->
  {#if arrowPoints}
    <svg class="fixed inset-0 z-[56] pointer-events-none tutorial-arrow" width="100%" height="100%">
      <!-- Dark outline for visibility -->
      <line
        x1={arrowPoints.x1} y1={arrowPoints.y1}
        x2={arrowPoints.x2} y2={arrowPoints.y2}
        stroke="black" stroke-width="5" stroke-linecap="round"
      />
      <!-- Cyan core -->
      <line
        x1={arrowPoints.x1} y1={arrowPoints.y1}
        x2={arrowPoints.x2} y2={arrowPoints.y2}
        stroke="#00e5ff" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="8,5"
      />
    </svg>
  {/if}

  <!-- Card (draggable) -->
  <div
    bind:this={cardEl}
    class="fixed z-[57] bg-gray-950 border border-term-cyan/40 rounded-lg
           w-[calc(100vw-2rem)] sm:w-[320px] max-w-[320px]
           shadow-lg shadow-cyan-900/20 font-mono select-none"
    style:left="{cardX}px"
    style:top="{cardY}px"
  >
    <!-- Header (drag handle) -->
    <div
      class="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 cursor-grab active:cursor-grabbing"
      onmousedown={startDrag}
    >
      <GripHorizontal size={12} class="text-gray-600 shrink-0" />
      <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_4px_rgba(0,229,255,0.6)]"></div>
      <span class="text-[12px] text-gray-200 font-medium flex-1">{$currentStep.title}</span>
      <button
        onclick={handleEnd}
        class="text-gray-600 hover:text-gray-300 transition-colors"
        title="Close tutorial"
      >
        <X size={14} />
      </button>
    </div>

    <!-- Body -->
    <div class="px-3 py-2 sm:py-3 text-[11px] text-gray-400 leading-relaxed min-h-[40px] sm:min-h-[48px]">
      {#if $stepActionRunning}
        <div class="flex items-center gap-2 text-term-cyan/80">
          <div class="w-3 h-3 border border-term-cyan/40 border-t-term-cyan rounded-full animate-spin"></div>
          <span>Working...</span>
        </div>
      {:else}
        {#each $currentStep.description.split('\n') as line}
          <p class:mt-2={line === ''}>{line}</p>
        {/each}
        {#if $currentStep.html}
          <div class="mt-2">
            {@html $currentStep.html}
          </div>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    <div class="flex items-center px-3 py-2 border-t border-gray-800/60">
      <span class="text-[10px] text-gray-600 tabular-nums">
        {$currentStepIndex + 1} / {$totalSteps}
      </span>
      <div class="flex-1"></div>
      <div class="flex items-center gap-2">
        <button
          onclick={handleEnd}
          class="text-[10px] text-gray-600 hover:text-gray-400 px-2 py-1 transition-colors"
        >SKIP</button>
        {#if showNext}
          <button
            onclick={handleNext}
            class="text-[10px] text-term-cyan px-3 py-1 rounded
                   border border-term-cyan/40 hover:bg-term-cyan/10 transition-colors"
          >{isLastStep ? 'FINISH' : 'NEXT'}</button>
        {/if}
      </div>
    </div>
  </div>

  <!-- Diagram panel (separate floating window — bottom-left) -->
  {#if $currentStep.diagram}
    <div
      class="fixed z-[57] left-0 bottom-0
             bg-gray-950/95 backdrop-blur-sm border-t border-r border-term-cyan/30
             rounded-tr-lg
             w-full sm:w-[520px] max-w-[520px]
             shadow-lg shadow-cyan-900/20 font-mono select-none"
    >
      <div
        class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60"
      >
        <div class="w-2 h-2 rounded-full bg-term-cyan/60 shrink-0"></div>
        {#if $currentStep.diagram.url}
          <a href={$currentStep.diagram.url} target="_blank" rel="noopener"
             class="text-[11px] text-term-cyan/80 hover:text-term-cyan flex-1 underline underline-offset-2 decoration-term-cyan/40 hover:decoration-term-cyan/80 transition-colors"
          >{$currentStep.diagram.title}</a>
        {:else}
          <span class="text-[11px] text-gray-400 flex-1">{$currentStep.diagram.title}</span>
        {/if}
      </div>
      <div class="px-4 py-3">
        {@html $currentStep.diagram.html}
      </div>
    </div>
  {/if}
{/if}

<style>
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .tutorial-arrow {
    animation: arrow-pulse 1.5s ease-in-out infinite;
  }
  @keyframes arrow-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
