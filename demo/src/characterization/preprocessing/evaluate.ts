// Pure evaluation core of the explorer: applies a pipeline through an injected kernel and
// compares the same spectra and bands before/after with fixed diagnostic parameters.
// The Methods-backed kernel lives in methodsKernel.ts; tests inject fakes or the real kernel.
import { localTransform } from "./localSteps";
import { STEP_SPECS, pipelineComparability, pipelinePreservesUnits, stepIssue, type Comparability, type StepRecipe } from "./catalog";
import type { DiagnosticSettings } from "./data";
import {
  bandEnvelope,
  bandSd,
  distortionProfile,
  diversityRetentionPercent,
  fineScaleReductionPercent,
  medianOf,
  relativeRmsePercent,
  residual,
  snrGainDb,
  spectralAngleDeg,
  type Matrix,
} from "./metrics";

export type { Matrix } from "./metrics";

export interface NoiseResult {
  snrDb: (number | null)[];
  sigma: (number | null)[];
  /** Per-spectrum mean |x| (the SNR numerator), signal unit. */
  meanAbs: (number | null)[];
}
export interface EventsResult {
  spikes: (number | null)[];
  jumps: (number | null)[];
  spikeBands: number[];
  jumpBands: number[];
}
export interface ProfileResult {
  band: (number | null)[];
  pooled: number | null;
}
export interface RepeatResult {
  sd: (number | null)[];
  icc: (number | null)[];
}

/** Owner kernels (Methods). Each diagnostic may be unavailable (null) without failing the run. */
export interface ExplorerKernel {
  /** Fits the step on `X` and transforms `X`. */
  transform(step: StepRecipe, X: Matrix, axisStep: number | null): Matrix;
  /** Fits the step on `fit` only, then transforms `fit` and each matrix of `apply` (returned in that order). */
  fitTransform?(step: StepRecipe, fit: Matrix, apply: readonly Matrix[], axisStep: number | null): Matrix[];
  noise(X: Matrix): NoiseResult | null;
  events(X: Matrix, settings: DiagnosticSettings): EventsResult | null;
  noiseProfile(X: Matrix, settings: DiagnosticSettings): ProfileResult | null;
  repeatability(X: Matrix, groups: readonly number[]): RepeatResult | null;
  /** Per-spectrum RMS distance to the mean spectrum of `X` (engine `reference.rms` procedure). */
  reference(X: Matrix): (number | null)[] | null;
}

export interface Diagnostics {
  noise: NoiseResult | null;
  events: EventsResult | null;
  profile: ProfileResult | null;
  repeat: RepeatResult | null;
  /** Per-spectrum RMS distance to the subset mean spectrum. */
  reference: (number | null)[] | null;
  envelope: { median: number[]; p5: number[]; p95: number[] };
  diversity: (number | null)[];
}

export interface EvaluationInput {
  matrix: Matrix;
  step: number | null;
  groups: number[];
  replicatedSamples: number;
  settings: DiagnosticSettings;
}

export function diagnose(kernel: ExplorerKernel, input: EvaluationInput, X: Matrix): Diagnostics {
  const safe = <T>(f: () => T | null): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  return {
    noise: safe(() => kernel.noise(X)),
    events: safe(() => kernel.events(X, input.settings)),
    profile: safe(() => kernel.noiseProfile(X, input.settings)),
    repeat: input.replicatedSamples >= 2 ? safe(() => kernel.repeatability(X, input.groups)) : null,
    reference: safe(() => kernel.reference(X)),
    envelope: bandEnvelope(X),
    diversity: bandSd(X),
  };
}

const checkOutput = (step: StepRecipe, out: Matrix, like: Matrix): Matrix => {
  if (out.rows !== like.rows || out.cols !== like.cols) throw new Error(`${STEP_SPECS[step.kind].label}: output shape changed`);
  for (let k = 0; k < out.data.length; k++) {
    if (!Number.isFinite(out.data[k]!)) throw new Error(`${STEP_SPECS[step.kind].label}: non-finite output`);
  }
  return out;
};
const checkStep = (step: StepRecipe, cols: number) => {
  const issue = stepIssue({ id: "", ...step }, cols);
  if (issue) throw new Error(`${STEP_SPECS[step.kind].label}: ${issue}`);
};

