import { describe, expect, it } from "vitest";
import {
  CROSS_RULES,
  DISTORTION_PERCENT,
  axisNoun,
  crossComments,
  distanceOverNoise,
  elevatedRegions,
  eventsInElevatedRegions,
  fromLines,
  lowSnrOverlap,
  mergeComments,
  preprocessingDistortion,
  runRules,
  type CharacterizationComment,
  type CrossContext,
} from "./comments";

const fmt = (v: number, digits = 3) => String(Number(v.toPrecision(digits)));
const axis = Array.from({ length: 20 }, (_, i) => 1000 + 10 * i);
const base = (over: Partial<CrossContext> = {}): CrossContext => ({
  fmt,
  axisUnit: "nm",
  axis,
  noiseToDiversity: null,
  eventBandCounts: null,
  lowSnr: null,
  scale: null,
  repeatability: "computed",
  noiseProxy: "computed",
  preprocessing: null,
  ...over,
});
const ids = (c: CrossContext) => crossComments(c).map((x) => x.id);
/** Ratio profile with runs of 0.5 at the given [start, end] band ranges, 0.05 elsewhere. */
const ratio = (runs: [number, number][], n = 20) => Array.from({ length: n }, (_, i) => (runs.some(([a, b]) => i >= a && i <= b) ? 0.5 : 0.05));

describe("comment framework", () => {
  it("runRules emits only rules whose condition holds and drops empty text", () => {
    const rules = [
      { id: "a", dimension: "noise" as const, when: (n: number) => n > 1, text: (n: number) => `n=${n}` },
      { id: "b", dimension: "noise" as const, when: () => true, text: () => "  " },
    ];
    expect(runRules(rules, 2)).toEqual([{ id: "a", dimension: "noise", text: "n=2" }]);
    expect(runRules(rules, 1)).toEqual([]);
  });

  it("orders by dimension (integrity, noise, diversity, repeatability, cross) keeping the order within a group", () => {
    const merged = mergeComments(
      fromLines("cross", ["x1"]),
      fromLines("repeatability", ["r1", "r2"]),
      fromLines("diversity", ["d1"]),
      fromLines("noise", ["n1", "n2"]),
      fromLines("integrity", ["i1"]),
    );
    expect(merged.map((c) => c.text)).toEqual(["i1", "n1", "n2", "d1", "r1", "r2", "x1"]);
  });

  it("drops repeated rule ids and repeated texts (case and spacing ignored)", () => {
    const a: CharacterizationComment = { id: "same", dimension: "cross", text: "One thing." };
    const merged = mergeComments([a, { ...a, text: "Another thing." }], [{ id: "other", dimension: "cross", text: "one   THING." }, { id: "third", dimension: "noise", text: "Third." }]);
    expect(merged.map((c) => c.id)).toEqual(["third", "same"]);
  });

  it("is deterministic: the same input gives the same list", () => {
    const ctx = base({ noiseToDiversity: { values: ratio([[2, 5]]), basis: "sample" } });
    expect(crossComments(ctx)).toEqual(crossComments(ctx));
  });
});

describe("axisNoun", () => {
  it("names the axis from its unit without assuming an NIR range", () => {
    expect(axisNoun("nm")).toBe("wavelength");
    expect(axisNoun("µm")).toBe("wavelength");
    expect(axisNoun("cm-1")).toBe("wavenumber");
    expect(axisNoun("cm⁻¹")).toBe("wavenumber");
    expect(axisNoun("")).toBe("spectral");
    expect(axisNoun("index")).toBe("spectral");
  });
});

