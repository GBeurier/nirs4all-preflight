import { describe, expect, it } from "vitest";
import { domainModel, interpret, missingDeclarations } from "./model";
import { auditInput, auditView } from "./testkit";

describe("domain model (engine values → relative metrics)", () => {
  it("derives the relative metrics with documented conventions", () => {
    const [f] = domainModel(auditView(), auditInput(), "nir");
    const c = f!.comparisons[0]!;
    expect(f!.audit).toBe(true);
    expect(c.referenceName).toBe("Calibration (development)");
    expect(c.comparedName).toBe("Retained test");
    // centre 2 ÷ sqrt(16) = 0.5
    expect(c.centre.relative).toBeCloseTo(0.5, 12);
    expect(c.centre.outsideSquaredShare).toBeCloseTo((1.2 / 2) ** 2, 12);
    // 0.1487 → 14.87 %, SD 38.56 %, 85.13 % lower
    expect(c.dispersion.relativePercent).toBeCloseTo(14.87, 10);
    expect(c.dispersion.relativeSd! * 100).toBeCloseTo(38.562, 2);
    expect(c.dispersion.differencePercent).toBeCloseTo(-85.13, 10);
    expect(c.energy.relative).toBeCloseTo(0.5, 12);
    expect(c.coverage.nBeyondBoth).toBe(1);
    // the audit never carries a target change
    expect(c.target).toBeNull();
  });

  it("handles zero denominators without inventing values", () => {
    const [f] = domainModel(auditView({ refVar: 0, within: 0, centroid: 0 }), auditInput(), "nir");
    const c = f!.comparisons[0]!;
    expect(c.centre.relative).toBeNull();
    expect(c.centre.outsideSquaredShare).toBeNull();
    expect(c.energy.relative).toBeNull();
  });

  it("reports the inference status and the missing declarations", () => {
    const [f] = domainModel(auditView(), auditInput(), "nir");
    expect(f!.inference.status).toBe("unavailable");
    expect(f!.inference.reasonCode).toBe("INDEPENDENCE_UNIT_UNKNOWN");
    expect(f!.inference.missing.join(" ")).toMatch(/Independent experimental unit/);
    expect(f!.inference.missing.join(" ")).toMatch(/Physical sample identifier/);
    expect(f!.inference.missing.join(" ")).toMatch(/Exchangeability/);
    const [valid] = domainModel(auditView({ testStatus: "computed", pValue: 0.3 }), auditInput(), "nir");
    expect(valid!.inference.status).toBe("valid");
    expect(missingDeclarations({ ...auditInput(), options: { independence_unit: "sample", exchangeable_units: true }, samples: auditInput().samples.map((s) => ({ ...s, physical_sample_id: s.sample_id })) }, "nir", null)).toEqual([]);
  });
});

describe("deterministic interpretation", () => {
  const base = () => domainModel(auditView(), auditInput(), "nir")[0]!;

  it("states the variance share and the narrower domain", () => {
    const f = base();
    const it = interpret(f.comparisons[0]!, f.inference);
    const text = it.findings.map((x) => x.text);
    expect(text).toContain("The compared population has 14.87% of the total spectral variance observed in the reference population.");
    expect(text.some((t) => t.startsWith("The compared domain exhibits substantially lower spectral diversity"))).toBe(true);
    // without coverage support the "restricted part" clause is not added
    expect(text.some((t) => t.includes("restricted part"))).toBe(false);
    expect(text).toContain("Statistical inference is unavailable because independent experimental units and exchangeability conditions have not been established.");
    expect(text).toContain("Most compared samples remain within the reference T² and Q limits.");
    expect(it.investigate.length).toBeGreaterThan(0);
  });

  it("adds the restricted-part clause only when coverage supports it", () => {
    const f = base();
    const text = interpret(f.comparisons[0]!, f.inference, { support: { supported: 0.95, represented: 0.3 } }).findings.map((x) => x.text);
    expect(text.some((t) => t.includes("It may cover only a restricted part of the calibration population."))).toBe(true);
    expect(text.some((t) => t.includes("may limit the representativeness of the validation dataset"))).toBe(true);
  });

  it("flags elevated Q, broad domains, energy context and never a 'no shift' wording", () => {
    const [f] = domainModel(auditView({ nQ: 6, nEither: 7, tgtVar: 3, centroid: 8 }), auditInput(), "nir");
    const text = interpret(f!.comparisons[0]!, f!.inference, { energy: { status: "available", reason: null, percentile: 0.99, typical: 1 } }).findings.map((x) => x.text);
    expect(text).toContain("Several samples exhibit elevated Q residuals, indicating spectral structures poorly represented by the reference subspace.");
    expect(text.some((t) => t.includes("substantially broader"))).toBe(true);
    expect(text.some((t) => t.includes("larger than the typical spread"))).toBe(true);
    expect(text).toContain("The energy distance is larger than typical differences observed between comparable reference subsets.");
    expect(text.some((t) => /\bno shift\b/i.test(t))).toBe(false);
    const [valid] = domainModel(auditView({ testStatus: "computed", pValue: 0.4 }), auditInput(), "nir");
    expect(interpret(valid!.comparisons[0]!, valid!.inference).findings.map((x) => x.text)).toContain("No statistically significant evidence of distribution shift under the specified test.");
  });

  it("does not state the energy context when it is unavailable", () => {
    const f = base();
    const text = interpret(f.comparisons[0]!, f.inference, { energy: { status: "unavailable", reason: "small", percentile: 1, typical: null } }).findings.map((x) => x.text);
    expect(text.some((t) => t.startsWith("The energy distance"))).toBe(false);
  });
});
