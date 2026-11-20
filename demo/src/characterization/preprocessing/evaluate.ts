// Pure evaluation core of the explorer: applies a pipeline through an injected kernel and
// compares the same spectra and bands before/after with fixed diagnostic parameters.
// The Methods-backed kernel lives in methodsKernel.ts; tests inject fakes or the real kernel.
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

export interface NoiseResult {
  snrDb: (number | null)[];
  sigma: (number | null)[];
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
  transform(step: StepRecipe, X: Matrix, axisStep: number | null): Matrix;
  noise(X: Matrix): NoiseResult | null;
  events(X: Matrix, settings: DiagnosticSettings): EventsResult | null;
  noiseProfile(X: Matrix, settings: DiagnosticSettings): ProfileResult | null;
  repeatability(X: Matrix, groups: readonly number[]): RepeatResult | null;
}

export interface Diagnostics {
  noise: NoiseResult | null;
  events: EventsResult | null;
  profile: ProfileResult | null;
  repeat: RepeatResult | null;
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
    envelope: bandEnvelope(X),
    diversity: bandSd(X),
  };
}

/** Applies the ordered pipeline on a copy; the input matrix is never written. */
export function applyPipeline(kernel: ExplorerKernel, X: Matrix, steps: readonly StepRecipe[], axisStep: number | null): Matrix {
  let current: Matrix = { data: Float64Array.from(X.data), rows: X.rows, cols: X.cols };
  for (const step of steps) {
    const issue = stepIssue({ id: "", ...step }, X.cols);
    if (issue) throw new Error(`${STEP_SPECS[step.kind].label}: ${issue}`);
    const out = kernel.transform(step, current, axisStep);
    if (out.rows !== X.rows || out.cols !== X.cols) throw new Error(`${STEP_SPECS[step.kind].label}: output shape changed`);
    for (let k = 0; k < out.data.length; k++) {
      if (!Number.isFinite(out.data[k]!)) throw new Error(`${STEP_SPECS[step.kind].label}: non-finite output`);
    }
    current = out;
  }
  return current;
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

/** Comparable-family grid: smoothing and denoising only (units and scale preserved). */
export function benchmarkGrid(bands: number): { label: string; steps: StepRecipe[] }[] {
  const out: { label: string; steps: StepRecipe[] }[] = [];
  for (const window of [5, 7, 9, 11, 15, 21, 31]) {
    for (const polyorder of [2, 3]) {
      if (window <= bands && polyorder < window) out.push({ label: `SG smoothing w${window} p${polyorder}`, steps: [{ kind: "savgol", params: { window, polyorder } }] });
    }
  }
  for (const sigma of [0.5, 1, 1.5, 2, 3, 4, 6]) out.push({ label: `Gaussian σ${sigma}`, steps: [{ kind: "gaussian", params: { sigma } }] });
  for (const family of ["db4", "sym4", "haar"]) {
    for (const level of [1, 2, 3, 4]) {
      if (2 ** level <= bands) out.push({ label: `Wavelet ${family} L${level}`, steps: [{ kind: "wavelet", params: { family, level, threshold_mode: "soft" } }] });
    }
  }
  return out;
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
