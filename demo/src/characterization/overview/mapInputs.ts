// Reads the per-band diagnostics of one source from the engine report (through the owner modules of
// the characterization views) and turns them into the inputs of the spectral quality map.
import { extractIntrinsic, metricLabel, type QualificationReportView } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { readBandCounts } from "../integrity/model";
import { bandProfiles, type ContextChoice } from "../repeatability/profiles";
import type { TrackInputs } from "./tracks";

const REPLICATE_REASON = "Not available: no technical replicate groups have been declared.";

/** Reason a replicate-based metric is missing, from the engine's own availability state when reported. */
function replicateReason(view: QualificationReportView, sourceId: string, disabled: boolean): string | undefined {
  if (disabled) return "Not available: the technical repeatability analysis was turned off in the settings.";
  const states = view.metrics.filter((m) => m.sourceId === sourceId && m.id.startsWith("measurement.") && !m.id.startsWith("measurement.noise_proxy") && m.status !== "computed");
  if (!states.length) return REPLICATE_REASON;
  const first = states[0]!;
  return first.reasonCode ? `Not available (${metricLabel(first.id, "en")}: ${first.reasonCode}).` : REPLICATE_REASON;
}

/** Observations behind the event band counts: spectra with a computed per-spectrum event count. */
function eventObservations(view: QualificationReportView, sourceId: string): number {
  const intrinsic = extractIntrinsic(view, sourceId);
  const signal = intrinsic?.signals["events.spike_count"] ?? intrinsic?.signals["events.jump_count"];
  return signal && signal.state.status === "computed" ? signal.values.filter((v) => v !== null && Number.isFinite(v)).length : 0;
}

/** Inputs of every track for the selected source; null when the source has no axis. */
export function qualityMapInputs(scope: Pick<Scope, "view" | "input" | "sourceId">, distortion: TrackInputs["distortion"] = null, context: ContextChoice = {}): TrackInputs | null {
  const { view, input, sourceId } = scope;
  const source = sourceId ? input.sources.find((s) => s.source_id === sourceId) : undefined;
  if (!source || !sourceId || !source.axis.length) return null;
  const profiles = bandProfiles(scope, context);
  const disabled = input.options.analysis_families?.repeatability === false;
  const reason = replicateReason(view, sourceId, disabled);
  const spikes = readBandCounts(view, sourceId, "spike");
  const jumps = readBandCounts(view, sourceId, "jump");
  return {
    axis: source.axis,
    observations: eventObservations(view, sourceId),
    spikes: spikes ? { axis: spikes.axis, counts: spikes.counts } : null,
    jumps: jumps ? { axis: jumps.axis, counts: jumps.counts } : null,
    distortion,
    // The repeatability module's profiles already follow BandProfileInput: `diversity` is the between-sample SD
    // (replicate groups) or the between-spectrum SD, as stated by `diversityBasis`.
    profiles: profiles
      ? {
          axis: profiles.axis,
          repeatabilitySd: profiles.repeatabilitySd,
          icc: profiles.icc,
          noiseProxy: profiles.noiseProxy,
          noiseToDiversity: profiles.noiseToDiversity,
          diversity: profiles.diversity,
          unit: profiles.unit,
          diversityBasis: profiles.diversityBasis,
          provenance: profiles.provenance,
          // The engine's own availability state (or a disabled analysis) refines the module's generic reason.
          // (Only when no context has replicate groups: a context without repeats keeps the module's own reason.)
          unavailable: { ...profiles.unavailable, ...(reason && !profiles.repeatabilitySd && !profiles.repeats.length ? { repeatability_sd: reason, icc: reason } : {}) },
        }
      : null,
  };
}
