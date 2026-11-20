// Plain-object summaries for the overview cards (agreed module contract). Pure functions of the
// scope: no hooks, no rendering; the panels use the same derivations.
import { extractIntrinsic } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { diversityComments, eventComments, snrComments } from "./comments";
import { contrastSnr, diversityStats, eventOverlap, eventPattern, eventStats, eventThreshold, readBandCounts, snrStats, type BandCounts, type DiversityStats, type EventStats, type SnrStats } from "./model";
import { makeFmt } from "./format";
import { quantile } from "../shared/derive";

type Base = Pick<Scope, "view" | "input" | "sourceId" | "locale">;

const sourceOf = (s: Base) => s.input.sources.find((x) => x.source_id === s.sourceId);

export interface IntegrityData {
  spikes: EventStats | null;
  jumps: EventStats | null;
  overlap: ReturnType<typeof eventOverlap>;
  spikeBands: BandCounts | null;
  jumpBands: BandCounts | null;
  threshold: number;
  comments: string[];
}

export function integrityData(s: Base): IntegrityData | null {
  const intrinsic = s.sourceId ? extractIntrinsic(s.view, s.sourceId) : null;
  if (!intrinsic || !s.sourceId) return null;
  const spikes = eventStats(intrinsic, "spike");
  const jumps = eventStats(intrinsic, "jump");
  const spikeBands = readBandCounts(s.view, s.sourceId, "spike");
  const jumpBands = readBandCounts(s.view, s.sourceId, "jump");
  if (!spikes && !jumps && !spikeBands && !jumpBands) return null;
  const overlap = eventOverlap(spikes, jumps);
  const comments = eventComments(spikes, jumps, overlap, { spike: eventPattern(spikeBands), jump: eventPattern(jumpBands) }, sourceOf(s)?.axis_unit ?? "", makeFmt(s.locale));
  return { spikes, jumps, overlap, spikeBands, jumpBands, threshold: eventThreshold(s.input.options), comments };
}

export interface SnrData {
  stats: SnrStats;
  /** interim contrast SNR per spectrum (dB) */
  contrast: { id: string; value: number }[] | null;
  contrastMedianDb: number | null;
  comments: string[];
}

/** Contrast SNR reads every cell of the source: computed once per (report, source), shared by the overview and the panel. */
const contrastCache = new WeakMap<Base["view"], WeakMap<object, ReturnType<typeof contrastSnr>>>();

export function snrData(s: Base): SnrData | null {
  const intrinsic = s.sourceId ? extractIntrinsic(s.view, s.sourceId) : null;
  const stats = intrinsic ? snrStats(intrinsic) : null;
  if (!intrinsic || !stats) return null;
  const source = sourceOf(s);
  let contrast: ReturnType<typeof contrastSnr> = null;
  if (source) {
    const byView = contrastCache.get(s.view) ?? new WeakMap();
    contrastCache.set(s.view, byView);
    contrast = byView.has(source) ? byView.get(source)! : contrastSnr(intrinsic, source);
    byView.set(source, contrast);
  }
  const contrastMedianDb = contrast?.length ? quantile(contrast.map((c) => c.value), 0.5) : null;
  return { stats, contrast, contrastMedianDb, comments: snrComments(stats, contrastMedianDb, makeFmt(s.locale)) };
}

export interface DiversityData {
  stats: DiversityStats;
  unit: string;
  comments: string[];
}

export function diversityData(s: Base, snv: { kept: number; k: number } | null = null): DiversityData | null {
  const intrinsic = s.sourceId ? extractIntrinsic(s.view, s.sourceId) : null;
  const stats = intrinsic ? diversityStats(intrinsic) : null;
  if (!stats) return null;
  const unit = sourceOf(s)?.signal_unit ?? "signal units";
  return { stats, unit, comments: diversityComments(stats, unit, snv, makeFmt(s.locale)) };
}

/** Overview card: affected shares per event type (null fields when not computed). */
export function integritySummary(s: Base) {
  const d = integrityData(s);
  if (!d) return null;
  const pick = (e: EventStats | null) => (e ? { affected: e.affected, evaluated: e.evaluated, affectedPercent: e.affectedRatio === null ? null : 100 * e.affectedRatio, events: e.events, eventsPerAffected: e.perAffected } : null);
  return {
    spikes: pick(d.spikes),
    jumps: pick(d.jumps),
    either: d.overlap ? { count: d.overlap.either, total: d.overlap.total, percent: d.overlap.eitherRatio === null ? null : 100 * d.overlap.eitherRatio } : null,
    threshold: d.threshold,
    comments: d.comments,
  };
}

/** Overview card: median SNR (dB), linear ratio, relative noise (%), indicative band. */
export function snrSummary(s: Base) {
  const d = snrData(s);
  if (!d) return null;
  return { medianDb: d.stats.medianDb, linear: d.stats.linear, relativeNoisePercent: d.stats.relativeNoisePercent, indicativeBand: d.stats.band, p5Db: d.stats.p.p5, p95Db: d.stats.p.p95, n: d.stats.n, comments: d.comments };
}

/** Overview card: P95 distance, typical level (median mean|x|) and relative P95 (× typical level). */
export function diversitySummary(s: Base) {
  const d = diversityData(s);
  if (!d) return null;
  return { median: d.stats.median, p95: d.stats.p95, max: d.stats.max, typicalLevel: d.stats.typicalLevel, relativeP95: d.stats.relativeP95, unit: d.unit, n: d.stats.n, comments: d.comments };
}
