// Deterministic interpretive comments (request §10): small explicit rules `{ id, when, text }`, no
// text generation. A comment is emitted only when the computed result demonstrates it. The rules of
// the single-dimension indicators live with their owners (integrity, repeatability); this module holds
// the framework (ordering, deduplication) and the cross-cutting rules that need several dimensions.
import { flagAtLeast, runRegions } from "./bands";

export type Dimension = "integrity" | "noise" | "diversity" | "repeatability" | "cross";

/** Display order of the dimensions in the comment list; the three dimensions are never merged into a score. */
export const DIMENSION_ORDER: readonly Dimension[] = ["integrity", "noise", "diversity", "repeatability", "cross"];

export const DIMENSION_LABEL: Record<Dimension, string> = {
  integrity: "Spectral integrity",
  noise: "Spectral noise",
  diversity: "Spectral diversity",
  repeatability: "Repeatability",
  cross: "Across dimensions",
};

export interface CharacterizationComment {
  /** Stable rule id (or `<dimension>:<n>` for lines supplied by a summary); the unit of deduplication. */
  id: string;
  dimension: Dimension;
  text: string;
}

export interface CommentRule<C> {
  id: string;
  dimension: Dimension;
  when: (ctx: C) => boolean;
  text: (ctx: C) => string;
}

/** Evaluates the rules in declaration order; a rule that throws or yields empty text emits nothing. */
export function runRules<C>(rules: readonly CommentRule<C>[], ctx: C): CharacterizationComment[] {
  const out: CharacterizationComment[] = [];
  for (const rule of rules) {
    if (!rule.when(ctx)) continue;
    const text = rule.text(ctx).trim();
    if (text) out.push({ id: rule.id, dimension: rule.dimension, text });
  }
  return out;
}

/** Lines already written by a summary, wrapped so that they join the same ordered, deduplicated list. */
export const fromLines = (dimension: Dimension, lines: readonly string[] | null | undefined): CharacterizationComment[] => (lines ?? []).map((text, i) => ({ id: `${dimension}:${i}`, dimension, text }));

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Orders comments by dimension (integrity, noise, diversity, repeatability, then cross-cutting),
 * keeping each group's own order, and drops repeated rule ids and repeated texts.
 */
export function mergeComments(...groups: readonly (readonly CharacterizationComment[])[]): CharacterizationComment[] {
  const all = groups.flat();
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const kept: CharacterizationComment[] = [];
  for (const comment of all) {
    const key = normalize(comment.text);
    if (!key || seenIds.has(comment.id) || seenText.has(key)) continue;
    seenIds.add(comment.id);
    seenText.add(key);
    kept.push(comment);
  }
  return DIMENSION_ORDER.flatMap((d) => kept.filter((c) => c.dimension === d));
}

// --- cross-cutting rules ------------------------------------------------------------------------
// Statements that need two dimensions at once. Single-dimension statements (including the "several
// contiguous regions of elevated fine-scale variation" and the SNR-vs-proxy divergence rules) belong to
// the modules that own those indicators and reach this list through their summaries.

/** Noise-to-diversity class "substantial" of the request (exploratory): the elevated-region threshold. */
export const ELEVATED_RATIO = 0.3;
/** A region is a run of at least this many consecutive evaluable bands; a single band is never a region. */
export const MIN_REGION_BANDS = 3;
/** Spectra compared in the "lowest SNR" rule and the minimum overlap that is stated. */
export const MIN_LOW_SNR_SPECTRA = 5;
export const MIN_LOW_SNR_FLAGGED = 3;
/** Relative P95 distance over relative noise: large from this factor, same order below this one. */
export const DOMINANT_FACTOR = 10;
export const SAME_ORDER_FACTOR = 3;
/** Substantial distortion of a preprocessing, in % of the local mean absolute signal (indicative). */
export const DISTORTION_PERCENT = 5;
/** Fine-scale variation reduction (%) from which a preprocessing is said to reduce it. */
export const REDUCTION_PERCENT = 10;

export type Fmt = (v: number, digits?: number) => string;

