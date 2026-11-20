// Per-unit domain-shift diagnostics the engine report does not carry. Every numerical kernel is a Methods
// WASM kernel, called on the same unit-mean spectra and input spaces as the engine:
// - `statsPcaMonitor` (the engine's T²/Q monitor): individual T² and Q of the compared units in the PCA fitted
//   on the reference units only, out-of-fold reference statistics and limits (never refitted on compared rows);
// - `preflightPca`: the engine's label-free leading space of all development units (factor comparisons), and
//   the reference-only PCA of the overlap plot (compared units are projected, never fitted);
// - `preflightNearestNeighbors`: Euclidean distances (nearest neighbours and the pairwise matrix);
// - `randomPermutations`: the seeded reference splits of the internal energy benchmark.
// Display arithmetic only in TS: band means/quantiles, projections onto the reference loadings, V-statistic
// means of the Methods distances. Interim (debt: docs/implementation/debt/characterization-domains.md).
import { quantile, sortedQuantile } from "../shared/derive";
import type { DomainPopulations, Unit } from "./populations";
import type { CoverageSupport, EnergyContext } from "./model";

type Methods = typeof import("@nirs4all/methods");
let methods: Promise<Methods> | null = null;
export function loadMethods(): Promise<Methods> {
  methods ??= import("@nirs4all/methods").then(async (m) => {
    await m.loadModule();
    return m;
  }).catch((e) => {
    methods = null;
    throw e;
  });
  return methods;
}

const matrix = (rows: readonly (readonly number[])[]) => {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  const data = new Float64Array(n * p);
  rows.forEach((r, i) => data.set(r, i * p));
  return { data, rows: n, cols: p };
};

// --- band profiles (display statistics over unit-mean spectra) ------------------------------------------------

export interface BandProfiles {
  meanRef: number[];
  meanCmp: number[];
  p5Ref: number[];
  p95Ref: number[];
  p5Cmp: number[];
  p95Cmp: number[];
  sdRef: (number | null)[];
  sdCmp: (number | null)[];
  /** mean compared − mean reference. */
  diff: number[];
  /** diff / sqrt((sdRef² + sdCmp²) / 2); null where that pooled SD is zero or negligible. */
  standardized: (number | null)[];
  /** sdCmp² / sdRef²; null where the reference SD is zero or negligible. */
  localRatio: (number | null)[];
}

const negligible = (sd: number, scale: number) => !(sd > 1e-9 * Math.max(scale, 1e-300));

export function bandProfiles(reference: readonly Unit[], compared: readonly Unit[]): BandProfiles | null {
  if (!reference.length || !compared.length) return null;
  const p = reference[0]!.spectrum.length;
  const out: BandProfiles = { meanRef: [], meanCmp: [], p5Ref: [], p95Ref: [], p5Cmp: [], p95Cmp: [], sdRef: [], sdCmp: [], diff: [], standardized: [], localRatio: [] };
  const col = (us: readonly Unit[], c: number) => us.map((u) => u.spectrum[c]!).sort((a, b) => a - b);
  const stats = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : null;
    return { m, sd };
  };
  for (let c = 0; c < p; c++) {
    const r = col(reference, c);
    const t = col(compared, c);
    const a = stats(r);
    const b = stats(t);
    const scale = Math.max(Math.abs(a.m), Math.abs(b.m));
    out.meanRef.push(a.m);
    out.meanCmp.push(b.m);
    out.p5Ref.push(sortedQuantile(r, 0.05)!);
    out.p95Ref.push(sortedQuantile(r, 0.95)!);
    out.p5Cmp.push(sortedQuantile(t, 0.05)!);
    out.p95Cmp.push(sortedQuantile(t, 0.95)!);
    out.sdRef.push(a.sd);
    out.sdCmp.push(b.sd);
    out.diff.push(b.m - a.m);
    const pooled = a.sd !== null && b.sd !== null ? Math.sqrt((a.sd ** 2 + b.sd ** 2) / 2) : null;
    out.standardized.push(pooled !== null && !negligible(pooled, scale) ? (b.m - a.m) / pooled : null);
    out.localRatio.push(a.sd !== null && b.sd !== null && !negligible(a.sd, scale) ? b.sd ** 2 / a.sd ** 2 : null);
  }
  return out;
}

