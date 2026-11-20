// Design adapter, consistency checks and local unit rebuild against the real engine on heterogeneous synthetic
// designs with arbitrary factor names (complete / incomplete factorials, directional and mutual determination,
// multivariate aliasing, constant factors, unequal groups, insufficient permutation resolution, blocked tests,
// no metadata, independence groups).
import { describe, expect, it } from "vitest";
import { loadMethods } from "../domains/kernels";
import { associationRows, permanovaChecks } from "./consistency";
import { runEngine } from "./engine";
import { adjustmentDrop, bhAdjust, designModel, holmAdjust, type DesignModel } from "./model";
import { cycle, designInput, type DesignSpec } from "./testkit";
import { designUnits, factorDistances } from "./units";

const run = (spec: DesignSpec) => {
  const input = designInput(spec);
  const { view, report } = runEngine(input);
  return { input, view, report, model: designModel(view, "src_a")! };
};
const factor = (m: DesignModel, f: string) => m.factors.find((x) => x.factor === f)!;
const relation = (m: DesignModel, to: string) => m.relations.filter((r) => r.to === to || (r.kind === "mutual" && r.from === to));

describe("design adapter on the real engine", () => {
  const n = 24;
  // f_one: 3 levels; f_two: 2 levels fully crossed with f_one; f_three: aliased with f_one × f_two cells but no
  // single factor determines it (incomplete crossing with f_one).
  const aliased = run({ factors: { f_one: cycle(["a", "b", "c"], n, 8), f_two: cycle(["x", "y"], n, 4), f_three: cycle(["m", "n"], n, 12) }, target: true, effects: { f_one: 0.2, f_two: 0.05 } });

  it("reads levels, units and denominators from the engine", () => {
    const m = aliased.model;
    expect(m.state.status).toBe("computed");
    expect(m.nUnitsAnalyzed).toBe(n);
    expect(factor(m, "f_one").levels).toEqual([{ level: "a", nUnits: 8 }, { level: "b", nUnits: 8 }, { level: "c", nUnits: 8 }]);
    expect(m.factors.every((f) => f.varying)).toBe(true);
  });

  it("derives crossing coverage from the engine unit counts", () => {
    const c = aliased.model.crossings.find((x) => x.a === "f_one" && x.b === "f_three")!;
    expect([c.occupied, c.possible, c.minOccupied, c.maxOccupied, c.nUnits]).toEqual([4, 6, 4, 8, n]);
    const full = aliased.model.crossings.find((x) => x.a === "f_one" && x.b === "f_two")!;
    expect(full.coverage).toBe(1);
  });

  it("reports multivariate aliasing when no pairwise relation explains it", () => {
    const m = aliased.model;
    const f3 = factor(m, "f_three");
    expect(f3.aliasedWithCells).toBe(true);
    expect(f3.identifiableAdditive).toBe(true);
    expect(relation(m, "f_three").map((r) => r.kind).sort()).toEqual(["aliasing", "partial"]);
    expect(f3.tests.within_cell!.state).toBe("not_identifiable");
    expect(f3.r2!.uniqueGivenCells).toBeNull();
    expect(f3.r2!.uniqueAdditive).not.toBeNull();
  });

  it("keeps marginal, unique-given-cells and unique-additive R² distinct and flags overlapping marginal R²", () => {
    const m = aliased.model;
    const shares = m.factors.map((f) => f.r2!.marginal!);
    // Overlapping marginal shares: their sum exceeds the R² of all observed cells.
    expect(shares.reduce((s, v) => s + v, 0)).toBeGreaterThan(m.joint!.r2AllCells!);
    const f1 = factor(m, "f_one");
    expect(f1.r2!.uniqueGivenCells!).toBeLessThan(f1.r2!.marginal!);
    expect(f1.r2!.partialGivenCells!).toBeGreaterThan(f1.r2!.uniqueGivenCells!);
    expect(adjustmentDrop(f1)).toMatchObject({ marginal: f1.r2!.marginal, adjusted: f1.r2!.uniqueGivenCells, basis: "cells" });
  });

  it("passes the F / R² / df / unit identities (§11)", () => {
    for (const f of aliased.model.factors) expect(permanovaChecks(f, aliased.model.nUnitsAnalyzed).every((c) => c.ok)).toBe(true);
    const rows = associationRows(aliased.view).filter((r) => r.state.status === "computed");
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.checks.map((c) => c.id).sort()).toEqual(["df1_levels", "df2_units", "f_identity", "level_units_sum", "test_join"]);
      expect(r.consistent).toBe(true);
      expect(r.test).not.toBeNull();
    }
  });

  it("reproduces the engine Holm families and Methods BH from the entered p-values", async () => {
    const methods = await loadMethods();
    for (const fam of aliased.model.families) {
      const entered = fam.members.map((mem) => factor(aliased.model, mem.factor).tests[mem.test.endsWith("permdisp_test") ? "permdisp" : mem.test.endsWith("conditional_test") ? "within_cell" : mem.test.endsWith("freedman_lane_test") ? "freedman_lane" : "marginal"]!);
      const p = entered.map((t) => t.pRaw ?? 1);
      const holm = holmAdjust(p);
      entered.forEach((t, i) => { if (t.pHolm !== null) expect(holm[i]).toBeCloseTo(t.pHolm, 12); });
      const bh = Array.from(methods.statsBhAdjust(Float64Array.from(p)));
      expect(bhAdjust(p).map((v, i) => v - bh[i]!).every((d) => Math.abs(d) < 1e-15)).toBe(true);
    }
    // Association family: the engine's own exploratory BH equals the mirror over its entered p-values.
    const rows = associationRows(aliased.view).filter((r) => r.test?.state.status === "computed");
    const p = rows.map((r) => r.test!.pRaw ?? 1);
    bhAdjust(p).forEach((v, i) => expect(v).toBeCloseTo(rows[i]!.test!.pBhExploratory!, 12));
  });

  it("rebuilds the analysed units and matches the engine PERMDISP distances", async () => {
    const methods = await loadMethods();
    const u = designUnits(aliased.view, aliased.input, aliased.model);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    for (const f of aliased.model.factors) {
      const d = factorDistances(methods, u.units, aliased.model, f.factor)!;
      expect(d.matchesEngine).toBe(true);
      expect(d.distances.length).toBe(n);
    }
  });

  it("orients full determination and detects mutual determination", () => {
    const fine = cycle(["k1", "k2", "k3", "k4"], 16, 4);
    const coarse = fine.map((l) => (l === "k1" || l === "k2" ? "G" : "H"));
    const twin = fine.map((l) => `t-${l}`);
    const m = run({ factors: { fine_lv: fine, coarse_lv: coarse, other: cycle(["p", "q"], 16) } }).model;
    expect(m.relations.find((r) => r.kind === "determines")).toMatchObject({ from: "fine_lv", to: "coarse_lv" });
    expect(factor(m, "coarse_lv").determinedBy).toContain("fine_lv");
    const mm = run({ factors: { left_f: fine, right_f: twin, other: cycle(["p", "q"], 16) } }).model;
    expect(mm.relations.some((r) => r.kind === "mutual")).toBe(true);
    expect(factor(mm, "left_f").aliasedWithCells).toBe(true);
    expect(factor(mm, "left_f").identifiableAdditive).toBe(false);
  });

  it("handles a constant factor, unequal groups and a blocked design", () => {
    const sizes = [...Array(3).fill("r1"), ...Array(9).fill("r2"), ...Array(6).fill("r3")];
    const m = run({ factors: { const_f: Array(18).fill("only"), uneq: sizes }, exchangeable: false }).model;
    const c = factor(m, "const_f");
    expect(c.varying).toBe(false);
    expect(c.tests.marginal!.state).toBe("not_applicable");
    expect(factor(m, "uneq").levels.map((l) => l.nUnits)).toEqual([3, 9, 6]);
    expect(factor(m, "uneq").tests.marginal!.state).toBe("blocked");
    expect(m.blockedReason).toBe("EXCHANGEABILITY_NOT_DECLARED");
  });

  it("explains insufficient permutation resolution from the admissible space", () => {
    const m = run({ factors: { pa: ["u", "u", "v", "v"], pb: ["s", "t", "s", "t"] } }).model;
    const t = factor(m, "pa").tests.marginal!;
    expect(t.state).toBe("insufficient_resolution");
    expect(t.plan!.resolutionCause).toBe("admissible_permutations");
  });

  it("reports an unavailable design without metadata", () => {
    const { view } = runEngine(designInput({ factors: {} }));
    const m = designModel(view, "src_a");
    expect(m?.state).toEqual({ status: "not_applicable", reasonCode: "NO_DECLARED_FACTOR" });
    expect(m?.factors).toEqual([]);
  });

  it("merges declared independence groups into units like the engine", async () => {
    const groups = cycle(["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"], 16, 2);
    const levels = groups.map((g) => (Number(g.slice(1)) % 2 ? "odd_l" : "even_l"));
    const r = run({ factors: { grp_level: levels, side: cycle(["l", "r"], 16, 4) }, groups });
    expect(r.model.nUnitsAnalyzed).toBe(8);
    const u = designUnits(r.view, r.input, r.model);
    expect(u.ok).toBe(true);
    if (u.ok) {
      const d = factorDistances(await loadMethods(), u.units, r.model, "grp_level");
      expect(d?.matchesEngine).toBe(true);
    }
  });
});

describe("association identities on mixed metadata and target kinds (§11)", () => {
  it("η²/F/df identities hold for categorical × continuous and continuous × categorical pairs", () => {
    const n = 21;
    const input = designInput({ factors: { cat_m: cycle(["l1", "l2", "l3"], n, 1) }, target: true });
    input.metadata!.columns.push({ name: "cont_m", kind: "continuous" });
    input.samples.forEach((s, i) => { input.metadata!.values[s.sample_id]!.cont_m = ((i * 7919) % 23) + 0.5 * (i % 2); });
    input.targets.push({ target_id: "class_t", kind: "categorical", values: input.samples.map((s, i) => ({ sample_id: s.sample_id, category: i % 3 === 0 ? "k_a" : "k_b", status: "exact" as const })) });
    const rows = associationRows(runEngine(input).view).filter((r) => r.state.status === "computed");
    const types = new Set(rows.map((r) => r.associationType));
    expect(types.has("categorical_metadata_continuous_target")).toBe(true);
    expect(types.has("continuous_metadata_categorical_target")).toBe(true);
    for (const r of rows.filter((x) => x.statisticName === "anova_f")) expect(r.consistent).toBe(true);
    for (const r of rows) expect(r.joinMismatch).toBe(false);
  });
});
