// Pure derivations for the integrity, SNR and diversity panels. Every per-spectrum or
// per-band estimate is an engine value (`extractIntrinsic`) or an input value; this module
// only counts, ranks, bins and converts them for display. The one interim numerical
// derivation (contrast SNR) is labelled as such and recorded in
// docs/implementation/debt/characterization-integrity.md.
import type { IntrinsicSignal, IntrinsicSignatures, QualificationReportView } from "nirs4all-ui/qualification";
import type { InputSource } from "../../input";
import { dbToLinear, dbToRelativeNoisePercent, finite, quantile, safeRatio, share, snrBand, sortedQuantile } from "../shared/derive";

export type EventType = "spike" | "jump";

/** Default population-relative event threshold of the engine (`intrinsic_qc.outlier_threshold`). */
export const DEFAULT_EVENT_THRESHOLD = 8;

export const eventThreshold = (options: { intrinsic_qc?: Record<string, unknown> } | undefined): number => {
  const v = options?.intrinsic_qc?.outlier_threshold;
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_EVENT_THRESHOLD;
};

const computed = (s: IntrinsicSignal | undefined): s is IntrinsicSignal => s?.state.status === "computed";

// --- events -----------------------------------------------------------------------------------

export interface HistogramBin {
  /** inclusive lower bound */
  lo: number;
  /** exclusive upper bound (inclusive for the last bin) */
  hi: number;
  count: number;
  /** observation ids in this bin (for interactive selection) */
  ids: string[];
}

export interface EventStats {
  type: EventType;
  /** spectra with a non-null count (the denominator) */
  evaluated: number;
  affected: number;
  unaffected: number;
  affectedRatio: number | null;
  unaffectedRatio: number | null;
  /** total flagged positions (engine global count when reported, else the per-spectrum sum) */
  events: number;
  perAffected: number | null;
  maxPerSpectrum: number;
  /** spectra ranked by count, descending (affected only) */
  ranked: { observationId: string; sampleId: string; count: number }[];
  /** number of top spectra holding at least 80% of the events, and its share of affected spectra */
  top80: { spectra: number; ofAffected: number | null } | null;
  /** events per spectrum, one bin per integer count (or wider bins above 30) */
  histogram: HistogramBin[];
}

/** Integer histogram of per-spectrum counts: one bin per count when max ≤ 30, else ~20 equal bins. */
export function countHistogram(entries: readonly { id: string; value: number }[]): HistogramBin[] {
  if (!entries.length) return [];
  const max = Math.max(...entries.map((e) => e.value));
  const width = max <= 30 ? 1 : Math.ceil((max + 1) / 20);
  const bins: HistogramBin[] = [];
  for (let lo = 0; lo <= max; lo += width) bins.push({ lo, hi: lo + width, count: 0, ids: [] });
  for (const e of entries) {
    const bin = bins[Math.min(bins.length - 1, Math.floor(e.value / width))]!;
    bin.count += 1;
    bin.ids.push(e.id);
  }
  return bins;
}

export function eventStats(intrinsic: IntrinsicSignatures, type: EventType): EventStats | null {
  const signal = intrinsic.signals[`events.${type}_count`];
  if (!computed(signal)) return null;
  const entries = signal.values.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [{ id: signal.observationIds[i] ?? String(i), sampleId: signal.sampleIds[i] ?? "", value: v }]));
  const evaluated = entries.length;
  const ranked = entries.filter((e) => e.value > 0).sort((a, b) => b.value - a.value).map((e) => ({ observationId: e.id, sampleId: e.sampleId, count: e.value }));
  const affected = ranked.length;
  const sum = ranked.reduce((acc, r) => acc + r.count, 0);
  const global = intrinsic.globals[`events.global_${type}_count`];
  const events = typeof global === "number" && Number.isFinite(global) ? global : sum;
  let top80: EventStats["top80"] = null;
  if (sum > 0) {
    let acc = 0;
    let k = 0;
    while (k < ranked.length && acc < 0.8 * sum) acc += ranked[k++]!.count;
    top80 = { spectra: k, ofAffected: share(k, affected).ratio };
  }
  return {
    type,
    evaluated,
    affected,
    unaffected: evaluated - affected,
    affectedRatio: share(affected, evaluated).ratio,
    unaffectedRatio: share(evaluated - affected, evaluated).ratio,
    events,
    perAffected: affected > 0 ? sum / affected : null,
    maxPerSpectrum: ranked[0]?.count ?? 0,
    ranked,
    top80,
    histogram: countHistogram(entries),
  };
}

