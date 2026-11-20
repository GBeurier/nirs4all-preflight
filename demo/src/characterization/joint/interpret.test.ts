// Every joint-interpretation template: emitted when its condition holds, not emitted otherwise.
import { describe, expect, it } from "vitest";
import type { DesignModel, FactorDesign, TestEvidence, TestKind } from "../design/model";
import { translate } from "../../i18n";
import { fill } from "../../i18n";
import { jointSentences } from "./interpret";
import type { AssociationResult, JointRow } from "./model";
import { jointRows } from "./model";

const ev = (kind: TestKind, state: TestEvidence["state"]): TestEvidence => ({ kind, metricId: kind, factor: "", state, status: state === "significant" || state === "not_significant" ? "computed" : "not_identifiable", reasonCode: null, statistic: null, statisticName: null, pRaw: null, pHolm: state === "significant" ? 0.01 : 0.4, rejects: state === "significant", pBhExploratory: null, family: null, plan: null });

function factor(name: string, o: { marginal?: TestEvidence["state"]; within?: TestEvidence["state"]; permdisp?: TestEvidence["state"]; aliased?: boolean; determinedBy?: string[]; r2?: number | null; units?: number }): FactorDesign {
  return {
    factor: name, nLevels: 2, levels: [{ level: "l1", nUnits: (o.units ?? 20) / 2 }, { level: "l2", nUnits: (o.units ?? 20) / 2 }], varying: true,
    dfNominal: 1, dfGivenCells: o.aliased ? 0 : 1, dfGivenMainEffects: 1, dfReasonCode: null, aliasedWithCells: o.aliased ?? false, identifiableAdditive: !o.aliased, additiveReasonCode: null,
    partiallyConfounded: false, determinedBy: o.determinedBy ?? [], nOtherCells: 2,
    r2: { marginal: o.r2 === undefined ? 0.2 : o.r2, uniqueGivenCells: 0.1, uniqueAdditive: 0.1, partialGivenCells: null, partialAdditive: null, dfMarginal: 1, dfGivenCells: 1, dfAdditive: 1, pseudoFMarginal: null, reasonCode: null },
    tests: { marginal: o.marginal ? ev("marginal", o.marginal) : null, within_cell: o.within ? ev("within_cell", o.within) : null, freedman_lane: null, permdisp: o.permdisp ? ev("permdisp", o.permdisp) : null },
    dispersion: null,
  };
}

const design = (factors: FactorDesign[], cells: number | null = 0.9) => ({ factors, joint: { r2AllCells: cells, df: null, nCells: null, pseudoF: null, reasonCode: null } }) as unknown as DesignModel;

function assoc(metadata: string, o: { eta?: number; rejects?: boolean | null; units?: number; target?: string; kind?: "categorical" | "continuous" }): AssociationResult {
  return {
    targetId: o.target ?? "resp", metadata, metadataKind: o.kind ?? "categorical", metadataUnit: null, targetUnit: null, associationType: o.kind === "continuous" ? "continuous_metadata_continuous_target" : "categorical_metadata_continuous_target", status: "computed", reasonCode: null,
    populationId: "development_real", analysisUnit: null, denominators: { n_units_analyzed: o.units ?? 20, n_independence_units: 20 },
    measure: o.kind === "continuous" ? "spearman_rho" : "eta_squared", effect: o.eta ?? 0.3, statisticName: null, statistic: null, df1: 1, df2: 18, nLevels: 2, levels: [], classes: [], pearsonR: null, metadataSummary: null,
    test: o.rejects === undefined ? null : { status: "computed", reasonCode: null, pRaw: 0.01, pHolm: o.rejects ? 0.02 : 0.5, pBh: null, rejects: o.rejects, nPermutations: 999, resolution: 0.001, nullHypothesis: null },
    checks: [], consistent: null, joinMismatch: false,
  };
}

const fmt = (v: number) => v.toFixed(3);
const keys = (d: DesignModel, a: AssociationResult[], target = "resp") => jointSentences(jointRows(d, a, target), d, a, target, fmt).map((s) => s.key);

