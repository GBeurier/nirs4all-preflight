// Deterministic interpretive comments (request §10). Each rule fires only when the computed
// result demonstrates it; thresholds are stated in the rule and covered by comments.test.ts.
import type { DiversityStats, EventStats, SnrStats, eventOverlap, eventPattern } from "./model";

export type Fmt = (v: number, digits?: number) => string;

const pct = (r: number, f: Fmt) => `${f(r * 100, 3)}%`;
const NAME = { spike: "isolated peak", jump: "abrupt change" } as const;

/**
 * Event comments. Concentration: ≥ 3 affected spectra and at most max(1, ⌊20% of them⌋) hold ≥ 80%
 * of the events. Dispersion: ≥ 10 affected spectra and none carries more than 2 events.
 */
export function eventComments(
  spikes: EventStats | null,
  jumps: EventStats | null,
  overlap: ReturnType<typeof eventOverlap>,
  patterns: { spike: ReturnType<typeof eventPattern>; jump: ReturnType<typeof eventPattern> },
  axisUnit: string,
  f: Fmt,
): string[] {
  const out: string[] = [];
  for (const s of [spikes, jumps]) {
    if (!s || s.evaluated === 0) continue;
    const name = NAME[s.type];
    if (s.affected === 0) {
      out.push(`No ${name} was flagged in any of the ${s.evaluated} evaluated spectra.`);
      continue;
    }
    out.push(`${pct(s.affectedRatio!, f)} of spectra (${s.affected}/${s.evaluated}) contain at least one flagged ${name}.`);
    if (s.affected >= 3 && s.top80 && s.top80.spectra <= Math.max(1, Math.floor(0.2 * s.affected))) {
      out.push(`Flagged ${name}s are concentrated in a small number of spectra: ${s.top80.spectra} of the ${s.affected} flagged spectra hold 80% of the events.`);
    } else if (s.affected >= 10 && s.maxPerSpectrum <= 2) {
      out.push(`Flagged ${name}s are dispersed: no spectrum carries more than ${s.maxPerSpectrum} event${s.maxPerSpectrum > 1 ? "s" : ""}.`);
    }
    const p = patterns[s.type];
    const u = axisUnit ? ` ${axisUnit}` : "";
    if (p.kind === "regional") {
      out.push(`${name[0]!.toUpperCase()}${name.slice(1)} flags recur in one spectral region (${f(p.region.start)}–${f(p.region.end)}${u}): ${pct(p.region.share, f)} of band-level flags fall within ${pct(p.region.width, f)} of the bands.`);
    } else if (p.kind === "spread") {
      out.push(`${name[0]!.toUpperCase()}${name.slice(1)} flags are spread across the spectral range (${pct(p.coverage, f)} of bands carry at least one flag).`);
    }
  }
  if (overlap && overlap.both > 0) {
    out.push(`${overlap.both} spectra (${pct(overlap.bothRatio!, f)}) carry both isolated peaks and abrupt changes; ${overlap.either} (${pct(overlap.eitherRatio!, f)}) carry at least one of the two.`);
  }
  return out;
}

/** SNR comments. Spread: P95 − P5 ≥ 20 dB (a 10× amplitude ratio). Low tail: spectra ≥ 20 dB below the median. */
export function snrComments(s: SnrStats | null, contrastMedianDb: number | null, f: Fmt): string[] {
  if (!s) return [];
  const out = [`Fine-scale variation represents approximately ${f(s.relativeNoisePercent, 2)}% of the typical absolute signal amplitude (median estimated SNR ${f(s.medianDb, 3)} dB, about ${f(s.linear, 3)}:1).`];
  const spread = s.p.p95 - s.p.p5;
  if (spread >= 20) out.push(`Estimated SNR varies by ${f(spread, 3)} dB between the 5th and 95th percentiles (more than a tenfold amplitude ratio): fine-scale variation is heterogeneous across spectra.`);
  const low = s.entries.filter((e) => e.value <= s.medianDb - 20).length;
  if (low > 0) out.push(`${low} spectr${low > 1 ? "a have" : "um has"} an estimated SNR at least 20 dB (10×) below the median; inspect them first.`);
  if (contrastMedianDb !== null && Math.abs(contrastMedianDb - s.medianDb) >= 6) {
    out.push(`The contrast-based SNR (median ${f(contrastMedianDb, 3)} dB) differs by ${f(Math.abs(contrastMedianDb - s.medianDb), 2)} dB from the mean-level SNR: ${contrastMedianDb < s.medianDb ? "the mean absolute level exceeds the spectral contrast, consistent with a constant offset" : "the spectral contrast exceeds the mean absolute level"}.`);
  }
  return out;
}

/** Diversity comments. Heterogeneity statements use the P95/typical-level ratio; tail uses max ≥ 2 × P95. */
export function diversityComments(d: DiversityStats | null, unit: string, snv: { kept: number; k: number } | null, f: Fmt): string[] {
  if (!d) return [];
  const out: string[] = [];
  const u = unit ? ` ${unit}` : "";
  if (d.relativeP95 === null) {
    out.push(`95% of distances are at or below ${f(d.p95)}${u}; the relative distance is not available because the typical absolute signal level is zero, negligible or not computed.`);
  } else if (d.relativeP95 >= 1) {
    out.push(`The 95th percentile spectral distance is ${f(d.relativeP95, 3)} times the typical absolute signal level, indicating substantial spectral heterogeneity.`);
  } else if (d.relativeP95 < 0.1) {
    out.push(`The 95th percentile spectral distance is ${f(d.relativeP95 * 100, 3)}% of the typical absolute signal level: spectra stay close to the mean spectrum relative to the signal level.`);
  } else {
    out.push(`The 95th percentile spectral distance is ${f(d.relativeP95 * 100, 3)}% of the typical absolute signal level.`);
  }
  if (d.p95 > 0 && d.max >= 2 * d.p95) out.push(`The most distant spectrum lies ${f(d.max / d.p95, 3)} times further from the mean spectrum than the 95th percentile; inspect it individually.`);
  // Scale-free comparison: raw and SNV distances have different units, so only ranks are compared.
  if (snv && snv.k >= 5) {
    if (snv.kept <= snv.k / 2) out.push(`Only ${snv.kept} of the ${snv.k} spectra farthest from the mean remain among the ${snv.k} farthest after SNV: their raw distance mainly reflects overall level or scale differences.`);
    else if (snv.kept >= 0.8 * snv.k) out.push(`${snv.kept} of the ${snv.k} spectra farthest from the mean remain among the farthest after SNV: their distance reflects spectral shape, not only overall level.`);
  }
  return out;
}
