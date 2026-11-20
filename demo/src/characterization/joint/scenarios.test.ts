// Validation scenario generation and per-fold audit on heterogeneous synthetic designs (arbitrary names).
import { describe, expect, it } from "vitest";
import { loadMethods } from "../domains/kernels";
import { auditFold, candidateScenarios, customScenario, groupedCv, scenarioBase, scenarioTargets } from "./scenarios";
import { foldSpectral } from "./spectralShift";
import { simultaneousMessage, targetMessage } from "./ScenarioAudit";
import { translate, type TextKey } from "../../i18n";
import { synthInput } from "./testkit";

const fmt = (v: number) => String(+v.toPrecision(3));
const t = (k: TextKey) => translate(k, "en");

// Nested design: "lotx" levels are each inside one "sitey" level; "crossz" is crossed with "sitey".
const nested = () => synthInput({
  units: 36,
  retained: (i) => i >= 30,
  spectralFactors: ["sitey"],
  factors: [
    { name: "sitey", kind: "categorical", of: (i) => ["s1", "s2", "s3"][i % 3]! },
    { name: "lotx", kind: "categorical", of: (i) => `${["s1", "s2", "s3"][i % 3]}-L${Math.floor(i / 6) % 2}` },
    { name: "crossz", kind: "categorical", of: (i) => ["c1", "c2"][Math.floor(i / 3) % 2]! },
    { name: "dose", kind: "continuous", of: (i) => (i % 9 === 4 ? null : Math.floor(i / 2)) },
  ],
  targets: [
    { id: "resp", kind: "continuous", of: (i) => i },
    { id: "cls", kind: "categorical", of: (i) => (i % 3 === 0 ? "rare" : "common") },
  ],
});

