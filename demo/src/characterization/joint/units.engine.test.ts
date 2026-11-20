// Local association units vs the real engine (@nirs4all/preflight WASM + Methods) on heterogeneous synthetic inputs:
// every denominator of every metadata × target pair, per-level unit counts and per-level target min / median / max.
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";
import { associationResults } from "./model";
import { associationRows, metadataFactors, targetUnits } from "./units";
import { synthInput } from "./testkit";

const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const root = new URL("../../../", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("node_modules/@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", root)),
  dagMlWasmModule: await fs.readFile(new URL("../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", root)),
});

const crossed = () => synthInput({
  units: 42,
  retained: (i) => i % 7 === 6,
  repeats: 2,
  spectralFactors: ["alpha"],
  factors: [
    { name: "alpha", kind: "categorical", of: (i) => (i % 11 === 3 ? null : ["a1", "a2", "a3"][i % 3]!) },
    { name: "gamma", kind: "categorical", of: (i) => ["g1", "g2"][Math.floor(i / 21)]! },
    { name: "beta_value", kind: "continuous", of: (i) => (i % 13 === 5 ? null : 0.25 * i), unit: "u" },
  ],
  targets: [
    { id: "t_cont", kind: "continuous", of: (i, l) => (l.alpha === "a1" ? 4 : 2) + (i % 5) * 0.3, unit: "mg" },
    { id: "t_cat", kind: "categorical", of: (i) => (i % 4 < 2 ? "P" : "Q") },
  ],
});

/** Shared physical samples (pairs), a metadata level varying inside one unit and a target varying inside another. */
const linked = () => {
  const input = synthInput({
    units: 30,
    retained: (i) => i >= 26,
    factors: [{ name: "zone", kind: "categorical", of: (i) => ["z1", "z2", "z3"][Math.floor(i / 2) % 3]! }],
    targets: [{ id: "score", kind: "continuous", of: (i) => Math.floor(i / 2) * 0.5 }],
  });
  input.samples.forEach((s, i) => (s.physical_sample_id = `p-${Math.floor(i / 2)}`));
  input.metadata!.values["obj-005"]!.zone = "z9";
  input.targets[0]!.values[8]!.value = 99;
  return input;
};

/** Declared groups as the independence unit. */
const grouped = () => {
  const input = synthInput({
    units: 36,
    factors: [{ name: "lot", kind: "categorical", of: (i) => ["L1", "L2", "L3", "L4"][Math.floor(i / 3) % 4]! }],
    targets: [{ id: "y", kind: "continuous", of: (i) => Math.floor(i / 3) }],
  });
  input.samples.forEach((s, i) => (s.independence_group = `grp-${Math.floor(i / 3)}`));
  input.options.independence_unit = "group";
  return input;
};

const noMetadata = () => synthInput({ units: 12, targets: [{ id: "only", kind: "continuous", of: (i) => i }] });

/** Only the association and confounding families (the other analyses are irrelevant here and slow). */
const focused = (input: EngineInput): EngineInput => ({ ...input, options: { ...input.options, analysis_families: { spectral_quality: false, sensitivity: false, repeatability: false, clustering: false, association: true, confounding: true, domain_shift: false, probe: false } } });
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const h = (s.length - 1) / 2; return (s[Math.floor(h)]! + s[Math.ceil(h)]!) / 2; };

function compare(name: string, input: EngineInput) {
  it(`reproduces the engine association units (${name})`, () => {
    const report = runtime.analyze(focused(input)) as EngineReport;
    const view = buildQualificationReportView(report);
    const results = associationResults(view, null, true);
    expect(results.length).toBe(input.targets.length * metadataFactors(input).length);
    for (const a of results) {
      const units = targetUnits(input, a.targetId)!;
      const factor = metadataFactors(input).find((f) => f.name === a.metadata)!;
      const local = associationRows(input, units, factor);
      expect(local.denominators, `${a.targetId} × ${a.metadata}`).toEqual(a.denominators);
      if (a.status !== "computed" || a.metadataKind !== "categorical" || !a.levels.some((l) => l.target)) continue;
      for (const l of a.levels) {
        const values = local.rows.filter((r) => r.metadata.kind === "level" && r.metadata.level === l.level).map((r) => (r.target as { value: number }).value);
        expect(values.length).toBe(l.nUnits);
        expect(Math.min(...values)).toBeCloseTo(l.target!.min!, 12);
        expect(Math.max(...values)).toBeCloseTo(l.target!.max!, 12);
        expect(median(values)).toBeCloseTo(l.target!.median!, 12);
      }
    }
  }, 60_000);
}

describe("association units vs the real engine", () => {
  compare("crossed factors, two targets, retained test, missing metadata", crossed());
  compare("linked physical samples, varying metadata and target", linked());
  compare("declared groups", grouped());
  compare("no declared metadata", noMetadata());

  it("covers the expected exclusions", () => {
    const input = linked();
    const units = targetUnits(input, "score")!;
    const rows = associationRows(input, units, metadataFactors(input).find((f) => f.name === "zone")!);
    expect(rows.denominators.n_units_metadata_varies_within_unit).toBe(1);
    expect(rows.denominators.n_units_target_varies_within_unit).toBe(1);
    expect(units.references.excludedRetainedPredictionOrAugmented).toBe(4);
  });

  it("reports eta² for categorical metadata and Spearman rho for continuous metadata, F consistent", () => {
    const view = buildQualificationReportView(runtime.analyze(focused(crossed())) as EngineReport);
    const rows = associationResults(view, "t_cont");
    expect(rows.find((a) => a.metadata === "alpha")!.measure).toBe("eta_squared");
    expect(rows.find((a) => a.metadata === "beta_value")!.measure).toBe("spearman_rho");
    expect(rows.find((a) => a.metadata === "alpha")!.consistent).toBe(true);
    expect(associationResults(view, "t_cat").find((a) => a.metadata === "alpha")!.measure).toBe("cramers_v");
  }, 60_000);
});
