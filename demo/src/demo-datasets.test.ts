import * as ioOwner from "../vendor/io-browser-owner/nirs4all_io_wasm.js";
import { readFileSync as readIoBytes } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { DEMO_DATASETS, readDemoFiles, assembleDemoDataset } from "./demo-datasets";
import type { IoRuntime, FormatsRuntime } from "./dataset-io";
import { buildEngineInput, defaultConfig, NO_FAMILIES } from "./input";

const require = createRequire(import.meta.url);
ioOwner.initSync({ module: readIoBytes(new URL("../vendor/io-browser-owner/nirs4all_io_wasm_bg.wasm", import.meta.url)) });
const io: IoRuntime = ioOwner;
const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;

describe("real demo datasets reuse Web's CSVs through native IO", () => {
  for (const sample of DEMO_DATASETS) {
    it(`loads ${sample.id} with its full spectral grid, split and declared target kind`, async () => {
      const files = await readDemoFiles(sample.id);
      expect(files).toHaveLength(4);
      const input = assembleDemoDataset(sample, files, io, formats);
      expect(input.data_origin).toBe("user_provided");
      expect(input.samples).toHaveLength(sample.samples);
      expect(input.sources).toHaveLength(1);
      expect(input.sources[0]?.x).toHaveLength(sample.samples);
      expect(input.sources[0]?.axis).toHaveLength(sample.bands);
      expect(input.samples.filter((s) => s.partition === "development")).toHaveLength(sample.train);
      expect(input.samples.filter((s) => s.partition === "retained_test")).toHaveLength(sample.test);
      expect(input.targets).toHaveLength(1);
      expect(input.targets[0]?.target_id).toBe(sample.target);
      expect(input.targets[0]?.kind).toBe(sample.task === "classification" ? "categorical" : "continuous");
      if (sample.task === "classification") expect([...new Set(input.targets[0]?.values.map((v) => v.category))].sort()).toEqual(["0", "1"]);
    }, 20000);
  }
});

describe("real demo datasets keep their published splits disjoint", () => {
  it("has no exact spectral duplicate between development and retained test (engine count)", async () => {
    const modules = new URL("../node_modules/", import.meta.url);
    const runtime = await createQualificationRuntime({
      wasmModule: readIoBytes(new URL("@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", modules)),
      dagMlWasmModule: readIoBytes(new URL("../../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", import.meta.url)),
    });
    for (const sample of DEMO_DATASETS) {
      const input = assembleDemoDataset(sample, await readDemoFiles(sample.id), io, formats);
      const report = runtime.analyze(buildEngineInput(input, { ...defaultConfig(input), families: NO_FAMILIES })) as { metrics: { metric_id: string; value: unknown }[] };
      const pairs = report.metrics.find((m) => m.metric_id === "integrity.cross_partition_exact_duplicate_pairs");
      expect(pairs?.value, sample.id).toBe(0);
    }
  }, 60000);
});
