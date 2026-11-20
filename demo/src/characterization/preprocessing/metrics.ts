// Before/after comparison metrics of the preprocessing explorer. Per-spectrum noise (σ, SNR),
// events, per-band noise proxy and repeatability come from Methods kernels (methodsKernel.ts);
// the distortion metrics below (relative RMSE, spectral angle, per-band SD, band descriptors,
// Pareto front) are small interim descriptive computations, recorded as Methods debt in
// docs/implementation/debt/characterization-preprocessing.md.

export interface Matrix {
  /** Row-major, rows = spectra, cols = bands; every cell finite. */
  data: Float64Array;
  rows: number;
  cols: number;
}

export const row = (m: Matrix, i: number) => m.data.subarray(i * m.cols, (i + 1) * m.cols);

const median = (xs: readonly number[]): number | null => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const h = (v.length - 1) / 2;
  return (v[Math.floor(h)]! + v[Math.ceil(h)]!) / 2;
};
export { median as medianOf };

/** Type-7 quantile of a finite list (sorted copy). */
const q7 = (sorted: Float64Array, q: number) => {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo]! + (h - lo) * (sorted[Math.ceil(h)]! - sorted[lo]!);
};

/** Per-band median, P5 and P95 across spectra. */
export function bandEnvelope(m: Matrix): { median: number[]; p5: number[]; p95: number[] } {
  const med: number[] = [], p5: number[] = [], p95: number[] = [];
  const col = new Float64Array(m.rows);
  for (let j = 0; j < m.cols; j++) {
    for (let i = 0; i < m.rows; i++) col[i] = m.data[i * m.cols + j]!;
    col.sort();
    med.push(m.rows ? q7(col, 0.5) : NaN);
    p5.push(m.rows ? q7(col, 0.05) : NaN);
    p95.push(m.rows ? q7(col, 0.95) : NaN);
  }
  return { median: med, p5, p95 };
}

/** Per-band sample SD across spectra (between-sample spread); null with fewer than 2 spectra. */
export function bandSd(m: Matrix): (number | null)[] {
  const out: (number | null)[] = [];
  for (let j = 0; j < m.cols; j++) {
    if (m.rows < 2) {
      out.push(null);
      continue;
    }
    let mean = 0;
    for (let i = 0; i < m.rows; i++) mean += m.data[i * m.cols + j]!;
    mean /= m.rows;
    let ss = 0;
    for (let i = 0; i < m.rows; i++) ss += (m.data[i * m.cols + j]! - mean) ** 2;
    out.push(Math.sqrt(ss / (m.rows - 1)));
  }
  return out;
}

/** Raw − processed, cell by cell (same spectra, same bands). */
export function residual(raw: Matrix, processed: Matrix): Matrix {
  if (raw.rows !== processed.rows || raw.cols !== processed.cols) throw new Error("residual: shape mismatch");
  const data = new Float64Array(raw.data.length);
  for (let k = 0; k < data.length; k++) data[k] = raw.data[k]! - processed.data[k]!;
  return { data, rows: raw.rows, cols: raw.cols };
}

/**
 * Relative spectral RMSE per spectrum, in percent: 100·‖x − y‖₂ / ‖x‖₂ (equivalently
 * RMS(raw − processed) / RMS(raw) over the bands). Null when the raw spectrum is all zero.
 */
export function relativeRmsePercent(raw: Matrix, processed: Matrix): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < raw.rows; i++) {
    const x = row(raw, i), y = row(processed, i);
    let d = 0, n = 0;
    for (let j = 0; j < x.length; j++) {
      d += (x[j]! - y[j]!) ** 2;
      n += x[j]! ** 2;
    }
    out.push(n > 0 ? (100 * Math.sqrt(d)) / Math.sqrt(n) : null);
  }
  return out;
}

/** Spectral angle per spectrum in degrees: arccos(⟨x, y⟩ / (‖x‖‖y‖)); null for a zero vector. */
export function spectralAngleDeg(raw: Matrix, processed: Matrix): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < raw.rows; i++) {
    const x = row(raw, i), y = row(processed, i);
    let xy = 0, xx = 0, yy = 0;
    for (let j = 0; j < x.length; j++) {
      xy += x[j]! * y[j]!;
      xx += x[j]! ** 2;
      yy += y[j]! ** 2;
    }
    out.push(xx > 0 && yy > 0 ? (Math.acos(Math.min(1, Math.max(-1, xy / Math.sqrt(xx * yy)))) * 180) / Math.PI : null);
  }
  return out;
}