/** Contiguous window (one tenth of the bands) holding the largest share of the squared mean difference. */
export function dominantRegion(diff: readonly number[], minShare = 0.3): { i0: number; i1: number; share: number } | null {
  const p = diff.length;
  const w = Math.max(3, Math.round(p / 10));
  if (p < 2 * w) return null;
  const sq = diff.map((d) => d * d);
  const total = sq.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let s = sq.slice(0, w).reduce((a, b) => a + b, 0);
  let best = { i0: 0, sum: s };
  for (let i = 1; i + w <= p; i++) {
    s += sq[i + w - 1]! - sq[i - 1]!;
    if (s > best.sum) best = { i0: i, sum: s };
  }
  const share = best.sum / total;
  return share >= minShare ? { i0: best.i0, i1: best.i0 + w - 1, share } : null;
}

// --- Methods diagnostics -----------------------------------------------------------------------------------------

export interface SpaceOptions {
  audit: boolean;
  energyOnSpectra: boolean;
  monitorOnSpectra: boolean;
}

export interface MonitorResult {
  components: number;
  t2Limit: number;
  qLimit: number;
  comparedT2: number[];
  comparedQ: number[];
  referenceT2: number[];
  referenceQ: number[];
  nBeyondT2: number;
  nBeyondQ: number;
  nBeyondEither: number;
  folds: number;
}

export interface OverlapResult {
  /** Reference / compared scores on the reference-fitted PCs (rows × k). */
  reference: number[][];
  compared: number[][];
  /** Explained share of the reference total variance per PC. */
  explained: (number | null)[];
}

export interface NeighbourResult {
  refToRef: number[];
  cmpToRef: number[];
  refToCmp: number[];
  cmpToCmp: number[];
  support: CoverageSupport;
}

export interface EnergyBenchmark extends EnergyContext {
  /** Energies between internal reference splits. */
  values: number[];
  sizes: [number, number] | null;
  resamples: number;
  seed: number;
  /** Observed energy recomputed from the Methods distances (consistency with the engine value). */
  observed: number | null;
}

export interface DomainDiagnostics {
  space: "complete_spectra" | "leading_pca";
  monitor: MonitorResult | null;
  overlap: OverlapResult | null;
  neighbours: NeighbourResult | null;
  energy: EnergyBenchmark;
  notes: string[];
}

/** Engine monitor shape: K = min(10, n_r) folds and k = min(10, n_r − ceil(n_r / K) − 1, p). */
export function monitorShape(nReference: number, p: number): [number, number] {
  const folds = Math.min(10, nReference);
  const train = nReference - Math.ceil(nReference / folds);
  return [folds, Math.min(10, train - 1, p)];
}

export const ENERGY_RESAMPLES = 199;
export const ENERGY_SEED = 20261120;
export const MAX_PAIRWISE_UNITS = 1500;

/** V-statistic energy 2 M_ab − M_aa − M_bb from a full distance matrix (self-pairs included, as the engine). */
export function energyFromDistances(D: Float64Array, N: number, a: readonly number[], b: readonly number[]): number {
  const mean = (x: readonly number[], y: readonly number[]) => {
    let s = 0;
    for (const i of x) for (const j of y) s += D[i * N + j]!;
    return s / (x.length * y.length);
  };
  return 2 * mean(a, b) - mean(a, a) - mean(b, b);
}

