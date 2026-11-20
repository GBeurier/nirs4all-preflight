// Reads the summaries of the integrity and repeatability modules for one source and merges their
// comment lines with the cross-cutting rules. Plain objects, no JSX: the overview cards and tests share it.
import type { Scope } from "../../Sections";
import { extractIntrinsic } from "nirs4all-ui/qualification";
import { eventOverlap, eventStats, readBandCounts, snrStats } from "../integrity/model";
import { diversitySummary, integritySummary, snrSummary } from "../integrity/summaries";
import { fmt } from "../repeatability/comments";
import { bandProfiles } from "../repeatability/profiles";
import { noiseProxySummary, repeatabilitySummary, type PanelSummary } from "../repeatability/summary";
import { crossComments, fromLines, mergeComments, type CharacterizationComment, type CrossContext } from "./comments";

export type OverviewScope = Pick<Scope, "view" | "input" | "sourceId" | "locale">;

export interface OverviewModel {
  integrity: ReturnType<typeof integritySummary>;
  snr: ReturnType<typeof snrSummary>;
  diversity: ReturnType<typeof diversitySummary>;
  repeatability: PanelSummary | null;
  noiseProxy: PanelSummary | null;
  /** Context of the cross-cutting rules (without any preprocessing state); null when the source is unknown. */
  cross: CrossContext | null;
  comments: CharacterizationComment[];
}

/** Evaluated preprocessing of the explorer, as read by the cross-cutting rules. */
export type PreprocessingState = NonNullable<CrossContext["preprocessing"]>;

/** Cross-cutting comments once the explorer has evaluated a pipeline (its published profile): merged into the model's list. */
export function withPreprocessing(model: OverviewModel, preprocessing: PreprocessingState | null): CharacterizationComment[] {
  return model.cross && preprocessing ? mergeComments(model.comments, crossComments({ ...model.cross, preprocessing })) : model.comments;
}

/**
 * Cross-dimension context from the owner modules' own derivations (cheap ones: event statistics, SNR
 * order statistics, band counts, ratio profile); the cards' summaries are passed in, never recomputed.
 */
export function crossContext(scope: OverviewScope, parts: Pick<OverviewModel, "snr" | "diversity" | "repeatability" | "noiseProxy">): CrossContext | null {
  const source = scope.sourceId ? scope.input.sources.find((s) => s.source_id === scope.sourceId) : undefined;
  const intrinsic = scope.sourceId ? extractIntrinsic(scope.view, scope.sourceId) : null;
  if (!source || !scope.sourceId) return null;
  const spikes = intrinsic ? eventStats(intrinsic, "spike") : null;
  const jumps = intrinsic ? eventStats(intrinsic, "jump") : null;
  const overlap = eventOverlap(spikes, jumps);
  const snr = intrinsic ? snrStats(intrinsic) : null;
  const spikeBands = readBandCounts(scope.view, scope.sourceId, "spike");
  const jumpBands = readBandCounts(scope.view, scope.sourceId, "jump");
  const sameAxis = (b: { counts: readonly number[] } | null) => (b && b.counts.length === source.axis.length ? b.counts : null);
  const spikeCounts = sameAxis(spikeBands);
  const jumpCounts = sameAxis(jumpBands);
  const flaggedIds = new Set([...(spikes?.ranked ?? []), ...(jumps?.ranked ?? [])].map((r) => r.observationId));
  const profiles = bandProfiles(scope);
  // Either rate: spectra with at least one event of either type over the evaluated spectra.
  const flaggedRate = overlap?.eitherRatio ?? (spikes ?? jumps)?.affectedRatio ?? null;
  return {
    fmt,
    axisUnit: source.axis_unit ?? "",
    axis: source.axis,
    noiseToDiversity: profiles?.noiseToDiversity ? { values: profiles.noiseToDiversity, basis: profiles.diversityKind === "between-sample" ? "sample" : "spectrum" } : null,
    eventBandCounts: spikeCounts || jumpCounts ? source.axis.map((_, i) => ((spikeCounts?.[i] ?? 0) > 0 || (jumpCounts?.[i] ?? 0) > 0 ? 1 : 0)) : null,
    lowSnr: snr && snr.noisiest.length ? { ids: snr.noisiest.map((n) => n.observationId), flaggedIds, flaggedRate } : null,
    scale: { relativeP95: parts.diversity?.relativeP95 ?? null, relativeNoisePercent: parts.snr?.relativeNoisePercent ?? null },
    repeatability: parts.repeatability?.status === "computed" ? "computed" : "unavailable",
    noiseProxy: parts.noiseProxy?.status === "computed" ? "computed" : "unavailable",
    preprocessing: null,
  };
}

export function overviewModel(scope: OverviewScope): OverviewModel {
  const integrity = integritySummary(scope);
  const snr = snrSummary(scope);
  const diversity = diversitySummary(scope);
  const repeatability = scope.sourceId && scope.input.options.analysis_families?.repeatability !== false ? repeatabilitySummary(scope) : null;
  const noiseProxy = scope.sourceId ? noiseProxySummary(scope) : null;
  const cross = crossContext(scope, { snr, diversity, repeatability, noiseProxy });
  const comments = mergeComments(
    fromLines("integrity", integrity?.comments),
    fromLines("noise", [...(snr?.comments ?? []), ...(noiseProxy?.comments ?? [])]),
    fromLines("diversity", diversity?.comments),
    fromLines("repeatability", repeatability?.comments),
    cross ? crossComments(cross) : [],
  );
  return { integrity, snr, diversity, repeatability, noiseProxy, cross, comments };
}
