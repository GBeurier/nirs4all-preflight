// Tracks of the spectral quality map: one row per local diagnostic on the shared spectral axis,
// each with its own scale and legend. Sequential scales for intensities; categorical classes
// only where explicit indicative bands exist (Koo & Li ICC bands, noise-to-diversity bands).
// No red/green pair anywhere, and none for diversity: ordered single-hue ramps plus text labels.
import { iccBand, noiseDiversityBand, type IccBand, type NoiseDiversityBand } from "../shared/derive";

export type TrackId = "repeatability_sd" | "icc" | "noise_proxy" | "noise_to_diversity" | "spike_frequency" | "jump_frequency" | "distortion" | "diversity";

export interface Category {
  id: string;
  label: string;
  color: string;
  /** Inclusive lower bound of the class, for the legend text. */
  range: string;
}

export interface QualityTrack {
  id: TrackId;
  label: string;
  /** Unit of the values (signal unit, fraction, ratio); null for unitless categories. */
  unit: string | null;
  /** Values in source-axis order; null = non-evaluable band (grey hatch). */
  values: (number | null)[];
  kind: "sequential" | "categorical";
  /** Colour ramp (light to dark) of a sequential track. */
  ramp: readonly string[];
  /** Sequential domain [min, max] of the evaluable values; null when none. */
  domain: [number, number] | null;
  categories: readonly Category[];
  /** Which extreme a binned column keeps when bands are merged for drawing. */
  aggregate: "max" | "min";
  /** Where the number comes from: the engine report, a Methods kernel, or an interim demo derivation. */
  origin: "engine" | "derived" | "interim";
  /** Estimator parameters and provenance shown under the track legend. */
  provenance: string;
  /** Detailed panel that opens when a band of the track is clicked. */
  panel: "s-repeat" | "s-quality" | "s-preprocessing";
  /** Present when the track cannot be drawn (e.g. no replicate groups): the reason replaces the strip. */
  unavailable: string | null;
}

export const NON_EVALUABLE_COLOR = "#9aa3ad";
export const NON_EVALUABLE_LABEL = "Not evaluable";

// ColorBrewer sequential ramps (9 steps, light to dark): colour-blind safe, perceptually ordered.
export const RAMPS = {
  blues: ["#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
  oranges: ["#fff5eb", "#fee6ce", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#a63603", "#7f2704"],
  purples: ["#fcfbfd", "#efedf5", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#54278f", "#3f007d"],
  browns: ["#ffffe5", "#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#993404", "#662506"],
  teals: ["#f7fcfd", "#e0ecf4", "#bfd3e6", "#9ebcda", "#8c96c6", "#8c6bb1", "#88419d", "#810f7c", "#4d004b"],
} as const;

/** Ramp colour of `value` within `domain` (linear); the lightest step when the domain is degenerate (no contrast to show). */
export function rampColor(ramp: readonly string[], domain: readonly [number, number] | null, value: number): string {
  if (!domain || !(domain[1] > domain[0])) return ramp[0]!;
  const t = Math.min(1, Math.max(0, (value - domain[0]) / (domain[1] - domain[0])));
  return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]!;
}

export const ICC_CATEGORIES: readonly Category[] = [
  { id: "negative", label: "Negative (kept as estimated)", color: "#fdd0a2", range: "ICC < 0" },
  { id: "poor", label: "Poor", color: "#c6dbef", range: "0 ≤ ICC < 0.50" },
  { id: "moderate", label: "Moderate", color: "#6baed6", range: "0.50 ≤ ICC < 0.75" },
  { id: "good", label: "Good", color: "#2171b5", range: "0.75 ≤ ICC < 0.90" },
  { id: "excellent", label: "Excellent", color: "#08306b", range: "ICC ≥ 0.90" },
];
export const RATIO_CATEGORIES: readonly Category[] = [
  { id: "low", label: "Low relative to diversity", color: "#fee6ce", range: "< 0.10" },
  { id: "moderate", label: "Moderate", color: "#fdae6b", range: "0.10 – 0.30" },
  { id: "substantial", label: "Substantial", color: "#d94801", range: "0.30 – 1.00" },
  { id: "exceeds", label: "Exceeds observed diversity", color: "#7f2704", range: "≥ 1.00" },
];

/** Category of an ICC value; negative values keep their own class instead of being clipped to poor. */
export const iccCategory = (icc: number): Category => ICC_CATEGORIES.find((c) => c.id === (icc < 0 ? "negative" : (iccBand(icc) satisfies IccBand)))!;
export const ratioCategory = (ratio: number): Category => RATIO_CATEGORIES.find((c) => c.id === (noiseDiversityBand(ratio) satisfies NoiseDiversityBand))!;

/** Finite values kept, everything else (null, NaN, infinity) becomes the non-evaluable null. */
const clean = (series: readonly (number | null | undefined)[] | null | undefined): (number | null)[] => (series ?? []).map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : v));

const extent = (values: readonly (number | null)[]): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
};

