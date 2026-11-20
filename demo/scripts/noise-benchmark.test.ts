// Reproducible generator of src/characterization/integrity/noiseBenchmark.ts: runs the SAME engine
// estimator the demo shows (per-spectrum `intrinsic.noise.signal_noise_db` of the installed
// @nirs4all/preflight Rust/WASM runtime with its Methods kernels, development partition) on public
// NIR datasets whose instrument or manufacturer is documented: the two datasets bundled with the
// demo (src/data/demo) and datasets of the sibling ../nirs4all-data checkout, all read through the
// app's IO path (importFiles over the vendored IO browser owner + Formats). Only computed summary
// statistics and a provenance reference are written; no data is copied. Skipped unless
// NOISE_BENCHMARK is set:
//   NOISE_BENCHMARK=write npx vitest run scripts/noise-benchmark.test.ts   (regenerate the file)
//   NOISE_BENCHMARK=check npx vitest run scripts/noise-benchmark.test.ts   (compare with the file)
import * as ioOwner from "../vendor/io-browser-owner/nirs4all_io_wasm.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, extractIntrinsic, type EngineReport } from "nirs4all-ui/qualification";
import { importFiles, type FormatsRuntime, type IoRuntime } from "../src/dataset-io";
import type { RepetitionDeclaration } from "../src/dataset";
import { DEMO_DATASETS, assembleDemoDataset, readDemoFiles } from "../src/demo-datasets";
import { ANALYSIS_FAMILIES, buildEngineInput, defaultConfig, type EngineInput } from "../src/input";
import { quantile } from "../src/characterization/shared/derive";
import { NOISE_BENCHMARK } from "../src/characterization/integrity/noiseBenchmark";

const mode = process.env.NOISE_BENCHMARK;
const target = new URL("../src/characterization/integrity/noiseBenchmark.ts", import.meta.url);
const DATA = new URL("../../../nirs4all-data/", import.meta.url);

interface Entry {
  id: string;
  /** "demo:<id>" (bundled with the demo) or a dataset folder of nirs4all-data */
  location: string;
  dataset: string;
  /** Manufacturer and model exactly as documented (null when not stated). */
  manufacturer: string | null;
  instrument: string;
  /** Sample type (DatabaseDetail.xlsx "Sample" column or the dataset documentation). */
  matrix: string;
  /** Signal representation when documented. */
  representation: string | null;
  measurement: string;
  documentation: string;
  source: string;
  /** Repetition column declared in the app (as in src/nirs4all-data.test.ts). */
  repetition?: RepetitionDeclaration;
}

/**
 * Curated, documented facts only. Instrument and manufacturer: quoted from files of the
 * nirs4all-data checkout (path, page); matrix: DatabaseDetail.xlsx; one representative dataset per
 * database and instrument (all spectra of that instrument where the checkout has them).
 */