describe("scenario generation", () => {
  it("without metadata only grouped CV exists; every development unit is validated exactly once", () => {
    const input = synthInput({ units: 17, retained: (i) => i > 14 });
    const base = scenarioBase(input, "src")!;
    expect(base.units).toHaveLength(15);
    const sc = candidateScenarios(input, base, fmt);
    expect(sc.map((s) => s.kind)).toEqual(["grouped_cv"]);
    const seen = sc[0]!.folds.flatMap((f) => f.validation).sort((a, b) => a - b);
    expect(seen).toEqual(base.units.map((u) => u.index));
    for (const f of sc[0]!.folds) expect(f.development.some((u) => f.validation.includes(u))).toBe(false);
    // Deterministic for a given seed.
    expect(groupedCv(base, 5)).toEqual(groupedCv(base, 5));
  });

  it("builds leave-one-level-out, interval and combination scenarios from development units only", () => {
    const input = nested();
    const base = scenarioBase(input, "src")!;
    expect(base.units).toHaveLength(30);
    const sc = candidateScenarios(input, base, fmt);
    expect(sc.map((s) => s.id)).toEqual(["cv", "lolo:sitey", "lolo:lotx", "lolo:crossz", "int:dose", "combo:sitey:lotx", "combo:sitey:crossz", "combo:lotx:crossz"]);
    const dose = sc.find((s) => s.id === "int:dose")!;
    expect(dose.folds).toHaveLength(4);
    expect(dose.unassigned).toBe(base.units.filter((u) => u.values.dose === null).length);
    // Tied values never split across bins.
    const binOf = new Map(dose.folds.flatMap((f, b) => f.validation.map((u) => [base.units[u]!.values.dose, b] as const)));
    for (const f of dose.folds) for (const u of f.validation) expect(binOf.get(base.units[u]!.values.dose)).toBe(dose.folds.indexOf(f));
  });

  it("flags nested levels held out with the scenario factor (parameterized message)", () => {
    const input = nested();
    const base = scenarioBase(input, "src")!;
    const lolo = candidateScenarios(input, base, fmt).find((s) => s.id === "lolo:sitey")!;
    const a = auditFold(base, lolo, lolo.folds[0]!, null, null);
    expect(a.simultaneous).toEqual([{ factor: "lotx", levels: ["s1-L0", "s1-L1"] }]);
    expect(simultaneousMessage(lolo, a, t)).toBe("Holding out s1 simultaneously holds out entire lotx (s1-L0, s1-L1) levels. This scenario does not isolate the effect of sitey.");
    const crossed = candidateScenarios(input, base, fmt).find((s) => s.id === "lolo:crossz")!;
    const b = auditFold(base, crossed, crossed.folds[0]!, null, null);
    expect(b.simultaneous).toEqual([]);
    expect(simultaneousMessage(crossed, b, t)).toBeNull();
  });

  it("counts covered and unseen level combinations", () => {
    const input = nested();
    const base = scenarioBase(input, "src")!;
    const combo = candidateScenarios(input, base, fmt).find((s) => s.id === "combo:sitey:crossz")!;
    const a = auditFold(base, combo, combo.folds[0]!, null, null);
    // Full cells over every categorical factor: s1 × c1 spans the two s1 lots.
    expect(a.cells.val).toBe(2);
    expect(a.cells.valUnseen).toBe(2);
    expect(a.cells.inDev).toBe(a.cells.total - 2);
    expect(a.absentFromDev).toEqual([]);
  });

  it("reports target extrapolation and absent classes from development references only", () => {
    const input = nested();
    const base = scenarioBase(input, "src")!;
    const dose = candidateScenarios(input, base, fmt).find((s) => s.id === "int:dose")!;
    const top = dose.folds[dose.folds.length - 1]!;
    const resp = scenarioTargets(input, "resp");
    const a = auditFold(base, dose, top, resp.labels, resp.kind);
    expect(a.target.kind).toBe("continuous");
    if (a.target.kind !== "continuous") return;
    expect(a.target.nOutside).toBe(a.nVal);
    expect(a.target.devRange[1]).toBeLessThan(30); // retained-test targets (30..35) never enter the range
    expect(targetMessage(a, t, fmt)).toMatch(/possible target extrapolation/);
    const cls = scenarioTargets(input, "cls");
    const site = candidateScenarios(input, base, fmt).find((s) => s.id === "lolo:sitey")!;
    const b = auditFold(base, site, site.folds[0]!, cls.labels, cls.kind);
    expect(b.target).toEqual({ kind: "categorical", absentFromDev: ["rare"], nValUnits: b.nVal });
    expect(auditFold(base, site, site.folds[0]!, null, null).target).toEqual({ kind: "none", reason: "no_target" });
  });

  it("different X and Y populations: units without a development target are not counted on the target side", () => {
    const input = nested();
    input.targets[0]!.values = input.targets[0]!.values.filter((_, i) => i % 2 === 0);
    const base = scenarioBase(input, "src")!;
    const cv = candidateScenarios(input, base, fmt)[0]!;
    const resp = scenarioTargets(input, "resp");
    const a = auditFold(base, cv, cv.folds[0]!, resp.labels, resp.kind);
    expect(a.target.kind === "continuous" && a.target.nValUnits < a.nVal).toBe(true);
  });

  it("user-defined domains", () => {
    const input = nested();
    const base = scenarioBase(input, "src")!;
    const s = customScenario(base, { factor: "crossz", kind: "categorical", levels: ["c2"] }, fmt)!;
    expect(s.folds[0]!.validation.every((u) => base.units[u]!.levels.crossz === "c2")).toBe(true);
    expect(customScenario(base, { factor: "dose", kind: "continuous", lo: 3, hi: 6 }, fmt)!.folds[0]!.validation.every((u) => base.units[u]!.values.dose! >= 3 && base.units[u]!.values.dose! <= 6)).toBe(true);
    expect(customScenario(base, { factor: "crossz", kind: "categorical", levels: ["c1", "c2"] }, fmt)).toBeNull();
  });
});

describe("spectral fold description (Methods monitor, development-only fit)", () => {
  it("separates a shifted validation side from a random one", async () => {
    const m = await loadMethods();
    const input = nested();
    const base = scenarioBase(input, "src")!;
    const lolo = candidateScenarios(input, base, fmt).find((s) => s.id === "lolo:sitey")!;
    const cv = candidateScenarios(input, base, fmt)[0]!;
    const at = (f: { development: number[]; validation: number[] }) => foldSpectral(m, f.development.map((i) => base.spectra[i]!), f.validation.map((i) => base.spectra[i]!));
    const shifted = at(lolo.folds[2]!);
    const random = at(cv.folds[0]!);
    expect(shifted.centreShift!).toBeGreaterThan(random.centreShift!);
    for (const r of [shifted, random]) {
      expect(r.coverage!).toBeGreaterThanOrEqual(0);
      expect(r.coverage!).toBeLessThanOrEqual(1);
      expect(r.dispersionRatio!).toBeGreaterThan(0);
    }
    expect(at({ development: [0, 1], validation: [2] }).coverage).toBeNull();
  });
});