/** Per-band profiles read from the repeatability module (source order); every series is optional. */
export interface BandProfileInput {
  axis: readonly number[];
  repeatabilitySd?: readonly (number | null)[] | null;
  /** Per-band diversity SD: between-sample with replicate groups, else between-spectrum (see `diversityBasis`). */
  diversity?: readonly (number | null)[] | null;
  icc?: readonly (number | null)[] | null;
  noiseProxy?: readonly (number | null)[] | null;
  noiseToDiversity?: readonly (number | null)[] | null;
  /** Signal unit of the SD / noise series. */
  unit?: string | null;
  /** Reasons a series is missing, shown instead of an empty strip. */
  unavailable?: Partial<Record<TrackId, string>>;
  /** Estimator provenance lines (window, polynomial order, ICC model …) keyed by track. */
  provenance?: Partial<Record<TrackId, string>>;
  /** Wording of the between-sample denominator: "sample" with replicate groups, else "spectrum". */
  diversityBasis?: "sample" | "spectrum";
}

/** Band-wise event counts of the engine (`global_*_band_counts`) with the spectra they refer to. */
export interface EventBandInput {
  axis: readonly number[];
  counts: readonly number[];
}

export interface TrackInputs {
  profiles: BandProfileInput | null;
  spikes: EventBandInput | null;
  jumps: EventBandInput | null;
  /** Observations behind the band counts (denominator of the event frequency). */
  observations: number;
  /** Preprocessing distortion per band when the explorer exports one (same axis as `axis`). */
  distortion?: { axis: readonly number[]; values: readonly (number | null)[]; unit: string | null; provenance: string } | null;
  /** Source axis the map is drawn on. */
  axis: readonly number[];
  /** Provenance of the event band counts when they do not come from the engine report (e.g. the explorer). */
  eventsProvenance?: string | undefined;
}

const NOT_COMPUTED_DISTORTION = "Not computed: open the preprocessing explorer to evaluate a configuration.";

/** Resamples a series defined on another axis onto the map axis, only when the axes are identical. */
function onSameAxis(axis: readonly number[], other: readonly number[], values: readonly (number | null | undefined)[]): readonly (number | null | undefined)[] | null {
  return other.length === axis.length && other.every((x, i) => x === axis[i]) ? values : null;
}

const base = (id: TrackId, label: string, unit: string | null, panel: QualityTrack["panel"]): Omit<QualityTrack, "values" | "kind" | "ramp" | "domain" | "categories" | "aggregate" | "origin" | "provenance" | "unavailable"> => ({ id, label, unit, panel });

