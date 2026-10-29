import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import { ClusteringSection, ConfoundingSection, DomainShiftSection, ProbeSection, presentSections } from "./Blocks";
import { translate, type TextKey } from "./i18n";
import type { Scope } from "./Sections";
import { syntheticInput, type SyntheticScenario } from "./synthetic";

// The real engine: the installed @nirs4all/preflight Rust/WASM runtime, the Methods WASM kernels
// and dag-ml-wasm for the validation probe, run on the demo's own synthetic sets. Node has no
// fetch for file URLs, so the module bytes are read from the installed packages.
const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const modules = new URL("../node_modules/", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", modules)),
  dagMlWasmModule: await fs.readFile(new URL("dag-ml-wasm/dag_ml_wasm_bg.wasm", modules)),
});

interface Metric { metric_id: string; status: string; reason_code?: string; parameters?: Record<string, unknown> }
const analyze = (scenario: SyntheticScenario) => {
  const input = syntheticInput(scenario);
  const report = runtime.analyze(input) as EngineReport & { engine_version: string; data_origin: string; metrics: Metric[] };
  const scope: Scope = {
    t: (k: TextKey) => translate(k, "en"),
    locale: "en",
    view: buildQualificationReportView(report),
    input,
    sourceId: "synthetic_nir",
    targetId: "concentration",
  };
  return { report, scope };
};
const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("real engine on the demo synthetic sets", () => {
  const { report, scope } = analyze("clean");

  it("is the 0.1.1 engine and labels the synthetic origin", () => {
    expect(report.engine_version).toBe("0.1.1");
    expect(report.data_origin).toBe("synthetic");
    expect(presentSections(scope).map((s) => s.id)).toEqual(["s-sensitivity", "s-duplicates", "s-clustering", "s-confounding", "s-shift", "s-association", "s-probe"]);
  });

  it("renders the clustering section from computed engine metrics", () => {
    expect(report.metrics.filter((m) => m.metric_id.startsWith("clustering.")).every((m) => m.status === "computed")).toBe(true);
    const out = html(<ClusteringSection {...scope} />);
    expect(out).toContain("Density groups (exploratory)");
    expect(out).toContain("HDBSCAN partition");
    expect(out).toContain("Exploratory verdict");
  });

  it("renders the confounding tests with their engine availability", () => {
    const out = html(<ConfoundingSection {...scope} />);
    expect(out).toContain("Confounding factors");
    expect(out).toContain("Partial (Freedman–Lane)");
    expect(out).toContain("SINGLE_FACTOR_LEVEL");
    expect(out).toContain("EXCHANGEABILITY_NOT_DECLARED");
  });

  it("renders the domain-shift matrix for the campaign factor", () => {
    const out = html(<DomainShiftSection {...scope} />);
    expect(out).toContain("Shift between domains");
    expect(out).toContain("Factor campaign");
    expect(out).toContain("vs 2026-B");
  });

  it("runs the grouped probe through dag-ml-wasm and renders it", () => {
    const rmse = report.metrics.find((m) => m.metric_id === "probe.rmse" && m.parameters?.estimator === "pls");
    expect(rmse?.status).toBe("computed");
    expect(String(rmse?.parameters?.validation_backend)).toMatch(/dag-ml-wasm/);
    const out = html(<ProbeSection {...scope} />);
    expect(out).toContain("Grouped validation probe");
    expect(out).toContain("Out-of-fold RMSE");
    expect(out).toContain("the model beats the mean");
    expect(out).not.toMatch(/NaN|Infinity/);
  });

  it("pitfalls: the probe refuses identical spectra across independence components", () => {
    const pitfalls = analyze("pitfalls");
    expect(pitfalls.report.metrics.filter((m) => m.metric_id.startsWith("probe.")).every((m) => m.reason_code === "EXACT_DUPLICATE_SPECTRUM_ACROSS_COMPONENTS")).toBe(true);
    expect(html(<ProbeSection {...pitfalls.scope} />)).toContain("EXACT_DUPLICATE_SPECTRUM_ACROSS_COMPONENTS");
  });
});
