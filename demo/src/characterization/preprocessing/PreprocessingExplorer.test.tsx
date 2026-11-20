import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EngineInput } from "../../input";
import type { Scope } from "../../Sections";
import { PreprocessingExplorer } from "./index";

const scopeOf = (x: (number | null)[][]): Scope =>
  ({
    t: ((k: string) => k) as unknown as Scope["t"],
    locale: "en",
    view: {} as Scope["view"],
    input: { sources: [{ source_id: "s", observation_ids: x.map((_, i) => `o${i}`), sample_ids: x.map((_, i) => `S${i}`), x, axis: x[0]!.map((_, j) => 1000 + 2 * j), axis_unit: "nm" }], samples: x.map((_, i) => ({ sample_id: `S${i}` })), options: {} } as unknown as EngineInput,
    sourceId: "s",
    targetId: null,
  }) as Scope;

describe("PreprocessingExplorer (static render)", () => {
  it("states its denominators, the local steps and the chemometric opt-in", () => {
    const x: (number | null)[][] = Array.from({ length: 6 }, (_, i) => Array.from({ length: 40 }, (_, j) => 1 + 0.01 * i + Math.sin(j / 5)));
    x[2]![3] = null;
    const html = renderToStaticMarkup(<PreprocessingExplorer scope={scopeOf(x)} />);
    expect(html).toContain("Computed on 5 of 6 spectra");
    expect(html).toContain("Median filter");
    expect(html).toContain("Despiking");
    expect(html).toContain("computed locally in the demo (interim");
    expect(html).toContain("Chemometric validation (optional)");
    expect(html).toContain("No target is declared");
    expect(html).toContain("Impact on spectral characteristics");
    expect(html).toContain("Noise reduction vs spectral distortion");
    expect(html).not.toContain("Zone");
  });
  it("explains when there are not enough complete spectra", () => {
    const html = renderToStaticMarkup(<PreprocessingExplorer scope={scopeOf([[1, 2, 3, 4, 5, 6]])} />);
    expect(html).toContain("at least two complete spectra");
  });
});