export function energyBenchmark(D: Float64Array, N: number, nRef: number, nCmp: number, engineValue: number | null, perms: (n: number, b: number) => number[][]): EnergyBenchmark {
  const ref = Array.from({ length: nRef }, (_, i) => i);
  const cmp = Array.from({ length: nCmp }, (_, i) => nRef + i);
  const observed = nRef && nCmp ? energyFromDistances(D, N, ref, cmp) : null;
  const base = { values: [], resamples: 0, seed: ENERGY_SEED, observed, typical: null, percentile: null };
  const m = Math.min(nCmp, Math.floor(nRef / 2));
  if (nRef < 6 || m < 3) return { ...base, status: "unavailable", reason: `Too few reference units (${nRef}) to draw two disjoint internal subsets of at least 3 units.`, sizes: null };
  const values = perms(nRef, ENERGY_RESAMPLES).map((perm) => Math.max(0, energyFromDistances(D, N, perm.slice(0, m), perm.slice(m))));
  const obs = engineValue ?? observed;
  const sorted = [...values].sort((x, y) => x - y);
  return {
    // Sizes match only when both internal subsets have the observed sizes (n_c, n_r), which disjoint subsets of
    // the reference cannot reach: the V-statistic (self-pairs included) grows as group sizes shrink.
    status: m === nCmp && nRef - m === nRef ? "available" : "approximate",
    reason: `Internal subsets of ${m} and ${nRef - m} units against observed groups of ${nCmp} and ${nRef} units: the V-statistic (self-pairs included) grows as group sizes shrink, so the internal distances are biased upward relative to the observed one.`,
    values,
    sizes: [m, nRef - m],
    resamples: values.length,
    seed: ENERGY_SEED,
    observed,
    typical: sortedQuantile(sorted, 0.5),
    percentile: obs === null ? null : values.filter((v) => v <= obs).length / values.length,
  };
}

/** Nearest-neighbour distances (self excluded) and the bidirectional coverage shares. */
export function neighbourSummary(D: Float64Array, N: number, nRef: number): NeighbourResult {
  const ref = Array.from({ length: nRef }, (_, i) => i);
  const cmp = Array.from({ length: N - nRef }, (_, i) => nRef + i);
  const nearest = (i: number, pool: readonly number[]) => {
    let best = Infinity;
    for (const j of pool) if (j !== i && D[i * N + j]! < best) best = D[i * N + j]!;
    return best;
  };
  const refToRef = ref.map((i) => nearest(i, ref)).filter(Number.isFinite);
  const cmpToRef = cmp.map((i) => nearest(i, ref)).filter(Number.isFinite);
  const refToCmp = ref.map((i) => nearest(i, cmp)).filter(Number.isFinite);
  const cmpToCmp = cmp.map((i) => nearest(i, cmp)).filter(Number.isFinite);
  const p95rr = quantile(refToRef, 0.95);
  const p95cc = quantile(cmpToCmp, 0.95);
  return {
    refToRef, cmpToRef, refToCmp, cmpToCmp,
    support: {
      supported: p95rr === null || !cmpToRef.length ? null : cmpToRef.filter((d) => d <= p95rr).length / cmpToRef.length,
      represented: p95cc === null || !refToCmp.length ? null : refToCmp.filter((d) => d <= p95cc).length / refToCmp.length,
    },
  };
}

