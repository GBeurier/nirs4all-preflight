import { describe, expect, it } from "vitest";
import { measurementContexts, pickContext } from "./contexts";
import { repeatStats } from "./comments";
import type { NoiseProfile, RepeatProfile } from "./profiles";
import { sourceProfiles } from "./profiles";
import { metric, replicateInput, view } from "./testkit";

const rp = (repeatType: string, instrument: string, campaign: string, icc: (number | null)[] = [0.5], over: Partial<RepeatProfile> = {}): RepeatProfile => ({
  context: { id: `${repeatType} · ${instrument} · ${campaign}`, repeatType, instrument, campaign, unit: "abs", pooledSd: icc.map(() => 1), icc, bandStatus: icc.map(() => 0), observations: 6, physicalGroups: 2 },
  uncertainty: null, sd: icc.map(() => 1), betweenSd: icc.map(() => null), betweenKind: "anova", icc, iccKind: "icc_1_1",
  ratio: icc.map((k) => (k !== null && k >= 0 && k < 1 ? Math.sqrt(k / (1 - k)) : null)), nonEvaluable: icc.map((k) => k === null), categories: icc.map(() => null), ...over,
});
const np = (instrument: string, campaign: string) => ({ id: `${instrument} · ${campaign}`, instrument, campaign } as NoiseProfile);

describe("measurement contexts", () => {
  it("pairs each repeatability context with the noise context of its instrument and campaign, then lists noise-only contexts", () => {
    const ctx = measurementContexts([rp("rescan", "a", "A"), rp("rescan", "b", "A")], [np("a", "A"), np("b", "A"), np("b", "B")]);
    expect(ctx.map((c) => [c.label, c.repeatIndex, c.noiseIndex])).toEqual([
      ["rescan · a · A", 0, 0],
      ["rescan · b · A", 1, 1],
      ["no technical repeats · b · B", null, 2],
    ]);
    expect(new Set(ctx.map((c) => c.key)).size).toBe(3);
  });

  it("picks the requested context, else the first; null without contexts", () => {
    const ctx = measurementContexts([rp("rescan", "a", "A")], [np("a", "A"), np("b", "B")]);
    expect(pickContext(ctx, ctx[1]!.key)).toBe(ctx[1]);
    expect(pickContext(ctx, "unknown")).toBe(ctx[0]);
    expect(pickContext([], null)).toBeNull();
  });

  it("keeps a repeatability context without noise proxy (noise index null)", () => {
    expect(measurementContexts([rp("rescan", "a", "A")], [])[0]).toMatchObject({ repeatIndex: 0, noiseIndex: null });
  });
});

describe("median R = σb/σw", () => {
  it("follows the median ICC for the ANOVA model (negative ICC bands never inflate it)", () => {
    // Median ICC is negative while the few positive bands have a large R: no R is claimed.
    expect(repeatStats(rp("rescan", "a", "A", [-0.2, -0.1, -0.3, 0.99, 0.98])).medianRatio).toBeNull();
    const s = repeatStats(rp("rescan", "a", "A", [0.5, 0.8, 0.2]));
    expect(s.medianIcc).toBe(0.5);
    expect(s.medianRatio).toBeCloseTo(1, 12);
  });

  it("uses the exact per-band R of the REML components", () => {
    const s = repeatStats(rp("rescan", "a", "A", [0.5, 0.8, 0.2], { betweenKind: "reml", iccKind: "icc_1_reml", ratio: [1, 2, 0.5] }));
    expect(s.medianRatio).toBe(1);
  });
});

describe("profile cache", () => {
  it("returns the same profiles (and residual rows) for the same report, input and source", () => {
    const input = replicateInput();
    const v = view([metric("measurement.noise_proxy", [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], { instrument: "A", campaign: "", window_bands: 3, polyorder: 1 })]);
    const a = sourceProfiles(v, input, "nir");
    const b = sourceProfiles(v, input, "nir");
    expect(b).toBe(a);
    expect(b.noise[0]?.rows).toBe(a.noise[0]?.rows);
  });
});
