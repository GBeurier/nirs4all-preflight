import { describe, expect, it } from "vitest";
import { ICC_CATEGORIES, NON_EVALUABLE_COLOR, RAMPS, RATIO_CATEGORIES, buildTracks, categoryOf, categoryShares, colorOf, iccCategory, rampColor, ratioCategory, summarizeInterval, type BandProfileInput, type TrackId, type TrackInputs } from "./tracks";

const axis = [4000, 3990, 3975, 3940, 3900, 3850];
const profiles = (over: Partial<BandProfileInput> = {}): BandProfileInput => ({
  axis,
  repeatabilitySd: [0.01, 0.02, null, 0.04, 0.05, 0.06],
  icc: [-0.2, 0.3, null, 0.8, 0.95, 0.5],
  noiseProxy: [0.001, 0.002, 0.003, null, 0.005, 0.006],
  noiseToDiversity: [0.05, 0.2, null, 0.6, 1.5, 0.1],
  diversity: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  unit: "AU",
  diversityBasis: "sample",
  ...over,
});
const inputs = (over: Partial<TrackInputs> = {}): TrackInputs => ({
  axis,
  profiles: profiles(),
  spikes: { axis, counts: [0, 0, 5, 0, 0, 1] },
  jumps: null,
  observations: 10,
  distortion: null,
  ...over,
});
const byId = (tracks: ReturnType<typeof buildTracks>, id: TrackId) => tracks.find((t) => t.id === id)!;

describe("category classes", () => {
  it("follow the Koo & Li boundaries and keep negative ICC as its own class instead of clipping it", () => {
    expect([-0.01, 0, 0.49, 0.5, 0.74, 0.75, 0.89, 0.9, 1].map((v) => iccCategory(v).id)).toEqual(["negative", "poor", "poor", "moderate", "moderate", "good", "good", "excellent", "excellent"]);
    expect(ICC_CATEGORIES.map((c) => c.range)).toEqual(["ICC < 0", "0 ≤ ICC < 0.50", "0.50 ≤ ICC < 0.75", "0.75 ≤ ICC < 0.90", "ICC ≥ 0.90"]);
  });
  it("follow the exploratory noise-to-diversity boundaries", () => {
    expect([0, 0.0999, 0.1, 0.2999, 0.3, 0.999, 1, 25].map((v) => ratioCategory(v).id)).toEqual(["low", "low", "moderate", "moderate", "substantial", "substantial", "exceeds", "exceeds"]);
    expect(RATIO_CATEGORIES).toHaveLength(4);
  });
  it("never use green or pure red: every ramp and class colour is outside the green and red hue ranges", () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return { h: 0, s: 0 };
      const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return { h: h * 60, s: d / (1 - Math.abs(max + min - 1) || 1) };
    };
    const colors = [...Object.values(RAMPS).flat(), ...ICC_CATEGORIES.map((c) => c.color), ...RATIO_CATEGORIES.map((c) => c.color)];
    for (const hex of colors) {
      const { h, s: sat } = hue(hex);
      const green = h >= 75 && h <= 165 && sat > 0.2;
      const red = (h <= 10 || h >= 345) && sat > 0.4;
      expect(green || red, hex).toBe(false);
    }
  });
});

