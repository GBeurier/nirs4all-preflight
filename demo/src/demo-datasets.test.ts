import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DEMO_DATASETS, readDemoFiles, assembleDemoDataset } from "./demo-datasets";
import type { IoRuntime, FormatsRuntime } from "./dataset-io";

const require = createRequire(import.meta.url);
const io = require("@nirs4all/io-wasm") as IoRuntime;
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
