// Quality-map inputs recomputed on the preprocessing explorer's spectra. The explorer (agent C's module)
// runs the same Methods kernels as the engine families (events, noise proxy, repeatability) on its
// deterministic subset, before and after the pipeline, and publishes the per-band results with its
// distortion profile. This module only reshapes those published arrays into the map's track inputs: no
// numerics beyond the guarded noise / diversity ratio of the repeatability module.
import { guardedRatio, negligibleFloor } from "../repeatability/profiles";
import type { TrackInputs } from "./tracks";

/** Per-band diagnostics of one matrix of the explorer (raw subset or processed). */
export interface BandDiagnostics {
  spikeBands: readonly number[] | null;
  jumpBands: readonly number[] | null;
  /** Spectra evaluated by the event kernel (denominator of the band frequencies). */
  observations: number;
  noiseProxy: readonly (number | null)[] | null;
  /** Between-spectrum SD per band. */
  diversity: readonly (number | null)[];
  repeatabilitySd: readonly (number | null)[] | null;
  icc: readonly (number | null)[] | null;
}

/** Structural view of `preprocessing/distortion.ts` `DistortionProfile` with its optional per-band diagnostics. */
export interface PublishedBands {
  sourceId: string;
  axis: readonly number[];
  label: string;
  n: number;
  values: readonly (number | null)[] | null;
  bands?: { raw: BandDiagnostics; processed: BandDiagnostics; preservesUnits: boolean; comparability?: string } | undefined;
}

export type MapMode = "raw" | "subset" | "processed";

/** True when the explorer has published per-band diagnostics on the source's axis. */
export function hasPublishedBands(profile: PublishedBands | null, axis: readonly number[]): profile is PublishedBands & { bands: NonNullable<PublishedBands["bands"]> } {
  return !!profile?.bands && profile.axis.length === axis.length && profile.axis.every((x, i) => x === axis[i]);
}

/**
 * Map inputs from the explorer's published diagnostics (`mode` "subset" = raw subset, "processed" = after
 * the pipeline). The distortion track keeps the published distortion of the same pipeline.
 */
export function explorerTrackInputs(profile: PublishedBands & { bands: NonNullable<PublishedBands["bands"]> }, mode: Exclude<MapMode, "raw">, signalUnit: string): TrackInputs {
  const d = mode === "processed" ? profile.bands.processed : profile.bands.raw;
  const processed = mode === "processed";
  const unit = processed && !profile.bands.preservesUnits ? "processed units" : signalUnit || null;
  const floor = negligibleFloor(d.diversity, null);
  const ratio = d.noiseProxy ? d.noiseProxy.map((v, i) => guardedRatio(v, d.diversity[i], floor)) : null;
  const what = processed ? `the ${profile.n} spectra of the explorer subset after "${profile.label}"` : `the ${profile.n} raw spectra of the explorer subset`;
  const src = `Methods kernels run by the preprocessing explorer on ${what}`;
  return {
    axis: profile.axis,
    observations: d.observations,
    spikes: d.spikeBands ? { axis: profile.axis, counts: d.spikeBands } : null,
    jumps: d.jumpBands ? { axis: profile.axis, counts: d.jumpBands } : null,
    eventsProvenance: `Band counts of Methods spectral_population_events_qc on ${what}`,
    distortion: profile.values ? { axis: profile.axis, values: profile.values, unit: "fraction of mean |raw|", provenance: `Pipeline "${profile.label}" on ${profile.n} spectra: |mean residual| ÷ mean |raw| per band (explorer metric).` } : null,
    profiles: {
      axis: profile.axis,
      repeatabilitySd: d.repeatabilitySd,
      icc: d.icc,
      noiseProxy: d.noiseProxy,
      noiseToDiversity: ratio,
      diversity: d.diversity,
      unit,
      diversityBasis: "spectrum",
      provenance: {
        repeatability_sd: `Pooled within-group SD (Methods preflight_repeatability) of every declared technical repeat group of the subset (contexts pooled by the explorer), ${src}.`,
        icc: `ICC(1,1) (Methods preflight_repeatability) over every declared technical repeat group of the subset, ${src}. Indicative Koo & Li (2016) bands.`,
        noise_proxy: `Savitzky–Golay residual proxy (Methods preflight_noise_proxy, engine window and order), ${src}.`,
        noise_to_diversity: `Noise proxy / between-spectrum SD of the same spectra; null where the denominator is negligible. ${src}.`,
        diversity: `Per-band SD across ${what}.`,
      },
      unavailable: {
        ...(d.repeatabilitySd ? {} : { repeatability_sd: "Not available: fewer than two technical repeat groups in the explorer subset.", icc: "Not available: fewer than two technical repeat groups in the explorer subset." }),
        ...(d.noiseProxy ? {} : { noise_proxy: "Not available: the noise proxy kernel did not run on the explorer spectra.", noise_to_diversity: "Not available: the noise proxy kernel did not run on the explorer spectra." }),
      },
    },
  };
}
