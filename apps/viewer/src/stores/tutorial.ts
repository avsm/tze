import { writable, derived, get } from 'svelte/store';
import type { TutorialDef, TutorialStep } from '../lib/tutorial';
import { simScores, simRefEmbedding, simSelectedPixel, simThreshold } from './similarity';
import { zarrSource } from './zarr';
import { classes, labels, isClassified, activeClassName } from './classifier';

export const tutorialRegistry = writable<TutorialDef[]>([]);
export const activeTutorial = writable<TutorialDef | null>(null);
export const currentStepIndex = writable(0);
export const stepActionRunning = writable(false);

export const currentStep = derived(
  [activeTutorial, currentStepIndex],
  ([$tut, $idx]): TutorialStep | null => {
    if (!$tut) return null;
    return $tut.steps[$idx] ?? null;
  },
);

export const totalSteps = derived(
  activeTutorial,
  ($tut): number => $tut?.steps.length ?? 0,
);

export function registerTutorial(def: TutorialDef) {
  tutorialRegistry.update((list) => {
    if (list.some((t) => t.id === def.id)) return list;
    return [...list, def];
  });
}

export function startTutorial(id: string) {
  const list = get(tutorialRegistry);
  const def = list.find((t) => t.id === id);
  if (!def) return;

  // Reset similarity + classifier state so the tutorial starts clean
  const src = get(zarrSource);
  if (src) src.clearClassificationOverlays();
  simSelectedPixel.set(null);
  simRefEmbedding.set(null);
  simScores.set([]);
  simThreshold.set(0.5);
  classes.set([]);
  labels.set([]);
  isClassified.set(false);
  activeClassName.set(null);

  currentStepIndex.set(0);
  stepActionRunning.set(false);
  activeTutorial.set(def);
}

export function nextStep() {
  const tut = get(activeTutorial);
  const idx = get(currentStepIndex);
  if (!tut) return;
  if (idx + 1 >= tut.steps.length) {
    endTutorial();
    return;
  }
  stepActionRunning.set(false);
  currentStepIndex.set(idx + 1);
}

export function endTutorial() {
  activeTutorial.set(null);
  currentStepIndex.set(0);
  stepActionRunning.set(false);
}