/** Spectra flagged by both event types (and by either), matched on observation ids, never by adding rates. */
export function eventOverlap(spikes: EventStats | null, jumps: EventStats | null) {
  if (!spikes || !jumps) return null;
  const a = new Set(spikes.ranked.map((r) => r.observationId));
  const b = new Set(jumps.ranked.map((r) => r.observationId));
  const both = [...a].filter((id) => b.has(id)).length;
  const either = new Set([...a, ...b]).size;
  // Same engine population for both counts: the denominator is the larger evaluated set.
  const total = Math.max(spikes.evaluated, jumps.evaluated);
  return { both, either, total, bothRatio: share(both, total).ratio, eitherRatio: share(either, total).ratio };
}

export interface BandCounts {
  axis: number[];
  counts: number[];
  /** spectra evaluated at each band (null when the engine did not report it) */
  evaluated: (number | null)[];
}

export function readBandCounts(view: QualificationReportView, sourceId: string, type: EventType): BandCounts | null {
  const metric = view.metrics.find((m) => m.sourceId === sourceId && m.id === `intrinsic.events.global_${type}_band_counts` && m.status === "computed");
  const value = metric?.value as { axis?: unknown; counts?: unknown; evaluated?: unknown } | undefined;
  if (!value || !Array.isArray(value.axis) || !Array.isArray(value.counts) || value.axis.length !== value.counts.length) return null;
  const evaluated = Array.isArray(value.evaluated) && value.evaluated.length === value.axis.length ? value.evaluated.map((v) => (typeof v === "number" ? v : null)) : value.axis.map(() => null);
  return { axis: value.axis as number[], counts: value.counts as number[], evaluated };
}

export interface EventRegion {
  start: number;
  end: number;
  /** band indices [startIndex, endIndex] inclusive */
  startIndex: number;
  endIndex: number;
  /** share of all band-level flags inside the region */
  share: number;
  /** share of the bands covered by the region */
  width: number;
}

/**
 * Contiguous runs of bands with at least one flag (gaps of ≤ 2 bands merged, since a spike
 * also counts on its two neighbour bands). Sorted by flag share, descending.
 */
export function eventRegions(bands: BandCounts): EventRegion[] {
  const total = bands.counts.reduce((a, c) => a + (c > 0 ? c : 0), 0);
  if (total <= 0) return [];
  const runs: [number, number][] = [];
  bands.counts.forEach((c, i) => {
    if (!(c > 0)) return;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= 3) last[1] = i;
    else runs.push([i, i]);
  });
  const n = bands.counts.length;
  return runs
    .map(([s, e]) => ({
      startIndex: s,
      endIndex: e,
      start: bands.axis[s]!,
      end: bands.axis[e]!,
      share: bands.counts.slice(s, e + 1).reduce((a, c) => a + (c > 0 ? c : 0), 0) / total,
      width: (e - s + 1) / n,
    }))
    .sort((a, b) => b.share - a.share);
}

/** Spectral pattern of the band-level flags; only `regional`/`spread` are demonstrated claims. */
export function eventPattern(bands: BandCounts | null): { kind: "regional"; region: EventRegion } | { kind: "spread"; coverage: number } | { kind: "none" } | { kind: "mixed" } {
  if (!bands) return { kind: "none" };
  const total = bands.counts.reduce((a, c) => a + (c > 0 ? c : 0), 0);
  if (total === 0) return { kind: "none" };
  const top = eventRegions(bands)[0]!;
  // At least 6 band-level flags so that a single isolated spike (3 bands) cannot make a "region".
  if (total >= 6 && top.share >= 0.5 && top.width <= 0.1) return { kind: "regional", region: top };
  const coverage = bands.counts.filter((c) => c > 0).length / bands.counts.length;
  if (coverage >= 0.25) return { kind: "spread", coverage };
  return { kind: "mixed" };
}

// --- SNR --------------------------------------------------------------------------------------

export interface SnrStats {
  n: number;
  medianDb: number;
  linear: number;
  relativeNoisePercent: number;
  band: string;
  p: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** lowest-SNR spectra first */
  noisiest: { observationId: string; sampleId: string; db: number }[];
  entries: { id: string; value: number }[];
}

export function snrStats(intrinsic: IntrinsicSignatures): SnrStats | null {
  const signal = intrinsic.signals["noise.signal_noise_db"];
  if (!computed(signal)) return null;
  const entries = signal.values.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [{ id: signal.observationIds[i] ?? String(i), sampleId: signal.sampleIds[i] ?? "", value: v }]));
  if (!entries.length) return null;
  const values = entries.map((e) => e.value);
  const q = (p: number) => quantile(values, p)!;
  const medianDb = signal.median ?? q(0.5);
  return {
    n: entries.length,
    medianDb,
    linear: dbToLinear(medianDb),
    relativeNoisePercent: dbToRelativeNoisePercent(medianDb),
    band: snrBand(medianDb),
    p: { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) },
    noisiest: [...entries].sort((a, b) => a.value - b.value).slice(0, 10).map((e) => ({ observationId: e.id, sampleId: e.sampleId, db: e.value })),
    entries: entries.map((e) => ({ id: e.id, value: e.value })),
  };
}