/** Applies the ordered pipeline on a copy; the input matrix is never written. Learned steps fit on `X` itself. */
export function applyPipeline(kernel: ExplorerKernel, X: Matrix, steps: readonly StepRecipe[], axisStep: number | null): Matrix {
  let current: Matrix = { data: Float64Array.from(X.data), rows: X.rows, cols: X.cols };
  for (const step of steps) {
    checkStep(step, X.cols);
    current = checkOutput(step, localTransform(step, current) ?? kernel.transform(step, current, axisStep), X);
  }
  return current;
}

/**
 * Applies the ordered pipeline with every learned parameter fitted on `fit` only: each step is fitted on
 * the fit rows as transformed by the previous steps (MSC reference = their mean), then applied to the fit
 * rows and to every matrix of `apply`. Per-spectrum steps learn nothing. Inputs are never written.
 */
export function applyPipelineFitted(kernel: ExplorerKernel, steps: readonly StepRecipe[], fit: Matrix, apply: readonly Matrix[], axisStep: number | null): { fit: Matrix; apply: Matrix[] } {
  let f: Matrix = { data: Float64Array.from(fit.data), rows: fit.rows, cols: fit.cols };
  let a: Matrix[] = apply.map((m) => {
    if (m.cols !== fit.cols) throw new Error("applyPipelineFitted: band count differs between fit and apply rows.");
    return { data: Float64Array.from(m.data), rows: m.rows, cols: m.cols };
  });
  for (const step of steps) {
    checkStep(step, fit.cols);
    let outs: Matrix[];
    const local = localTransform(step, f);
    if (local) outs = [local, ...a.map((m) => localTransform(step, m)!)];
    else if (kernel.fitTransform) outs = kernel.fitTransform(step, f, a, axisStep);
    else if (!STEP_SPECS[step.kind].learned) outs = [kernel.transform(step, f, axisStep), ...a.map((m) => kernel.transform(step, m, axisStep))];
    else throw new Error(`${STEP_SPECS[step.kind].label}: this kernel cannot fit on reference rows.`);
    f = checkOutput(step, outs[0]!, f);
    a = a.map((m, k) => checkOutput(step, outs[k + 1]!, m));
  }
  return { fit: f, apply: a };
}

/** Row subset of a matrix (copy, order kept). */
export function takeRows(X: Matrix, rows: readonly number[]): Matrix {
  const data = new Float64Array(rows.length * X.cols);
  rows.forEach((r, i) => {
    if (!(r >= 0 && r < X.rows)) throw new Error(`Row ${r} out of range.`);
    data.set(X.data.subarray(r * X.cols, (r + 1) * X.cols), i * X.cols);
  });
  return { data, rows: rows.length, cols: X.cols };
}

/** applyPipelineFitted on row indices of one matrix: fit on X[fitRows], apply to X[applyRows]. */
export function applyPipelineFittedRows(kernel: ExplorerKernel, steps: readonly StepRecipe[], X: Matrix, fitRows: readonly number[], applyRows: readonly number[], axisStep: number | null): { fit: Matrix; apply: Matrix } {
  const r = applyPipelineFitted(kernel, steps, takeRows(X, fitRows), [takeRows(X, applyRows)], axisStep);
  return { fit: r.fit, apply: r.apply[0]! };
}

/** One metric with its denominator, or the reason it is withheld. */
export interface MetricValue {
  value: number | null;
  n: number;
  disabled: string | null;
}

const NOT_SAME_SPACE = "Not meaningful in the new spectral space (derivative or unit change).";
const UNITS_CHANGED = "Signal unit or scale changed: raw − processed is not defined on one scale.";

export interface ComparisonMetrics {
  snrGainDb: MetricValue;
  fineScaleReduction: MetricValue;
  relativeRmse: MetricValue;
  spectralAngle: MetricValue;
  diversityRetention: MetricValue;
}

