import { describe, expect, it } from "vitest";
import { regionsExport, type InvestigationRegion } from "./selection";
import { alignedTracks, describeValue } from "./SpectralQualityMap";
import { buildTracks } from "./tracks";

const region = (over: Partial<InvestigationRegion> = {}): InvestigationRegion => ({ id: "region-1", sourceId: "nir", i0: 10, i1: 4, from: 1500, to: 1400, note: "", ...over });

describe("regionsExport", () => {
  it("exports ascending bounds, the band count and an explicit statement that the marks reject nothing", () => {
    const out = regionsExport([region()], "nir", "nm");
    expect(out.regions).toEqual([{ from: 1400, to: 1500, band_start: 4, band_end: 10, bands: 7, note: "" }]);
    expect(out.source_id).toBe("nir");
    expect(out.axis_unit).toBe("nm");
    expect(out.note).toMatch(/not an automatic rejection/);
  });
  it("keeps only the regions of the exported source and tolerates an empty list", () => {
    expect(regionsExport([region(), region({ id: "region-2", sourceId: "mir" })], "nir", "nm").regions).toHaveLength(1);
    expect(regionsExport([], "nir", "").regions).toEqual([]);
  });
  it("is JSON-serialisable", () => {
    expect(() => JSON.parse(JSON.stringify(regionsExport([region()], "nir", "nm")))).not.toThrow();
  });
});

describe("quality map tracks as aligned strips", () => {
  const axis = [1000, 1010, 1020, 1030];
  const tracks = buildTracks({ axis, profiles: { axis, icc: [-0.1, 0.6, null, 0.95], noiseProxy: [0.1, 0.2, 0.3, 0.4], unit: "AU", unavailable: {} }, spikes: null, jumps: null, observations: 0, distortion: null });
  const strips = alignedTracks(tracks);

  it("draws only the available tracks, each with a strip, its unit and a per-band non-evaluable flag", () => {
    expect(strips.map((s) => s.id)).toEqual(["icc", "noise_proxy"]);
    expect(strips.find((s) => s.id === "spike_frequency")).toBeUndefined();
    expect(strips.find((s) => s.id === "noise_proxy")).toMatchObject({ unit: "AU", nonEvaluable: [false, false, false, false] });
    expect(strips.find((s) => s.id === "icc")!.nonEvaluable).toEqual([false, false, true, false]);
  });

  it("colours non-evaluable bands through the hatch (null colour is not produced for values)", () => {
    const icc = strips.find((s) => s.id === "icc")!.strip!;
    expect(icc.color(-0.1)).not.toBeNull();
    expect(icc.color(0.95)).not.toBe(icc.color(0.6));
  });

  it("describes values with their class so that colour is never the only carrier", () => {
    const icc = tracks.find((t) => t.id === "icc")!;
    expect(describeValue(icc, -0.1)).toContain("Negative (kept as estimated)");
    expect(describeValue(icc, 0.6)).toContain("Moderate (0.50 ≤ ICC < 0.75)");
    expect(describeValue(tracks.find((t) => t.id === "noise_proxy")!, 0.2)).toBe("0.2 AU");
  });

  it("sends each track to its detailed panel", () => {
    const panels = Object.fromEntries(tracks.map((t) => [t.id, t.panel]));
    expect(panels).toEqual({ repeatability_sd: "s-repeat", icc: "s-repeat", noise_proxy: "s-repeat", noise_to_diversity: "s-repeat", spike_frequency: "s-quality", jump_frequency: "s-quality", distortion: "s-preprocessing", diversity: "s-repeat" });
  });
});