const CATALOGUE: Entry[] = [
  { id: "beer", location: "demo:beer", dataset: "Beer — original extract (demo)", manufacturer: "NIRSystems Inc.", instrument: "Model 6500", matrix: "Beer", representation: "absorbance (transmission converted)", measurement: "30 mm quartz cell, 1100–2250 nm in 2 nm steps", documentation: "nirs4all-data regression/BEER, Nørgaard et al. 2000 (PDF p. 2): \"collected with the use of a NIRSystems Inc. (Model 6500) spectrophotometer\"", source: "OHPL beer, https://ohpl.io/doc/reference/beer.html (Nørgaard et al. 2000)" },
  { id: "anopheles", location: "demo:anopheles", dataset: "Anopheles — oocyst presence (demo)", manufacturer: "ASD", instrument: "LabSpec 4i", matrix: "Mosquito (whole insects)", representation: null, measurement: "Bifurcated fibre-optic probe over a Spectralon plate; .asd converted to .spc", documentation: "nirs4all-data regression/MALARIA/NIRS+Data+Readme+File.txt (l. 45): \"Labspec 4i near infrared spectrometer … (ASD Inc, Longmont, CO)\"", source: "Maia et al., Harvard Dataverse, https://doi.org/10.7910/DVN/YD34OX" },
  { id: "pistacia", location: "classification/PISTACIA/Species_code_grpStrat70_30_bySpecimen", dataset: "Pistacia leaves — species", manufacturer: "ASD", instrument: "LabSpec Pro", matrix: "Leaves (per-leaf spectra)", representation: "reflectance", measurement: "Contact probe; 500–2450 nm in the checkout, gap handling not documented", documentation: "nirs4all-data classification/PISTACIA/Readme.txt (l. 21): \"LabSpec Pro (ASD, Analytical Spectral Devices Inc., Boulder, Colorado, USA)\"", source: "nirs4all-data classification/PISTACIA (Readme.txt)" },
  { id: "grapevine-asd", location: "regression/GRAPEVINE_LeafTraits/LMA_spxyG70_30_byCultivar_ASD", dataset: "Grapevine leaf traits — ASD", manufacturer: "ASD", instrument: "LabSpec 4", matrix: "Dried leaf", representation: null, measurement: "Paper: gaps removed, cut below 400 nm, loess smoothing; 4 spectra averaged per leaf (whether the raw files are smoothed is unclear)", documentation: "nirs4all-data regression/GRAPEVINE_LeafTraits, Coindre et al. 2026 (PDF p. 5): \"laboratory spectrometer ASD (ASD LabSpec 4, Analytical Spectral Devices)\"", source: "https://doi.org/10.57745/WVAPOL" },
  { id: "alpine", location: "regression/ALPINE/ALPINE_N_552_KS", dataset: "Arctic-alpine foliage — N", manufacturer: "ASD", instrument: "FieldSpec 3", matrix: "Ground dried leaves", representation: "log(1/R)", measurement: "Average of 3 scans, interpolated to 1 nm; full 350–2500 nm kept in the checkout", documentation: "nirs4all-data regression/ALPINE, Murguzur et al. 2019 (PDF p. 8): \"portable NIRS spectrometer (FieldSpec 3, Asd Inc., Boulder, Colorado)\"", source: "https://doi.org/10.18710/CXRCUW" },
  { id: "colza", location: "regression/COLZA/C_wOutlier", dataset: "Oilseed rape tissues — C", manufacturer: "Bruker Optics", instrument: "MPA (FT-NIR)", matrix: "Oilseed rape plant tissues (ground)", representation: "absorbance", measurement: "12489.6–3594.9 cm⁻¹; average of 64 readings", documentation: "nirs4all-data regression/COLZA/README.txt (l. 19): \"collected by a BRUKER MPA spectrometer\"; Rolland et al. 2024 (PDF p. 2): \"Bruker Optics GmbH\"", source: "https://doi.org/10.57745/6VYUQN" },
  { id: "amylose", location: "regression/AMYLOSE/Rice_Amylose_313_YbasedSplit", dataset: "Rice flour — amylose", manufacturer: "Bruker Optics", instrument: "MPA (FT-NIR, transflection)", matrix: "Rice flour", representation: null, measurement: "16 scans; 2 spectra per sample", documentation: "nirs4all-data regression/AMYLOSE, Sampaio et al. 2017 (PDF p. 3): \"NIR transflection MPA equipment (Bruker Optics, Germany)\"", source: "https://doi.org/10.1016/j.dib.2017.09.077" },
  { id: "cassava", location: "regression/CASSAVA/Cassava_DM_5578_DavrieuxRobustness2014", dataset: "Cassava roots — dry matter", manufacturer: "FOSS", instrument: "6500 (monochromator)", matrix: "Fresh cassava root", representation: "log(1/R)", measurement: "Autocup module, 32 scans", documentation: "nirs4all-data regression/CASSAVA, Sanchez et al. 2014 (PDF p. 2): \"spectrometer (FOSS 6500, monochromator with autocup sampling module, Hillerod, Denmark)\"", source: "nirs4all-data regression/CASSAVA (Davrieux et al. 2016; Sanchez et al. 2014)" },
  { id: "lucas", location: "regression/LUCAS/LUCAS_pH_Organic_1763_LiuRandomOrganic", dataset: "LUCAS topsoil — organic soils, pH", manufacturer: "FOSS", instrument: "XDS Rapid Content Analyzer", matrix: "Dried topsoil (organic soils subset)", representation: "absorbance", measurement: "Mean of 2 scans; 1100 nm splice offset-corrected (LUCAS corrected release)", documentation: "nirs4all-data regression/LUCAS, Nocita et al. 2014 (PDF p. 2): \"FOSS XDS Rapid Content Analyzer (FOSS NIRSystems Inc., Denmark)\"", source: "https://esdac.jrc.ec.europa.eu/content/lucas2015-topsoil-data" },
  { id: "berry", location: "regression/BERRY/brix_groupSampleID_stratDateVar_balRows", dataset: "Winegrape — berry Brix", manufacturer: "Spectra Vista Corporation", instrument: "HR-1024i", matrix: "Fresh leaf / berry (tissue not determined in the checkout)", representation: "reflectance", measurement: "Replicates averaged, interpolated to 1 nm", documentation: "nirs4all-data regression/BERRY, Wong et al. 2025 (PDF p. 4): \"full-range spectrometer (HR-1024i; Spectra Vista Corporation—SVC)\"", source: "https://github.com/WongCYS/grapevine_RMI_2025", repetition: { column: "Sample_ID", type: "rescan" } },
  { id: "fusarium", location: "regression/FUSARIUM/FinalScore_grp70_30_scoreQ", dataset: "Strawberry leaves — Fusarium score", manufacturer: "Spectra Vista Corporation", instrument: "HR-1024i (LC-RC Pro leaf clip)", matrix: "Fresh leaf", representation: "reflectance", measurement: "Leaf clip, 339–2515 nm", documentation: "nirs4all-data regression/FUSARIUM, Au et al. 2025 (PDF p. 4): \"LC-RC Pro leaf clip (… Spectra Vista Corp. HR-1024i)\"", source: "https://doi.org/10.5281/zenodo.16217833" },
  { id: "darkresp", location: "regression/DarkResp/LMA_spxy70", dataset: "Forest tree leaves — LMA", manufacturer: "PANalytical", instrument: "QualitySpec Trek", matrix: "Forest tree fresh leaf", representation: "reflectance", measurement: "Contact probe; 3–6 positions averaged per leaf, interpolated to 1 nm", documentation: "nirs4all-data regression/DarkResp, Wu et al. 2024 (PDF p. 4): \"portable handheld contact-type spectrometer QualitySpec Trek (PANalytical, Boulder, CO, USA\"", source: "https://doi.org/10.6084/m9.figshare.27641136" },
  { id: "phosphorus", location: "regression/PHOSPHORUS/N_spxy", dataset: "Leaves — N (phosphorus study)", manufacturer: "PANalytical", instrument: "QualitySpec TREK", matrix: "Fresh leaf", representation: null, measurement: "Leaf spectra averaged per branch", documentation: "nirs4all-data regression/PHOSPHORUS, Dong et al. 2025 (PDF p. 4): \"portable handheld contact-type spectroradiometer (QualitySpec TREK; PANalytical, Boulder, USA\"", source: "https://doi.org/10.6084/m9.figshare.28675304" },
  { id: "grapevine-micronir", location: "regression/GRAPEVINE_LeafTraits/LMA_spxyG70_30_byCultivar_MicroNIR", dataset: "Grapevine leaf traits — MicroNIR", manufacturer: "VIAVI", instrument: "MicroNIR Onsite-W", matrix: "Fresh leaf", representation: "reflectance (converted from absorbance)", measurement: "Handheld; 2 spectra averaged per leaf", documentation: "nirs4all-data regression/GRAPEVINE_LeafTraits, Coindre et al. 2026 (PDF p. 4): \"MicroNIR (MicroNIR Onsite-W, VIAVI)\"", source: "https://doi.org/10.57745/WVAPOL" },
  { id: "grapevine-neospectra", location: "regression/GRAPEVINE_LeafTraits/LMA_spxyG70_30_byCultivar_NeoSpectra", dataset: "Grapevine leaf traits — NeoSpectra", manufacturer: "Si-Ware", instrument: "NeoSpectra Scanner", matrix: "Fresh leaf", representation: null, measurement: "Handheld FT-NIR; cm⁻¹ converted to nm; 2 spectra averaged per leaf", documentation: "nirs4all-data regression/GRAPEVINE_LeafTraits, Coindre et al. 2026 (PDF p. 4): \"NeoSpectra (NeoSpectra Scanner, Si-Ware)\"", source: "https://doi.org/10.57745/WVAPOL" },
  { id: "beefmarbling", location: "regression/BEEFMARBLING/Beef_Marbling_RandomSplit", dataset: "Beef carcass muscle — marbling", manufacturer: "Consumer Physics", instrument: "SCiO molecular sensor", matrix: "Fresh beef carcass muscle", representation: "log(1/R)", measurement: "Average of 5 scans, 740–1070 nm", documentation: "nirs4all-data regression/BEEFMARBLING, 1-s2.0-S030917402300075X-main.pdf (p. 2): \"SCiO™ molecular sensor (Consumer Physics Inc., Tel Aviv, Israel)\"", source: "https://doi.org/10.57745/FRDOJC" },
  { id: "tablet", location: "regression/TABLET/Escitalopramt_310_Zhao", dataset: "Pharmaceutical tablets — active substance", manufacturer: "ABB Bomem", instrument: "MB-160 (FT-NIR)", matrix: "Tablet", representation: "absorbance (transmittance converted)", measurement: "Transmission, 128 scans; sub-range 7398–10507 cm⁻¹ in the checkout", documentation: "nirs4all-data regression/TABLET, Dyrby et al. 2002 (PDF p. 2): \"ABB Bomem FT-NIR model MB-160\"", source: "https://ucphchemometrics.com/tablet/" },
  { id: "wood", location: "regression/WOOD_density/WOOD_Density_402_Olale", dataset: "Tropical wood cores — density", manufacturer: null, instrument: "FT-NIR MPA (manufacturer not stated)", matrix: "Ground dried wood auger cores", representation: "reflectance", measurement: "8000–4000 cm⁻¹, 30 scans averaged", documentation: "nirs4all-data regression/WOOD_density, Olale et al. 2013 (PDF p. 2): \"Fourier Transform Infrared Multi-purpose Analyzer (FTIR MPA) from 8000 to 4000 cm−1\"", source: "https://doi.org/10.34725/DVN/24522" },
];