/** Paired per-spectrum values, kept only where both sides are finite. */
export function paired(a: readonly (number | null)[], b: readonly (number | null)[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x !== null && x !== undefined && y !== null && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** SNR gain in dB: median over spectra of (SNR_processed − SNR_raw), paired per spectrum. */
export function snrGainDb(rawDb: readonly (number | null)[], procDb: readonly (number | null)[]) {
  const pairs = paired(rawDb, procDb);
  return { value: median(pairs.map(([r, p]) => p - r)), n: pairs.length };
}

/**
 * Fine-scale variation reduction in percent: 100·(1 − median_i(σ_processed,i / σ_raw,i)), with σ the
 * fixed second-difference MAD estimator. Spectra with σ_raw = 0 are not evaluable. Negative values
 * mean the processed spectra vary more at the finest scale.
 */
export function fineScaleReductionPercent(rawSigma: readonly (number | null)[], procSigma: readonly (number | null)[]) {
  const pairs = paired(rawSigma, procSigma).filter(([r]) => r > 0);
  const m = median(pairs.map(([r, p]) => p / r));
  return { value: m === null ? null : 100 * (1 - m), n: pairs.length };
}

/**
 * Between-sample diversity retention in percent: 100·sqrt(Σ_b SD_b(processed)² / Σ_b SD_b(raw)²),
 * over bands evaluable on both sides. 100 % = same total between-spectrum variance; lower is not
 * an improvement by itself.
 */
export function diversityRetentionPercent(rawSd: readonly (number | null)[], procSd: readonly (number | null)[]) {
  const pairs = paired(rawSd, procSd);
  const den = pairs.reduce((s, [r]) => s + r * r, 0);
  const num = pairs.reduce((s, [, p]) => s + p * p, 0);
  return { value: den > 0 ? 100 * Math.sqrt(num / den) : null, n: pairs.length };
}

/**
 * Per-band relative distortion of the processing: |mean_i r_ib| / mean_i |x_ib| with r = raw − processed.
 * Null where the raw band is zero on average.
 */
export function distortionProfile(raw: Matrix, processed: Matrix): (number | null)[] {
  const out: (number | null)[] = [];
  for (let j = 0; j < raw.cols; j++) {
    let r = 0, a = 0;
    for (let i = 0; i < raw.rows; i++) {
      const x = raw.data[i * raw.cols + j]!;
      r += x - processed.data[i * raw.cols + j]!;
      a += Math.abs(x);
    }
    out.push(a > 0 && raw.rows ? Math.abs(r / raw.rows) / (a / raw.rows) : null);
  }
  return out;
}

export interface BandDescriptor {
  /** Axis position of the maximum above the straight baseline joining the window ends. */
  position: number;
  /** Height above that baseline, in signal units. */
  height: number;
  /** Full width at half that height, in axis units (contiguous run around the maximum). */
  width: number | null;
}

/**
 * Descriptive band of one profile (typically the median spectrum) within the axis window [lo, hi]:
 * maximum of (profile − linear baseline through the window end points). Null when fewer than three
 * bands fall inside, or when nothing rises above the baseline.
 */
export function bandDescriptor(axis: readonly number[], profile: readonly number[], lo: number, hi: number): BandDescriptor | null {
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  const idx = axis.map((v, i) => [v, i] as const).filter(([v]) => v >= a && v <= b).map(([, i]) => i);
  if (idx.length < 3) return null;
  const i0 = idx[0]!, i1 = idx[idx.length - 1]!;
  const x0 = axis[i0]!, x1 = axis[i1]!, y0 = profile[i0]!, y1 = profile[i1]!;
  const above = (i: number) => profile[i]! - (x1 === x0 ? y0 : y0 + ((axis[i]! - x0) * (y1 - y0)) / (x1 - x0));
  let best = idx[0]!;
  for (const i of idx) if (above(i) > above(best)) best = i;
  const height = above(best);
  if (!(height > 0)) return null;
  const half = height / 2;
  let l = best, r = best;
  while (idx.includes(l - 1) && above(l - 1) >= half) l--;
  while (idx.includes(r + 1) && above(r + 1) >= half) r++;
  const closed = idx.includes(l - 1) && idx.includes(r + 1);
  return { position: axis[best]!, height, width: closed ? Math.abs(axis[r]! - axis[l]!) : null };
}

/** Indices of non-dominated points: minimise `x` (distortion), maximise `y` (variation reduction). */
export function paretoFront(points: readonly { x: number | null; y: number | null }[]): Set<number> {
  const front = new Set<number>();
  points.forEach((p, i) => {
    if (p.x === null || p.y === null) return;
    const dominated = points.some(
      (q, k) => k !== i && q.x !== null && q.y !== null && q.x <= p.x! && q.y >= p.y! && (q.x < p.x! || q.y > p.y!),
    );
    if (!dominated) front.add(i);
  });
  return front;
}

/** Median spacing between consecutive axis values and whether the axis is irregular (>1 % spread). */
export function axisStep(axis: readonly number[]): { step: number | null; irregular: boolean } {
  const d = axis.slice(1).map((v, i) => Math.abs(v - axis[i]!)).filter((v) => v > 0);
  const step = median(d);
  if (step === null) return { step: null, irregular: false };
  return { step, irregular: d.some((v) => Math.abs(v - step) > 0.01 * step) };
}

/** Histogram over shared bin edges so before/after distributions are directly comparable. */
export function sharedHistogram(series: readonly (readonly (number | null)[])[], bins = 20) {
  const all = series.flatMap((s) => s.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) {
    lo -= 0.5;
    hi += 0.5;
  }
  const width = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, k) => lo + k * width);
  const counts = series.map((s) => {
    const c = new Array<number>(bins).fill(0);
    for (const v of s) if (v !== null && Number.isFinite(v)) c[Math.min(bins - 1, Math.floor((v - lo) / width))]! += 1;
    return c;
  });
  return { edges, counts };
}