export function comparisonMetrics(raw: Matrix, proc: Matrix, before: Diagnostics, after: Diagnostics, comparability: Comparability, preservesUnits: boolean): ComparisonMetrics {
  const off = (reason: string): MetricValue => ({ value: null, n: 0, disabled: reason });
  const on = (r: { value: number | null; n: number }): MetricValue => ({ ...r, disabled: null });
  const perSpectrum = (xs: (number | null)[]) => {
    const f = xs.filter((v): v is number => v !== null);
    return { value: medianOf(f), n: f.length };
  };
  const noiseOk = before.noise && after.noise;
  return {
    snrGainDb: comparability === "not_comparable" ? off(NOT_SAME_SPACE) : noiseOk ? on(snrGainDb(before.noise!.snrDb, after.noise!.snrDb)) : off("Noise kernel unavailable."),
    // σ carries the signal unit: a σ ratio across a rescaling (SNV) measures the scale factor, not smoothing.
    fineScaleReduction: comparability === "not_comparable" ? off(NOT_SAME_SPACE) : !preservesUnits ? off(UNITS_CHANGED) : noiseOk ? on(fineScaleReductionPercent(before.noise!.sigma, after.noise!.sigma)) : off("Noise kernel unavailable."),
    relativeRmse: preservesUnits ? on(perSpectrum(relativeRmsePercent(raw, proc))) : off(UNITS_CHANGED),
    spectralAngle: comparability === "not_comparable" ? off(NOT_SAME_SPACE) : on(perSpectrum(spectralAngleDeg(raw, proc))),
    diversityRetention: preservesUnits ? on(diversityRetentionPercent(before.diversity, after.diversity)) : off(UNITS_CHANGED),
  };
}

export interface Evaluation {
  comparability: Comparability;
  preservesUnits: boolean;
  processed: Matrix;
  after: Diagnostics;
  metrics: ComparisonMetrics;
  /** Per-band raw − processed median and P5–P95 (units preserved only). */
  residual: { median: number[]; p5: number[]; p95: number[] } | null;
  distortion: (number | null)[] | null;
}

export function evaluatePipeline(kernel: ExplorerKernel, input: EvaluationInput, before: Diagnostics, steps: readonly StepRecipe[]): Evaluation {
  const processed = applyPipeline(kernel, input.matrix, steps, input.step);
  const after = steps.length ? diagnose(kernel, input, processed) : before;
  const comparability = pipelineComparability(steps.map((s) => ({ id: "", ...s })));
  const preservesUnits = pipelinePreservesUnits(steps.map((s) => ({ id: "", ...s })));
  return {
    comparability,
    preservesUnits,
    processed,
    after,
    metrics: comparisonMetrics(input.matrix, processed, before, after, comparability, preservesUnits),
    residual: preservesUnits ? bandEnvelope(residual(input.matrix, processed)) : null,
    distortion: preservesUnits ? distortionProfile(input.matrix, processed) : null,
  };
}

export interface BenchmarkPoint {
  key: string;
  label: string;
  steps: StepRecipe[];
  /** Median per-spectrum relative RMSE (%), the distortion axis. */
  distortion: number | null;
  /** Fine-scale variation reduction (%). */
  reduction: number | null;
  snrGainDb: number | null;
  error: string | null;
}

/** Savitzky–Golay windows of the benchmark trajectory (polyorder 2), as in the request mockup. */
export const SG_SWEEP_WINDOWS = [5, 7, 9, 11, 15, 21, 31, 51] as const;
export const SG_SWEEP_POLYORDER = 2;

/** Comparable-family grid: smoothing and denoising only (units and scale preserved). */
export function benchmarkGrid(bands: number): { label: string; steps: StepRecipe[] }[] {
  const out: { label: string; steps: StepRecipe[] }[] = [];
  for (const window of SG_SWEEP_WINDOWS) {
    if (window <= bands) out.push({ label: `SG ${window}`, steps: [{ kind: "savgol", params: { window, polyorder: SG_SWEEP_POLYORDER } }] });
  }
  for (const window of [7, 11, 15, 21, 31]) {
    if (window <= bands) out.push({ label: `SG ${window} (order 3)`, steps: [{ kind: "savgol", params: { window, polyorder: 3 } }] });
  }
  for (const sigma of [0.5, 1, 1.5, 2, 3, 4, 6]) out.push({ label: `Gaussian σ ${sigma}`, steps: [{ kind: "gaussian", params: { sigma } }] });
  for (const window of [3, 5, 7, 9, 11, 15, 21]) {
    if (window <= bands) out.push({ label: `Median ${window}`, steps: [{ kind: "median", params: { window } }] });
  }
  for (const threshold of [3.5, 5, 6, 8, 12]) out.push({ label: `Despike z ${threshold}`, steps: [{ kind: "despike", params: { threshold, half_window: 3 } }] });
  for (const family of ["db4", "sym4", "haar"]) {
    for (const level of [1, 2, 3, 4]) {
      if (2 ** level <= bands) out.push({ label: `Wavelet ${family} L${level}`, steps: [{ kind: "wavelet", params: { family, level, threshold_mode: "soft" } }] });
    }
  }
  return out;
}