export interface CrossContext {
  fmt: Fmt;
  axisUnit: string;
  /** Source axis (band order of every per-band array below). */
  axis: readonly number[];
  /** Per-band noise-to-diversity ratio (null = non-evaluable) and the wording of its denominator. */
  noiseToDiversity: { values: readonly (number | null)[]; basis: "sample" | "spectrum" } | null;
  /** Engine band counts of isolated peaks and abrupt changes combined, on the same axis. */
  eventBandCounts: readonly number[] | null;
  /** The lowest-SNR spectra (ids), those carrying any flagged event, and the dataset-wide flagged rate. */
  lowSnr: { ids: readonly string[]; flaggedIds: ReadonlySet<string>; flaggedRate: number | null } | null;
  /** Relative P95 spectral distance (× typical level) and relative noise from the median SNR (%). */
  scale: { relativeP95: number | null; relativeNoisePercent: number | null } | null;
  /** Whether technical repeatability could be computed, and whether the noise proxy was. */
  repeatability: "computed" | "unavailable";
  noiseProxy: "computed" | "unavailable";
  /** Selected preprocessing from the explorer, when one was evaluated on this source. */
  preprocessing: { label: string; fineScaleReductionPercent: number | null; distortion: readonly (number | null)[] | null; interval: { i0: number; i1: number } | null } | null;
}

/** "wavelength", "wavenumber" or "spectral" from the axis unit; no fixed NIR range is assumed. */
export function axisNoun(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/[\s^⁻¹-]/g, "");
  if (u === "nm" || u === "µm" || u === "μm" || u === "um" || u === "mm") return "wavelength";
  if (u === "cm" || u === "cm1" || u === "1/cm" || u === "wavenumber") return "wavenumber";
  return "spectral";
}

/** Contiguous runs (>= MIN_REGION_BANDS bands) of the ratio at or above the elevated threshold. */
export function elevatedRegions(ctx: CrossContext) {
  return runRegions(ctx.axis, flagAtLeast(ctx.noiseToDiversity?.values ?? [], ELEVATED_RATIO), MIN_REGION_BANDS);
}

/** Bands with flagged events inside the elevated regions, all flagged bands, and the elevated share of evaluable bands. */
export function eventsInElevatedRegions(ctx: CrossContext): { inside: number; flagged: number; coverage: number } | null {
  const counts = ctx.eventBandCounts;
  const ratio = ctx.noiseToDiversity?.values;
  if (!counts || !ratio || counts.length !== ratio.length) return null;
  const runs = elevatedRegions(ctx);
  const elevated = new Array<boolean>(ratio.length).fill(false);
  for (const r of runs) for (let i = r.start; i <= r.end; i++) elevated[i] = true;
  const evaluable = ratio.filter((v) => v !== null).length;
  const flagged = counts.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);
  const inside = counts.reduce((a, c, i) => a + (c > 0 && elevated[i] ? 1 : 0), 0);
  return evaluable > 0 ? { inside, flagged, coverage: elevated.filter(Boolean).length / evaluable } : null;
}

export const lowSnrOverlap = (ctx: CrossContext): { flagged: number; total: number } | null =>
  ctx.lowSnr ? { flagged: ctx.lowSnr.ids.filter((id) => ctx.lowSnr!.flaggedIds.has(id)).length, total: ctx.lowSnr.ids.length } : null;

/** Relative P95 distance divided by the relative noise (both relative to the typical signal level). */
export function distanceOverNoise(ctx: CrossContext): number | null {
  const p = ctx.scale?.relativeP95;
  const n = ctx.scale?.relativeNoisePercent;
  return p !== null && p !== undefined && n !== null && n !== undefined && p > 0 && n > 0 ? p / (n / 100) : null;
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) / 2;
  return (s[Math.floor(h)]! + s[Math.ceil(h)]!) / 2;
};

/** Median relative distortion (%) of the explorer's profile over the selected interval, else over all bands. */
export function preprocessingDistortion(ctx: CrossContext): { percent: number; scope: "interval" | "all" } | null {
  const p = ctx.preprocessing;
  if (!p?.distortion) return null;
  const inInterval = p.interval ? p.distortion.slice(Math.min(p.interval.i0, p.interval.i1), Math.max(p.interval.i0, p.interval.i1) + 1) : null;
  const finiteIn = (inInterval ?? []).filter((v): v is number => v !== null && Number.isFinite(v));
  const m = finiteIn.length ? median(finiteIn) : null;
  if (m !== null) return { percent: 100 * m, scope: "interval" };
  const all = median(p.distortion.filter((v): v is number => v !== null && Number.isFinite(v)));
  return all === null ? null : { percent: 100 * all, scope: "all" };
}

