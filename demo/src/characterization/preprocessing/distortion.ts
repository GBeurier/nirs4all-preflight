// Latest per-band distortion profile of the configuration loaded in the explorer, shared with the
// spectral quality map. Null until the explorer has evaluated a unit-preserving pipeline.
import { useSyncExternalStore } from "react";

export interface DistortionProfile {
  sourceId: string;
  axis: readonly number[];
  /** |mean residual| / mean |raw| per band as a fraction (×100 for %); null where not evaluable. */
  values: readonly (number | null)[];
  /** Human-readable pipeline label. */
  label: string;
  /** Spectra the profile was computed on. */
  n: number;
  /** Fine-scale variation reduction (%) of the same configuration; null when withheld. */
  fineScaleReductionPercent: number | null;
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