/** Parameter sweep a single-step configuration belongs to (one trajectory per sweep), or null. */
export interface Sweep {
  key: string;
  label: string;
  /** Position along the sweep (window, sigma or level). */
  order: number;
  /** Short point label, e.g. "SG 11". */
  short: string;
}

export function sweepOf(steps: readonly StepRecipe[]): Sweep | null {
  if (steps.length !== 1) return null;
  const { kind, params: p } = steps[0]!;
  if (kind === "savgol") {
    const k = Number(p.polyorder);
    return { key: `savgol:${k}`, label: `Savitzky–Golay, order ${k} (window)`, order: Number(p.window), short: k === SG_SWEEP_POLYORDER ? `SG ${p.window}` : `SG ${p.window} o${k}` };
  }
  if (kind === "median") return { key: "median", label: "Median filter (window)", order: Number(p.window), short: `Median ${p.window}` };
  if (kind === "despike") return { key: `despike:${p.half_window}`, label: `Despiking, half-window ${p.half_window} (threshold)`, order: -Number(p.threshold), short: `z ${p.threshold}` };
  if (kind === "gaussian") return { key: "gaussian", label: "Gaussian (sigma)", order: Number(p.sigma), short: `σ ${p.sigma}` };
  if (kind === "wavelet") return { key: `wavelet:${p.family}:${p.threshold_mode}`, label: `Wavelet ${p.family}, ${p.threshold_mode} (level)`, order: Number(p.level), short: `${p.family} L${p.level}` };
  return null;
}

/** Sweeps present among the evaluated points, in first-appearance order. */
export function sweeps(points: readonly BenchmarkPoint[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const p of points) {
    const s = sweepOf(p.steps);
    if (s && !seen.has(s.key)) seen.set(s.key, s.label);
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

/**
 * Indices of the evaluated points of one sweep, ordered by its parameter: the dashed trajectory of the
 * trade-off chart (drawn from the raw origin, distortion 0 and reduction 0 by definition).
 */
export function sweepTrajectory(points: readonly BenchmarkPoint[], key = `savgol:${SG_SWEEP_POLYORDER}`): number[] {
  return points
    .map((p, i) => ({ p, i, s: sweepOf(p.steps) }))
    .filter(({ p, s }) => s?.key === key && p.distortion !== null && p.reduction !== null)
    .sort((a, b) => a.s!.order - b.s!.order)
    .map(({ i }) => i);
}

export const recipeKey = (steps: readonly StepRecipe[]) => JSON.stringify(steps.map((s) => [s.kind, Object.entries(s.params).sort()]));

/** Lightweight benchmark evaluation: transform + noise kernel only. */
export function benchmarkPoint(kernel: ExplorerKernel, input: EvaluationInput, before: Diagnostics, config: { label: string; steps: StepRecipe[] }): BenchmarkPoint {
  const base = { key: recipeKey(config.steps), label: config.label, steps: config.steps };
  try {
    const proc = applyPipeline(kernel, input.matrix, config.steps, input.step);
    const noise = kernel.noise(proc);
    const rmse = relativeRmsePercent(input.matrix, proc).filter((v): v is number => v !== null);
    return {
      ...base,
      distortion: medianOf(rmse),
      reduction: before.noise && noise ? fineScaleReductionPercent(before.noise.sigma, noise.sigma).value : null,
      snrGainDb: before.noise && noise ? snrGainDb(before.noise.snrDb, noise.snrDb).value : null,
      error: null,
    };
  } catch (e) {
    return { ...base, distortion: null, reduction: null, snrGainDb: null, error: e instanceof Error ? e.message : String(e) };
  }
}
