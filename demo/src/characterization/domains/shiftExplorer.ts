// §13 domain-shift preprocessing explorer kernel (interim, computed locally in the demo). The preprocessing
// pipeline is agent C's fitted pipeline (`applyPipelineFittedRows`): learned parameters (MSC reference) are
// fitted on the reference-domain spectra only and applied unchanged to the compared domain. Spectra are then
// averaged into the engine's independence units, and every metric is computed on complete spectra with the
// reference-only PCA (never refitted on compared rows). No target value is read; no setting is searched or
// optimized: the reader chooses the pipeline, the kernel reports before / after.
import { applyPipelineFittedRows, type Matrix } from "../preprocessing/evaluate";
import type { StepRecipe } from "../preprocessing/catalog";
import type { ExplorerKernel } from "../preprocessing/evaluate";
import { matrix, monitorShape, type loadMethods } from "./kernels";
import { condensedDistances } from "./permutation";

type Methods = Awaited<ReturnType<typeof loadMethods>>;

export interface ExploreRequest {
  /** Source rows used by the two domains (row-major, finite). */
  X: Matrix;
  /** Per unit, per aggregated group: row indices into X. */
  reference: number[][][];
  compared: number[][][];
  steps: StepRecipe[];
  axisStep: number | null;
}

export interface ShiftSide {
  relativeCentre: number | null;
  dispersionRatio: number | null;
  energy: number | null;
  relativeEnergy: number | null;
  beyondT2: number | null;
  beyondQ: number | null;
  beyondEither: number | null;
  components: number | null;
  nReference: number;
  nCompared: number;
  /** Reference-fitted PCA scores (2 components) of both domains. */
  overlap: { reference: number[][]; compared: number[][]; explained: (number | null)[] } | null;
}

export interface ExploreResult {
  raw: ShiftSide;
  processed: ShiftSide;
}

const unitMeans = (X: Matrix, units: number[][][]): number[][] =>
  units.map((groups) => {
    const out = new Array<number>(X.cols).fill(0);
    for (const rows of groups) for (const r of rows) for (let c = 0; c < X.cols; c++) out[c]! += X.data[r * X.cols + c]! / (rows.length * groups.length);
    return out;
  });

/** Shift metrics of two unit-mean populations in complete spectra, reference-only fits. */
export function shiftMetrics(m: Methods, ref: number[][], cmp: number[][]): ShiftSide {
  const p = ref[0]?.length ?? 0;
  const mean = (rows: number[][]) => {
    const out = new Array<number>(p).fill(0);
    for (const r of rows) r.forEach((v, c) => (out[c]! += v / rows.length));
    return out;
  };
  const total = (rows: number[][], mu: number[]) => (rows.length < 2 ? null : rows.reduce((s, r) => s + r.reduce((a, v, c) => a + (v - mu[c]!) ** 2, 0), 0) / (rows.length - 1));
  const mr = mean(ref);
  const mc = mean(cmp);
  const tr = total(ref, mr);
  const tc = total(cmp, mc);
  let shift = 0;
  for (let c = 0; c < p; c++) shift += (mc[c]! - mr[c]!) ** 2;
  shift = Math.sqrt(shift);
  // Energy (V-statistic) and within-reference mean distance.
  const nr = ref.length;
  const n = nr + cmp.length;
  const dist = condensedDistances([...ref, ...cmp]);
  let srr = 0, scc = 0, src = 0, k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++, k++) {
    const d = dist[k]!;
    if (j < nr) srr += d; else if (i >= nr) scc += d; else src += d;
  }
  const nc = cmp.length;
  const Mrr = (2 * srr) / (nr * nr);
  const Mcc = (2 * scc) / (nc * nc);
  const Mrc = src / (nr * nc);
  const energy = nr && nc ? Math.max(0, 2 * Mrc - Mrr - Mcc) : null;
  let beyondT2: number | null = null, beyondQ: number | null = null, beyondEither: number | null = null, components: number | null = null;
  if (nr >= 3 && nc >= 1) {
    const [folds, kk] = monitorShape(nr, p);
    const r = m.statsPcaMonitor(matrix(ref), matrix(cmp), kk, folds, 0.05);
    beyondT2 = r.nBeyondT2 / nc;
    beyondQ = r.nBeyondQ / nc;
    beyondEither = r.nBeyondEither / nc;
    components = r.effectiveComponents;
  }
  let overlap: ShiftSide["overlap"] = null;
  if (nr >= 3) {
    const pca = m.preflightPca(matrix(ref), Math.min(2, nr - 1, p));
    const comps = Array.from({ length: pca.loadings.rows }, (_, a) => a).filter((a) => !pca.unresolved[a]);
    if (comps.length >= 2) {
      const project = (x: number[]) => comps.map((a) => {
        let s = 0;
        for (let c = 0; c < p; c++) s += (x[c]! - mr[c]!) * pca.loadings.data[a * p + c]!;
        return s;
      });
      const full = pca.fullMoments[0];
      overlap = { reference: ref.map(project), compared: cmp.map(project), explained: comps.map((a) => (full > 0 ? pca.eigenvalues[a]! / full : null)) };
    }
  }
  return {
    relativeCentre: tr !== null && tr > 0 ? shift / Math.sqrt(tr) : null,
    dispersionRatio: tr !== null && tc !== null && tr > 0 ? tc / tr : null,
    energy,
    relativeEnergy: energy !== null && Mrr > 0 ? energy / Mrr : null,
    beyondT2, beyondQ, beyondEither, components,
    nReference: nr,
    nCompared: nc,
    overlap,
  };
}

/** Before / after metrics of one pipeline fitted on the reference rows only. */
export function exploreShift(m: Methods, kernel: ExplorerKernel, req: ExploreRequest): ExploreResult {
  const refRows = [...new Set(req.reference.flat(2))];
  const allRows = Array.from({ length: req.X.rows }, (_, i) => i);
  const raw = shiftMetrics(m, unitMeans(req.X, req.reference), unitMeans(req.X, req.compared));
  if (!req.steps.length) return { raw, processed: raw };
  const { apply } = applyPipelineFittedRows(kernel, req.steps, req.X, refRows, allRows, req.axisStep);
  return { raw, processed: shiftMetrics(m, unitMeans(apply, req.reference), unitMeans(apply, req.compared)) };
}
