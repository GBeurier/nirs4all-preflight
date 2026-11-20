// Overview-card summaries of the repeatability and noise-proxy diagnostics.
// Shape: `{ id, status, title, headline, metrics[], comments[], unavailable }` — plain data, no JSX.
import { extractIntrinsic } from "nirs4all-ui/qualification";
import { dbToRelativeNoisePercent, quantile } from "../shared/derive";
import { NO_REPLICATES_COMMENT, fmt, noiseComments, noiseStats, repeatStats, repeatabilityComments } from "./comments";
import { noiseProfiles, repeatProfiles, typicalSignalLevel, type ProfileScope } from "./profiles";

export interface SummaryMetric {
  label: string;
  value: number | null;
  unit?: string;
  /** Ready-to-print value, "—" when null. */
  display: string;
}

export interface PanelSummary {
  id: "repeatability" | "noise_proxy";
  status: "computed" | "unavailable";
  title: string;
  /** One-line result for an overview card. */
  headline: string;
  metrics: SummaryMetric[];
  /** Deterministic interpretation lines (request §10). */
  comments: string[];
  /** Why the diagnostic is not available (null when computed). */
  unavailable: string | null;
}

const metric = (label: string, value: number | null, unit = "", digits = 3): SummaryMetric => ({ label, value, ...(unit ? { unit } : {}), display: value === null ? "—" : `${fmt(value, digits)}${unit ? ` ${unit}` : ""}` });

export const NO_REPLICATES_MESSAGE = "Technical repeatability is not available because no technical replicate groups have been declared. Configure physical sample identifiers and replicate groups in the dataset settings.";

const source = (scope: ProfileScope) => (scope.sourceId ? scope.input.sources.find((s) => s.source_id === scope.sourceId) : undefined);

export const medianSnrDb = (scope: ProfileScope): number | null => {
  const s = scope.sourceId ? extractIntrinsic(scope.view, scope.sourceId)?.signals["noise.signal_noise_db"] : undefined;
  return s && s.state.status === "computed" ? (s.median ?? quantile(s.values, 0.5)) : null;
};

export function repeatabilitySummary(scope: ProfileScope): PanelSummary {
  const src = source(scope);
  const title = "Per-band technical repeatability";
  const profiles = src && scope.sourceId ? repeatProfiles(scope.view, scope.sourceId) : [];
  if (!src || !profiles.length) {
    return { id: "repeatability", status: "unavailable", title, headline: "Not available: no technical replicate groups declared", metrics: [], comments: [NO_REPLICATES_COMMENT], unavailable: NO_REPLICATES_MESSAGE };
  }
  const p = profiles[0]!;
  const s = repeatStats(p);
  const unit = p.context.unit ?? src.signal_unit ?? "";
  const rc = p.uncertainty?.repeatCounts;
  return {
    id: "repeatability",
    status: "computed",
    title,
    headline: s.medianIcc === null ? `Median repeatability SD ${fmt(s.medianSd ?? NaN)}${unit ? ` ${unit}` : ""}` : `Median ICC ${fmt(s.medianIcc)} · median repeatability SD ${fmt(s.medianSd ?? NaN)}${unit ? ` ${unit}` : ""}`,
    metrics: [
      metric("Median repeatability SD", s.medianSd, unit),
      metric(p.iccKind === "icc_1_reml" ? "Median ICC(1) REML" : "Median ICC(1,1)", s.medianIcc),
      metric("ICC P5", s.p5Icc),
      metric("Share of evaluable bands", s.bands ? (100 * s.evaluable) / s.bands : null, "%", 3),
      metric("Physical samples", rc?.nGroups ?? p.context.physicalGroups ?? null),
      metric("Samples with ≥ 2 repeats", rc?.nRepeatedGroups ?? null),
    ],
    comments: repeatabilityComments(profiles, src.axis, src.axis_unit ?? ""),
    unavailable: null,
  };
}

export function noiseProxySummary(scope: ProfileScope): PanelSummary {
  const src = source(scope);
  const title = "Per-band noise proxy";
  const profiles = src && scope.sourceId ? noiseProfiles(scope.view, scope.input, scope.sourceId) : [];
  if (!src || !profiles.length) {
    return { id: "noise_proxy", status: "unavailable", title, headline: "Not computed", metrics: [], comments: [], unavailable: "The per-band noise proxy was not computed for this source." };
  }
  const level = typicalSignalLevel(scope.view, scope.sourceId!);
  const snr = medianSnrDb(scope);
  const p = profiles[0]!;
  const s = noiseStats(p, level);
  const unit = p.unit ?? src.signal_unit ?? "";
  return {
    id: "noise_proxy",
    status: "computed",
    title,
    headline: s.relativePooledPercent !== null ? `Pooled noise proxy ${fmt(p.pooled!)}${unit ? ` ${unit}` : ""} (${fmt(s.relativePooledPercent)}% of the typical signal level)` : `Pooled noise proxy ${p.pooled === null ? "—" : fmt(p.pooled)}${unit ? ` ${unit}` : ""}`,
    metrics: [
      metric("Pooled noise proxy", p.pooled, unit),
      metric("Relative pooled noise proxy", s.relativePooledPercent, "%"),
      metric("Median per-band noise proxy", s.median, unit),
      metric("P95 per-band noise proxy", s.p95, unit),
      metric("SNR-derived relative noise", snr === null ? null : dbToRelativeNoisePercent(snr), "%"),
      metric("Evaluable bands", p.nEvaluableBands),
    ],
    comments: noiseComments(profiles, level, snr, src.axis, src.axis_unit ?? "", unit),
    unavailable: null,
  };
}
