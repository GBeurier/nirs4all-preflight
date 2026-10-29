import type { EngineInput, InputSample, InputSource, InputTarget, Partition, RepetitionType } from "./input";

export interface IoMatrix { n_rows: number; n_cols: number; data: (number | null)[] }
export interface IoBlock {
  n_samples: number;
  source_ids: string[];
  x: IoMatrix[];
  feature_headers: string[][];
  header_units: string[];
  signal_types: (string | null)[];
  y?: IoMatrix | null;
  y_headers: string[];
  y_categorical?: Record<string, { categories: string[] }>;
  metadata?: { columns: { name: string; values: (string | number | null)[] }[] } | null;
}
export interface AssembledDataset {
  assembled_schema_version: number;
  name: string;
  blocks: Record<string, IoBlock>;
  identity?: { provenance: { sample_id?: string; observation_id?: string; group_id?: string } };
}

const numberOrNull = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
const partitionOf = (name: string): Partition => {
  if (["train", "val", "validation", "development"].includes(name)) return "development";
  if (["test", "retained_test"].includes(name)) return "retained_test";
  if (["predict", "prediction"].includes(name)) return "prediction";
  throw new Error(`Unknown dataset partition: ${name}`);
};

/** Contract adapter only. IO already decoded, aligned and partitioned every row. */
export function toEngineInput(full: AssembledDataset): EngineInput {
  if (full.assembled_schema_version !== 2) throw new Error("Expected nirs4all-io assembled dataset v2.");
  const sources: InputSource[] = [];
  const samples = new Map<string, InputSample>();
  const targets = new Map<string, InputTarget>();
  const identity = full.identity?.provenance;
  for (const [part, block] of Object.entries(full.blocks)) {
    if (!block.n_samples) continue;
    const partition = partitionOf(part);
    const metadata = (name: string | undefined, row: number): string | undefined => {
      if (!name) return undefined;
      const value = block.metadata?.columns.find((c) => c.name === name)?.values[row];
      return value === null || value === undefined || value === "" ? undefined : String(value);
    };
    const ids: string[] = [];
    for (let row = 0; row < block.n_samples; row++) {
      const physical = metadata(identity?.sample_id, row);
      // Separate records preserve a physical sample appearing in both development and test.
      const sample_id = JSON.stringify([part, physical ?? row]);
      ids.push(sample_id);
      const sample: InputSample = { sample_id, partition };
      if (physical !== undefined) sample.physical_sample_id = physical;
      for (const field of ["instrument", "campaign", "individual_id", "augmentation_parent_id"] as const) {
        const value = metadata(field, row);
        if (value !== undefined) sample[field] = value;
      }
      const group = metadata(identity?.group_id, row);
      if (group !== undefined) sample.independence_group = group;
      const previous = samples.get(sample_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(sample)) throw new Error(`Conflicting sample metadata: ${physical}`);
      samples.set(sample_id, sample);
    }
    block.x.forEach((matrix, index) => {
      if (matrix.n_rows !== block.n_samples || matrix.data.length !== matrix.n_rows * matrix.n_cols) throw new Error("Misaligned IO feature matrix.");
      const headers = block.feature_headers[index] ?? [];
      const numericAxis = headers.length === matrix.n_cols && headers.every((h) => h.trim() !== "" && Number.isFinite(Number(h)));
      const axis = numericAxis ? headers.map(Number) : Array.from({ length: matrix.n_cols }, (_, i) => i);
      const unit = numericAxis ? (block.header_units[index] || "unknown") : "index";
      let source = sources[index];
      if (!source) {
        source = { source_id: `source_${index + 1}`, observation_ids: [], sample_ids: [], x: [], axis, axis_unit: unit, repetition_types: [] };
        const signal = block.signal_types[index];
        if (signal) source.signal_type = signal;
        sources[index] = source;
      }
      if (JSON.stringify(source.axis) !== JSON.stringify(axis) || source.axis_unit !== unit) throw new Error("Spectral axes differ across partitions; align them in nirs4all-io before analysis.");
      for (let row = 0; row < matrix.n_rows; row++) {
        source.sample_ids.push(ids[row]!);
        source.observation_ids.push(JSON.stringify([index, part, row, metadata(identity?.observation_id, row) ?? null]));
        source.x.push(matrix.data.slice(row * matrix.n_cols, (row + 1) * matrix.n_cols).map(numberOrNull));
        const repetition = metadata("repetition_type", row);
        source.repetition_types!.push((["rescan", "repositioning", "repreparation", "biological"] as string[]).includes(repetition ?? "") ? repetition as RepetitionType : "unknown");
      }
    });
    if (block.y) {
      if (block.y.n_rows !== block.n_samples || block.y.data.length !== block.n_samples * block.y.n_cols) throw new Error("Misaligned IO target matrix.");
      for (let col = 0; col < block.y.n_cols; col++) {
        const name = block.y_headers[col] ?? `target_${col + 1}`;
        const categories = block.y_categorical?.[name]?.categories;
        const kind = categories ? "categorical" : "continuous";
        let target = targets.get(name);
        if (!target) { target = { target_id: name, kind, values: [] }; targets.set(name, target); }
        if (target.kind !== kind) throw new Error(`Target kind differs across partitions: ${name}`);
        for (let row = 0; row < block.y.n_rows; row++) {
          const value = numberOrNull(block.y.data[row * block.y.n_cols + col]);
          target.values.push({ sample_id: ids[row]!, status: "exact", ...(categories ? { category: value === null ? null : categories[value] ?? null } : { value }) });
        }
      }
    }
  }
  if (!sources.length || !samples.size) throw new Error("No spectra found in the dataset.");
  return { schema_version: 1, data_origin: "user_provided", sources, samples: [...samples.values()], targets: [...targets.values()], options: { independence_unit: "unknown" } };
}

export interface SavedDataset {
  id: string;
  name: string;
  savedAt: string;
  input: EngineInput;
}

/** Small display contract consumed by nirs4all-ui's shared preview card. */
export function datasetPreview(dataset: SavedDataset) {
  return { id: dataset.id, name: dataset.name, sampleCount: dataset.input.samples.length,
    featureCount: dataset.input.sources.reduce((n, s) => n + s.axis.length, 0), targetCount: dataset.input.targets.length };
}