/** Equal-width histogram of finite values with the observation ids per bin. */
export function valueHistogram(entries: readonly { id: string; value: number }[], bins = 24): HistogramBin[] {
  const xs = entries.filter((e) => Number.isFinite(e.value));
  if (!xs.length) return [];
  const lo = Math.min(...xs.map((e) => e.value));
  const hi = Math.max(...xs.map((e) => e.value));
  // Constant (or numerically constant) values: one bin, never a range of float noise.
  if (hi - lo <= 1e-9 * Math.max(Math.abs(lo), Math.abs(hi))) return [{ lo, hi: lo, count: xs.length, ids: xs.map((e) => e.id) }];
  const k = Math.max(1, Math.min(bins, xs.length));
  const w = (hi - lo) / k;
  const out: HistogramBin[] = Array.from({ length: k }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, count: 0, ids: [] }));
  for (const e of xs) {
    const b = out[Math.min(k - 1, Math.floor((e.value - lo) / w))]!;
    b.count += 1;
    b.ids.push(e.id);
  }
  return out;
}

/**
 * INTERIM contrast SNR (dB) per spectrum: 20·log10([Q95(x) − Q5(x)] / σ), σ = the engine
 * `noise.noise_sigma` of that spectrum, quantiles over its finite valid cells. Less sensitive to a
 * constant offset than mean|x|/σ. Null when σ ≤ 0, the row is missing or its range is zero.
 */
export function contrastSnr(intrinsic: IntrinsicSignatures, source: InputSource): { id: string; value: number }[] | null {
  const sigma = intrinsic.signals["noise.noise_sigma"];
  if (!computed(sigma)) return null;
  const rowOf = new Map(source.observation_ids.map((id, i) => [id, i]));
  return sigma.values.flatMap((s, i) => {
    const id = sigma.observationIds[i] ?? "";
    const row = rowOf.get(id);
    if (row === undefined || s === null || !(s > 0)) return [];
    const x = source.x[row] ?? [];
    const mask = source.valid_mask?.[row];
    // One numeric (typed-array) sort per spectrum for both quantiles: this runs over every spectrum.
    const cells = Float64Array.from(x.filter((v, j): v is number => v !== null && Number.isFinite(v) && (mask ? mask[j] !== false : true))).sort();
    const q5 = sortedQuantile(cells, 0.05);
    const q95 = sortedQuantile(cells, 0.95);
    if (q5 === null || q95 === null) return [];
    const r = safeRatio(q95 - q5, s);
    return r !== null && r > 0 ? [{ id, value: 20 * Math.log10(r) }] : [];
  });
}

// --- diversity --------------------------------------------------------------------------------

export interface DiversityStats {
  n: number;
  median: number;
  p95: number;
  max: number;
  maxId: string;
  /** median over spectra of `noise.signal_mean_abs` (null when not computed) */
  typicalLevel: number | null;
  relativeMedian: number | null;
  relativeP95: number | null;
  relativeMax: number | null;
  entries: { id: string; sampleId: string; value: number }[];
}

export function diversityStats(intrinsic: IntrinsicSignatures): DiversityStats | null {
  const signal = intrinsic.signals["reference.rms"];
  if (!computed(signal)) return null;
  const entries = signal.values.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [{ id: signal.observationIds[i] ?? String(i), sampleId: signal.sampleIds[i] ?? "", value: v }]));
  if (!entries.length) return null;
  const values = entries.map((e) => e.value);
  const top = entries.reduce((a, b) => (b.value > a.value ? b : a));
  const level = intrinsic.signals["noise.signal_mean_abs"];
  const typicalLevel = computed(level) ? (level.median ?? quantile(level.values, 0.5)) : null;
  const median = signal.median ?? quantile(values, 0.5)!;
  const p95 = signal.p95 ?? quantile(values, 0.95)!;
  // N/A when the typical level is zero or negligible against the distance itself.
  const rel = (v: number) => (typicalLevel === null ? null : safeRatio(v, typicalLevel, 1e-9));
  return { n: entries.length, median, p95, max: top.value, maxId: top.id, typicalLevel, relativeMedian: rel(median), relativeP95: rel(p95), relativeMax: rel(top.value), entries };
}

/** Rows of `source` for the given observation ids, in id order (missing ids skipped). */
export function rowsFor(source: InputSource, ids: readonly string[]): { id: string; row: number }[] {
  const rowOf = new Map(source.observation_ids.map((id, i) => [id, i]));
  return ids.flatMap((id) => {
    const row = rowOf.get(id);
    return row === undefined ? [] : [{ id, row }];
  });
}

