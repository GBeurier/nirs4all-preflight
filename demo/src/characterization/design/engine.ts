// Test-only: the real engine (@nirs4all/preflight WASM + Methods + dag-ml-wasm) run under vitest.
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport, type QualificationReportView } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";

const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const root = new URL("../../../", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("node_modules/@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", root)),
  dagMlWasmModule: await fs.readFile(new URL("../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", root)),
});

export interface RawMetric { metric_id: string; status: string; reason_code?: string | null; source_id?: string | null; target_id?: string | null; value?: unknown; parameters?: Record<string, unknown>; denominators?: Record<string, number> }

export function runEngine(input: EngineInput): { report: EngineReport & { metrics: RawMetric[] }; view: QualificationReportView } {
  const report = runtime.analyze(input) as EngineReport & { metrics: RawMetric[] };
  return { report, view: buildQualificationReportView(report) };
}
