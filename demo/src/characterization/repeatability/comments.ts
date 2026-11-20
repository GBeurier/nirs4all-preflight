// Deterministic interpretive comments for repeatability and the noise proxy (request §10).
// Each rule fires only when the computed result demonstrates it; thresholds are stated next to
// the rule and covered by comments.test.ts. No text generation.
import { dbToRelativeNoisePercent, finite, quantile } from "../shared/derive";
import type { NoiseProfile, RepeatProfile } from "./profiles";

export type Fmt = (v: number, digits?: number) => string;

/** Plain English number formatting with `digits` significant digits. */
export const fmt: Fmt = (v, digits = 3) => {
  if (!Number.isFinite(v)) return "—";
  if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4)) return v.toExponential(Math.max(0, digits - 1));
  return Number(v.toPrecision(digits)).toLocaleString("en", { maximumFractionDigits: 12, useGrouping: false });
};

export const NO_REPLICATES_COMMENT = "Technical repeatability cannot be assessed because no replicate groups have been declared.";

/** Contiguous runs of ≥ `min` bands where `test` holds. */
export function bandRuns(values: readonly (number | null)[], test: (v: number) => boolean, min = 3) {
  const out: { i0: number; i1: number }[] = [];
  let start = -1;
  values.forEach((v, i) => {
    const hit = v !== null && Number.isFinite(v) && test(v);
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) {
      if (i - start >= min) out.push({ i0: start, i1: i - 1 });
      start = -1;
    }
  });
  if (start >= 0 && values.length - start >= min) out.push({ i0: start, i1: values.length - 1 });
  return out;
}

const span = (axis: readonly number[], r: { i0: number; i1: number }, unit: string, f: Fmt) => `${f(axis[r.i0]!, 4)}–${f(axis[r.i1]!, 4)}${unit ? ` ${unit}` : ""}`;
const pct = (r: number, f: Fmt) => `${f(r * 100, 3)}%`;

export interface RepeatStats {
  evaluable: number;
  bands: number;
  medianSd: number | null;
  medianIcc: number | null;
  p5Icc: number | null;
  negative: number;
  belowHalf: number;
  medianRatio: number | null;
}

export function repeatStats(p: RepeatProfile): RepeatStats {
  const icc = finite(p.icc ?? []);
  return {
    evaluable: icc.length,
    bands: p.sd.length,
    medianSd: quantile(p.sd, 0.5),
    medianIcc: quantile(icc, 0.5),
    p5Icc: quantile(icc, 0.05),
    negative: icc.filter((v) => v < 0).length,
    belowHalf: icc.filter((v) => v < 0.5).length,
    // R is monotone in the ICC: with a negative ANOVA ICC (σb² estimate ≤ 0) R is not defined per band, so the
    // median R is the transform of the median ICC (consistent with the median ICC shown next to it), null when < 0.
    medianRatio: p.betweenKind === "anova" ? (() => {
      const m = quantile(icc, 0.5);
      return m === null || m < 0 || m >= 1 ? null : Math.sqrt(m / (1 - m));
    })() : quantile(p.ratio, 0.5),
  };
}

/**
 * Repeatability rules. Region rule: ≥ 3 contiguous bands with ICC < 0.50. Few-groups rule: fewer
 * than 10 physical samples with ≥ 2 repeats. R statement: model-exact only (balanced ICC(1,1) or the engine's REML components).
 */
export function repeatabilityComments(profiles: readonly RepeatProfile[], axis: readonly number[], axisUnit: string, f: Fmt = fmt): string[] {
  if (!profiles.length) return [NO_REPLICATES_COMMENT];
  const out: string[] = [];
  for (const p of profiles) {
    const s = repeatStats(p);
    const tag = profiles.length > 1 ? `[${p.context.id}] ` : "";
    if (!s.evaluable) {
      out.push(`${tag}Replicate groups are declared, but the ICC could not be evaluated at any band (unbalanced or insufficient groups).`);
      continue;
    }
    out.push(`${tag}Median ICC over ${s.evaluable} of ${s.bands} bands is ${f(s.medianIcc!)}; 5% of evaluable bands fall below ${f(s.p5Icc!)}.`);
    if (s.belowHalf > 0) out.push(`${tag}${pct(s.belowHalf / s.evaluable, f)} of evaluable bands have an ICC below 0.50 (indicative "poor" band); this may reflect limited between-sample variability rather than poor absolute repeatability.`);
    if (s.negative > 0) out.push(`${tag}${s.negative} band${s.negative > 1 ? "s have" : " has"} a negative ICC estimate (within-sample variation exceeds between-sample variation); values are shown unclipped.`);
    const low = bandRuns(p.icc ?? [], (v) => v < 0.5);
    if (low.length) {
      const widest = [...low].sort((a, b) => b.i1 - b.i0 - (a.i1 - a.i0))[0]!;
      out.push(`${tag}ICC stays below 0.50 over ${low.length} contiguous region${low.length > 1 ? "s" : ""} of at least 3 bands; the widest spans ${span(axis, widest, axisUnit, f)}.`);
    }
    if (p.betweenKind !== "approximate" && s.medianRatio !== null) {
      out.push(`${tag}Between-sample spectral variability is approximately ${f(s.medianRatio, 2)} times the within-sample measurement variability (median over evaluable bands).`);
    }
    const rc = p.uncertainty?.repeatCounts;
    if (rc && rc.rMin !== null && rc.rMax !== null && rc.rMin !== rc.rMax) {
      out.push(`${tag}Replicate group sizes are unbalanced (${rc.rMin} to ${rc.rMax} acquisitions per physical sample)${p.iccKind === "icc_1_reml" ? "; the REML ICC(1) is shown because the balanced ICC(1,1) is undefined" : ""}.`);
    }
    if (rc && rc.nRepeatedGroups !== null && rc.nRepeatedGroups < 10) {
      out.push(`${tag}Only ${rc.nRepeatedGroups} physical sample${rc.nRepeatedGroups > 1 ? "s have" : " has"} two or more repeats: per-band ICC estimates are imprecise.`);
    }
  }
  return out;
}

