// Optional exploratory chemometric comparison of preprocessing pipelines (request §8, "validation
// chimiométrique"): leak-free grouped cross-validation of a PLS model on raw vs preprocessed spectra.
// Interim, computed in the demo: the PLS fit is Methods `models.pls.pls_regression` (methodsKernel.ts);
// the grouped fold assignment, nested latent-variable selection and scoring here belong to DAG-ML
// (debt: docs/implementation/debt/characterization-preprocessing.md). Not a validated model.
import type { EngineInput } from "../../input";
import type { StepRecipe } from "./catalog";
import { sampleRows } from "./data";
import { applyPipelineFitted, takeRows, type ExplorerKernel } from "./evaluate";
import { axisStep as axisSpacing, type Matrix } from "./metrics";

/** PLS1 owner kernel: predictions of `Xt` for 1..`components` latent variables from one fit on X, y. */
export interface PlsKernel {
  plsPredictPath(X: Matrix, y: Float64Array, components: number, Xt: Matrix): Float64Array[];
}

/** Rows entering the comparison (spectra of the calibration population), at most this many. */
export const CHEMO_ROW_CAP = 1000;
export const CHEMO_MAX_LV = 15;
export const CHEMO_OUTER_FOLDS = 5;
export const CHEMO_INNER_FOLDS = 5;
/** Parsimony rule of the inner selection: smallest LV count within this factor of the minimum inner RMSECV. */
export const CHEMO_LV_TOLERANCE = 1.02;
export const CHEMO_DEFAULT_SEED = 20261120;

export type ChemoMode = "regression" | "binary";

export interface CalibrationPopulation {
  targetId: string;
  targetUnit: string;
  mode: ChemoMode;
  /** Binary target: [class coded 0, class coded 1]. */
  classes: [string, string] | null;
  matrix: Matrix;
  /** Reference value per row (its sample's value; 0/1 for a binary target). */
  y: Float64Array;
  /** Cross-validation group per row (rows of one group never split across folds). */
  groups: number[];
  /** Sample code per row: predictions are averaged per sample before scoring. */
  samples: number[];
  axisStep: number | null;
  seed: number;
  unitRule: string;
  counts: {
    /** Development rows of the source (calibration population before exclusions). */
    development: number;
    /** Rows not read because their sample is retained-test, prediction or augmented. */
    notDevelopment: number;
    noReference: number;
    incomplete: number;
    /** Rows dropped by the deterministic cap. */
    capped: number;
    used: number;
    samples: number;
    groups: number;
  };
}

export type PopulationResult = { ok: true; population: CalibrationPopulation } | { ok: false; reason: string };

const complete = (x: readonly (number | null)[] | undefined, mask: readonly boolean[] | undefined, p: number) =>
  !!x && x.length === p && x.every((v, j) => v !== null && Number.isFinite(v) && (mask ? mask[j] !== false : true));

const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);
/** FNV-1a over the float64 bits of a spectrum (−0 folded onto +0, as `===` compares). */
function spectrumHash(x: readonly number[]): number {
  let h = 2166136261;
  for (const v of x) {
    bits[0] = v + 0;
    h = Math.imul(h ^ words[0]!, 16777619);
    h = Math.imul(h ^ words[1]!, 16777619);
  }
  return h >>> 0;
}
const sameSpectrum = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, j) => v === b[j]);

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]!]!;
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * Calibration population of one source and target. Only development samples (not augmented) are
 * considered; the X rows and the reference values of retained-test and prediction samples are never
 * read. Grouping (union of rows that must stay in one fold): same sample id, same physical sample,
 * the declared independence group (`independence_unit` "group") or reference group ("reference_group"),
 * and identical spectra.
 */
