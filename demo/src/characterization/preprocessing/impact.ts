// "Impact on spectral characteristics" rows (request mockup image6): the overview indicators
// recomputed on the same explorer subset before and after the pipeline, with fixed diagnostics.
// Display arithmetic only (medians, shares, dB ↔ % conversion); every per-spectrum value comes
// from the Methods kernels run by the worker.
import { dbToRelativeNoisePercent } from "../shared/derive";
import type { Diagnostics, Evaluation } from "./evaluate";
import { medianOf } from "./metrics";

export type ImpactKey = "snr" | "relativeNoise" | "isolatedPeaks" | "abruptChanges" | "relativeDistance" | "distortion";

export interface ImpactRow {
  key: ImpactKey;
  label: string;
  unit: "dB" | "%" | "×";
  raw: number | null;
  /** "reference" marks the raw spectra as the zero-distortion reference. */
  rawReference?: boolean;
  processed: number | null;
  /** processed − raw (dB, percentage points or ×); null when withheld or not computable. */
  delta: number | null;
  /** Why the delta (or the processed value) is withheld; null when shown. */
  withheld: string | null;
  /** Spectra entering the row (denominator). */
  n: number;
}

const finiteOf = (xs: readonly (number | null)[] | null | undefined) => (xs ?? []).filter((v): v is number => v !== null && Number.isFinite(v));
const median = (xs: readonly (number | null)[] | null | undefined) => medianOf(finiteOf(xs));
const p95 = (xs: readonly (number | null)[] | null | undefined) => {
  const v = finiteOf(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const h = (v.length - 1) * 0.95, lo = Math.floor(h);
  return v[lo]! + (h - lo) * (v[Math.ceil(h)]! - v[lo]!);
};

/** Share (%) of evaluated spectra with at least one event; null when nothing was evaluated. */
export function affectedPercent(counts: readonly (number | null)[] | null | undefined): number | null {
  const v = finiteOf(counts);
  return v.length ? (100 * v.filter((c) => c > 0).length) / v.length : null;
}

/** P95 of the RMS distance to the mean spectrum, divided by the median mean |x| (× typical level). */
export function relativeDistance(d: Pick<Diagnostics, "reference" | "noise">): number | null {
  const dist = p95(d.reference);
  const level = median(d.noise?.meanAbs);
  return dist === null || level === null || !(Math.abs(level) > 1e-12) ? null : dist / level;
}

const NOT_SAME_SPACE = "not comparable (different spectral space)";
const SCALE_CHANGED = "not comparable (signal rescaled)";

export function impactRows(before: Diagnostics, evaluation: Evaluation | null, n: number): ImpactRow[] {
  const after = evaluation?.after ?? null;
  const space = evaluation?.comparability ?? "comparable";
  const units = evaluation?.preservesUnits ?? true;
  const derivative = space === "not_comparable";
  const pair = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  const row = (key: ImpactKey, label: string, unit: ImpactRow["unit"], raw: number | null, processed: number | null, withheld: string | null): ImpactRow => ({
    key,
    label,
    unit,
    raw,
    processed,
    delta: withheld ? null : pair(raw, processed),
    withheld,
    n,
  });
  const snrRaw = median(before.noise?.snrDb);
  const snrProc = after ? median(after.noise?.snrDb) : null;
  const distortion = evaluation?.metrics.relativeRmse;
  return [
    row("snr", "SNR (median)", "dB", snrRaw, snrProc, derivative ? NOT_SAME_SPACE : null),
    row("relativeNoise", "Relative noise", "%", snrRaw === null ? null : dbToRelativeNoisePercent(snrRaw), snrProc === null ? null : dbToRelativeNoisePercent(snrProc), derivative ? NOT_SAME_SPACE : null),
    row("isolatedPeaks", "Isolated peaks (spectra)", "%", affectedPercent(before.events?.spikes), after ? affectedPercent(after.events?.spikes) : null, derivative ? NOT_SAME_SPACE : null),
    row("abruptChanges", "Abrupt changes (spectra)", "%", affectedPercent(before.events?.jumps), after ? affectedPercent(after.events?.jumps) : null, derivative ? NOT_SAME_SPACE : null),
    row("relativeDistance", "Relative spectral distance (P95)", "×", relativeDistance(before), after ? relativeDistance(after) : null, derivative ? NOT_SAME_SPACE : units ? null : SCALE_CHANGED),
    {
      key: "distortion",
      label: "Spectral distortion (median relative RMSE)",
      unit: "%",
      raw: 0,
      rawReference: true,
      processed: distortion && !distortion.disabled ? distortion.value : null,
      delta: null,
      withheld: distortion?.disabled ? (derivative ? NOT_SAME_SPACE : SCALE_CHANGED) : null,
      n,
    },
  ];
}
