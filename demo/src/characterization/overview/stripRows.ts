// Quality-map tracks → labelled rows of segmented colour strips (image (15) layout). Categorical tracks keep
// their indicative classes; sequential tracks are binned into 5 equal-width classes of their own domain,
// labelled with value ranges (colour is never the only carrier: every class has a text label and share).
import type { StripRow } from "../shared/charts";
import { categoryOf, type QualityTrack, type TrackId } from "./tracks";

/** Row order of the mockup, then the other tracks. */
export const STRIP_ORDER: readonly TrackId[] = ["noise_proxy", "icc", "spike_frequency", "jump_frequency", "noise_to_diversity", "distortion", "repeatability_sd", "diversity"];
export const STRIP_LABEL: Record<TrackId, string> = { noise_proxy: "Noise", icc: "ICC", spike_frequency: "Spikes", jump_frequency: "Jumps", noise_to_diversity: "Noise / diversity", distortion: "Distortion", repeatability_sd: "Repeatability SD", diversity: "Diversity" };

const STEPS = 5;
/** Ramp steps picked from a 9-step ramp for the 5 classes (light → dark). */
const PICK = [1, 3, 5, 6, 8];

export function sequentialClass(domain: [number, number], v: number): number {
  if (!(domain[1] > domain[0])) return 0;
  return Math.min(STEPS - 1, Math.max(0, Math.floor(((v - domain[0]) / (domain[1] - domain[0])) * STEPS)));
}

/** Maximum number of segments drawn per row (image (15) shows a few coarse segments, not one cell per band). */
export const MAX_SEGMENTS = 48;

/**
 * Coarsens a per-band series into at most `segments` equal windows: every band takes its window's
 * aggregate (the track's own extreme, `max` or `min`, so a local problem is never averaged away);
 * a window with no evaluable band stays null.
 */
export function windowed(values: readonly (number | null)[], aggregate: "max" | "min", segments = MAX_SEGMENTS): (number | null)[] {
  const n = values.length;
  if (n <= segments) return [...values];
  const size = Math.ceil(n / segments);
  const out: (number | null)[] = new Array(n).fill(null);
  for (let a = 0; a < n; a += size) {
    let agg: number | null = null;
    for (let i = a; i < Math.min(n, a + size); i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      agg = agg === null ? v : aggregate === "max" ? Math.max(agg, v) : Math.min(agg, v);
    }
    for (let i = a; i < Math.min(n, a + size); i++) out[i] = agg;
  }
  return out;
}

export function stripRow(track: QualityTrack, fmt: (v: number, digits?: number) => string): StripRow {
  const coarse = windowed(track.values, track.aggregate);
  if (track.kind === "categorical") {
    return {
      id: track.id,
      label: STRIP_LABEL[track.id],
      values: coarse.map((v) => categoryOf(track, v)?.id ?? null),
      bandValues: track.values.map((v) => categoryOf(track, v ?? null)?.id ?? null),
      classes: track.categories.map((c) => ({ id: c.id, label: c.label.replace(/ \(kept as estimated\)$/, ""), color: c.color })),
    };
  }
  const domain = track.domain;
  const flat = !domain || !(domain[1] > domain[0]);
  const classes = flat
    ? [{ id: "c0", label: domain ? `${fmt(domain[0])} at every band${track.unit ? ` (${track.unit})` : ""}` : "—", color: "var(--cz-bar)" }]
    : Array.from({ length: STEPS }, (_, k) => {
        const lo = domain[0] + ((domain[1] - domain[0]) * k) / STEPS;
        const hi = domain[0] + ((domain[1] - domain[0]) * (k + 1)) / STEPS;
        return { id: `c${k}`, label: `${fmt(lo, 2)}–${fmt(hi, 2)}`, color: track.ramp[PICK[k]!]! };
      });
  const classOf = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || !domain ? null : flat ? "c0" : `c${sequentialClass(domain, v)}`);
  return {
    id: track.id,
    label: STRIP_LABEL[track.id],
    values: coarse.map(classOf),
    bandValues: track.values.map(classOf),
    classes,
  };
}

export const stripRows = (tracks: readonly QualityTrack[], fmt: (v: number, digits?: number) => string): StripRow[] =>
  [...tracks].filter((t) => !t.unavailable).sort((a, b) => STRIP_ORDER.indexOf(a.id) - STRIP_ORDER.indexOf(b.id)).map((t) => stripRow(t, fmt));