export function buildCalibrationPopulation(input: EngineInput, sourceId: string | null, targetId: string | null, cap = CHEMO_ROW_CAP): PopulationResult {
  const target = (input.targets ?? []).find((t) => t.target_id === targetId) ?? (targetId === null ? input.targets?.[0] : undefined);
  if (!target) return { ok: false, reason: "No target is declared: the chemometric comparison needs a reference value Y." };
  const source = input.sources.find((s) => s.source_id === sourceId) ?? input.sources[0];
  if (!source) return { ok: false, reason: "No spectral source." };
  const p = source.axis.length;
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const calibration = new Set(input.samples.filter((s) => (s.partition ?? "development") === "development" && !s.augmentation_parent_id).map((s) => s.sample_id));

  // Reference values of calibration samples only: the sample id is checked before any value is read.
  const entries = new Map<string, { value: number | string; refGroup: string | null } | "conflict">();
  for (const v of target.values) {
    const id = v.sample_id;
    if (!calibration.has(id)) continue;
    if (v.status !== "exact") continue;
    const value = target.kind === "continuous" ? v.value : v.category;
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) continue;
    const prev = entries.get(id);
    entries.set(id, prev === undefined ? { value, refGroup: v.reference_group_id ?? null } : prev !== "conflict" && prev.value === value ? prev : "conflict");
  }
  let classes: [string, string] | null = null;
  if (target.kind === "categorical") {
    const cats = [...new Set([...entries.values()].flatMap((e) => (e === "conflict" ? [] : [String(e.value)])))].sort();
    if (cats.length !== 2) return { ok: false, reason: `PLS-DA comparison supports a binary target only (${cats.length} classes with exact development references).` };
    classes = [cats[0]!, cats[1]!];
  }

  const counts = { development: 0, notDevelopment: 0, noReference: 0, incomplete: 0, capped: 0, used: 0, samples: 0, groups: 0 };
  const rows: number[] = [];
  source.sample_ids.forEach((id, r) => {
    if (!calibration.has(id)) {
      counts.notDevelopment++;
      return;
    }
    counts.development++;
    const e = entries.get(id);
    if (!e || e === "conflict") counts.noReference++;
    else if (!complete(source.x[r], source.valid_mask?.[r], p)) counts.incomplete++;
    else rows.push(r);
  });

  // Groups over the eligible rows.
  const unit = input.options.independence_unit ?? "unknown";
  const uf = new UnionFind(rows.length);
  const first = new Map<string, number>();
  const link = (key: string, k: number) => {
    const f = first.get(key);
    if (f === undefined) first.set(key, k);
    else uf.union(f, k);
  };
  const buckets = new Map<number, number[]>();
  rows.forEach((r, k) => {
    const id = source.sample_ids[r]!;
    const s = samples.get(id);
    link(`s:${id}`, k);
    link(`p:${s?.physical_sample_id ?? id}`, k);
    if (unit === "group" && s?.independence_group) link(`g:${s.independence_group}`, k);
    const e = entries.get(id);
    if (unit === "reference_group" && e && e !== "conflict" && e.refGroup) link(`r:${e.refGroup}`, k);
    // Identical spectra: hash bucket, then exact comparison (no string of every spectrum on the main thread).
    const x = source.x[r] as number[];
    const h = spectrumHash(x);
    const bucket = buckets.get(h);
    const twin = bucket?.find((k2) => sameSpectrum(source.x[rows[k2]!] as number[], x));
    if (twin !== undefined) uf.union(twin, k);
    else if (bucket) bucket.push(k);
    else buckets.set(h, [k]);
  });
  const groupKey = rows.map((_, k) => uf.find(k));
  const byRow = new Map(rows.map((r, k) => [r, `g${groupKey[k]}`]));
  const used = sampleRows(rows, source.sample_ids.map((_, r) => byRow.get(r) ?? `#${r}`), cap);
  counts.capped = rows.length - used.length;
  counts.used = used.length;
  if (used.length < 6) return { ok: false, reason: `Only ${used.length} calibration spectra with an exact reference value and a complete spectrum (at least 6 needed).` };

  const data = new Float64Array(used.length * p);
  used.forEach((r, i) => data.set(source.x[r] as number[], i * p));
  const code = (m: Map<string, number>, key: string) => m.get(key) ?? (m.set(key, m.size), m.size - 1);
  const gCodes = new Map<string, number>(), sCodes = new Map<string, number>();
  const groups = used.map((r) => code(gCodes, byRow.get(r)!));
  const sampleCodes = used.map((r) => code(sCodes, source.sample_ids[r]!));
  const y = Float64Array.from(used, (r) => {
    const e = entries.get(source.sample_ids[r]!) as { value: number | string };
    return classes ? (String(e.value) === classes[1] ? 1 : 0) : Number(e.value);
  });
  counts.samples = sCodes.size;
  counts.groups = gCodes.size;
  if (gCodes.size < 3) return { ok: false, reason: `Only ${gCodes.size} independent groups: grouped cross-validation needs at least 3.` };
  if (y.every((v) => v === y[0])) return { ok: false, reason: "The reference value is constant over the calibration spectra." };

  const { step: spacing } = axisSpacing(source.axis);
  const seedOpt = Number(input.options.seed);
  const unitRule =
    unit === "group"
      ? "declared independence group (plus physical sample and identical spectra)"
      : unit === "reference_group"
        ? "reference group of the target (plus physical sample and identical spectra)"
        : "physical sample, else sample id (plus identical spectra)";
  return {
    ok: true,
    population: {
      targetId: target.target_id,
      targetUnit: target.unit ?? "",
      mode: classes ? "binary" : "regression",
      classes,
      matrix: { data, rows: used.length, cols: p },
      y,
      groups,
      samples: sampleCodes,
      axisStep: spacing !== null && source.axis[p - 1]! < source.axis[0]! ? -spacing : spacing,
      seed: Number.isFinite(seedOpt) && seedOpt >= 0 ? seedOpt % 2 ** 32 : CHEMO_DEFAULT_SEED,
      unitRule,
      counts,
    },
  };
}