describe("cross.low-snr-flagged", () => {
  const lowSnr = (flagged: string[], rate: number | null, total = 10) => ({ ids: Array.from({ length: total }, (_, i) => `o${i}`), flaggedIds: new Set(flagged), flaggedRate: rate });
  it("is emitted when at least half of the lowest-SNR spectra carry events and at least twice the dataset rate", () => {
    const ctx = base({ lowSnr: lowSnr(["o0", "o1", "o2", "o3", "o4", "o9"], 0.2) });
    expect(lowSnrOverlap(ctx)).toEqual({ flagged: 6, total: 10 });
    expect(crossComments(ctx).find((c) => c.id === "cross.low-snr-flagged")!.text).toContain("6 of the 10 spectra with the lowest estimated SNR");
  });
  it("is not emitted below three spectra, below half, or when the dataset rate is already as high", () => {
    expect(ids(base({ lowSnr: lowSnr(["o0", "o1"], 0.01) }))).not.toContain("cross.low-snr-flagged");
    expect(ids(base({ lowSnr: lowSnr(["o0", "o1", "o2"], 0.01) }))).not.toContain("cross.low-snr-flagged");
    expect(ids(base({ lowSnr: lowSnr(["o0", "o1", "o2", "o3", "o4", "o5"], 0.5) }))).not.toContain("cross.low-snr-flagged");
    expect(ids(base({ lowSnr: lowSnr(["o0", "o1", "o2", "o3", "o4", "o5"], null) }))).not.toContain("cross.low-snr-flagged");
    expect(ids(base({ lowSnr: lowSnr(["o0", "o1", "o2", "o3"], 0.01, 4) }))).not.toContain("cross.low-snr-flagged");
    expect(ids(base())).not.toContain("cross.low-snr-flagged");
  });
});

describe("cross.events-in-elevated-regions", () => {
  const counts = (flagged: number[], n = 20) => Array.from({ length: n }, (_, i) => (flagged.includes(i) ? 2 : 0));
  it("requires at least two regions' worth of evidence: flagged bands inside runs of at least 3 elevated bands", () => {
    const ctx = base({ noiseToDiversity: { values: ratio([[4, 7]]), basis: "spectrum" }, eventBandCounts: counts([4, 5, 6, 7, 15]) });
    expect(elevatedRegions(ctx).map((r) => [r.start, r.end])).toEqual([[4, 7]]);
    expect(eventsInElevatedRegions(ctx)).toEqual({ inside: 4, flagged: 5, coverage: 0.2 });
    const text = crossComments(ctx).find((c) => c.id === "cross.events-in-elevated-regions")!.text;
    expect(text).toContain("4 of the 5 bands carrying flagged events lie inside the wavelength regions");
    expect(text).toContain("20% of the evaluable bands");
  });
  it("is not emitted when flagged bands are outside, too few, or the regions cover as much as the events", () => {
    expect(ids(base({ noiseToDiversity: { values: ratio([[4, 7]]), basis: "spectrum" }, eventBandCounts: counts([0, 1, 2, 15]) }))).not.toContain("cross.events-in-elevated-regions");
    expect(ids(base({ noiseToDiversity: { values: ratio([[4, 7]]), basis: "spectrum" }, eventBandCounts: counts([4, 5]) }))).not.toContain("cross.events-in-elevated-regions");
    // regions cover 100% of the bands: no enrichment to claim
    expect(ids(base({ noiseToDiversity: { values: ratio([[0, 19]]), basis: "spectrum" }, eventBandCounts: counts([1, 2, 3, 4]) }))).not.toContain("cross.events-in-elevated-regions");
  });
  it("ignores a length mismatch and non-evaluable bands", () => {
    expect(eventsInElevatedRegions(base({ noiseToDiversity: { values: ratio([[4, 7]], 10), basis: "spectrum" }, eventBandCounts: counts([4, 5, 6])}))).toBeNull();
    const values = ratio([[4, 7]]).map((v, i) => (i >= 10 ? null : v));
    expect(eventsInElevatedRegions(base({ noiseToDiversity: { values, basis: "spectrum" }, eventBandCounts: counts([4, 5, 6]) }))!.coverage).toBeCloseTo(4 / 10);
  });
});

