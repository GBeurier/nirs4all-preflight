// `@nirs4all/methods` 1.5 implementation of the explorer kernel. Marshalling only: every
// transform and diagnostic is a native Methods method. The diagnostics are the same procedures the
// Preflight engine calls for the intrinsic `noise` and `events` families and the measurement noise
// proxy / repeatability, run with fixed parameters on the explorer subset.
import {
  Detrend,
  Gaussian,
  MSC,
  SNV,
  SavitzkyGolay,
  SpectralNoiseProxy,
  SpectralPopulationEventsQc,
  SpectralReferenceQc,
  WaveletDenoise,
  loadModule,
  preflightNoiseProxy,
  preflightRepeatability,
  type Matrix as MethodsMatrix,
} from "@nirs4all/methods";
import type { StepRecipe } from "./catalog";
import type { DiagnosticSettings } from "./data";
import type { EventsResult, ExplorerKernel, NoiseResult } from "./evaluate";
import type { Matrix } from "./metrics";

type Output = Record<string, MethodsMatrix | number[] | number>;
type Transformer = { fit(X: MethodsMatrix): unknown; transform(X: MethodsMatrix): MethodsMatrix; dispose(): void };

function transformer(step: StepRecipe, axisStep: number | null): Transformer {
  const p = step.params;
  // Signed axis step: the derivative is per axis unit, in the axis direction.
  const delta = axisStep !== null && Number.isFinite(axisStep) && axisStep !== 0 ? axisStep : 1;
  switch (step.kind) {
    case "savgol":
      return new SavitzkyGolay({ window_length: Number(p.window), polyorder: Number(p.polyorder), deriv: 0 });
    case "sg_d1":
      return new SavitzkyGolay({ window_length: Number(p.window), polyorder: Number(p.polyorder), deriv: 1, delta });
    case "sg_d2":
      return new SavitzkyGolay({ window_length: Number(p.window), polyorder: Number(p.polyorder), deriv: 2, delta });
    case "gaussian":
      return new Gaussian({ sigma: Number(p.sigma) });
    case "wavelet":
      return new WaveletDenoise({
        family: String(p.family) as "db4",
        level: Number(p.level),
        threshold_mode: String(p.threshold_mode) as "soft",
      });
    case "snv":
      return new SNV();
    case "msc":
      return new MSC();
    case "detrend":
      return new Detrend({ polyorder: Number(p.polyorder) });
  }
}

/** Per-row values of one per-spectrum signal of a Methods intrinsic procedure (null when not evaluable). */
function perRow(out: Output, signal: string, n: number): (number | null)[] {
  const values: (number | null)[] = new Array<number | null>(n).fill(null);
  const rows = out[`${signal}_rows`];
  const data = out[`${signal}_values`];
  if (!Array.isArray(rows) || !data || typeof data === "number" || Array.isArray(data)) return values;
  rows.forEach((r, k) => {
    const v = data.data[k];
    if (r >= 0 && r < n && v !== undefined && Number.isFinite(v)) values[r] = v;
  });
  return values;
}

const ints = (out: Output, key: string): number[] => (Array.isArray(out[key]) ? (out[key] as number[]) : []);

export function methodsKernel(): ExplorerKernel {
  return {
    transform(step, X, axisStep) {
      const t = transformer(step, axisStep);
      try {
        t.fit(X);
        const out = t.transform(X);
        return { data: Float64Array.from(out.data), rows: out.rows, cols: out.cols };
      } finally {
        t.dispose();
      }
    },
    noise(X): NoiseResult {
      const out = new SpectralNoiseProxy({}).run(X) as Output;
      return { snrDb: perRow(out, "signal_noise_db", X.rows), sigma: perRow(out, "noise_sigma", X.rows), meanAbs: perRow(out, "signal_mean_abs", X.rows) };
    },
    events(X: Matrix, s: DiagnosticSettings): EventsResult {
      const out = new SpectralPopulationEventsQc({ outlier_threshold: s.eventThreshold, min_spectra: s.eventMinSpectra, axis_basis: "index" }).run(X) as Output;
      return {
        spikes: perRow(out, "spike_count", X.rows),
        jumps: perRow(out, "jump_count", X.rows),
        spikeBands: ints(out, "spike_band_counts"),
        jumpBands: ints(out, "jump_band_counts"),
      };
    },
    noiseProfile(X, s) {
      if (s.noiseWindow > X.cols) return null;
      const r = preflightNoiseProxy(X, s.noiseWindow, s.noisePolyorder);
      return { band: Array.from(r.bandNoise, (v) => (Number.isFinite(v) ? v : null)), pooled: Number.isFinite(r.pooled) ? r.pooled : null };
    },
    reference(X) {
      return perRow(new SpectralReferenceQc({ reference_mode: "dataset_mean" }).run(X) as Output, "rms", X.rows);
    },
    repeatability(X, groups) {
      // Replicated samples only; band status 0 computed, 1 insufficient, 2 unbalanced (pooled SD
      // kept, balanced ICC withheld), 3 zero total variance.
      const size = new Map<number, number>();
      for (const g of groups) size.set(g, (size.get(g) ?? 0) + 1);
      const keep = groups.map((g, i) => ((size.get(g) ?? 0) >= 2 ? i : -1)).filter((i) => i >= 0);
      if (keep.length < 4) return null;
      const data = new Float64Array(keep.length * X.cols);
      keep.forEach((r, i) => data.set(X.data.subarray(r * X.cols, (r + 1) * X.cols), i * X.cols));
      const r = preflightRepeatability({ data, rows: keep.length, cols: X.cols }, keep.map((i) => groups[i]!));
      return {
        sd: Array.from(r.pooledSd, (v, i) => (r.bandStatus[i] !== 1 && Number.isFinite(v) ? v : null)),
        icc: Array.from(r.icc, (v, i) => (r.bandStatus[i] === 0 && Number.isFinite(v) ? v : null)),
      };
    },
  };
}

let ready: Promise<ExplorerKernel> | null = null;
/** Loads the Methods WASM module once per worker. */
export function loadMethodsKernel(): Promise<ExplorerKernel> {
  ready ??= loadModule().then(() => methodsKernel());
  return ready;
}
