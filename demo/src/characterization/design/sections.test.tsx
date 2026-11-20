// Rendering of the design section and the confounding detail on heterogeneous synthetic designs run through the
// real engine (arbitrary factor names), in English and French: no crash, explicit states, no unresolved template.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Locale } from "nirs4all-ui/lab";
import { translate, type TextKey } from "../../i18n";
import type { Scope } from "../../Sections";
import { runEngine } from "./engine";
import { ConfoundingDetail, DesignSection } from "./sections";
import { cycle, designInput, type DesignSpec } from "./testkit";

const html = (el: ReactElement) => renderToStaticMarkup(el);
function scopeOf(spec: DesignSpec, locale: Locale = "en"): Scope {
  const input = designInput(spec);
  return { t: (k: TextKey) => translate(k, locale), locale, view: runEngine(input).view, input, sourceId: "src_a", targetId: spec.target ? "response_q" : null };
}
const clean = (out: string) => {
  expect(out).not.toMatch(/undefined|NaN|\{[a-z]+\}/);
};

describe("design views on heterogeneous designs", () => {
  const n = 24;
  const aliased: DesignSpec = { factors: { f_one: cycle(["a", "b", "c"], n, 8), f_two: cycle(["x", "y"], n, 4), f_three: cycle(["m", "n"], n, 12) }, target: true, effects: { f_one: 0.2 } };

  for (const locale of ["en", "fr"] as const) {
    it(`renders overview, graph, coverage, partition, evidence and PERMDISP (${locale})`, () => {
      const scope = scopeOf(aliased, locale);
      const design = html(<DesignSection {...scope} />);
      clean(design);
      expect(design).toContain('id="s-design"');
      expect(design).toContain(translate("dzRelAliasing", locale));
      expect(design).toContain(locale === "en" ? "Contingency table f_one × f_three" : "Table de contingence f_one × f_three");
      const detail = html(<ConfoundingDetail scope={scope} />);
      clean(detail);
      expect(detail).toContain(translate("dzStSignificant", locale));
      expect(detail).toContain(translate("dzStNotIdentifiable", locale));
      expect(detail).toContain(translate("dzNotIdentifiable", locale));
      expect(detail).toContain(translate("dzCellsBar", locale).slice(0, 20));
    });
  }

  it("states the marginal → adjusted decrease without calling it confounded variance", () => {
    const out = html(<ConfoundingDetail scope={scopeOf(aliased)} />);
    expect(out).toMatch(/The spectral association with f_one decreases from [\d.]+ % marginally to [\d.]+ % after adjustment/);
    expect(out).not.toMatch(/confounded variance/i);
  });

  it("shows the unavailable design without metadata and renders no detail", () => {
    const scope = scopeOf({ factors: {} });
    expect(html(<DesignSection {...scope} />)).toContain("Experimental design not analysed for this source");
    expect(html(<ConfoundingDetail scope={scope} />)).toBe("");
  });

  it("explains blocked tests, a constant factor and a single varying factor", () => {
    const sizes = [...Array(3).fill("r1"), ...Array(9).fill("r2"), ...Array(6).fill("r3")];
    const scope = scopeOf({ factors: { const_f: Array(18).fill("only"), uneq: sizes }, exchangeable: false });
    const design = html(<DesignSection {...scope} />);
    clean(design);
    expect(design).toContain("single observed level");
    expect(design).toContain(translate("dzGraphSingle", "en"));
    expect(design).toContain(translate("dzCoverageNone", "en"));
    const detail = html(<ConfoundingDetail scope={scope} />);
    expect(detail).toContain(translate("dzStBlocked", "en"));
    expect(detail).toContain("no other factor");
  });

  it("explains insufficient permutation resolution as structural", () => {
    const scope = scopeOf({ factors: { pa: ["u", "u", "v", "v"], pb: ["s", "t", "s", "t"] } });
    const detail = html(<ConfoundingDetail scope={scope} />);
    expect(detail).toContain(translate("dzStResolution", "en"));
    expect(detail).toContain(translate("dzCauseAdmissible", "en"));
  });

  it("orients full determination in the graph sentences", () => {
    const fine = cycle(["k1", "k2", "k3", "k4"], 16, 4);
    const coarse = fine.map((l) => (l === "k1" || l === "k2" ? "G" : "H"));
    const out = html(<DesignSection {...scopeOf({ factors: { fine_lv: fine, coarse_lv: coarse, other: cycle(["p", "q"], 16) } })} />);
    expect(out).toContain("coarse_lv is determined by fine_lv");
    expect(out).not.toContain("fine_lv is determined by coarse_lv");
  });
});
