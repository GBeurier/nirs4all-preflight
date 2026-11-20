// Interim local transformers: median filter and despiking. `@nirs4all/methods` 1.5 exposes neither
// (no median-filter or despiking source in nirs4all-methods/cpp, checked 2026-11-20), so the demo
// computes them here, per spectrum, with no learned state. Owner debt: Methods transformers
// (docs/implementation/debt/characterization-preprocessing.md).
import type { Matrix } from "./metrics";

/** scipy.ndimage "reflect" (half-sample symmetric) index: d c b a | a b c d | d c b a. */
export function reflectIndex(j: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n;
  let k = ((j % period) + period) % period;
  if (k >= n) k = period - 1 - k;
  return k;
}

const medianInPlace = (buf: Float64Array, len: number): number => {
  const v = buf.subarray(0, len).sort();
  const h = (len - 1) / 2;
  return (v[Math.floor(h)]! + v[Math.ceil(h)]!) / 2;
};

/**
 * Running median of one spectrum over an odd `window` of bands. Edges use half-sample symmetric
 * reflection (scipy.ndimage.median_filter default mode "reflect"), so the output keeps the length,
 * unit and scale of the input. `window` = 1 is the identity.
 */
export function medianFilter1d(x: ArrayLike<number>, window: number): Float64Array {
  const n = x.length;
  const half = Math.floor(window / 2);
  const out = new Float64Array(n);
  const buf = new Float64Array(2 * half + 1);
  for (let j = 0; j < n; j++) {
    for (let k = -half; k <= half; k++) buf[k + half] = x[reflectIndex(j + k, n)]!;
    out[j] = medianInPlace(buf, 2 * half + 1);
  }
  return out;
}

/** Points flagged by the Whitaker–Hayes rule and the despiked spectrum. */
export interface DespikeResult {
  values: Float64Array;
  flagged: number[];
}

/**
 * Whitaker–Hayes despiking (Whitaker & Hayes 2018, Chemometr. Intell. Lab. Syst. 179:82–84), one spectrum:
 * 1. first differences Δ_j = x_j − x_(j−1), j = 1..p−1;
 * 2. modified z-score z_j = 0.6745·(Δ_j − median Δ) / MAD(Δ), MAD = median |Δ − median Δ|;
 * 3. point j is flagged when |z_j| > `threshold` (a spike at j flags j and usually j + 1);
 * 4. each flagged point is replaced by the median of the unflagged raw points within ±`halfWindow`
 *    bands (it is kept when none is unflagged). MAD = 0 (piecewise-linear spectrum) flags nothing.
 */
export function despike1d(x: ArrayLike<number>, threshold: number, halfWindow: number): DespikeResult {
  const n = x.length;
  const values = Float64Array.from(x as ArrayLike<number>);
  if (n < 3) return { values, flagged: [] };
  const d = new Float64Array(n - 1);
  for (let j = 1; j < n; j++) d[j - 1] = x[j]! - x[j - 1]!;
  const sorted = Float64Array.from(d).sort();
  const med = medianInPlace(sorted, sorted.length);
  const dev = d.map((v) => Math.abs(v - med)).sort();
  const mad = medianInPlace(dev, dev.length);
  if (!(mad > 0)) return { values, flagged: [] };
  const flag = new Uint8Array(n);
  const flagged: number[] = [];
  for (let j = 1; j < n; j++) {
    if (Math.abs((0.6745 * (d[j - 1]! - med)) / mad) > threshold) {
      flag[j] = 1;
      flagged.push(j);
    }
  }
  const buf = new Float64Array(2 * halfWindow + 1);
  for (const j of flagged) {
    let len = 0;
    for (let k = Math.max(0, j - halfWindow); k <= Math.min(n - 1, j + halfWindow); k++) if (!flag[k]) buf[len++] = x[k]!;
    if (len) values[j] = medianInPlace(buf, len);
  }
  return { values, flagged };
}

/** Row-wise application on a copy; the input matrix is never written. */
function rowwise(X: Matrix, f: (row: Float64Array) => Float64Array): Matrix {
  const data = new Float64Array(X.data.length);
  for (let i = 0; i < X.rows; i++) data.set(f(X.data.subarray(i * X.cols, (i + 1) * X.cols)), i * X.cols);
  return { data, rows: X.rows, cols: X.cols };
}

export const medianFilter = (X: Matrix, window: number): Matrix => rowwise(X, (r) => medianFilter1d(r, window));
export const despike = (X: Matrix, threshold: number, halfWindow: number): Matrix => rowwise(X, (r) => despike1d(r, threshold, halfWindow).values);

/** Local transform of a `local` catalog step; null for a Methods step. */
export function localTransform(step: { kind: string; params: Record<string, number | string> }, X: Matrix): Matrix | null {
  if (step.kind === "median") return medianFilter(X, Number(step.params.window));
  if (step.kind === "despike") return despike(X, Number(step.params.threshold), Number(step.params.half_window));
  return null;
}
