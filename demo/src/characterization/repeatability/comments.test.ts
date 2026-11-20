import { describe, expect, it } from "vitest";
import { NO_REPLICATES_COMMENT, bandRuns, fmt, noiseComments, repeatabilityComments } from "./comments";
import type { NoiseProfile, RepeatProfile } from "./profiles";
import { noiseProxySummary, repeatabilitySummary } from "./summary";
import { metric, replicateInput, view } from "./testkit";

const axis = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070];

const repeat = (icc: (number | null)[], over: Partial<RepeatProfile> = {}): RepeatProfile => ({
  context: { id: "rescan · A", repeatType: "rescan", instrument: "A", campaign: null, unit: "abs", pooledSd: icc.map(() => 0.01), icc, bandStatus: icc.map(() => 0), observations: 12, physicalGroups: 4 },
  uncertainty: null,
  sd: icc.map(() => 0.01),
  betweenSd: icc.map(() => null),
  icc,
  iccKind: "icc_1_1",
  ratio: icc.map((k) => (k !== null && k >= 0 && k < 1 ? Math.sqrt(k / (1 - k)) : null)),
  nonEvaluable: icc.map((k) => k === null),
  categories: icc.map(() => null),
  ...over,
});

const noise = (values: (number | null)[], ratio: (number | null)[], over: Partial<NoiseProfile> = {}): NoiseProfile => ({
  id: "A", instrument: "A", campaign: "", unit: "abs", values, pooled: 0.5, windowBands: 5, polyorder: 2, nEvaluableBands: values.filter((v) => v !== null).length,
  rows: [], diversity: values.map(() => 1), diversityKind: "between-spectrum", diversityContext: null, ratio, ratioBands: ratio.map(() => null), nonEvaluable: values.map((v) => v === null), ...over,
});

describe("repeatability comments", () => {
  it("states the absence of replicate groups and nothing else", () => {
    expect(repeatabilityComments([], axis, "nm")).toEqual([NO_REPLICATES_COMMENT]);
  });

  it("reports negative ICC, low-ICC regions and the model-exact R statement", () => {
    const out = repeatabilityComments([repeat([0.95, 0.4, 0.3, -0.2, 0.9, 0.95, 0.9, 0.9])], axis, "nm");
    expect(out.join("\n")).toContain("1 band has a negative ICC estimate");
    expect(out.join("\n")).toContain("contiguous region of at least 3 bands; the widest spans 1010–1030 nm");
    expect(out.join("\n")).toContain("Between-sample spectral variability is approximately");
    expect(out.join("\n")).toContain("37.5% of evaluable bands have an ICC below 0.50");
  });

  it("does not claim regions, negatives or R when not demonstrated (REML, all high)", () => {
    const out = repeatabilityComments([repeat([0.95, 0.96, 0.97, 0.98, 0.95, 0.96, 0.97, 0.98], { iccKind: "icc_1_reml" })], axis, "nm").join("\n");
    expect(out).not.toMatch(/negative|contiguous region|times the within-sample/);
  });

  it("flags unbalanced and small replicate designs, and non-evaluable contexts", () => {
    const unc = { id: "rescan · A", repeatCounts: { histogram: [], nGroups: 5, nRepeatedGroups: 4, rMin: 2, rMax: 4, rMedian: 3 }, sdInterval: null, iccReml: null, iccInterval: null, unavailable: {} };
    const out = repeatabilityComments([repeat([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], { uncertainty: unc, iccKind: "icc_1_reml" })], axis, "nm").join("\n");
    expect(out).toContain("unbalanced (2 to 4 acquisitions");
    expect(out).toContain("REML ICC(1) is shown");
    expect(out).toContain("Only 4 physical samples have two or more repeats");
    expect(repeatabilityComments([repeat(axis.map(() => null))], axis, "nm")[0]).toContain("could not be evaluated at any band");
  });
});

describe("noise comments", () => {
  it("relative pooled noise and the SNR divergence note", () => {
    const out = noiseComments([noise([1, 1, 1, 1, 1, 1, 1, 1], axis.map(() => 0.05), { pooled: 0.63 })], 16.1, 48.9, axis, "nm", "abs");
    expect(out[0]).toContain("approximately 3.91% of the typical absolute signal level (16.1 abs");
    expect(out[1]).toContain("times higher than the relative noise derived from the median SNR (0.359%)");
    expect(out.join("\n")).toContain("stays below 0.30 × the between-spectrum SD at every evaluable band");
  });

  it("several elevated ratio regions and bands exceeding diversity; null level gives no percentage", () => {
    const ratio = [0.5, 0.6, 0.7, 0.05, 1.2, 1.5, 1.1, 0.01];
    const out = noiseComments([noise(axis.map(() => 1), ratio, { diversityKind: "between-sample" })], null, null, axis, "nm", "abs").join("\n");
    expect(out).toContain("Several contiguous wavelength regions exhibit elevated fine-scale variation relative to observed spectral diversity");
    expect(out).toContain("between-sample SD over 2 regions");
    expect(out).toContain("exceeds the observed between-sample SD in 3 of 8 evaluable bands");
    expect(out).toContain("relative value is not available");
  });

  it("bandRuns honours the minimum length and nulls", () => {
    expect(bandRuns([1, 1, null, 1, 1, 1], (v) => v > 0)).toEqual([{ i0: 3, i1: 5 }]);
    expect(fmt(0.0035912, 3)).toBe("0.00359");
  });
});

describe("summaries", () => {
  it("no replicates: explicit unavailable state, no zero, no ICC", () => {
    const s = repeatabilitySummary({ view: view([]), input: replicateInput(), sourceId: "nir" });
    expect(s.status).toBe("unavailable");
    expect(s.metrics).toEqual([]);
    expect(s.unavailable).toContain("no technical replicate groups have been declared");
    expect(noiseProxySummary({ view: view([]), input: replicateInput(), sourceId: "nir" }).status).toBe("unavailable");
  });

  it("computed summaries carry the key metrics", () => {
    const v = view([
      metric("measurement.repeatability_sd", [0.01, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], { repeat_type: "rescan", instrument: "A", campaign: "" }),
      metric("measurement.icc_1_1", [0.9, 0.8, -0.1, 0.95, 0.9, 0.9, 0.9, 0.9], { repeat_type: "rescan", instrument: "A", campaign: "" }),
      metric("measurement.noise_proxy", [null, null, 0.01, 0.02, 0.01, 0.01, null, null], { instrument: "A", campaign: "", window_bands: 5, polyorder: 2 }),
      metric("measurement.noise_proxy_pooled", 0.012, { instrument: "A", campaign: "" }),
    ]);
    const r = repeatabilitySummary({ view: v, input: replicateInput(), sourceId: "nir" });
    expect(r.status).toBe("computed");
    expect(r.metrics.find((m) => m.label === "Median ICC(1,1)")!.value).toBeCloseTo(0.9, 12);
    expect(r.comments.join("\n")).toContain("negative ICC");
    const q = noiseProxySummary({ view: v, input: replicateInput(), sourceId: "nir" });
    expect(q.metrics.find((m) => m.label === "Pooled noise proxy")!.value).toBe(0.012);
    expect(q.metrics.find((m) => m.label === "Relative pooled noise proxy")!.value).toBeNull(); // no intrinsic level
  });
});
