import { createRequire } from "node:module";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import { importFiles, type FormatsRuntime, type IoRuntime } from "./dataset-io";
import { buildChecks } from "./checks";
import { ClusteringSection, ConfoundingSection, DomainShiftSection, ProbeSection, presentSections } from "./Blocks";
import { translate, type TextKey } from "./i18n";
import { buildEngineInput, defaultConfig } from "./input";
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
  dagMlWasmModule: await fs.readFile(new URL("../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", new URL("../", import.meta.url))),
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

  it("is the 0.1.3 engine and labels the synthetic origin", () => {
    expect(report.engine_version).toBe("0.1.6");
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

describe("real engine on dropped X/y/metadata files", () => {
  const require = createRequire(import.meta.url);
  const io = require("@nirs4all/io-wasm") as IoRuntime;
  const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;

  it("accepts the IO metadata table and analyses its associations", () => {
    const n = 24;
    const axis = Array.from({ length: 16 }, (_, b) => 1000 + 20 * b).join(";");
    const rows = Array.from({ length: n }, (_, r) => Array.from({ length: 16 }, (_, b) => (0.5 + 0.2 * Math.sin(b / 3 + r / 5) + 0.01 * ((r * 7 + b * 3) % 11)).toFixed(4)).join(";"));
    const encode = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
    const { input, tables } = importFiles([
      encode("X_train.csv", `${axis}\n${rows.join("\n")}`),
      encode("y_train.csv", `protein\n${Array.from({ length: n }, (_, r) => (10 + (r % 6) + r / 10).toFixed(2)).join("\n")}`),
      encode("metadata_train.csv", `site;moisture\n${Array.from({ length: n }, (_, r) => `${r % 2 ? "north" : "south"};${(12 + (r % 5)).toFixed(1)}`).join("\n")}`),
    ], "drop", io, formats);
    expect(tables.map((t) => [t.file, t.role, t.partition])).toEqual([["X_train.csv", "x", "train"], ["y_train.csv", "y", "train"], ["metadata_train.csv", "metadata", "train"]]);
    const report = runtime.analyze(input) as EngineReport & { validation: { valid: boolean }; metrics: Metric[] };
    expect(report.validation.valid).toBe(true);
    expect(input.metadata?.columns.map((c) => c.name)).toEqual(["site", "moisture"]);
    expect(report.metrics.some((m) => m.metric_id === "association.metadata_target" && m.status === "computed")).toBe(true);
  });

  it("never reads a missing reference or an unevaluated event count as an all-clear", () => {
    const n = 12;
    const rows = Array.from({ length: n }, (_, r) => Array.from({ length: 4 }, (_, b) => (0.5 + 0.1 * b + 0.01 * ((r * 7 + b * 3) % 11)).toFixed(4)).join(";"));
    const encode = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
    const { input } = importFiles([
      encode("X_train.csv", `1000;1100;1200;1300\n${rows.join("\n")}`),
      encode("y_train.csv", `protein\n${Array.from({ length: n }, (_, r) => (r === 3 ? "" : (10 + r / 3).toFixed(2))).join("\n")}`),
    ], "short", io, formats);
    const report = runtime.analyze(input) as EngineReport;
    const checks = buildChecks(buildQualificationReportView(report), input, input.sources[0]!.source_id, "protein", (k: TextKey) => translate(k, "en"), "en");
    const target = checks.find((c) => c.id === "target");
    expect(target?.status).toBe("attention");
    expect(target?.detail).toContain(`1 of ${n} calibration samples without a reference`);
    // T²/Q ranks by the dataset's own p95 (about 5% exceed it by construction): never a control point
    expect(checks.some((c) => c.id === "atypical")).toBe(false);
    const events = checks.find((c) => c.id === "events");
    // four bands are too few for the spike detector: its count stays unevaluated, never zero
    expect(events?.status).not.toBe("ok");
    expect(events?.detail).toMatch(/^— isolated spikes/);
  });

  it("measures technical repeatability once the repetition column is declared", () => {
    const n = 8, scans = 3;
    const axis = Array.from({ length: 16 }, (_, b) => 1000 + 20 * b).join(";");
    const rows = Array.from({ length: n * scans }, (_, r) => Array.from({ length: 16 }, (_, b) => (0.5 + 0.2 * Math.sin(b / 3 + Math.floor(r / scans) / 2) + 0.004 * (((r % scans) * 5 + b * 3) % 7)).toFixed(4)).join(";"));
    const encode = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
    const files = [
      encode("X_train.csv", `${axis}\n${rows.join("\n")}`),
      encode("y_train.csv", `protein\n${Array.from({ length: n * scans }, (_, r) => (10 + Math.floor(r / scans) * 0.7).toFixed(2)).join("\n")}`),
      encode("metadata_train.csv", `Sample_ID;site\n${Array.from({ length: n * scans }, (_, r) => `p${Math.floor(r / scans)};${Math.floor(r / scans) % 2 ? "north" : "south"}`).join("\n")}`),
    ];
    const status = (input: ReturnType<typeof importFiles>["input"]) => (runtime.analyze(input) as EngineReport & { metrics: Metric[] }).metrics.find((m) => m.metric_id === "measurement.repeatability_sd");
    expect(status(importFiles(files, "rows", io, formats).input)?.reason_code).toBe("NO_DECLARED_TECHNICAL_REPEATS");
    const { input } = importFiles(files, "repeats", io, formats, { column: "Sample_ID", type: "rescan" });
    expect(input.samples).toHaveLength(n);
    expect(status(input)?.status).toBe("computed");
  });
});



describe("configured engine protocols", () => {
  it("uses X-only repeat distances for tolerance and includes baseline sensitivity", () => {
    const input = syntheticInput("pitfalls");
    const report = runtime.analyze(buildEngineInput(input, defaultConfig(input))) as EngineReport;
    expect(report.validation?.valid).toBe(true);
    const tolerance = report.metrics.find((m) => m.metric_id === "integrity.quasi_duplicate_pairs");
    expect(tolerance?.status, JSON.stringify(tolerance)).toBe("computed");
    expect(tolerance?.parameters?.tolerance_source).toBe("technical_repeat_rms_Q3_plus_1.5_IQR_X_only");
    expect(tolerance?.parameters?.tolerance_repeat_groups).toBe(8);
    expect(report.metrics.find((m) => m.metric_id === "structure.detrend_sensitivity")?.status).toBe("computed");
  });

  it("omits identifier metadata across associations, confounding and domain comparisons", () => {
    const input = syntheticInput("pitfalls");
    const config = defaultConfig(input);
    config.metadataRoles = { instrument: "identifier", campaign: "excluded", batch: "analysis", id_sample: "identifier" };
    const report = runtime.analyze(buildEngineInput(input, config)) as EngineReport;
    expect(report.validation?.valid).toBe(true);
    const linked = report.metrics.filter((m) => /^(association|confounding|domain_shift)\./.test(m.metric_id));
    expect(linked.length).toBeGreaterThan(0);
    for (const metric of linked) {
      if (metric.parameters?.factor) expect(["instrument", "campaign", "id_sample"]).not.toContain(metric.parameters.factor);
      if (metric.parameters?.metadata) expect(["instrument", "campaign", "id_sample"]).not.toContain(metric.parameters.metadata);
    }
    const design = report.metrics.find((m) => m.metric_id === "confounding.design");
    expect(JSON.stringify(design?.value)).toContain("batch");
    expect(JSON.stringify(design?.value)).not.toContain('"factor":"instrument"');
  });
});
