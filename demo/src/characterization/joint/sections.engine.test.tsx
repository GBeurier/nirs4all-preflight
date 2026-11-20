// Rendering and retained-test protection of the joint sections on real engine reports of heterogeneous synthetic
// inputs (no metadata, no target, several targets, categorical target, continuous metadata, nested factors).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";
import { translate, type TextKey } from "../../i18n";
import type { Scope } from "../../Sections";
import { DesignSelectionProvider } from "../design/selection";
import { JointSection } from "./JointSection";
import { ScenarioAuditSection } from "./ScenarioAudit";
import { TargetAssociations } from "./TargetAssociations";
import { auditFold, candidateScenarios, scenarioBase, scenarioTargets } from "./scenarios";
import { associationRows, metadataFactors, targetUnits } from "./units";
import { guardRetainedTargets, synthInput } from "./testkit";

const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const root = new URL("../../../", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("node_modules/@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", root)),
  dagMlWasmModule: await fs.readFile(new URL("../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", root)),
});
const focused = (input: EngineInput): EngineInput => ({ ...input, options: { ...input.options, analysis_families: { spectral_quality: false, sensitivity: false, repeatability: false, clustering: false, association: true, confounding: true, domain_shift: false, probe: false } } });

const designed = () => synthInput({
  units: 40,
  retained: (i) => i % 8 === 7,
  spectralFactors: ["kappa"],
  factors: [
    { name: "kappa", kind: "categorical", of: (i) => ["k-a", "k-b"][i % 2]! },
    { name: "lambda", kind: "categorical", of: (i) => ["m1", "m2", "m3", "m4"][i % 4]! },
    { name: "mu_cont", kind: "continuous", of: (i) => i * 1.5, unit: "deg" },
  ],
  targets: [
    { id: "y_main", kind: "continuous", of: (i, l) => (l.kappa === "k-a" ? 10 : 5) + (i % 7) * 0.2, unit: "%" },
    { id: "y_class", kind: "categorical", of: (i) => (i % 2 === 0 ? "pos" : "neg") },
  ],
});

function scopeOf(input: EngineInput, targetId: string | null, locale: "en" | "fr" = "en"): Scope {
  const report = runtime.analyze(focused(input)) as EngineReport;
  return { t: (k: TextKey) => translate(k, locale), locale, view: buildQualificationReportView(report), input, sourceId: "src", targetId };
}
const render = (scope: Scope) => renderToStaticMarkup(
  <DesignSelectionProvider>
    <TargetAssociations scope={scope} />
    <JointSection {...scope} />
    <ScenarioAuditSection {...scope} />
  </DesignSelectionProvider>,
);

describe("joint sections on real engine reports", () => {
  it("renders η², ρ, the landscape, interpretation and scenarios for a designed input", () => {
    const html = render(scopeOf(designed(), "y_main"));
    expect(html).toContain("Target variance associated with categorical metadata (η²)");
    expect(html).toContain("Rank correlation with continuous metadata (Spearman ρ)");
    expect(html).toContain("Joint X–Y association landscape");
    expect(html).toContain("kappa is associated with both spectral structure and the target distribution.");
    expect(html).toContain("Validation scenario audit");
    expect(html).toContain("Leave one kappa level out");
    expect(html).toContain("mu_cont interval hold-out");
    expect(html).toContain("df1 = 1, df2 = ");
    expect(html).not.toContain("unsuitable");
  }, 60_000);

  it("renders in French", () => {
    const html = render(scopeOf(designed(), "y_main", "fr"));
    expect(html).toContain("Paysage conjoint des associations X–Y");
    expect(html).toContain("Audit des scénarios de validation");
  }, 60_000);

  it("categorical target: other measures, never on the η² axis", () => {
    const html = render(scopeOf(designed(), "y_class"));
    expect(html).toContain("Other association measures (categorical target)");
    expect(html).toContain("Target classes by kappa");
  }, 60_000);

  it("no metadata: no association rows, grouped CV only", () => {
    const input = synthInput({ units: 15, targets: [{ id: "solo", kind: "continuous", of: (i) => i }] });
    const html = render(scopeOf(input, "solo"));
    expect(html).toContain("No varying metadata: only grouped CV is available.");
    expect(html).not.toContain("Joint X–Y association landscape");
  }, 60_000);

  it("no target: explicit empty state, scenarios without target coverage", () => {
    const input = synthInput({ units: 15, factors: [{ name: "w", kind: "categorical", of: (i) => ["x", "y", "z"][i % 3]! }] });
    const html = render(scopeOf(input, null));
    expect(html).toContain("No target is declared: target associations are not available.");
    expect(html).toContain("No target selected: target coverage not evaluated.");
  }, 60_000);
});

describe("retained-test Y protection", () => {
  it("the guard throws when a retained-test target value is read (positive control)", () => {
    const input = guardRetainedTargets(designed());
    const retained = input.samples.find((s) => s.partition === "retained_test")!.sample_id;
    expect(() => input.targets[0]!.values.find((v) => v.sample_id === retained)!.value).toThrow(/retained-test target value accessed/);
  });

  it("units, rows, scenarios and every section run without reading retained-test Y", () => {
    const plain = designed();
    const guarded = guardRetainedTargets(plain);
    for (const target of guarded.targets) {
      const units = targetUnits(guarded, target.target_id)!;
      for (const f of metadataFactors(guarded)) associationRows(guarded, units, f);
      const base = scenarioBase(guarded, "src")!;
      const tg = scenarioTargets(guarded, target.target_id);
      for (const s of candidateScenarios(guarded, base, String)) for (const f of s.folds) auditFold(base, s, f, tg.labels, tg.kind);
    }
    const scope = { ...scopeOf(plain, "y_main"), input: guarded };
    expect(() => render(scope)).not.toThrow();
    expect(() => render({ ...scope, targetId: "y_class" })).not.toThrow();
  }, 60_000);
});