const r4 = (v: number) => Number(v.toPrecision(6));

async function load(entry: Entry, io: IoRuntime, formats: FormatsRuntime): Promise<EngineInput> {
  if (entry.location.startsWith("demo:")) {
    const sample = DEMO_DATASETS.find((d) => d.id === entry.location.slice(5))!;
    return assembleDemoDataset(sample, await readDemoFiles(sample.id), io, formats);
  }
  const folder = new URL(`${entry.location}/`, DATA);
  const files = readdirSync(folder).filter((name) => name.endsWith(".csv")).map((name) => ({ name, bytes: new Uint8Array(readFileSync(new URL(name, folder))) }));
  return importFiles(files, entry.dataset, io, formats, entry.repetition).input;
}

describe.skipIf(!mode)("empirical noise benchmark reference", () => {
  it("recomputes the per-spectrum engine SNR on documented public datasets", async () => {
    expect(existsSync(DATA)).toBe(true);
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
    for (const entry of CATALOGUE) {
      const input = await load(entry, io, formats);
      const config = defaultConfig(input);
      const families = Object.fromEntries(ANALYSIS_FAMILIES.map((f) => [f, f === "spectral_quality"])) as typeof config.families;
      const engineInput = buildEngineInput(input, { ...config, families });
      // Only the noise protocol is needed: same estimator, no PCA/LOF/event cost on large sets.
      engineInput.options.intrinsic_qc = { ...engineInput.options.intrinsic_qc, reference: false, events: false, pca: false, local_density: false, noise: true };
      // Host-authorized cell budget of this offline generator (the engine default protects browsers).
      (engineInput.options as Record<string, unknown>).max_cells = Math.max(10_000_000, input.sources.reduce((a, s) => a + s.x.length * s.axis.length, 0));
      const report = runtime.analyze(engineInput) as EngineReport & { engine_version: string };
      engineVersion = report.engine_version;
      const source = input.sources[0]!;
      const signal = extractIntrinsic(buildQualificationReportView(report), source.source_id)?.signals["noise.signal_noise_db"];
      const values = (signal?.values ?? []).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      expect(values.length, `${entry.id}: ${JSON.stringify(signal?.state)} ${input.samples.filter((x) => x.partition === "development").length} development samples, ${source.x.length}×${source.axis.length}`).toBeGreaterThan(0);
      const q = (p: number) => r4(quantile(values, p)!);
      rows.push({
        id: entry.id,
        dataset: entry.dataset,
        manufacturer: entry.manufacturer,
        instrument: entry.instrument,
        matrix: entry.matrix,
        representation: entry.representation,
        measurement: entry.measurement,
        axis: `${r4(Math.min(...source.axis))}–${r4(Math.max(...source.axis))} ${source.axis_unit ?? ""}`.trim(),
        bands: source.axis.length,
        n: values.length,
        spectra: source.x.length,
        developmentSpectra: (() => {
          const development = new Set(input.samples.filter((s) => s.partition === "development").map((s) => s.sample_id));
          return source.sample_ids.filter((id) => development.has(id)).length;
        })(),
        min: r4(values[0]!),
        p5: q(0.05),
        p25: q(0.25),
        p50: q(0.5),
        p75: q(0.75),
        p95: q(0.95),
        max: r4(values[values.length - 1]!),
        location: entry.location.startsWith("demo:") ? `bundled with the demo (src/data/demo/${entry.location.slice(5)})` : `nirs4all-data ${entry.location}`,
        documentation: entry.documentation,
        source: entry.source,
      });
    }
    const out = { estimator: "intrinsic.noise.signal_noise_db (per spectrum, 20·log10(mean|x| / σ), σ = MAD of second differences × 1.4826/√6), development partition", engine: engineVersion, methods: methodsVersion, rows };
    if (mode === "write") {
      const generated = new Date().toISOString().slice(0, 10);
      writeFileSync(target, `${HEADER}export const NOISE_BENCHMARK: NoiseBenchmark = ${JSON.stringify({ generated, ...out }, null, 2)};\n`);
    } else {
      expect({ estimator: NOISE_BENCHMARK.estimator, engine: NOISE_BENCHMARK.engine, methods: NOISE_BENCHMARK.methods, rows: NOISE_BENCHMARK.rows }).toEqual(out);
    }
  }, 900000);
});

const HEADER = `// GENERATED by demo/scripts/noise-benchmark.test.ts (NOISE_BENCHMARK=write); do not edit by hand.
// Empirical noise reference: per-spectrum engine SNR quantiles on public NIR datasets whose instrument
// or manufacturer is documented (the 2 datasets bundled with the demo and datasets of the sibling
// nirs4all-data checkout, read through the app's IO path). Only computed summary statistics and
// provenance references; no data is copied. Interim demo data (Datasets catalogue debt).

export interface NoiseBenchmarkRow {
  id: string;
  dataset: string;
  /** Manufacturer as documented (null when the documentation does not state it). */
  manufacturer: string | null;
  /** Instrument model as documented. */
  instrument: string;
  matrix: string;
  /** Signal representation when documented, else null. */
  representation: string | null;
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
  /** Where the spectra were read (no data copied into this repository). */
  location: string;
  /** File documenting the instrument, with a short quotation. */
  documentation: string;
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
