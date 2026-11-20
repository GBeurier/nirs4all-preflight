// Per-band profiles for the repeatability and noise-proxy views. Every per-band estimate comes
// from the engine report (Methods kernels); this module only selects the engine's rows, derives
// display quantities (order statistics, the one-way-model between-sample SD, ratios) and never
// changes the input. Debt: docs/implementation/debt/characterization-repeatability.md.
import {
  extractIntrinsic,
  extractNoiseProxy,
  extractRepeatability,
  extractRepeatabilityUncertainty,
  withRepeatabilityUncertainty,
  type QualificationReportView,
  type RepeatabilityContext,
  type RepeatabilityUncertainty,
} from "nirs4all-ui/qualification";
import type { EngineInput, InputSource } from "../../input";
import { finite, iccBand, iccToRatio, noiseDiversityBand, quantile, sortedQuantile, type IccBand, type NoiseDiversityBand } from "../shared/derive";

export type Values = (number | null)[];

/** Minimal scope these derivations need (a subset of the demo `Scope`). */
export interface ProfileScope {
  view: QualificationReportView;
  input: EngineInput;
  sourceId: string | null;
}

/** Engine `real_rows(Development)`: development samples (Rust default) that are not augmentations. */
export function developmentRows(input: EngineInput, source: InputSource): number[] {
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const out: number[] = [];
  source.sample_ids.forEach((id, r) => {
    const s = samples.get(id);
    if (s && (s.partition ?? "development") === "development" && !s.augmentation_parent_id) out.push(r);
  });
  return out;
}

/** Engine `valid_cell`: null for a missing value or a masked cell. */
export const cell = (source: InputSource, r: number, c: number): number | null => {
  const v = source.x[r]?.[c];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return source.valid_mask && source.valid_mask[r]?.[c] === false ? null : v;
};

/** Per-band median and P5–P95 envelope of the given rows (type-7 quantiles, valid cells only). */
export function bandEnvelope(source: InputSource, rows: readonly number[]) {
  const p = source.axis.length;
  const median: Values = new Array(p).fill(null);
  const p5: Values = new Array(p).fill(null);
  const p95: Values = new Array(p).fill(null);
  const buf = new Float64Array(rows.length);
  for (let c = 0; c < p; c++) {
    let k = 0;
    for (const r of rows) {
      const v = cell(source, r, c);
      if (v !== null) buf[k++] = v;
    }
    if (!k) continue;
    // One numeric sort per band for the three quantiles (thousands of spectra × thousands of bands).
    const col = buf.subarray(0, k).sort();
    median[c] = sortedQuantile(col, 0.5);
    p5[c] = sortedQuantile(col, 0.05);
    p95[c] = sortedQuantile(col, 0.95);
  }
  return { median, p5, p95, n: rows.length };
}

/** Per-band sample SD (n − 1) across spectra: the "between-spectrum SD"; null below two values. */
export function betweenSpectrumSd(source: InputSource, rows: readonly number[]): Values {
  return source.axis.map((_, c) => {
    let n = 0;
    let mean = 0;
    let m2 = 0;
    for (const r of rows) {
      const v = cell(source, r, c);
      if (v === null) continue;
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
    }
    return n >= 2 ? Math.sqrt(Math.max(0, m2) / (n - 1)) : null;
  });
}

/**
 * Between-sample SD in the engine's one-way random-effects model. Methods (`n4m_preflight_repeatability`)
 * reports pooled SD = √MSW and, for balanced groups of size r, ICC(1,1) = (MSB − MSW)/(MSB + (r − 1)·MSW),
 * which equals σb²/(σb² + σw²) with σw² = MSW and σb² = (MSB − MSW)/r. Hence
 * σb = σw·√(ICC/(1 − ICC)) = √((MSB − MSW)/r) exactly, for 0 ≤ ICC < 1. A negative ICC (MSB < MSW)
 * has no real σb (null, the ICC itself stays negative); ICC = 1 means σw = 0 (null, no finite ratio).
 * With the REML ICC(1) (unbalanced designs) σw stays the ANOVA pooled SD, so the result is approximate.
 */