/** Builds the tracks in display order, aligned with `input.axis` (source-axis order). */
export function buildTracks(input: TrackInputs): QualityTrack[] {
  const p = input.profiles;
  const basis = p?.diversityBasis === "sample" ? "sample" : "spectrum";
  const same = (series: readonly (number | null | undefined)[] | null | undefined) => (p && series ? onSameAxis(input.axis, p.axis, series) : null);
  const sequential = (id: TrackId, label: string, unit: string | null, panel: QualityTrack["panel"], series: readonly (number | null | undefined)[] | null | undefined, ramp: readonly string[], provenance: string, absent: string, origin: QualityTrack["origin"] = "engine", zeroBased = false): QualityTrack => {
    const values = clean(series);
    const found = extent(values);
    // Frequencies start at zero: "no spectrum affected" must be the lightest step, never a mid-scale colour.
    const domain: [number, number] | null = found && zeroBased && found[0] >= 0 ? [0, found[1]] : found;
    const missing = !series || !domain;
    return { ...base(id, label, unit, panel), values, kind: "sequential", ramp, domain, categories: [], aggregate: "max", origin, provenance, unavailable: missing ? (p?.unavailable?.[id] ?? absent) : null };
  };
  const categorical = (id: TrackId, label: string, panel: QualityTrack["panel"], series: readonly (number | null | undefined)[] | null | undefined, categories: readonly Category[], provenance: string, absent: string, aggregate: "max" | "min"): QualityTrack => {
    const values = clean(series);
    const missing = !series || extent(values) === null;
    return { ...base(id, label, null, panel), values, kind: "categorical", ramp: [], domain: extent(values), categories, aggregate, origin: "engine", provenance, unavailable: missing ? (p?.unavailable?.[id] ?? absent) : null };
  };
  const frequency = (id: TrackId, label: string, events: EventBandInput | null) => {
    const counts = events ? onSameAxis(input.axis, events.axis, events.counts) : null;
    const share = counts && input.observations > 0 ? counts.map((c) => (c === null || c === undefined ? null : c / input.observations)) : null;
    return sequential(id, label, "fraction of spectra", "s-quality", share, RAMPS.browns, `${input.eventsProvenance ?? "Engine band counts"} divided by ${input.observations} spectra; a spike also counts on its two neighbouring bands.`, "Not computed: intrinsic events were not requested or have no band counts.", input.eventsProvenance ? "derived" : "engine", true);
  };
  const distortion = input.distortion ? onSameAxis(input.axis, input.distortion.axis, input.distortion.values) : null;
  const ratio = same(p?.noiseToDiversity);
  const icc = same(p?.icc);
  return [
    sequential("repeatability_sd", "Repeatability SD", p?.unit ?? null, "s-repeat", same(p?.repeatabilitySd), RAMPS.blues, p?.provenance?.repeatability_sd ?? "Pooled within-sample SD of declared technical replicate groups (engine measurement.repeatability_sd).", "Not available: no technical replicate groups have been declared."),
    categorical("icc", "Repeatability ICC", "s-repeat", icc, ICC_CATEGORIES, p?.provenance?.icc ?? "ICC(1,1), one-way random effects (engine measurement.icc_1_1). Indicative bands from Koo & Li (2016), not NIR-specific criteria.", "Not available: no technical replicate groups have been declared.", "min"),
    sequential("noise_proxy", "Local noise proxy", p?.unit ?? null, "s-repeat", same(p?.noiseProxy), RAMPS.oranges, p?.provenance?.noise_proxy ?? "Savitzky–Golay residual spread per band (engine measurement.noise_proxy).", "Not available: the per-band noise proxy was not computed."),
    categorical("noise_to_diversity", `Noise-to-diversity ratio (noise proxy / between-${basis} SD)`, "s-repeat", ratio, RATIO_CATEGORIES, p?.provenance?.noise_to_diversity ?? `Per-band noise proxy divided by the between-${basis} SD; null where the denominator is zero or negligible. Exploratory bands, not metrologically validated.`, "Not available: needs both a per-band noise proxy and a between-spectrum SD.", "max"),
    frequency("spike_frequency", "Isolated peak frequency", input.spikes),
    frequency("jump_frequency", "Abrupt change frequency", input.jumps),
    distortion
      ? sequential("distortion", "Preprocessing distortion", input.distortion?.unit ?? null, "s-preprocessing", distortion, RAMPS.purples, input.distortion?.provenance ?? "", "", "derived")
      : { ...sequential("distortion", "Preprocessing distortion", null, "s-preprocessing", null, RAMPS.purples, "", NOT_COMPUTED_DISTORTION, "derived"), unavailable: NOT_COMPUTED_DISTORTION },
    sequential("diversity", `Between-${basis} diversity (SD)`, p?.unit ?? null, "s-repeat", same(p?.diversity), RAMPS.teals, p?.provenance?.diversity ?? `Per-band SD across ${basis === "sample" ? "physical sample means" : "spectra"}; spectral diversity is not a quality defect and carries no good/bad colouring.`, "Not available: the between-sample SD profile was not computed."),
  ];
}

/** Class (categorical) or `null` for one band value of a track. */
export function categoryOf(track: QualityTrack, value: number | null): Category | null {
  if (value === null || track.kind !== "categorical") return null;
  return track.id === "icc" ? iccCategory(value) : ratioCategory(value);
}

/** Fill colour of a band value: grey for non-evaluable, class colour or ramp step otherwise. */
export function colorOf(track: QualityTrack, value: number | null): string {
  if (value === null) return NON_EVALUABLE_COLOR;
  const category = categoryOf(track, value);
  return category ? category.color : rampColor(track.ramp, track.domain, value);
}

/** Share of bands in each class (a stacked-bar legend): evaluable and non-evaluable counts included. */
export function categoryShares(track: QualityTrack): { category: Category | null; count: number }[] {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const v of track.values) {
    const c = categoryOf(track, v);
    if (c) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    else missing += 1;
  }
  return [...track.categories.map((category) => ({ category, count: counts.get(category.id) ?? 0 })), { category: null, count: missing }];
}

export interface TrackSummary {
  id: TrackId;
  /** Bands of the interval (denominator) and those with an evaluable value. */
  bands: number;
  evaluable: number;
  min: number | null;
  max: number | null;
  /** Class counts of a categorical track, most affected classes included (zero counts omitted). */
  classes: { label: string; count: number }[];
}

/** Local values of every drawable track over the inclusive band interval [i0, i1]. */
export function summarizeInterval(tracks: readonly QualityTrack[], i0: number, i1: number): TrackSummary[] {
  const a = Math.max(0, Math.min(i0, i1));
  const b = Math.max(i0, i1);
  return tracks.filter((t) => !t.unavailable).map((t) => {
    const slice = t.values.slice(a, b + 1);
    const finiteValues = slice.filter((v): v is number => v !== null);
    const counts = new Map<string, number>();
    for (const v of finiteValues) {
      const c = categoryOf(t, v);
      if (c) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
    }
    return {
      id: t.id,
      bands: slice.length,
      evaluable: finiteValues.length,
      min: finiteValues.length ? Math.min(...finiteValues) : null,
      max: finiteValues.length ? Math.max(...finiteValues) : null,
      classes: [...counts].map(([label, count]) => ({ label, count })),
    };
  });
}
