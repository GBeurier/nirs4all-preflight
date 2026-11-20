// Local permutation null against the real engine (@nirs4all/preflight WASM + Methods), on the demo synthetic
// set with declared independent units (one physical sample per unit) and declared exchangeability, so the
// engine's energy tests are valid for the campaign factor and for the development / retained-test audit.
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";
import { syntheticInput } from "../../synthetic";
import { loadMethods } from "./kernels";
import { domainModel, testPlan } from "./model";
import { pairwiseMatrix } from "./pairwise";
import { deriveSeed, monteCarloAgreement, permutationNull, seedDomain } from "./permutation";
import { testPopulation } from "./populations";

const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const root = new URL("../../../", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("node_modules/@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", root)),
  dagMlWasmModule: await fs.readFile(new URL("../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", root)),
});

interface RawMetric { metric_id: string; status: string; source_id?: string; value?: Record<string, unknown> | null; parameters?: Record<string, unknown> }

function validInput(): EngineInput {
  const input = syntheticInput("clean");
  input.options = { ...input.options, exchangeable_units: true, domain_shift: { external_domain_audit: true } };
  return input;
}

describe("local energy permutation null vs the engine", async () => {
  const input = validInput();
  const report = runtime.analyze(input) as { metrics: RawMetric[] };
  const m = await loadMethods();
  const tests = report.metrics.filter((x) => x.metric_id === "domain_shift.energy_test" && x.status === "computed");
  const families = report.metrics.filter((x) => x.metric_id === "domain_shift.test_family");

  it("has valid engine tests for the campaign factor and the audit", () => {
    expect(tests.map((t) => t.parameters?.factor).sort()).toEqual(["campaign", "partition"]);
  });

  for (const factor of ["campaign", "partition"]) {
    it(`reproduces the engine statistic, seed, draws count and p-value (${factor})`, () => {
      const t = tests.find((x) => x.parameters?.factor === factor)!;
      const plan = t.parameters!.permutation_plan as Record<string, unknown>;
      const value = t.value!;
      const audit = factor === "partition";
      const pop = testPopulation(input, "synthetic_nir", factor, audit)!;
      // Seed: the plan's decimal u64 equals the engine derivation recomputed here.
      expect(String(deriveSeed(BigInt(String(input.options.seed)), seedDomain("synthetic_nir", factor)))).toBe(String(plan.seed));
      const fam = families.find((x) => x.parameters?.family === t.parameters?.family)!;
      const members = (fam.value!.members as { factor: string; p_value_entered: number }[]);
      const r = permutationNull(m, {
        spectra: pop.units.map((u) => u.spectrum),
        codes: pop.codes,
        nGroups: pop.levels.length,
        seed: String(plan.seed),
        permutations: Number(plan.n_permutations_executed),
        leading: audit ? null : { development: pop.development.map((u) => u.spectrum), index: pop.developmentIndex! },
        family: { pValues: members.map((x) => x.p_value_entered), member: members.findIndex((x) => x.factor === factor) },
      });
      expect(r.space).toBe(audit ? "complete_spectra" : "leading_pca");
      expect(r.observed).toBeCloseTo(Number(value.statistic), 9);
      expect(Math.abs(r.observed - Number(value.statistic)) / Number(value.statistic)).toBeLessThan(1e-9);
      expect(r.draws).toHaveLength(999);
      expect(r.atLeast).toBe(Number(value.n_at_least_observed));
      expect(r.pValue).toBe(Number(value.p_value));
      expect(r.pValueHolm).toBeCloseTo(Number(value.p_value_holm), 12);
      expect(monteCarloAgreement(r.pValue, Number(value.p_value), 999).differs).toBe(false);
      // Methods reference kernel with the same seed: same count of draws at least as extreme.
      const X = pop.units.map((u) => u.spectrum);
      if (audit) {
        const p = X[0]!.length;
        const data = new Float64Array(X.length * p);
        X.forEach((row, i) => data.set(row, i * p));
        const e = m.statsEnergyDistance({ data, rows: X.length, cols: p }, pop.codes, 2, 999, BigInt(String(plan.seed)));
        expect(e.nAtLeastObserved).toBe(r.atLeast);
      }
    });
  }

  it("reads the engine plan through the report view (seed kept as a decimal string)", () => {
    const view = buildQualificationReportView(report as unknown as EngineReport);
    const plan = testPlan(view, "synthetic_nir", "partition")!;
    expect(plan.permutations).toBe(999);
    expect(plan.seed).toMatch(/^\d+$/);
    expect(plan.familyPValues).toHaveLength(1);
    expect(testPlan(view, "synthetic_nir", "instrument")).toBeNull();
  });

  it("pairwise matrix of a two-level factor reproduces the engine level-vs-rest metrics", () => {
    const view = buildQualificationReportView(report as unknown as EngineReport);
    const campaign = domainModel(view, input, "synthetic_nir").find((f) => f.factor === "campaign")!;
    const pop = testPopulation(input, "synthetic_nir", "campaign", false)!;
    const r = pairwiseMatrix(m, { development: pop.development.map((u) => u.spectrum), index: pop.developmentIndex!, codes: pop.codes, levels: pop.levels, energyOnSpectra: false, monitorOnSpectra: false });
    for (const c of campaign.comparisons) {
      const cell = r.cells.find((x) => r.levels[x.compared] === c.comparedLevel && r.levels[x.reference] === c.referenceLevels[0])!;
      expect(cell.relativeCentre!).toBeCloseTo(c.centre.relative!, 9);
      expect(cell.dispersionRatio!).toBeCloseTo(c.dispersion.ratio!, 9);
      expect(cell.relativeEnergy!).toBeCloseTo(c.energy.relative!, 9);
    }
  });
});
