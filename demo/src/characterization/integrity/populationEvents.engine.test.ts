// Engine-vs-local validation of the interim population-events port (populationEvents.ts): the real
// @nirs4all/preflight Rust/WASM engine (its Methods `spectral_population_events_qc` kernel) and the
// TypeScript port must give identical per-spectrum and per-band counts on Beer, Anopheles and both
// synthetic sets, at the engine default threshold and at two lower inspection thresholds.
import * as ioOwner from "../../../vendor/io-browser-owner/nirs4all_io_wasm.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, extractIntrinsic, type EngineReport } from "nirs4all-ui/qualification";
import type { FormatsRuntime, IoRuntime } from "../../dataset-io";
import { DEMO_DATASETS, assembleDemoDataset, readDemoFiles } from "../../demo-datasets";
import { ANALYSIS_FAMILIES, buildEngineInput, defaultConfig, type EngineInput } from "../../input";
import { syntheticInput } from "../../synthetic";
import { readBandCounts } from "./model";
import { engineMatrix, mergeEvents, populationEvents } from "./populationEvents";

const require = createRequire(import.meta.url);
ioOwner.initSync({ module: readFileSync(new URL("../../../vendor/io-browser-owner/nirs4all_io_wasm_bg.wasm", import.meta.url)) });
const io: IoRuntime = ioOwner;
const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;
const modules = new URL("../../../node_modules/", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: readFileSync(new URL("@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", modules)),
  dagMlWasmModule: readFileSync(new URL("../../../../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", import.meta.url)),
});

const datasets: { name: string; load: () => Promise<EngineInput> }[] = [
  ...DEMO_DATASETS.map((d) => ({ name: d.id, load: async () => assembleDemoDataset(d, await readDemoFiles(d.id), io, formats) })),
  { name: "synthetic clean", load: async () => syntheticInput("clean") },
  { name: "synthetic pitfalls", load: async () => syntheticInput("pitfalls") },
];

function run(input: EngineInput, threshold: number) {
  const config = defaultConfig(input);
  const families = Object.fromEntries(ANALYSIS_FAMILIES.map((f) => [f, f === "spectral_quality"])) as typeof config.families;
  const engineInput = buildEngineInput(input, { ...config, families, eventThreshold: threshold });
  const view = buildQualificationReportView(runtime.analyze(engineInput) as EngineReport);
  return { engineInput, view };
}

describe("local population events = engine (Methods spectral_population_events_qc)", { timeout: 180000 }, () => {
  for (const { name, load } of datasets) {
    for (const threshold of [8, 4, 2]) {
      it(`${name}, threshold ${threshold}: per-spectrum and per-band counts`, async () => {
        const input = await load();
        const { engineInput, view } = run(input, threshold);
        const source = engineInput.sources[0]!;
        const intrinsic = extractIntrinsic(view, source.source_id)!;
        const spikeSignal = intrinsic.signals["events.spike_count"]!;
        const jumpSignal = intrinsic.signals["events.jump_count"]!;
        expect(spikeSignal.state.status).toBe("computed");
        const physical = engineInput.options.intrinsic_qc?.axis_basis === "physical";
        const { matrix, missing } = engineMatrix(source, spikeSignal.observationIds, { physical });
        expect(missing).toEqual([]);
        const local = populationEvents(matrix, threshold);
        expect(local.spike.counts).toEqual(spikeSignal.values);
        expect(local.jump.counts).toEqual(jumpSignal.values);
        expect(jumpSignal.observationIds).toEqual(spikeSignal.observationIds);
        for (const kind of ["spike", "jump"] as const) {
          const bands = readBandCounts(view, source.source_id, kind)!;
          expect(Array.from(local[kind].bandCounts)).toEqual(bands.counts);
          expect(Array.from(local[kind].bandEvaluated)).toEqual(bands.evaluated);
          expect(local[kind].globalCount).toBe(intrinsic.globals[`events.global_${kind}_count`]);
          expect(local[kind].globalEligible).toBe(intrinsic.globals[`events.global_${kind}_eligible`]);
          // Positions are consistent with the counts they explain.
          expect(local[kind].rows.length).toBe(local[kind].globalCount);
          for (const s of local[kind].scores) expect(s).toBeGreaterThan(threshold);
        }
        // Merging never creates or loses a flag.
        const merged = mergeEvents(local.spike, local.jump);
        expect(merged.reduce((a, e) => a + e.spikeFlags + e.jumpFlags, 0)).toBe(local.spike.globalCount + local.jump.globalCount);
        console.info(`${name} @${threshold}: ${matrix.n} spectra × ${matrix.p} bands, ${local.spike.globalCount} peak + ${local.jump.globalCount} jump flags → ${merged.length} physical events`);
      });
    }
  }
});
