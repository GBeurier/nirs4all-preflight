import { buildExportConfig } from "nirs4all-ui/datasetBuilder";
import type { NamedFile } from "@nirs4all/io-wasm/types";
import { assembleDraft, prepareDataset, type IoRuntime, type FormatsRuntime } from "./dataset-io";
import type { EngineInput } from "./input";

/** Same real CSV extracts and original splits as Web; provenance accompanies them. */
export const DEMO_DATASETS = [
  { id: "beer", name: "Beer — original extract", task: "regression", samples: 60, bands: 576, train: 40, test: 20,
    target: "original_extract", attribution: "OHPL — You-Wu Lin & Nan Xiao", source: "https://ohpl.io/doc/", license: "GPL-3.0", licenseFile: "GPL-3.0.txt" },
  { id: "anopheles", name: "Anopheles — oocyst presence", task: "classification", samples: 333, bands: 2151, train: 227, test: 106,
    target: "oocyst_presence", attribution: "Maia et al. — Harvard Dataverse", source: "https://doi.org/10.7910/DVN/YD34OX", license: "CC BY 4.0", licenseFile: "CC-BY-4.0.txt" },
] as const;
export type DemoDataset = typeof DEMO_DATASETS[number];
export type DemoDatasetId = DemoDataset["id"];

// Vite emits one lazy chunk per CSV; no dataset is downloaded until selected.
const csv = import.meta.glob<string>("./data/demo/*/*.csv", { query: "?raw", import: "default" });
export async function readDemoFiles(id: DemoDatasetId): Promise<NamedFile[]> {
  return Promise.all(["Xtrain.csv", "Ytrain.csv", "Xtest.csv", "Ytest.csv"].map(async (name) => {
    const load = csv[`./data/demo/${id}/${name}`];
    if (!load) throw new Error(`Missing demo file: ${id}/${name}`);
    return { name, bytes: new TextEncoder().encode(await load()) };
  }));
}

export function assembleDemoDataset(sample: DemoDataset, files: NamedFile[], io: IoRuntime, formats: FormatsRuntime): EngineInput {
  const draft = prepareDataset(files, io, formats);
  const input = assembleDraft(draft, buildExportConfig(sample.name, draft.sources), draft.sources, io);
  for (const target of input.targets) {
    target.target_id = sample.target;
    if (sample.task === "classification") {
      // The source CSV's documented 0/1 codes denote categories, not a continuous reference.
      target.kind = "categorical";
      target.values = target.values.map(({ value, ...reference }) => ({ ...reference, category: value === null || value === undefined ? null : String(value) }));
    }
  }
  return input;
}