export const CROSS_RULES: readonly CommentRule<CrossContext>[] = [
  {
    id: "cross.low-snr-flagged",
    dimension: "cross",
    when: (ctx) => {
      const o = lowSnrOverlap(ctx);
      const rate = ctx.lowSnr?.flaggedRate;
      return !!o && o.total >= MIN_LOW_SNR_SPECTRA && o.flagged >= MIN_LOW_SNR_FLAGGED && o.flagged / o.total >= 0.5 && rate !== null && rate !== undefined && o.flagged / o.total >= 2 * rate;
    },
    text: (ctx) => {
      const o = lowSnrOverlap(ctx)!;
      return `${o.flagged} of the ${o.total} spectra with the lowest estimated SNR also carry a flagged isolated peak or abrupt change, against ${ctx.fmt(100 * ctx.lowSnr!.flaggedRate!, 3)}% of all spectra: the SNR estimate of these spectra may be driven by the flagged events.`;
    },
  },
  {
    id: "cross.events-in-elevated-regions",
    dimension: "cross",
    when: (ctx) => {
      const e = eventsInElevatedRegions(ctx);
      return !!e && e.flagged >= MIN_REGION_BANDS && e.inside / e.flagged >= 0.5 && e.inside / e.flagged >= 2 * e.coverage;
    },
    text: (ctx) => {
      const e = eventsInElevatedRegions(ctx)!;
      return `${e.inside} of the ${e.flagged} bands carrying flagged events lie inside the ${axisNoun(ctx.axisUnit)} regions of elevated fine-scale variation, which cover ${ctx.fmt(100 * e.coverage, 3)}% of the evaluable bands: the local noise proxy there may include the flagged events.`;
    },
  },
  {
    id: "cross.distance-dominates-noise",
    dimension: "cross",
    when: (ctx) => (distanceOverNoise(ctx) ?? 0) >= DOMINANT_FACTOR,
    text: (ctx) => `The 95th percentile spectral distance (${ctx.fmt(ctx.scale!.relativeP95!, 3)}× the typical signal level) is about ${ctx.fmt(distanceOverNoise(ctx)!, 3)} times the estimated fine-scale noise (${ctx.fmt(ctx.scale!.relativeNoisePercent!, 3)}% of the signal level): differences between spectra are large compared with fine-scale variation.`,
  },
  {
    id: "cross.distance-near-noise",
    dimension: "cross",
    when: (ctx) => {
      const r = distanceOverNoise(ctx);
      return r !== null && r <= SAME_ORDER_FACTOR;
    },
    text: (ctx) => `The 95th percentile spectral distance is only about ${ctx.fmt(distanceOverNoise(ctx)!, 3)} times the estimated fine-scale noise: differences between spectra are of the same order as fine-scale variation, so sample diversity may be hard to tell apart from noise.`,
  },
  {
    id: "cross.noise-proxy-only",
    dimension: "cross",
    when: (ctx) => ctx.repeatability === "unavailable" && ctx.noiseProxy === "computed",
    text: () => "The per-band noise proxy is the only estimate of local fine-scale variation available; it does not replace an experimental repeatability measurement.",
  },
  {
    id: "cross.preprocessing-distortion",
    dimension: "cross",
    when: (ctx) => {
      const d = preprocessingDistortion(ctx);
      return !!d && (ctx.preprocessing!.fineScaleReductionPercent ?? 0) >= REDUCTION_PERCENT && d.percent >= DISTORTION_PERCENT;
    },
    text: (ctx) => {
      const d = preprocessingDistortion(ctx)!;
      const where = d.scope === "interval" ? `in the selected ${axisNoun(ctx.axisUnit)} region` : "across the spectral range";
      return `The selected preprocessing (${ctx.preprocessing!.label}) reduces fine-scale variation by ${ctx.fmt(ctx.preprocessing!.fineScaleReductionPercent!, 3)}% but also introduces substantial spectral changes ${where} (median ${ctx.fmt(d.percent, 3)}% of the local mean absolute signal; indicative threshold ${DISTORTION_PERCENT}%).`;
    },
  },
];

export const crossComments = (ctx: CrossContext): CharacterizationComment[] => runRules(CROSS_RULES, ctx);
