import { writable, derived, get } from 'svelte/store';
import type { EmbeddingAt } from '@ucam-eo/maplibre-zarr-tessera';

export interface ClassDef {
  name: string;
  color: string;  // hex color
  id: number;
}

export interface LabelPoint {
  lngLat: [number, number];
  ci: number;
  cj: number;
  row: number;
  col: number;
  classId: number;
  embedding: Float32Array;
}

// --- Stores ---
export const classes = writable<ClassDef[]>([]);
export const labels = writable<LabelPoint[]>([]);
export const activeClassName = writable<string | null>(null);
export const kernelSize = writable(1);
export const kValue = writable(5);
export const confidenceThreshold = writable(0.5);
export const classificationOpacity = writable(0.7);
export const isClassified = writable(false);

// Next class ID counter
let nextClassId = 0;

// --- Derived ---
export const activeClass = derived(
  [classes, activeClassName],
  ([$classes, $name]) => $classes.find(c => c.name === $name) ?? null
);

export const labelCounts = derived(labels, ($labels) => {
  const counts = new Map<number, number>();
  for (const l of $labels) {
    counts.set(l.classId, (counts.get(l.classId) ?? 0) + 1);
  }
  return counts;
});

// --- Actions ---
export function addClass(name: string, color: string): void {
  const id = nextClassId++;
  classes.update(cs => [...cs, { name, color, id }]);
  activeClassName.set(name);
}

export function removeClass(name: string): void {
  const cls = get(classes);
  const removed = cls.find(c => c.name === name);
  classes.update(cs => cs.filter(c => c.name !== name));
  if (removed) {
    labels.update(ls => ls.filter(l => l.classId !== removed.id));
  }
  activeClassName.update(n => n === name ? null : n);
}

export function addLabel(
  lngLat: [number, number],
  embeddingAt: EmbeddingAt,
  classId: number,
): void {
  labels.update(ls => [...ls, {
    lngLat,
    ci: embeddingAt.ci,
    cj: embeddingAt.cj,
    row: embeddingAt.row,
    col: embeddingAt.col,
    classId,
    embedding: embeddingAt.embedding,
  }]);
}

export function removeLabel(index: number): void {
  labels.update(ls => ls.filter((_, i) => i !== index));
}

export function clearLabels(): void {
  labels.set([]);
  isClassified.set(false);
}

export function exportLabelsJson(): string {
  const cs = get(classes);
  const ls = get(labels);
  return JSON.stringify({
    classes: cs,
    labels: ls.map(l => ({
      lngLat: l.lngLat,
      ci: l.ci, cj: l.cj,
      row: l.row, col: l.col,
      classId: l.classId,
    })),
    k: get(kValue),
    confidenceThreshold: get(confidenceThreshold),
  }, null, 2);
}