describe("cross.distance-over-noise rules", () => {
  it("states that distances dominate fine-scale variation from a factor of 10", () => {
    const ctx = base({ scale: { relativeP95: 2.73, relativeNoisePercent: 0.359 } });
    expect(distanceOverNoise(ctx)).toBeCloseTo(2.73 / 0.00359, 6);
    const text = crossComments(ctx).find((c) => c.id === "cross.distance-dominates-noise")!.text;
    expect(text).toContain("2.73× the typical signal level");
    expect(text).toContain("0.359% of the signal level");
    expect(ids(ctx)).not.toContain("cross.distance-near-noise");
  });
  it("states that diversity is hard to tell from noise at a factor of 3 or less, and nothing in between", () => {
    expect(ids(base({ scale: { relativeP95: 0.03, relativeNoisePercent: 1 } }))).toContain("cross.distance-near-noise");
    const between = base({ scale: { relativeP95: 0.05, relativeNoisePercent: 1 } });
    expect(distanceOverNoise(between)).toBeCloseTo(5);
    expect(ids(between)).not.toContain("cross.distance-near-noise");
    expect(ids(between)).not.toContain("cross.distance-dominates-noise");
  });
  it("is silent when either value is missing, zero or negative", () => {
    for (const scale of [null, { relativeP95: null, relativeNoisePercent: 1 }, { relativeP95: 2, relativeNoisePercent: null }, { relativeP95: 2, relativeNoisePercent: 0 }, { relativeP95: 0, relativeNoisePercent: 1 }]) {
      expect(distanceOverNoise(base({ scale }))).toBeNull();
      expect(ids(base({ scale })).filter((id) => id.startsWith("cross.distance"))).toEqual([]);
    }
  });
});

describe("cross.noise-proxy-only", () => {
  it("is emitted only when repeatability is unavailable and the noise proxy was computed", () => {
    expect(ids(base({ repeatability: "unavailable" }))).toContain("cross.noise-proxy-only");
    expect(ids(base({ repeatability: "computed" }))).not.toContain("cross.noise-proxy-only");
    expect(ids(base({ repeatability: "unavailable", noiseProxy: "unavailable" }))).not.toContain("cross.noise-proxy-only");
  });
});

describe("cross.preprocessing-distortion", () => {
  const pre = (over: Partial<NonNullable<CrossContext["preprocessing"]>> = {}) => ({ label: "SG(11,2)", fineScaleReductionPercent: 60, distortion: axis.map((_, i) => (i >= 4 && i <= 8 ? 0.12 : 0.01)), interval: null, ...over });
  it("uses the selected interval when there is one and says so", () => {
    const ctx = base({ preprocessing: pre({ interval: { i0: 4, i1: 8 } }) });
    expect(preprocessingDistortion(ctx)).toEqual({ percent: 12, scope: "interval" });
    const text = crossComments(ctx).find((c) => c.id === "cross.preprocessing-distortion")!.text;
    expect(text).toContain("reduces fine-scale variation by 60% but also introduces substantial spectral changes in the selected wavelength region");
  });
  it("falls back to the whole range without a selection, and is silent for a mild distortion", () => {
    const mild = base({ preprocessing: pre() });
    expect(preprocessingDistortion(mild)!.scope).toBe("all");
    expect(ids(mild)).not.toContain("cross.preprocessing-distortion");
    const spread = base({ preprocessing: pre({ distortion: axis.map(() => 0.1) }) });
    expect(crossComments(spread).find((c) => c.id === "cross.preprocessing-distortion")!.text).toContain("across the spectral range");
    expect(DISTORTION_PERCENT).toBe(5);
  });
  it("is silent without a measured reduction, without a distortion profile, or with a small reduction", () => {
    expect(ids(base({ preprocessing: pre({ fineScaleReductionPercent: null }) }))).not.toContain("cross.preprocessing-distortion");
    expect(ids(base({ preprocessing: pre({ fineScaleReductionPercent: 3, interval: { i0: 4, i1: 8 } }) }))).not.toContain("cross.preprocessing-distortion");
    expect(ids(base({ preprocessing: pre({ distortion: null }) }))).not.toContain("cross.preprocessing-distortion");
    expect(ids(base({ preprocessing: pre({ distortion: axis.map(() => null), interval: { i0: 0, i1: 3 } }) }))).not.toContain("cross.preprocessing-distortion");
    expect(ids(base())).not.toContain("cross.preprocessing-distortion");
  });
});

describe("rule set", () => {
  it("has unique ids and every rule is exercised above", () => {
    expect(new Set(CROSS_RULES.map((r) => r.id)).size).toBe(CROSS_RULES.length);
    expect(CROSS_RULES.map((r) => r.id).sort()).toEqual(["cross.distance-dominates-noise", "cross.distance-near-noise", "cross.events-in-elevated-regions", "cross.low-snr-flagged", "cross.noise-proxy-only", "cross.preprocessing-distortion"]);
  });
  it("emits nothing for an empty context (no generic comment shared by every dataset)", () => {
    expect(crossComments(base({ repeatability: "computed", noiseProxy: "computed" }))).toEqual([]);
  });
});
