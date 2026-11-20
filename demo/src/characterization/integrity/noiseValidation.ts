// INTERIM estimator validation by synthetic noise injection (chat §5): known white Gaussian noise is
// added to the loaded spectra at several relative levels (seeded, deterministic) and σ is
// re-estimated with the engine's own estimator, the Methods `diagnostics.spectral_noise_proxy`
// kernel (σ = MAD of second differences × 1.4826/√6), passed in as `estimate`. This validates the
// estimator, it is not a dataset result. Debt: docs/implementation/debt/characterization-integrity.md.
import type { EventsMatrix } from "./populationEvents";
import { gaussianSequence } from "./model";

export interface NoiseEstimate {
  /** per row; null when the kernel did not compute it */
  sigma: (number | null)[];
  meanAbs: (number | null)[];
}
export type NoiseEstimator = (m: EventsMatrix) => NoiseEstimate;

export interface Spread { p5: number; p50: number; p95: number }

export interface NoiseLevelResult {
  /** injected relative noise σ_inj / mean|x| (ratio, not %) */
  injected: number;
  /** re-estimated relative noise σ̂ / mean|x̂| of the noisy spectra */
  recovered: Spread;
  /** √max(0, σ̂² − σ₀²) / mean|x|: the estimate of the injected part alone */
  excess: Spread;
  /** expected total under independence √(injected² + ρ₀²), median over spectra */
  expected: number;
  /** spectra with an estimate before and after injection */
  n: number;
}

export interface NoiseValidation {
  seed: number;
  /** relative noise of the spectra as loaded (σ₀ / mean|x|) */
  baseline: Spread;
  n: number;
  levels: NoiseLevelResult[];
}

/** Default injected levels: ρ₀ × 10^(k/2), k = −1…4 (about 0.3× to 100× the dataset's own relative noise). */
export const LEVEL_EXPONENTS = [-1, 0, 1, 2, 3, 4];
export const DEFAULT_SEED = 20261120;

function spread(values: number[]): Spread | null {
  if (!values.length) return null;
  const s = Float64Array.from(values).sort();
  const q = (p: number) => {
    const at = (s.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return s[lo]! * (1 - (at - lo)) + s[hi]! * (at - lo);
  };
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}

/** `m` plus white Gaussian noise of σ_i = level × meanAbs_i on its valid cells (new matrix; `m` unchanged). */
export function injectNoise(m: EventsMatrix, level: number, meanAbs: readonly (number | null)[], seed: number): EventsMatrix {
  const draws = gaussianSequence(m.n * m.p, seed);
  const x = new Float64Array(m.x);
  for (let i = 0; i < m.n; i++) {
    const sigma = level * (meanAbs[i] ?? 0);
    if (!(sigma > 0)) continue;
    for (let j = 0; j < m.p; j++) {
      const t = i * m.p + j;
      if (!m.mask || m.mask[t]) x[t] = x[t]! + sigma * draws[t]!;
    }
  }
  return { ...m, x };
}

export function validateNoiseEstimator(m: EventsMatrix, estimate: NoiseEstimator, options: { seed?: number; exponents?: readonly number[] } = {}): NoiseValidation | null {
  const seed = options.seed ?? DEFAULT_SEED;
  const base = estimate(m);
  const rho0: (number | null)[] = base.sigma.map((s, i) => {
    const a = base.meanAbs[i];
    return s !== null && a !== null && a !== undefined && a > 0 && s > 0 ? s / a : null;
  });
  const baseline = spread(rho0.filter((r): r is number => r !== null));
  if (!baseline) return null;
  const levels: NoiseLevelResult[] = [];
  (options.exponents ?? LEVEL_EXPONENTS).forEach((k, index) => {
    const level = baseline.p50 * 10 ** (k / 2);
    const noisy = estimate(injectNoise(m, level, base.meanAbs, seed + index));
    const recovered: number[] = [];
    const excess: number[] = [];
    const expected: number[] = [];
    for (let i = 0; i < m.n; i++) {
      const s0 = base.sigma[i];
      const a0 = base.meanAbs[i];
      const s = noisy.sigma[i];
      const a = noisy.meanAbs[i];
      if (s0 === null || s0 === undefined || s === null || s === undefined || a0 === null || a === null || a0 === undefined || a === undefined || !(a0 > 0) || !(a > 0) || rho0[i] === null) continue;
      recovered.push(s / a);
      excess.push(Math.sqrt(Math.max(0, s * s - s0 * s0)) / a0);
      expected.push(Math.hypot(level, rho0[i]!));
    }
    const r = spread(recovered);
    const e = spread(excess);
    const x = spread(expected);
    if (r && e && x) levels.push({ injected: level, recovered: r, excess: e, expected: x.p50, n: recovered.length });
  });
  return { seed, baseline, n: rho0.filter((r) => r !== null).length, levels };
}