describe("joint interpretation templates", () => {
  it("jtIBoth", () => {
    expect(keys(design([factor("f1", { marginal: "significant" })]), [assoc("f1", { rejects: true })])).toContain("jtIBoth");
    expect(keys(design([factor("f1", { marginal: "significant" })]), [assoc("f1", { rejects: false })])).not.toContain("jtIBoth");
    expect(keys(design([factor("f1", { marginal: "not_identifiable" })]), [assoc("f1", { rejects: true })])).not.toContain("jtIBoth");
  });

  it("jtIConfounded names the determining factor; jtIAliased without one", () => {
    const k1 = jointSentences(jointRows(design([factor("f1", { marginal: "significant", aliased: true, determinedBy: ["f2"] })]), [], "resp"), design([factor("f1", { marginal: "significant", aliased: true, determinedBy: ["f2"] })]), [], "resp", fmt);
    expect(k1.find((s) => s.key === "jtIConfounded")?.vars).toEqual({ factor: "f1", other: "f2" });
    expect(keys(design([factor("f1", { marginal: "significant", aliased: true })]), [])).toContain("jtIAliased");
    expect(keys(design([factor("f1", { marginal: "significant", aliased: false, determinedBy: ["f2"] })]), [])).not.toContain("jtIConfounded");
    expect(keys(design([factor("f1", { marginal: "not_significant", aliased: true, determinedBy: ["f2"] })]), [])).not.toContain("jtIConfounded");
  });

  it("jtITargetDispersion", () => {
    expect(keys(design([factor("f1", { permdisp: "significant" })]), [assoc("f1", { rejects: true })])).toContain("jtITargetDispersion");
    expect(keys(design([factor("f1", { permdisp: "not_significant" })]), [assoc("f1", { rejects: true })])).not.toContain("jtITargetDispersion");
  });

  it("jtISmallTarget below the 0.06 landmark only", () => {
    expect(keys(design([]), [assoc("f1", { rejects: true, eta: 0.03 })])).toContain("jtISmallTarget");
    expect(keys(design([]), [assoc("f1", { rejects: true, eta: 0.2 })])).not.toContain("jtISmallTarget");
    expect(keys(design([]), [assoc("f1", { rejects: false, eta: 0.03 })])).not.toContain("jtISmallTarget");
  });

  it("jtITargetOnly needs a computed non-significant spectral test", () => {
    expect(keys(design([factor("f1", { marginal: "not_significant" })]), [assoc("f1", { rejects: true })])).toContain("jtITargetOnly");
    expect(keys(design([factor("f1", { marginal: "insufficient_resolution" })]), [assoc("f1", { rejects: true })])).not.toContain("jtITargetOnly");
  });

  it("jtIDifferentPop when unit counts differ", () => {
    expect(keys(design([factor("f1", { units: 20 })]), [assoc("f1", { units: 16 })])).toContain("jtIDifferentPop");
    expect(keys(design([factor("f1", { units: 20 })]), [assoc("f1", { units: 20 })])).not.toContain("jtIDifferentPop");
  });

  it("jtINoAdjusted only when adjusted tests were computed and none is significant", () => {
    expect(keys(design([factor("f1", { within: "not_significant" }), factor("f2", { within: "not_significant" })]), [])).toContain("jtINoAdjusted");
    expect(keys(design([factor("f1", { within: "significant" })]), [])).not.toContain("jtINoAdjusted");
    expect(keys(design([factor("f1", { within: "not_identifiable" })]), [])).not.toContain("jtINoAdjusted");
  });

  it("jtIOverlap when the marginal R² sum exceeds the R² of all cells", () => {
    expect(keys(design([factor("f1", { r2: 0.6 }), factor("f2", { r2: 0.5 })], 0.7), [])).toContain("jtIOverlap");
    expect(keys(design([factor("f1", { r2: 0.3 }), factor("f2", { r2: 0.3 })], 0.7), [])).not.toContain("jtIOverlap");
    expect(keys(design([factor("f1", { r2: 0.9 })], 0.7), [])).not.toContain("jtIOverlap");
  });

  it("jtINoTarget only with computed, non-rejected tests of the selected target", () => {
    expect(keys(design([]), [assoc("f1", { rejects: false }), assoc("c1", { rejects: false, kind: "continuous" })])).toContain("jtINoTarget");
    expect(keys(design([]), [assoc("f1", { rejects: false }), assoc("c1", { rejects: true, kind: "continuous" })])).not.toContain("jtINoTarget");
    expect(keys(design([]), [assoc("f1", {})])).not.toContain("jtINoTarget");
  });

  it("continuous metadata never enters the eta² axis", () => {
    const rows: JointRow[] = jointRows(design([]), [assoc("c1", { kind: "continuous", rejects: true })], "resp");
    expect(rows).toEqual([]);
  });

  it("every template is filled in English and French with no placeholder left", () => {
    const all = jointSentences(jointRows(design([factor("f1", { marginal: "significant", aliased: true, determinedBy: ["f2"], permdisp: "significant", units: 30 }), factor("f2", { r2: 0.9 })], 0.5), [assoc("f1", { rejects: true, eta: 0.02 })], "resp"),
      design([factor("f1", { marginal: "significant", aliased: true, determinedBy: ["f2"], permdisp: "significant", units: 30 }), factor("f2", { r2: 0.9 })], 0.5), [assoc("f1", { rejects: true, eta: 0.02 })], "resp", fmt);
    expect(all.length).toBeGreaterThan(3);
    for (const s of all) for (const locale of ["en", "fr"] as const) expect(fill(translate(s.key, locale), s.vars)).not.toMatch(/\{\w+\}/);
  });
});