export function betweenSampleSd(pooledSd: readonly (number | null)[], icc: readonly (number | null)[] | null): Values {
  return pooledSd.map((sw, i) => {
    const k = icc?.[i];
    if (sw === null || sw === undefined || k === null || k === undefined) return null;
    const r = iccToRatio(k);
    return r === null ? null : sw * r;
  });
}

/** Typical absolute signal level: median over spectra of the intrinsic `noise.signal_mean_abs`. */
export function typicalSignalLevel(view: QualificationReportView, sourceId: string): number | null {
  const s = extractIntrinsic(view, sourceId)?.signals["noise.signal_mean_abs"];
  if (!s || s.state.status !== "computed") return null;
  return s.median ?? quantile(s.values, 0.5);
}

/**
 * Ratio guarded against zero/negligible denominators: null (never ±∞ or an artificial huge value)
 * when the denominator is not finite or ≤ `floor` (absolute, in the denominator's units).
 */
export function guardedRatio(num: number | null | undefined, den: number | null | undefined, floor: number): number | null {
  if (num === null || num === undefined || den === null || den === undefined || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return den > floor ? num / den : null;
}

/** Negligible-denominator floor: 1e-9 of the typical signal level (or of the largest denominator). */
export const negligibleFloor = (den: readonly (number | null)[], level: number | null) => {
  const scale = level !== null && level > 0 ? level : Math.max(0, ...finite(den).map(Math.abs));
  return scale > 0 ? scale * 1e-9 : Number.MIN_VALUE;
};

/** Repeat groups of one repeatability context, as the engine builds them (read-only mirror). */
export interface RepeatGroup {
  id: string;
  rows: number[];
}

/** Engine `analyze_repeats`: rows of a context = development rows with that technical repeat type, instrument and campaign; group = physical sample id, else sample id. */
export function contextGroups(input: EngineInput, source: InputSource, ctx: Pick<RepeatabilityContext, "repeatType" | "instrument" | "campaign">): RepeatGroup[] {
  const types = source.repetition_types;
  if (!types) return [];
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const groups = new Map<string, number[]>();
  for (const r of developmentRows(input, source)) {
    if (types[r] !== ctx.repeatType) continue;
    const s = samples.get(source.sample_ids[r]!)!;
    if ((s.instrument ?? "") !== (ctx.instrument ?? "") || (s.campaign ?? "") !== (ctx.campaign ?? "")) continue;
    const key = s.physical_sample_id ?? s.sample_id;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return [...groups].map(([id, rows]) => ({ id, rows }));
}

export interface RepeatProfile {
  context: RepeatabilityContext;
  uncertainty: RepeatabilityUncertainty | null;
  sd: Values;
  betweenSd: Values;
  icc: Values | null;
  iccKind: "icc_1_1" | "icc_1_reml";
  /** R = σb/σw per band (one-way model; null for negative ICC, ICC = 1 or a non-evaluable band) */
  ratio: Values;
  nonEvaluable: boolean[];
  categories: (IccBand | null)[];
}

export function repeatProfiles(view: QualificationReportView, sourceId: string): RepeatProfile[] {
  const uncertainty = extractRepeatabilityUncertainty(view, sourceId);
  return withRepeatabilityUncertainty(extractRepeatability(view, sourceId), uncertainty).map((c) => {
    const icc = c.icc ? [...c.icc] : null;
    const betweenSd = betweenSampleSd(c.pooledSd, icc);
    return {
      context: c,
      uncertainty: uncertainty.find((u) => u.id === c.id) ?? null,
      sd: [...c.pooledSd],
      betweenSd,
      icc,
      iccKind: c.iccKind ?? "icc_1_1",
      ratio: (icc ?? c.pooledSd.map(() => null)).map((k) => (k === null ? null : iccToRatio(k))),
      nonEvaluable: c.pooledSd.map((_, i) => (icc ? icc[i] === null : true)),
      categories: (icc ?? c.pooledSd.map(() => null)).map((k) => (k === null ? null : iccBand(k))),
    };
  });
}

export interface NoiseProfile {
  id: string;
  instrument: string;
  campaign: string;
  unit: string | null;
  values: Values;
  pooled: number | null;
  windowBands: number | null;
  polyorder: number | null;
  nEvaluableBands: number | null;
  rows: number[];
  /** Denominator of the noise-to-diversity ratio and its provenance. */
  diversity: Values;
  diversityKind: "between-sample" | "between-spectrum";
  diversityContext: string | null;
  ratio: Values;
  ratioBands: (NoiseDiversityBand | null)[];
  nonEvaluable: boolean[];
}

/** Engine noise-proxy contexts (instrument × campaign over development rows) with their rows. */
export function noiseProfiles(view: QualificationReportView, input: EngineInput, sourceId: string, repeats: readonly RepeatProfile[] = repeatProfiles(view, sourceId)): NoiseProfile[] {
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (!source) return [];
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const dev = developmentRows(input, source);
  const metrics = view.metrics.filter((m) => m.id === "measurement.noise_proxy" && m.sourceId === sourceId && m.status === "computed");
  const level = typicalSignalLevel(view, sourceId);
  return extractNoiseProxy(view, sourceId).map((c, k) => {
    const m = metrics[k];
    const instrument = typeof m?.parameters.instrument === "string" ? m.parameters.instrument : "";
    const campaign = typeof m?.parameters.campaign === "string" ? m.parameters.campaign : "";
    const rows = dev.filter((r) => {
      const s = samples.get(source.sample_ids[r]!);
      return (s?.instrument ?? "") === instrument && (s?.campaign ?? "") === campaign;
    });
    const repeat = repeats.find((p) => (p.context.instrument ?? "") === instrument && (p.context.campaign ?? "") === campaign && p.betweenSd.some((v) => v !== null));
    const diversity = repeat ? repeat.betweenSd : betweenSpectrumSd(source, rows);
    const floor = negligibleFloor(diversity, level);
    const ratio = c.values.map((v, i) => guardedRatio(v, diversity[i], floor));
    return {
      id: c.id,
      instrument,
      campaign,
      unit: c.unit,
      values: [...c.values],
      pooled: c.pooled,
      windowBands: c.windowBands,
      polyorder: c.polyorder,
      nEvaluableBands: c.nEvaluableBands,
      rows,
      diversity,
      diversityKind: repeat ? "between-sample" : "between-spectrum",
      diversityContext: repeat ? repeat.context.id : null,
      ratio,
      ratioBands: ratio.map((r) => (r === null ? null : noiseDiversityBand(r))),
      nonEvaluable: c.values.map((v) => v === null),
    };
  });
}

/** Contiguous band regions (≥ `minBands`) where `values` is at or above its `q` quantile, largest first. */
export function topRegions(axis: readonly number[], values: readonly (number | null)[], q = 0.9, minBands = 3, max = 3) {
  const cut = quantile(values, q);
  if (cut === null) return [];
  const out: { i0: number; i1: number; from: number; to: number; peak: number }[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start + 1 >= minBands) {
      const peak = Math.max(...finite(values.slice(start, end + 1)));
      out.push({ i0: start, i1: end, from: axis[start]!, to: axis[end]!, peak });
    }
    start = -1;
  };
  values.forEach((v, i) => {
    const hit = v !== null && Number.isFinite(v) && v >= cut;
    if (hit && start < 0) start = i;
    if (!hit) close(i - 1);
  });
  close(values.length - 1);
  return out.sort((a, b) => b.peak - a.peak).slice(0, max);
}

/** Per-band arrays for the spectral quality map (first context of each family; nulls = non-evaluable). */
export interface BandProfiles {
  axis: number[];
  axisUnit: string;
  signalUnit: string;
  repeatabilityContext: string | null;
  repeatabilitySd: Values | null;
  betweenSampleSd: Values | null;
  icc: Values | null;
  iccKind: "icc_1_1" | "icc_1_reml" | null;
  noiseContext: string | null;
  noiseProxy: Values | null;
  noiseToDiversity: Values | null;
  /** Denominator used by `noiseToDiversity` ("between-sample" SD from replicates, else "between-spectrum" SD). */
  diversity: Values | null;
  diversityKind: "between-sample" | "between-spectrum" | null;
  /** Same fields as the quality map's `BandProfileInput`. */
  unit: string | null;
  diversityBasis: "sample" | "spectrum";
  provenance: Partial<Record<"repeatability_sd" | "icc" | "noise_proxy" | "noise_to_diversity" | "diversity", string>>;
  unavailable: Partial<Record<"repeatability_sd" | "icc" | "noise_proxy" | "noise_to_diversity" | "diversity", string>>;
  /** Every context, for callers that need more than the first one. */
  repeats: RepeatProfile[];
  noise: NoiseProfile[];
}

export function bandProfiles(scope: ProfileScope): BandProfiles | null {
  const { view, input, sourceId } = scope;
  const source = sourceId ? input.sources.find((s) => s.source_id === sourceId) : undefined;
  if (!source || !sourceId) return null;
  const repeats = repeatProfiles(view, sourceId);
  const noise = noiseProfiles(view, input, sourceId, repeats);
  const r = repeats[0];
  const q = noise[0];
  return {
    axis: [...source.axis],
    axisUnit: source.axis_unit ?? "",
    signalUnit: source.signal_unit ?? "",
    repeatabilityContext: r?.context.id ?? null,
    repeatabilitySd: r?.sd ?? null,
    betweenSampleSd: r?.betweenSd ?? null,
    icc: r?.icc ?? null,
    iccKind: r?.iccKind ?? null,
    noiseContext: q?.id ?? null,
    noiseProxy: q?.values ?? null,
    noiseToDiversity: q?.ratio ?? null,
    diversity: q?.diversity ?? null,
    diversityKind: q?.diversityKind ?? null,
    unit: r?.context.unit ?? q?.unit ?? (source.signal_unit || null),
    diversityBasis: q?.diversityKind === "between-sample" ? "sample" : "spectrum",
    provenance: {
      ...(r ? {
        repeatability_sd: `Pooled within-sample SD (√MSW) of ${r.context.id}, engine measurement.repeatability_sd.`,
        icc: `${r.iccKind === "icc_1_reml" ? "REML ICC(1)" : "ICC(1,1)"}, one-way random effects, ${r.context.id}. Indicative Koo & Li (2016) bands, not NIR criteria.`,
      } : {}),
      ...(q ? {
        noise_proxy: `Savitzky–Golay residual RMS / white-noise gain (window ${q.windowBands ?? "—"}, order ${q.polyorder ?? "—"}), ${q.id}, engine measurement.noise_proxy.`,
        noise_to_diversity: `Noise proxy / ${q.diversityKind} SD${q.diversityContext ? ` (${q.diversityContext})` : ""}; null where the denominator is zero or negligible.`,
        diversity: q.diversityKind === "between-sample" ? `Between-sample SD σb = σw·√(ICC/(1 − ICC)) from the engine one-way model${repeats.find((x) => x.context.id === q.diversityContext)?.iccKind === "icc_1_reml" ? " (approximate: REML ICC(1) with the ANOVA pooled SD)" : ""}.` : "Per-band SD across the development spectra of the noise context (no replicate groups).",
      } : {}),
    },
    unavailable: {
      ...(r ? {} : { repeatability_sd: "Not available: no technical replicate groups have been declared.", icc: "Not available: no technical replicate groups have been declared." }),
      ...(q ? {} : { noise_proxy: "Not available: the per-band noise proxy was not computed.", noise_to_diversity: "Not available: the per-band noise proxy was not computed." }),
    },
    repeats,
    noise,
  };
}
