import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate, type TextKey } from "../../i18n";
import type { Scope } from "../../Sections";
import { legendItems } from "./AlignedTracks";
import { noiseBlocks, repeatabilityBlocks, spectrumTrack } from "./blocks";
import { divergingColor } from "./ResidualInspection";
import { metric, replicateInput, view } from "./testkit";

const scope = (metrics: unknown[]): Scope => ({ t: (k: TextKey) => translate(k, "en"), locale: "en", view: view(metrics), input: replicateInput(), sourceId: "nir", targetId: null });
const ctx = { repeat_type: "rescan", instrument: "A", campaign: "" };
const repeat = [
  metric("measurement.repeatability_sd", [0.01, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], ctx, { denominators: { n_observations: 12, n_physical_groups: 4 } }),
  metric("measurement.icc_1_1", [0.9, 0.3, -0.15, 0.2, 0.9, null, 0.9, 0.9], ctx),
];
const noise = [
  metric("measurement.noise_proxy", [null, null, 0.01, 0.02, 0.01, 0.01, null, null], { instrument: "A", campaign: "", window_bands: 5, polyorder: 2 }),
  metric("measurement.noise_proxy_pooled", 0.012, { instrument: "A", campaign: "" }),
];

describe("repeatabilityBlocks", () => {
  it("no replicates: explicit card, no KPI, no track, no ICC", () => {
    const b = repeatabilityBlocks(scope([]), { onOpenSettings: () => undefined });
    expect(b.status).toBe("unavailable");
    expect(b.kpis).toEqual([]);
    expect(b.bandTracks).toEqual([]);
    const card = renderToStaticMarkup(<>{b.distributions.map((d) => <div key={d.id}>{d.node}</div>)}</>);
    expect(card).toContain("No technical replicate groups have been declared.");
    expect(card).toContain("Configure technical replicate groups in dataset settings");
    expect(card).not.toMatch(/ICC/);
  });

  it("computed: KPIs, unclipped negative ICC on the ICC track, low-ICC regions, coverage shares", () => {
    const b = repeatabilityBlocks(scope(repeat));
    expect(b.status).toBe("computed");
    expect(b.kpis.map((k) => k.label)).toContain("Median ICC(1,1)");
    expect(b.bandTracks.map((t) => t.id)).toEqual(["rp-sd", "rp-icc"]);
    const icc = b.bandTracks[1]!;
    expect(icc.series![0]!.values).toContain(-0.15);
    expect(icc.yDomain![0]).toBeLessThan(-0.15);
    expect(b.markRegions).toEqual([{ i0: 1, i1: 3, label: expect.stringContaining("poor ICC") }]);
    const coverage = renderToStaticMarkup(<>{b.distributions[0]!.node}</>);
    expect(coverage).toContain("Good to excellent relative repeatability");
    expect(coverage).toContain("1.73×"); // ICC 0.75 ↔ R = √3
    expect(b.comments.some((c) => String(c.text).includes("negative ICC"))).toBe(true);
  });
});

describe("noiseBlocks", () => {
  it("relative units by default only with a typical level; ratio track guarded and capped explicitly", () => {
    const b = noiseBlocks(scope(noise));
    expect(b.status).toBe("computed");
    const [n, r] = b.bandTracks;
    expect(n!.id).toBe("np-noise");
    expect(n!.unit).not.toBe("%"); // no intrinsic signal level in this report → signal units
    expect(r!.id).toBe("np-ratio");
    expect(r!.series![0]!.values.every((v) => v === null || Number.isFinite(v))).toBe(true);
    expect(b.kpis.find((k) => k.label === "Relative pooled noise proxy")!.value).toBe("—");
    expect(noiseBlocks(scope([])).status).toBe("unavailable");
  });

  it("spectrum track: median and envelope of development rows only", () => {
    const t = spectrumTrack(scope([]))!;
    expect(t.series![0]!.values.every((v) => v === null || v < 99)).toBe(true); // retained-test row (99) excluded
  });
});

describe("helpers", () => {
  it("legend items are unique per label and envelopes are areas", () => {
    const items = legendItems([
      { id: "a", title: "A", series: [{ id: "s", label: "S", values: [] }], envelopes: [{ id: "e", label: "E", lower: [], upper: [] }] },
      { id: "b", title: "B", series: [{ id: "s2", label: "S", values: [] }] },
    ]);
    expect(items.map((i) => i.label)).toEqual(["E", "S"]);
    expect(items[0]!.area).toBe(true);
  });

  it("diverging colour is neutral at 0 and saturates symmetrically", () => {
    const stops = { neg: [0, 0, 255] as [number, number, number], mid: [200, 200, 200] as [number, number, number], pos: [255, 0, 0] as [number, number, number] };
    expect(divergingColor(0, 1, stops)).toEqual([200, 200, 200]);
    expect(divergingColor(5, 1, stops)).toEqual([255, 0, 0]);
    expect(divergingColor(-5, 1, stops)).toEqual([0, 0, 255]);
    expect(divergingColor(1, 0, stops)).toEqual([200, 200, 200]);
  });
});
