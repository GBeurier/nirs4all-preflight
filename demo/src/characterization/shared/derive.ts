// Shared presentation derivations for the characterization views. These are display
// conversions and order statistics over engine/owner values, not scientific kernels:
// every per-spectrum or per-band estimate comes from the engine report or a Methods kernel.
// Interim location: see docs/implementation/debt/ for the planned owner migration.

/**
 * Engine SNR definition (Methods `spectral_noise_proxy`, intrinsic_diagnostics.cpp):
 * SNR_dB = 20·log10(mean|x| / σ), σ = MAD(second differences)·1.4826/√6. It is an
 * amplitude ratio, so the conversions below are exact inverses of that definition.
 */
export const dbToLinear = (db: number): number => 10 ** (db / 20);
/** Estimated relative noise in percent of the mean absolute signal: 100·10^(−dB/20). */
export const dbToRelativeNoisePercent = (db: number): number => 100 * 10 ** (-db / 20);
export const linearToDb = (ratio: number): number | null => (ratio > 0 && Number.isFinite(ratio) ? 20 * Math.log10(ratio) : null);

/** Finite numbers only (nulls, NaN and infinities dropped). */
export const finite = (values: readonly (number | null | undefined)[]): number[] =>
  values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

/** Type-7 (linear interpolation) quantile of finite values; null when empty. `q` in [0, 1]. */
export function quantile(values: readonly (number | null | undefined)[], q: number): number | null {
  return sortedQuantile(finite(values).sort((a, b) => a - b), q);
}

/**
 * Type-7 quantile of values already sorted ascending (finite only); null when empty. Lets callers
 * that need several quantiles of one large column sort it once.
 */
export function sortedQuantile(xs: ArrayLike<number>, q: number): number | null {
  if (!xs.length) return null;
  const h = (xs.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return xs[lo]! + (h - lo) * (xs[hi]! - xs[lo]!);
}

export const quantiles = (values: readonly (number | null | undefined)[], qs: readonly number[]) => qs.map((q) => quantile(values, q));

/** Ratio guarded against zero/negligible denominators: null instead of an artificial huge value. */
export function safeRatio(num: number | null | undefined, den: number | null | undefined, eps = 1e-12): number | null {
  if (num === null || num === undefined || den === null || den === undefined) return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || Math.abs(den) <= eps * Math.max(1, Math.abs(num))) return null;
  return num / den;
}

/** Share with its denominator, e.g. `{ count: 28, total: 133, ratio: 0.2105 }`; ratio null when total is 0. */
export const share = (count: number, total: number) => ({ count, total, ratio: total > 0 ? count / total : null });

/**
 * One-way random-effects variance model (engine `measurement.icc_1_1`): ICC = σb²/(σb²+σw²),
 * so R = σb/σw = sqrt(ICC/(1−ICC)) and ICC = R²/(1+R²). Defined only for 0 ≤ ICC < 1;
 * negative ICC estimates (MSB < MSW) are preserved by callers and have no real R.
 */
export const iccToRatio = (icc: number): number | null => (icc >= 0 && icc < 1 ? Math.sqrt(icc / (1 - icc)) : null);
export const ratioToIcc = (r: number): number => (r * r) / (1 + r * r);

/** Koo & Li (2016) indicative ICC bands; general ICC conventions, not NIR instrument criteria. */
export type IccBand = "poor" | "moderate" | "good" | "excellent";
export const iccBand = (icc: number): IccBand => (icc < 0.5 ? "poor" : icc < 0.75 ? "moderate" : icc < 0.9 ? "good" : "excellent");

/** Heuristic SNR bands from the request (relative amplitude, not validated analytical thresholds). */
export const SNR_BANDS = [
  { maxDb: 20, label: "Very high" },
  { maxDb: 30, label: "High" },
  { maxDb: 40, label: "Moderate" },
  { maxDb: 50, label: "Low" },
  { maxDb: 60, label: "Very low" },
  { maxDb: 80, label: "Minimal" },
  { maxDb: Infinity, label: "Extremely low" },
] as const;
/** Indicative relative-noise label for an SNR in dB ("Very high" relative noise below 20 dB, ...). */
export const snrBand = (db: number) => SNR_BANDS.find((b) => db < b.maxDb)!.label;

/** Noise-to-diversity heuristic bands (exploratory, not metrologically validated). */
export type NoiseDiversityBand = "low" | "moderate" | "substantial" | "exceeds";
export const noiseDiversityBand = (r: number): NoiseDiversityBand => (r < 0.1 ? "low" : r < 0.3 ? "moderate" : r < 1 ? "substantial" : "exceeds");
