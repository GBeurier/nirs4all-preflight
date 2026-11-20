import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate, type TextKey } from "../../i18n";
import type { Scope } from "../../Sections";
import { AlignedTracks, nearestBand, niceTicks, runs } from "./AlignedTracks";
import { NoiseProxyPanel } from "./NoiseProxyPanel";
import { RepeatabilityPanel, REPEAT_WARNING } from "./RepeatabilityPanel";
import { NO_REPLICATES_MESSAGE } from "./summary";
import { metric, replicateInput, view } from "./testkit";

const html = (node: ReactElement) => renderToStaticMarkup(node);
const scope = (metrics: unknown[]): Scope => ({ t: (k: TextKey) => translate(k, "en"), locale: "en", view: view(metrics), input: replicateInput(), sourceId: "nir", targetId: null });

describe("AlignedTracks", () => {
  it("renders irregular, descending axes with gaps for nulls and hatched non-evaluable bands", () => {
    const axis = [4000, 3990, 3970, 3900, 3890];
    const out = html(<AlignedTracks axis={axis} axisLabel="Wavenumber (cm-1)" width={500} title="t" tracks={[
      { id: "a", title: "A", series: [{ id: "s", label: "S", values: [1, 2, null, 3, 4] }], nonEvaluable: [false, false, true, false, false] },
      { id: "b", title: "B", strip: { label: "cat", values: [0, 1, null, 1, 0], color: (v) => (v ? "#000" : "#fff") } },
    ]} />);
    const d = /<path d="([^"]+)"/.exec(out)![1]!;
    expect(d.match(/M/g)).toHaveLength(2); // the null splits the line
    expect(out).toContain("Not evaluable");
    expect(out).toContain("Wavenumber (cm-1)");
    expect(html(<AlignedTracks axis={[]} axisLabel="x" width={300} title="t" tracks={[]} />)).toBe("");
  });

  it("helpers: nice ticks, nearest band on irregular axes, runs", () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(10, 0, 2)).toEqual([0, 5, 10]);
    expect(nearestBand([1000, 1004, 1010, 1050], 1029)).toBe(2);
    expect(runs([true, true, false, true])).toEqual([{ i0: 0, i1: 1 }, { i0: 3, i1: 3 }]);
  });
});

describe("RepeatabilityPanel", () => {
  it("no replicates: explicit message, settings button only with a handler, noise-proxy note", () => {
    const withButton = html(<RepeatabilityPanel {...scope([])} onOpenSettings={() => undefined} />);
    expect(withButton).toContain(NO_REPLICATES_MESSAGE);
    expect(withButton).toContain("Open dataset settings");
    expect(withButton).toContain("does not replace an experimental measurement of repeatability");
    expect(withButton).not.toMatch(/ICC P5|Median ICC/);
    expect(html(<RepeatabilityPanel {...scope([])} />)).not.toContain("Open dataset settings");
  });

  it("computed: warning, model statement, negative ICC kept in the data table", () => {
    const out = html(<RepeatabilityPanel {...scope([
      metric("measurement.repeatability_sd", [0.01, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], { repeat_type: "rescan", instrument: "A", campaign: "" }, { denominators: { n_observations: 12, n_physical_groups: 4 } }),
      metric("measurement.icc_1_1", [0.9, 0.8, -0.15, 0.95, 0.9, null, 0.9, 0.9], { repeat_type: "rescan", instrument: "A", campaign: "" }),
    ])} />);
    expect(out).toContain(REPEAT_WARNING);
    expect(out).toContain("one-way random-effects");
    expect(out).toContain("Koo &amp; Li");
    expect(out).toContain("-0.15");
    expect(out).toContain("Not evaluable: 1 (12.5%)");
  });
});

describe("NoiseProxyPanel", () => {
  it("renders the pooled tile, the denominator wording and the residual entry point", () => {
    const out = html(<NoiseProxyPanel {...scope([
      metric("measurement.noise_proxy", [null, null, 0.01, 0.02, 0.01, 0.01, null, null], { instrument: "A", campaign: "", window_bands: 5, polyorder: 2 }),
      metric("measurement.noise_proxy_pooled", 0.012, { instrument: "A", campaign: "" }),
    ])} />);
    expect(out).toContain("Pooled noise proxy · A");
    expect(out).toContain("between-spectrum SD");
    expect(out).toContain("Compute residuals (12 of 12 spectra)");
    expect(out).not.toMatch(/Infinity|NaN/);
  });
});
