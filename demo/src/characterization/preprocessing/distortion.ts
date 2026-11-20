// Latest per-band distortion profile of the configuration loaded in the explorer, shared with the
// spectral quality map. Null until the explorer has evaluated a unit-preserving pipeline.
import { useSyncExternalStore } from "react";
import type { Comparability } from "./catalog";
import type { Diagnostics } from "./evaluate";

/** Per-band diagnostics of one explorer matrix (raw subset or processed), read by the quality map. */
export interface BandDiagnostics {
  /** Diagnostics.events.spikeBands (Methods spectral_population_events_qc). */
  spikeBands: readonly number[] | null;
  jumpBands: readonly number[] | null;
  /** Spectra evaluated by the event kernel (denominator of the band frequencies). */
  observations: number;
  /** Diagnostics.profile.band (Methods preflight_noise_proxy). */
  noiseProxy: readonly (number | null)[] | null;
  /** Between-spectrum SD per band. */
  diversity: readonly (number | null)[];
  repeatabilitySd: readonly (number | null)[] | null;
  icc: readonly (number | null)[] | null;
}

/** Reshapes explorer diagnostics (no numerics). `n` = spectra of the evaluated matrix. */
export function bandDiagnostics(d: Diagnostics, n: number): BandDiagnostics {
  return {
    spikeBands: d.events?.spikeBands ?? null,
    jumpBands: d.events?.jumpBands ?? null,
    observations: d.events ? n : 0,
    noiseProxy: d.profile?.band ?? null,
    diversity: d.diversity,
    repeatabilitySd: d.repeat?.sd ?? null,
    icc: d.repeat?.icc ?? null,
  };
}

export interface DistortionProfile {
  sourceId: string;
  axis: readonly number[];
  /** |mean residual| / mean |raw| per band as a fraction (×100 for %); null where not evaluable; null as a whole when withheld (unit-changing pipeline). */
  values: readonly (number | null)[] | null;
  /** Human-readable pipeline label. */
  label: string;
  /** Spectra the profile was computed on. */
  n: number;
  /** Fine-scale variation reduction (%) of the same configuration; null when withheld. */
  fineScaleReductionPercent: number | null;
  /** Per-band diagnostics on the same subset before (`raw`) and after (`processed`) the pipeline. */
  bands?: { raw: BandDiagnostics; processed: BandDiagnostics; preservesUnits: boolean; comparability: Comparability } | undefined;
}

let current: DistortionProfile | null = null;
const listeners = new Set<() => void>();

export function publishDistortionProfile(profile: DistortionProfile | null) {
  current = profile;
  for (const l of listeners) l();
}

export const getDistortionProfile = () => current;

/** React hook: the explorer's current distortion profile for `sourceId` (null otherwise). */
export function useDistortionProfile(sourceId: string | null): DistortionProfile | null {
  const p = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
  return p && (sourceId === null || p.sourceId === sourceId) ? p : null;
}