/**
 * Display aggregates over the given rows, band by band (finite valid cells only): column mean
 * and robust P5/P95 envelope. Presentation order statistics; the input is never modified.
 */
export function bandEnvelope(source: InputSource, rows: readonly number[]): { mean: (number | null)[]; p5: (number | null)[]; p95: (number | null)[] } {
  const bands = source.axis.length;
  const mean: (number | null)[] = [];
  const p5: (number | null)[] = [];
  const p95: (number | null)[] = [];
  const buf = new Float64Array(rows.length);
  for (let j = 0; j < bands; j++) {
    let k = 0;
    let sum = 0;
    for (const r of rows) {
      const v = source.x[r]?.[j];
      if (v !== null && v !== undefined && Number.isFinite(v) && source.valid_mask?.[r]?.[j] !== false) {
        buf[k++] = v;
        sum += v;
      }
    }
    if (!k) {
      mean.push(null);
      p5.push(null);
      p95.push(null);
      continue;
    }
    // One numeric sort per band for both quantiles (thousands of spectra × thousands of bands).
    const col = buf.subarray(0, k).sort();
    mean.push(sum / k);
    p5.push(sortedQuantile(col, 0.05));
    p95.push(sortedQuantile(col, 0.95));
  }
  return { mean, p5, p95 };
}

/** Complete rows (every band finite and valid) among `rows`, packed row-major for a Methods kernel. */
export function completeMatrix(source: InputSource, rows: readonly { id: string; row: number }[]): { ids: string[]; rows: number; cols: number; data: Float64Array } {
  const cols = source.axis.length;
  const keep = rows.filter(({ row }) => {
    const x = source.x[row];
    return !!x && x.length === cols && x.every((v, j) => v !== null && Number.isFinite(v) && source.valid_mask?.[row]?.[j] !== false);
  });
  const data = new Float64Array(keep.length * cols);
  keep.forEach(({ row }, i) => data.set(source.x[row] as number[], i * cols));
  return { ids: keep.map((k) => k.id), rows: keep.length, cols, data };
}

/** How many of the k largest `a` values (by id) are also among the k largest `b` values (ranks only). */
export function topKOverlap(ids: readonly string[], a: readonly (number | null)[], b: readonly (number | null)[], k = 10): { kept: number; k: number } | null {
  const both = ids.flatMap((id, i) => (a[i] !== null && a[i] !== undefined && b[i] !== null && b[i] !== undefined ? [{ id, a: a[i]!, b: b[i]! }] : []));
  const kk = Math.min(k, Math.floor(both.length / 2));
  if (kk < 1) return null;
  const top = (key: "a" | "b") => new Set([...both].sort((p, q) => q[key] - p[key]).slice(0, kk).map((p) => p.id));
  const ta = top("a");
  const tb = top("b");
  return { kept: [...ta].filter((id) => tb.has(id)).length, k: kk };
}

export { finite };

// --- illustrative noise scale (chat §5: "what does N dB look like?") ----------------------------

/** Deterministic standard normal draws (Box–Muller over a fixed LCG), so the illustration is stable. */
export function gaussianSequence(n: number, seed = 12345): Float64Array {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(next()));
    const t = 2 * Math.PI * next();
    out[i] = r * Math.cos(t);
    if (i + 1 < n) out[i + 1] = r * Math.sin(t);
  }
  return out;
}

/**
 * ILLUSTRATION ONLY: `values` plus Gaussian noise whose σ = mean|x| × 10^(−dB/20), i.e. the noise
 * that the dataset SNR definition (20·log10(mean|x|/σ)) maps to `db`. Missing values stay missing;
 * the input is not modified. Returns null when the spectrum has no finite non-zero level.
 */
export function addIllustrativeNoise(values: readonly (number | null)[], db: number, draws: Float64Array): { values: (number | null)[]; sigma: number } | null {
  let sum = 0;
  let n = 0;
  for (const v of values) if (v !== null && Number.isFinite(v)) { sum += Math.abs(v); n++; }
  if (!n || !(sum > 0) || !Number.isFinite(db)) return null;
  const sigma = (sum / n) * 10 ** (-db / 20);
  return { sigma, values: values.map((v, i) => (v === null || !Number.isFinite(v) ? null : v + sigma * (draws[i % draws.length] ?? 0))) };
}

/** The evaluated spectrum whose SNR is closest to the median (a typical spectrum for illustrations). */
export function medianSnrSpectrum(stats: SnrStats): string | null {
  let best: { id: string; d: number } | null = null;
  for (const e of stats.entries) {
    const d = Math.abs(e.value - stats.medianDb);
    if (!best || d < best.d) best = { id: e.id, d };
  }
  return best?.id ?? null;
}
