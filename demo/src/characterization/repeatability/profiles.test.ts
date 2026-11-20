import { describe, expect, it } from "vitest";
import { ratioToIcc } from "../shared/derive";
import { bandEnvelope, bandProfiles, betweenSampleSd, betweenSpectrumSd, contextGroups, developmentRows, guardedRatio, negligibleFloor, noiseProfiles, repeatProfiles, topRegions } from "./profiles";
import { metric, replicateInput, view } from "./testkit";

/** Balanced one-way ANOVA (independent oracle of the Methods definition). */
function anova(groups: number[][]) {
  const r = groups[0]!.length;
  const means = groups.map((g) => g.reduce((a, b) => a + b, 0) / r);
  const grand = means.reduce((a, b) => a + b, 0) / means.length;
  const msw = groups.reduce((s, g, i) => s + g.reduce((a, v) => a + (v - means[i]!) ** 2, 0), 0) / (groups.length * (r - 1));
  const msb = (r * means.reduce((a, m) => a + (m - grand) ** 2, 0)) / (groups.length - 1);
  return { r, msw, msb, icc: (msb - msw) / (msb + (r - 1) * msw) };
}

describe("between-sample SD from the one-way model", () => {
  it("matches √((MSB − MSW)/r) on a balanced design", () => {
    const a = anova([[1, 1.2, 0.9], [2, 2.3, 2.1], [3.5, 3.4, 3.2], [0.5, 0.7, 0.4]]);
    const [sb] = betweenSampleSd([Math.sqrt(a.msw)], [a.icc]);
    expect(sb).toBeCloseTo(Math.sqrt((a.msb - a.msw) / a.r), 12);
  });

  it("follows ICC = R²/(1+R²) and keeps undefined cases null (negative ICC, ICC = 1, missing)", () => {
    const sb = betweenSampleSd([1, 2, 1, 1, null, 1], [0.9, 0.5, -0.2, 1, 0.5, null]);
    expect(sb[0]).toBeCloseTo(3, 12);
    expect(sb.slice(1)).toEqual([2, null, null, null, null]);
    expect(ratioToIcc(3)).toBeCloseTo(0.9, 12);
  });
});

