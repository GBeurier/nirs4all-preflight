// Measurement contexts of one source (instrument × campaign × repeat type), shared by the repeatability
// and noise-proxy blocks and the spectral quality map. The engine computes repeatability per
// (repeat type, instrument, campaign) and the noise proxy per (instrument, campaign); a context here is
// one repeatability context with the noise context of the same instrument and campaign, plus every noise
// context that has no repeatability context. Contexts are never pooled.
import type { NoiseProfile, RepeatProfile } from "./profiles";

export interface MeasurementContext {
  /** Stable key: repeat type | instrument | campaign. */
  key: string;
  /** Readable label: "rescan · instrument A · 2026-A" (empty parts omitted). */
  label: string;
  instrument: string;
  campaign: string;
  /** Technical repeat type; null for a noise-only context (no replicate groups). */
  repeatType: string | null;
  /** Index into `repeatProfiles(...)`, null when this context has no repeatability result. */
  repeatIndex: number | null;
  /** Index into `noiseProfiles(...)`, null when this context has no noise-proxy result. */
  noiseIndex: number | null;
}

const keyOf = (repeatType: string | null, instrument: string, campaign: string) => JSON.stringify([repeatType ?? "", instrument, campaign]);

export function contextLabel(repeatType: string | null, instrument: string, campaign: string): string {
  const parts = [repeatType ?? "no technical repeats", instrument || "default instrument", campaign || "default campaign"];
  return parts.join(" · ");
}

/** Repeatability contexts first (engine order), then noise-only contexts. */
export function measurementContexts(repeats: readonly RepeatProfile[], noise: readonly NoiseProfile[]): MeasurementContext[] {
  const out: MeasurementContext[] = [];
  const noiseAt = (instrument: string, campaign: string) => {
    const k = noise.findIndex((q) => q.instrument === instrument && q.campaign === campaign);
    return k >= 0 ? k : null;
  };
  repeats.forEach((r, k) => {
    const instrument = r.context.instrument ?? "";
    const campaign = r.context.campaign ?? "";
    const repeatType = r.context.repeatType ?? "technical";
    out.push({ key: keyOf(repeatType, instrument, campaign), label: contextLabel(repeatType, instrument, campaign), instrument, campaign, repeatType, repeatIndex: k, noiseIndex: noiseAt(instrument, campaign) });
  });
  noise.forEach((q, k) => {
    if (out.some((c) => c.noiseIndex === k)) return;
    out.push({ key: keyOf(null, q.instrument, q.campaign), label: contextLabel(null, q.instrument, q.campaign), instrument: q.instrument, campaign: q.campaign, repeatType: null, repeatIndex: null, noiseIndex: k });
  });
  return out;
}

/** The context of `key`, else the first one; null when the source has no context at all. */
export function pickContext(contexts: readonly MeasurementContext[], key: string | null): MeasurementContext | null {
  return contexts.find((c) => c.key === key) ?? contexts[0] ?? null;
}
