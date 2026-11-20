// Reproducible generator of src/characterization/integrity/noiseBenchmark.ts: runs the SAME engine
// estimator the demo shows (per-spectrum `intrinsic.noise.signal_noise_db` of the installed
// @nirs4all/preflight Rust/WASM runtime with its Methods kernels) on the public datasets bundled
// with the demo (src/data/demo, provenance in public/data/demo/SOURCES.md), through the same IO
// assembly as the app. Skipped unless NOISE_BENCHMARK is set:
//   NOISE_BENCHMARK=write npx vitest run scripts/noise-benchmark.test.ts   (regenerate the file)
//   NOISE_BENCHMARK=check npx vitest run scripts/noise-benchmark.test.ts   (compare with the file)
import * as ioOwner from "../vendor/io-browser-owner/nirs4all_io_wasm.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, extractIntrinsic, type EngineReport } from "nirs4all-ui/qualification";
import type { FormatsRuntime, IoRuntime } from "../src/dataset-io";
import { DEMO_DATASETS, assembleDemoDataset, readDemoFiles } from "../src/demo-datasets";
import { ANALYSIS_FAMILIES, buildEngineInput, defaultConfig } from "../src/input";
import { quantile } from "../src/characterization/shared/derive";
import { NOISE_BENCHMARK } from "../src/characterization/integrity/noiseBenchmark";

const mode = process.env.NOISE_BENCHMARK;
const target = new URL("../src/characterization/integrity/noiseBenchmark.ts", import.meta.url);

/** Curated, documented facts only (SOURCES.md and the cited dataset pages); null = not documented. */
const META: Record<string, { instrument: string | null; matrix: string; measurement: string; source: string }> = {
  beer: {
    instrument: null,
    matrix: "Beer (undiluted, degassed)",
    measurement: "30 mm quartz cell, 1100–2250 nm in 2 nm steps (OHPL documentation); instrument not stated",
    source: "OHPL beer, https://ohpl.io/doc/reference/beer.html (Nørgaard et al. 2000)",
  },
  anopheles: {
    instrument: null,
    matrix: "Anopheles gambiae mosquitoes (whole insects)",
    measurement: "Dataverse record states NIRS scans (.spc, GRAMS IQ); instrument not stated in the record",
    source: "Maia et al., Harvard Dataverse, https://doi.org/10.7910/DVN/YD34OX",
  },
};

const r4 = (v: number) => Number(v.toPrecision(6));

describe.skipIf(!mode)("empirical noise benchmark reference", () => {
  it("recomputes the per-spectrum engine SNR on the bundled public datasets", async () => {
    const require = createRequire(import.meta.url);
    ioOwner.initSync({ module: readFileSync(new URL("../vendor/io-browser-owner/nirs4all_io_wasm_bg.wasm", import.meta.url)) });
    const io: IoRuntime = ioOwner;
    const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;
    const modules = new URL("../node_modules/", import.meta.url);
    const runtime = await createQualificationRuntime({
      wasmModule: readFileSync(new URL("@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", modules)),
      dagMlWasmModule: readFileSync(new URL("../../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", import.meta.url)),
    });
    const methodsVersion = (JSON.parse(readFileSync(new URL("../../bindings/wasm/node_modules/@nirs4all/methods/package.json", import.meta.url), "utf8")) as { version: string }).version;
    const rows = [];
    let engineVersion = "";
    for (const sample of DEMO_DATASETS) {
      const input = assembleDemoDataset(sample, await readDemoFiles(sample.id), io, formats);
      const config = defaultConfig(input);
      const families = Object.fromEntries(ANALYSIS_FAMILIES.map((f) => [f, f === "spectral_quality"])) as typeof config.families;
      const report = runtime.analyze(buildEngineInput(input, { ...config, families })) as EngineReport & { engine_version: string };
      engineVersion = report.engine_version;
      const source = input.sources[0]!;
      const signal = extractIntrinsic(buildQualificationReportView(report), source.source_id).signals["noise.signal_noise_db"];
      const values = (signal?.values ?? []).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      expect(values.length).toBeGreaterThan(0);
      const q = (p: number) => r4(quantile(values, p)!);
      const meta = META[sample.id]!;
      rows.push({
        id: sample.id,
        dataset: sample.name,
        instrument: meta.instrument,
        matrix: meta.matrix,
        measurement: meta.measurement,
        axis: `${r4(Math.min(...source.axis))}–${r4(Math.max(...source.axis))} ${source.axis_unit ?? ""}`.trim(),
        bands: source.axis.length,
        n: values.length,
        spectra: source.x.length,
        developmentSpectra: input.samples.filter((s) => s.partition === "development").length,
        min: r4(values[0]!),
        p5: q(0.05),
        p25: q(0.25),
        p50: q(0.5),
        p75: q(0.75),
        p95: q(0.95),
        max: r4(values[values.length - 1]!),
        source: meta.source,
      });
    }
    const out = { estimator: "intrinsic.noise.signal_noise_db (per spectrum, 20·log10(mean|x| / σ), σ from second differences)", engine: engineVersion, methods: methodsVersion, rows };
    if (mode === "write") {
      const generated = new Date().toISOString().slice(0, 10);
      writeFileSync(target, `${HEADER}export const NOISE_BENCHMARK: NoiseBenchmark = ${JSON.stringify({ generated, ...out }, null, 2)};\n`);
    } else {
      expect({ estimator: NOISE_BENCHMARK.estimator, engine: NOISE_BENCHMARK.engine, methods: NOISE_BENCHMARK.methods, rows: NOISE_BENCHMARK.rows }).toEqual(out);
    }
  }, 120000);
});

const HEADER = `// GENERATED by demo/scripts/noise-benchmark.test.ts (NOISE_BENCHMARK=write); do not edit by hand.
// Empirical noise reference: per-spectrum engine SNR quantiles on the public datasets bundled with
// the demo (provenance: public/data/demo/SOURCES.md). Real computed values only; instrument is null
// when the dataset provenance does not document it. Interim demo data (Datasets/ecosystem debt).

export interface NoiseBenchmarkRow {
  id: string;
  dataset: string;
  /** Manufacturer and model when documented by the dataset provenance; otherwise null. */
  instrument: string | null;
  matrix: string;
  measurement: string;
  axis: string;
  bands: number;
  /** Spectra with a finite estimate. */
  n: number;
  /** Spectra in the dataset and in its development partition (the engine analyses the development population). */
  spectra: number;
  developmentSpectra: number;
  min: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
  source: string;
}

export interface NoiseBenchmark {
  /** Date the rows were computed (YYYY-MM-DD). */
  generated: string;
  estimator: string;
  /** @nirs4all/preflight engine version and Methods package version used. */
  engine: string;
  methods: string;
  rows: NoiseBenchmarkRow[];
}

`;
