import { writable, derived, get } from 'svelte/store';
import type { EmbeddingAt } from '@ucam-eo/maplibre-zarr-tessera';

export interface ClassDef {
  name: string;
  color: string;  // hex color
  id: number;
}

export type LabelSource = 'human' | 'osm';

export interface LabelPoint {
  lngLat: [number, number];
  ci: number;
  cj: number;
  row: number;
  col: number;
  classId: number;
  embedding: Float32Array;
  source: LabelSource;
}

// --- Stores ---
export const classes = writable<ClassDef[]>([]);
export const labels = writable<LabelPoint[]>([]);
export const activeClassName = writable<string | null>(null);
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
    source: 'human',
  }]);
}

/** Remove a label at a specific pixel location. Returns true if a label was removed. */
export function removeLabel(ci: number, cj: number, row: number, col: number): boolean {
  const current = get(labels);
  const idx = current.findIndex(l => l.ci === ci && l.cj === cj && l.row === row && l.col === col);
  if (idx < 0) return false;
  labels.update(ls => ls.filter((_, i) => i !== idx));
  return true;
}

export function clearLabels(): void {
  labels.set([]);
  isClassified.set(false);
}

export function importOsmLabels(
  newClasses: Array<{ name: string; color: string }>,
  newLabels: Map<string, Array<{ lngLat: [number, number]; embeddingAt: EmbeddingAt }>>,
): { classesCreated: number; labelsImported: number } {
  let classesCreated = 0;
  let labelsImported = 0;
  const currentClasses = get(classes);

  // Map class name → ClassDef (reuse existing or create new)
  const classMap = new Map<string, ClassDef>();
  for (const cls of currentClasses) {
    classMap.set(cls.name, cls);
  }

  const toAddClasses: ClassDef[] = [];
  for (const { name, color } of newClasses) {
    if (!classMap.has(name)) {
      const def: ClassDef = { name, color, id: nextClassId++ };
      classMap.set(name, def);
      toAddClasses.push(def);
      classesCreated++;
    }
  }

  if (toAddClasses.length > 0) {
    classes.update(cs => [...cs, ...toAddClasses]);
  }

  // Bulk-append all label points
  const toAddLabels: LabelPoint[] = [];
  for (const [className, points] of newLabels) {
    const cls = classMap.get(className);
    if (!cls) {
      console.warn(`[importOsmLabels] class "${className}" not found in classMap — skipping ${points.length} labels`);
      continue;
    }
    for (const { lngLat, embeddingAt } of points) {
      toAddLabels.push({
        lngLat,
        ci: embeddingAt.ci,
        cj: embeddingAt.cj,
        row: embeddingAt.row,
        col: embeddingAt.col,
        classId: cls.id,
        embedding: embeddingAt.embedding,
        source: 'osm',
      });
      labelsImported++;
    }
  }

  if (toAddLabels.length > 0) {
    labels.update(ls => [...ls, ...toAddLabels]);
  }

  console.log(`[importOsmLabels] created ${classesCreated} classes, imported ${labelsImported} labels`);
  console.log(`[importOsmLabels] total classes now:`, get(classes).map(c => `${c.name}(id=${c.id})`));
  console.log(`[importOsmLabels] total labels now:`, get(labels).length);

  return { classesCreated, labelsImported };
}