export async function computeDiagnostics(pop: DomainPopulations, opts: SpaceOptions, engineEnergy: number | null): Promise<DomainDiagnostics> {
  const m = await loadMethods();
  const notes: string[] = [];
  const full = (us: readonly Unit[]) => us.map((u) => u.spectrum);
  // Leading label-free PCA space of every development unit (factor comparisons), as the engine.
  let reduced: number[][] | null = null;
  if (!opts.audit && !(opts.energyOnSpectra && opts.monitorOnSpectra)) {
    const n = pop.development.length;
    const p = pop.axis.length;
    const k = Math.min(50, Math.max(0, n - 2), p);
    if (k > 0 && k < p) {
      const pca = m.preflightPca(matrix(full(pop.development)), k);
      const keep = Array.from({ length: pca.scores.cols }, (_, c) => c).filter((c) => !pca.unresolved[c]);
      if (keep.length) reduced = Array.from({ length: n }, (_, i) => keep.map((c) => pca.scores.data[i * pca.scores.cols + c]!));
    }
  }
  const index = new Map(pop.development.map((u, i) => [u, i]));
  const inSpace = (us: readonly Unit[], onSpectra: boolean) => (reduced && !onSpectra ? us.map((u) => reduced![index.get(u)!]!) : full(us));
  const refMon = inSpace(pop.reference, opts.monitorOnSpectra);
  const cmpMon = inSpace(pop.compared, opts.monitorOnSpectra);

  let monitor: MonitorResult | null = null;
  if (refMon.length >= 3 && cmpMon.length >= 1) {
    const [folds, k] = monitorShape(refMon.length, refMon[0]!.length);
    const r = m.statsPcaMonitor(matrix(refMon), matrix(cmpMon), k, folds, 0.05);
    monitor = {
      components: r.effectiveComponents,
      t2Limit: r.t2Limit,
      qLimit: r.qLimit,
      comparedT2: Array.from(r.monitoredT2),
      comparedQ: Array.from(r.monitoredQ),
      referenceT2: Array.from(r.referenceT2),
      referenceQ: Array.from(r.referenceQ),
      nBeyondT2: r.nBeyondT2,
      nBeyondQ: r.nBeyondQ,
      nBeyondEither: r.nBeyondEither,
      folds,
    };
  } else notes.push("Fewer than three reference units: no individual T²/Q.");

  // Overlap plot: PCA fitted on the reference units only (complete spectra), compared units projected.
  let overlap: OverlapResult | null = null;
  const refFull = full(pop.reference);
  if (refFull.length >= 3) {
    const k = Math.min(3, refFull.length - 1, pop.axis.length);
    const pca = m.preflightPca(matrix(refFull), k);
    const p = pop.axis.length;
    const mean = new Array<number>(p).fill(0);
    for (const r of refFull) r.forEach((v, c) => (mean[c]! += v / refFull.length));
    const comps = Array.from({ length: pca.loadings.rows }, (_, a) => a).filter((a) => !pca.unresolved[a]);
    const project = (x: readonly number[]) => comps.map((a) => {
      let s = 0;
      for (let c = 0; c < p; c++) s += (x[c]! - mean[c]!) * pca.loadings.data[a * p + c]!;
      return s;
    });
    const total = pca.fullMoments[0];
    if (comps.length >= 2) overlap = { reference: refFull.map(project), compared: full(pop.compared).map(project), explained: comps.map((a) => (total > 0 ? pca.eigenvalues[a]! / total : null)) };
  }

  // Pairwise distances in the energy input space.
  const refE = inSpace(pop.reference, opts.energyOnSpectra);
  const cmpE = inSpace(pop.compared, opts.energyOnSpectra);
  const N = refE.length + cmpE.length;
  let neighbours: NeighbourResult | null = null;
  let energy: EnergyBenchmark = { status: "unavailable", reason: "No unit to compare.", percentile: null, typical: null, values: [], sizes: null, resamples: 0, seed: ENERGY_SEED, observed: null };
  if (N > MAX_PAIRWISE_UNITS) {
    energy = { ...energy, reason: `${N} units exceed the in-browser pairwise-distance budget (${MAX_PAIRWISE_UNITS}).` };
  } else if (refE.length && cmpE.length) {
    const all = matrix([...refE, ...cmpE]);
    const nn = m.preflightNearestNeighbors(all, all, N);
    const D = new Float64Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) D[i * N + nn.indices[i * N + j]!] = nn.distances[i * N + j]!;
    neighbours = neighbourSummary(D, N, refE.length);
    energy = energyBenchmark(D, N, refE.length, cmpE.length, engineEnergy, (n, b) => m.randomPermutations(ENERGY_SEED, n, b));
  }
  return { space: reduced ? "leading_pca" : "complete_spectra", monitor, overlap, neighbours, energy, notes };
}