/** mulberry32: small deterministic PRNG for the group order. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grouped K-fold: groups in a seeded random order, then by decreasing size (stable), each assigned to
 * the fold with the fewest rows so far. Returns the fold (0..k−1) of every row; a group never spans
 * two folds.
 */
export function groupedFolds(groups: readonly number[], k: number, seed: number): number[] {
  const sizes = new Map<number, number>();
  for (const g of groups) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  const rnd = mulberry32(seed);
  const order = [...sizes.keys()].sort((a, b) => a - b).map((g) => ({ g, r: rnd() }));
  order.sort((a, b) => a.r - b.r);
  order.sort((a, b) => sizes.get(b.g)! - sizes.get(a.g)!);
  const load = new Array<number>(k).fill(0);
  const foldOf = new Map<number, number>();
  for (const { g } of order) {
    let best = 0;
    for (let f = 1; f < k; f++) if (load[f]! < load[best]!) best = f;
    foldOf.set(g, best);
    load[best]! += sizes.get(g)!;
  }
  return groups.map((g) => foldOf.get(g)!);
}

/** Sample-level scores: predictions and references averaged per sample, then compared. */
export interface Scores {
  rmse: number;
  r2: number | null;
  bias: number;
  /** Binary target: balanced accuracy (%) at the 0.5 threshold on the per-sample mean prediction. */
  balancedAccuracy: number | null;
  n: number;
}

export function sampleScores(pred: ArrayLike<number>, y: ArrayLike<number>, samples: readonly number[], binary: boolean): Scores {
  const acc = new Map<number, { p: number; y: number; n: number }>();
  samples.forEach((s, i) => {
    const e = acc.get(s) ?? { p: 0, y: 0, n: 0 };
    e.p += pred[i]!;
    e.y += y[i]!;
    e.n++;
    acc.set(s, e);
  });
  const P = [...acc.values()].map((e) => e.p / e.n), Y = [...acc.values()].map((e) => e.y / e.n);
  const n = P.length;
  let sse = 0, bias = 0, mean = 0;
  for (let i = 0; i < n; i++) {
    sse += (P[i]! - Y[i]!) ** 2;
    bias += P[i]! - Y[i]!;
    mean += Y[i]!;
  }
  mean /= n;
  let sst = 0;
  for (const v of Y) sst += (v - mean) ** 2;
  let balancedAccuracy: number | null = null;
  if (binary) {
    const rate = (cls: number) => {
      const idx = Y.map((v, i) => (v === cls ? i : -1)).filter((i) => i >= 0);
      return idx.length ? idx.filter((i) => (P[i]! >= 0.5 ? 1 : 0) === cls).length / idx.length : null;
    };
    const r0 = rate(0), r1 = rate(1);
    balancedAccuracy = r0 === null || r1 === null ? null : (100 * (r0 + r1)) / 2;
  }
  return { rmse: Math.sqrt(sse / n), r2: sst > 0 ? 1 - sse / sst : null, bias: bias / n, balancedAccuracy, n };
}

export interface ConfigResult {
  label: string;
  steps: StepRecipe[];
  /** Nested: LV chosen inside each outer training fold by inner grouped CV. */
  nested: Scores | null;
  /** LV count selected per outer fold. */
  selectedLv: number[];
  /** Fixed-LV sweep over the outer folds (descriptive curve, never used for selection): RMSECV per LV 1..A. */
  curve: { lv: number; rmse: number; r2: number | null }[];
  error: string | null;
}

export interface ChemoResult {
  mode: ChemoMode;
  folds: number;
  innerFolds: number;
  maxLv: number;
  seed: number;
  rows: number;
  samples: number;
  groups: number;
  configs: ConfigResult[];
}

const isIn = (folds: readonly number[], f: number, inside: boolean) => folds.flatMap((v, i) => ((v === f) === inside ? [i] : []));