describe("buildTracks", () => {
  it("returns the eight tracks in the order of the request, aligned with the source axis", () => {
    const tracks = buildTracks(inputs());
    expect(tracks.map((t) => t.id)).toEqual(["repeatability_sd", "icc", "noise_proxy", "noise_to_diversity", "spike_frequency", "jump_frequency", "distortion", "diversity"]);
    for (const t of tracks.filter((x) => !x.unavailable)) expect(t.values).toHaveLength(axis.length);
  });

  it("keeps non-evaluable bands as null (grey) and negative ICC unclipped", () => {
    const tracks = buildTracks(inputs());
    expect(byId(tracks, "icc").values).toEqual([-0.2, 0.3, null, 0.8, 0.95, 0.5]);
    expect(colorOf(byId(tracks, "icc"), null)).toBe(NON_EVALUABLE_COLOR);
    expect(categoryOf(byId(tracks, "icc"), -0.2)!.id).toBe("negative");
    expect(categoryShares(byId(tracks, "icc")).map((s) => [s.category?.id ?? "na", s.count])).toEqual([["negative", 1], ["poor", 1], ["moderate", 1], ["good", 1], ["excellent", 1], ["na", 1]]);
  });

  it("turns NaN, infinity and undefined into non-evaluable bands", () => {
    const t = byId(buildTracks(inputs({ profiles: profiles({ noiseProxy: [Number.NaN, Infinity, -Infinity, undefined as unknown as number, 1, 2] }) })), "noise_proxy");
    expect(t.values).toEqual([null, null, null, null, 1, 2]);
    expect(t.domain).toEqual([1, 2]);
  });

  it("derives event frequency as engine band counts over the stated number of spectra", () => {
    const t = byId(buildTracks(inputs()), "spike_frequency");
    expect(t.values).toEqual([0, 0, 0.5, 0, 0, 0.1]);
    // zero is the lightest step of the frequency scale, also when no event is flagged anywhere
    expect(t.domain).toEqual([0, 0.5]);
    expect(colorOf(t, 0)).toBe(RAMPS.browns[0]);
    const none = byId(buildTracks(inputs({ spikes: { axis, counts: [0, 0, 0, 0, 0, 0] } })), "spike_frequency");
    expect(none.domain).toEqual([0, 0]);
    expect(colorOf(none, 0)).toBe(RAMPS.browns[0]);
    expect(t.unit).toBe("fraction of spectra");
    expect(byId(buildTracks(inputs()), "jump_frequency").unavailable).toMatch(/Not computed/);
    // no spectra behind the counts: no invented frequency
    expect(byId(buildTracks(inputs({ observations: 0 })), "spike_frequency").unavailable).toMatch(/Not computed/);
  });

  it("states why replicate-based tracks are missing instead of drawing zeros", () => {
    const reason = "Not available: no technical replicate groups have been declared.";
    const tracks = buildTracks(inputs({ profiles: profiles({ repeatabilitySd: null, icc: null, unavailable: { repeatability_sd: reason, icc: reason } }) }));
    expect(byId(tracks, "repeatability_sd")).toMatchObject({ unavailable: reason, values: [] });
    expect(byId(tracks, "icc").unavailable).toBe(reason);
    expect(byId(tracks, "noise_proxy").unavailable).toBeNull();
  });

  it("refuses a series whose axis differs from the map axis instead of misaligning it", () => {
    const t = byId(buildTracks(inputs({ profiles: profiles({ axis: [...axis].reverse() }) })), "noise_proxy");
    expect(t.unavailable).toMatch(/Not available/);
  });

  it("treats an all-null series as unavailable", () => {
    expect(byId(buildTracks(inputs({ profiles: profiles({ icc: [null, null, null, null, null, null] }) })), "icc").unavailable).toMatch(/Not available/);
  });

  it("words the diversity denominator by basis: sample with replicates, spectrum otherwise", () => {
    expect(byId(buildTracks(inputs()), "diversity").label).toBe("Between-sample diversity (SD)");
    expect(byId(buildTracks(inputs({ profiles: profiles({ diversityBasis: "spectrum" }) })), "noise_to_diversity").label).toContain("between-spectrum SD");
  });

  it("marks the preprocessing distortion as not computed until the explorer provides it", () => {
    expect(byId(buildTracks(inputs()), "distortion").unavailable).toMatch(/preprocessing explorer/);
    const t = byId(buildTracks(inputs({ distortion: { axis, values: [0, 0.01, 0.02, null, 0.1, 0.05], unit: "fraction of mean |raw|", provenance: "explorer" } })), "distortion");
    expect(t.unavailable).toBeNull();
    expect(t.values).toEqual([0, 0.01, 0.02, null, 0.1, 0.05]);
    expect(t.origin).toBe("derived");
    // a profile computed on another axis is not drawn
    expect(byId(buildTracks(inputs({ distortion: { axis: axis.slice(1), values: [0, 0, 0, 0, 0], unit: null, provenance: "" } })), "distortion").unavailable).toMatch(/Not computed/);
  });

  it("does not modify its inputs", () => {
    const i = inputs();
    const snapshot = JSON.stringify(i);
    buildTracks(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });

  it("handles a constant series (degenerate domain) and a single-band axis", () => {
    const constant = byId(buildTracks(inputs({ profiles: profiles({ noiseProxy: [1, 1, 1, 1, 1, 1] }) })), "noise_proxy");
    expect(constant.domain).toEqual([1, 1]);
    expect(RAMPS.oranges).toContain(colorOf(constant, 1));
    const one = buildTracks({ axis: [1500], profiles: { axis: [1500], noiseProxy: [0.2] }, spikes: null, jumps: null, observations: 0, distortion: null });
    expect(byId(one, "noise_proxy").values).toEqual([0.2]);
  });
});

describe("rampColor", () => {
  it("is monotone from light to dark and clamps outside the domain", () => {
    const ramp = RAMPS.blues;
    expect(rampColor(ramp, [0, 1], 0)).toBe(ramp[0]);
    expect(rampColor(ramp, [0, 1], 1)).toBe(ramp[ramp.length - 1]);
    expect(rampColor(ramp, [0, 1], -5)).toBe(ramp[0]);
    expect(rampColor(ramp, [0, 1], 9)).toBe(ramp[ramp.length - 1]);
    expect(rampColor(ramp, null, 3)).toBe(ramp[0]);
    expect(rampColor(ramp, [2, 2], 2)).toBe(ramp[0]);
  });
});

describe("summarizeInterval", () => {
  it("reports the local range, evaluable bands and class counts of every drawable track", () => {
    const tracks = buildTracks(inputs());
    const s = summarizeInterval(tracks, 1, 3);
    const icc = s.find((x) => x.id === "icc")!;
    expect(icc).toMatchObject({ bands: 3, evaluable: 2, min: 0.3, max: 0.8 });
    expect(icc.classes).toEqual([{ label: "Poor", count: 1 }, { label: "Good", count: 1 }]);
    expect(s.find((x) => x.id === "distortion")).toBeUndefined();
    expect(s.find((x) => x.id === "noise_proxy")).toMatchObject({ evaluable: 2, min: 0.002, max: 0.003 });
  });
  it("accepts reversed bounds and an interval with no evaluable band", () => {
    const tracks = buildTracks(inputs());
    expect(summarizeInterval(tracks, 3, 1).find((x) => x.id === "icc")!.bands).toBe(3);
    const none = summarizeInterval(tracks, 2, 2).find((x) => x.id === "icc")!;
    expect(none).toMatchObject({ evaluable: 0, min: null, max: null, classes: [] });
  });
});