export interface NoiseStats {
  evaluable: number;
  bands: number;
  median: number | null;
  p95: number | null;
  relativePooledPercent: number | null;
  ratioEvaluable: number;
  exceeds: number;
  substantialOrMore: number;
}

export function noiseStats(p: NoiseProfile, level: number | null): NoiseStats {
  const r = finite(p.ratio);
  return {
    evaluable: finite(p.values).length,
    bands: p.values.length,
    median: quantile(p.values, 0.5),
    p95: quantile(p.values, 0.95),
    relativePooledPercent: p.pooled !== null && level !== null && level > 0 ? (100 * p.pooled) / level : null,
    ratioEvaluable: r.length,
    exceeds: r.filter((v) => v >= 1).length,
    substantialOrMore: r.filter((v) => v >= 0.3).length,
  };
}

/**
 * Noise-proxy rules. SNR divergence: stated when the pooled relative proxy and the SNR-derived
 * relative noise differ by a factor ≥ 2. Ratio regions: ≥ 3 contiguous bands with ratio ≥ 0.30.
 * Highest regions: ≥ 3 contiguous bands in the top decile of the per-band proxy.
 */
export function noiseComments(profiles: readonly NoiseProfile[], level: number | null, medianSnrDb: number | null, axis: readonly number[], axisUnit: string, signalUnit: string, f: Fmt = fmt): string[] {
  const out: string[] = [];
  const u = signalUnit ? ` ${signalUnit}` : "";
  for (const p of profiles) {
    const s = noiseStats(p, level);
    const tag = profiles.length > 1 ? `[${p.id}] ` : "";
    if (s.relativePooledPercent !== null) {
      out.push(`${tag}The pooled noise proxy (${f(p.pooled!)}${u}) represents approximately ${f(s.relativePooledPercent)}% of the typical absolute signal level (${f(level!)}${u}, median over spectra of the mean absolute value).`);
      if (medianSnrDb !== null) {
        const snrPct = dbToRelativeNoisePercent(medianSnrDb);
        const k = s.relativePooledPercent / snrPct;
        if (k >= 2 || k <= 0.5) out.push(`${tag}This is ${f(k >= 1 ? k : 1 / k, 2)} times ${k >= 1 ? "higher" : "lower"} than the relative noise derived from the median SNR (${f(snrPct)}%): the estimators differ (smoothing residual pooled over bands vs second differences per spectrum), and curvature or anomalies inflate the residual.`);
      }
    } else if (p.pooled !== null) {
      out.push(`${tag}The pooled noise proxy is ${f(p.pooled)}${u}; its relative value is not available because the typical absolute signal level is zero, negligible or not computed.`);
    }
    const cut = s.evaluable >= 10 ? quantile(p.values, 0.9) : null;
    const high = cut === null ? [] : bandRuns(p.values, (v) => v >= cut);
    if (high.length) out.push(`${tag}The highest per-band noise proxy values (top 10% of bands) form ${high.length} contiguous region${high.length > 1 ? "s" : ""}, e.g. ${span(axis, high[0]!, axisUnit, f)}.`);
    if (s.ratioEvaluable) {
      const regions = bandRuns(p.ratio, (v) => v >= 0.3);
      const denom = p.diversityKind === "between-sample" ? "between-sample SD" : "between-spectrum SD";
      if (regions.length >= 2) out.push(`${tag}Several contiguous wavelength regions exhibit elevated fine-scale variation relative to observed spectral diversity (noise proxy ≥ 0.30 × ${denom} over ${regions.length} regions).`);
      else if (regions.length === 1) out.push(`${tag}One contiguous region (${span(axis, regions[0]!, axisUnit, f)}) exhibits elevated fine-scale variation relative to observed spectral diversity (noise proxy ≥ 0.30 × ${denom}).`);
      if (s.exceeds > 0) out.push(`${tag}Fine-scale variation exceeds the observed ${denom} in ${s.exceeds} of ${s.ratioEvaluable} evaluable bands (${pct(s.exceeds / s.ratioEvaluable, f)}).`);
      else if (!regions.length && s.substantialOrMore === 0) out.push(`${tag}Fine-scale variation stays below 0.30 × the ${denom} at every evaluable band.`);
    }
  }
  return out;
}