/**
 * Nested grouped cross-validation of PLS on each pipeline. For every outer fold: the pipeline's learned
 * parameters (e.g. the MSC reference) and the PLS centring are fitted on the outer training rows only;
 * the LV count is chosen by grouped CV inside those rows (pipeline refitted in each inner fold); the
 * outer test rows are predicted once. The same folds serve every pipeline.
 */
export function runChemometricComparison(
  kernel: ExplorerKernel & PlsKernel,
  pop: CalibrationPopulation,
  configs: readonly { label: string; steps: StepRecipe[] }[],
  onProgress?: (done: number, total: number) => void,
): ChemoResult {
  const nGroups = new Set(pop.groups).size;
  const K = Math.min(CHEMO_OUTER_FOLDS, nGroups);
  const outer = groupedFolds(pop.groups, K, pop.seed);
  const plan = Array.from({ length: K }, (_, f) => {
    const train = isIn(outer, f, false), test = isIn(outer, f, true);
    const trainGroups = train.map((i) => pop.groups[i]!);
    const kIn = Math.min(CHEMO_INNER_FOLDS, new Set(trainGroups).size);
    const inner = kIn >= 2 ? groupedFolds(trainGroups, kIn, pop.seed + f + 1) : null;
    return { train, test, inner, kIn };
  });
  // One LV range for all fits: below the smallest (inner) training set and the band count.
  let smallest = Infinity;
  for (const f of plan) {
    smallest = Math.min(smallest, f.train.length);
    if (f.inner) for (let g = 0; g < f.kIn; g++) smallest = Math.min(smallest, f.inner.filter((v) => v !== g).length);
  }
  const maxLv = Math.max(1, Math.min(CHEMO_MAX_LV, pop.matrix.cols - 1, smallest - 2));
  const binary = pop.mode === "binary";

  const fitPredict = (steps: readonly StepRecipe[], train: number[], test: number[]) => {
    const { fit, apply } = applyPipelineFitted(kernel, steps, takeRows(pop.matrix, train), [takeRows(pop.matrix, test)], pop.axisStep);
    return kernel.plsPredictPath(fit, Float64Array.from(train, (i) => pop.y[i]!), maxLv, apply[0]!);
  };

  const total = configs.length * K;
  const results = configs.map((config, ci): ConfigResult => {
    try {
      const nestedPred = new Float64Array(pop.matrix.rows);
      const pathPred = Array.from({ length: maxLv }, () => new Float64Array(pop.matrix.rows));
      const selectedLv: number[] = [];
      for (const f of plan) {
        // Inner selection on the outer training rows only.
        let chosen = maxLv;
        if (f.inner) {
          const innerPred = Array.from({ length: maxLv }, () => new Float64Array(f.train.length));
          for (let g = 0; g < f.kIn; g++) {
            const tr = isIn(f.inner, g, false), te = isIn(f.inner, g, true);
            const path = fitPredict(config.steps, tr.map((i) => f.train[i]!), te.map((i) => f.train[i]!));
            path.forEach((pred, a) => te.forEach((i, k) => (innerPred[a]![i] = pred[k]!)));
          }
          const trY = f.train.map((i) => pop.y[i]!), trS = f.train.map((i) => pop.samples[i]!);
          const rmse = innerPred.map((pred) => sampleScores(pred, trY, trS, binary).rmse);
          const best = Math.min(...rmse);
          chosen = rmse.findIndex((v) => v <= best * CHEMO_LV_TOLERANCE) + 1;
        }
        selectedLv.push(chosen);
        const path = fitPredict(config.steps, f.train, f.test);
        f.test.forEach((i, k) => {
          nestedPred[i] = path[chosen - 1]![k]!;
          for (let a = 0; a < maxLv; a++) pathPred[a]![i] = path[a]![k]!;
        });
        onProgress?.(ci * K + selectedLv.length, total);
      }
      return {
        label: config.label,
        steps: config.steps,
        nested: sampleScores(nestedPred, pop.y, pop.samples, binary),
        selectedLv,
        curve: pathPred.map((pred, a) => {
          const s = sampleScores(pred, pop.y, pop.samples, binary);
          return { lv: a + 1, rmse: s.rmse, r2: s.r2 };
        }),
        error: null,
      };
    } catch (e) {
      onProgress?.((ci + 1) * K, total);
      return { label: config.label, steps: config.steps, nested: null, selectedLv: [], curve: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { mode: pop.mode, folds: K, innerFolds: Math.min(...plan.map((f) => f.kIn)), maxLv, seed: pop.seed, rows: pop.matrix.rows, samples: pop.counts.samples, groups: pop.counts.groups, configs: results };
}