describe("engine row and group mirrors", () => {
  it("development rows exclude retained test and augmentations", () => {
    const input = replicateInput();
    input.samples.push({ sample_id: "aug", augmentation_parent_id: "s0-0" });
    input.sources[0]!.sample_ids.push("aug");
    input.sources[0]!.x.push([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(developmentRows(input, input.sources[0]!)).toEqual([...Array(12).keys()]);
  });

  it("groups repeats by physical sample within one repeat type × instrument × campaign, unbalanced allowed", () => {
    const input = replicateInput();
    input.samples[3]!.physical_sample_id = "s0"; // s1-0 joins s0 → sizes 4, 2, 3, 3
    const groups = contextGroups(input, input.sources[0]!, { repeatType: "rescan", instrument: "A", campaign: null });
    expect(groups.map((g) => g.rows.length)).toEqual([4, 2, 3, 3]);
    expect(contextGroups(input, input.sources[0]!, { repeatType: "rescan", instrument: "B", campaign: null })).toEqual([]);
    expect(contextGroups({ ...input, sources: [{ ...input.sources[0]!, repetition_types: undefined as never }] }, { ...input.sources[0]!, repetition_types: undefined as never }, { repeatType: "rescan", instrument: "A", campaign: "" })).toEqual([]);
  });
});

describe("display derivations", () => {
  it("envelope and between-spectrum SD skip missing/masked cells and leave the input unchanged", () => {
    const input = replicateInput();
    const src = input.sources[0]!;
    src.valid_mask = src.x.map((row) => row.map(() => true));
    src.valid_mask[0]![2] = false;
    const before = JSON.stringify(input);
    const env = bandEnvelope(src, [0, 1, 2]);
    expect(env.median[2]).toBeCloseTo(0.21, 12); // rows 0 (masked) and 1 (null) excluded
    expect(env.median[0]).toBeCloseTo(0, 12);
    const sd = betweenSpectrumSd(src, [0, 1]);
    expect(sd[2]).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
  });

  it("constant signals give a zero denominator and a null (never infinite) ratio", () => {
    const input = replicateInput();
    const src = { ...input.sources[0]!, x: input.sources[0]!.x.map((r) => r.map(() => 5)) };
    const sd = betweenSpectrumSd(src, [0, 1, 2]);
    expect(sd.every((v) => v === 0)).toBe(true);
    const floor = negligibleFloor(sd, 5);
    expect(guardedRatio(0.1, sd[0], floor)).toBeNull();
    expect(guardedRatio(0.1, 1e-12, floor)).toBeNull();
    expect(guardedRatio(0.1, 0.5, floor)).toBeCloseTo(0.2, 12);
    expect(guardedRatio(null, 0.5, floor)).toBeNull();
  });

  it("finds the contiguous highest-value regions", () => {
    const axis = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(topRegions(axis, [0, 0, 5, 6, 7, 0, 0, 0, 9, 0], 0.6, 3)).toEqual([{ i0: 2, i1: 4, from: 3, to: 5, peak: 7 }]);
    expect(topRegions(axis, [null, null], 0.9)).toEqual([]);
  });
});

describe("report profiles", () => {
  const sd = [0.01, 0.01, null, 0.02, 0.02, 0.01, 0.01, 0.01];
  const icc = [0.9, 0.5, null, -0.1, 0.99, 0.75, 0.2, 0.3];
  const repeatMetrics = [
    metric("measurement.repeatability_sd", sd, { repeat_type: "rescan", instrument: "A", campaign: "", band_status_0_icc_1_insufficient_2_unbalanced_3_zero_total: [0, 0, 1, 0, 0, 0, 0, 0] }, { denominators: { n_observations: 12, n_physical_groups: 4 } }),
    metric("measurement.icc_1_1", icc, { repeat_type: "rescan", instrument: "A", campaign: "" }),
  ];
  const noise = [0.002, 0.003, 0.004, 0.004, 0.002, null, null, null];
  const noiseMetrics = [
    metric("measurement.noise_proxy", noise, { instrument: "A", campaign: "", window_bands: 5, polyorder: 2 }, { denominators: { n_evaluable_bands: 5 } }),
    metric("measurement.noise_proxy_pooled", 0.003, { instrument: "A", campaign: "" }),
  ];

  it("keeps negative ICC unclipped and marks non-evaluable bands", () => {
    const [p] = repeatProfiles(view(repeatMetrics), "nir");
    expect(p!.icc).toEqual(icc);
    expect(p!.betweenSd[3]).toBeNull();
    expect(p!.betweenSd[0]).toBeCloseTo(0.03, 12);
    expect(p!.nonEvaluable[2]).toBe(true);
    expect(p!.categories).toEqual(["excellent", "moderate", null, "poor", "excellent", "good", "poor", "poor"]);
  });

  it("noise-to-diversity uses the between-sample SD when replicates exist, else the between-spectrum SD", () => {
    const input = replicateInput();
    const withRepeats = noiseProfiles(view([...repeatMetrics, ...noiseMetrics]), input, "nir");
    expect(withRepeats[0]!.diversityKind).toBe("between-sample");
    expect(withRepeats[0]!.ratio[0]).toBeCloseTo(0.002 / 0.03, 12);
    expect(withRepeats[0]!.ratio[3]).toBeNull(); // negative ICC → no σb → no ratio
    expect(withRepeats[0]!.rows).toHaveLength(12);
    const without = noiseProfiles(view(noiseMetrics), input, "nir");
    expect(without[0]!.diversityKind).toBe("between-spectrum");
    expect(without[0]!.ratio[0]).not.toBeNull();
    const profiles = bandProfiles({ view: view([...repeatMetrics, ...noiseMetrics]), input, sourceId: "nir" })!;
    expect(profiles.axis).toEqual(input.sources[0]!.axis);
    expect(profiles.icc).toEqual(icc);
    expect(profiles.diversityKind).toBe("between-sample");
    expect(profiles.diversityBasis).toBe("sample");
    expect(bandProfiles({ view: view([]), input, sourceId: "nir" })!.repeatabilitySd).toBeNull();
  });
});
