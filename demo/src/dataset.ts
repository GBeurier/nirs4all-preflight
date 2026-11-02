import type { DetectedTable } from "./dataset-io";
import type { EngineInput, InputMetadata, InputOptions, InputSample, InputSource, InputTarget, Partition, RepetitionType } from "./input";

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

/** Columns already carried by sample fields, identities or repetition types. */
const RESERVED_METADATA = new Set(["instrument", "campaign", "individual_id", "augmentation_parent_id", "repetition_type", "partition"]);

/**
 * Every other IO metadata column, keyed by sample. A column whose value differs between
 * repeated rows of one sample describes acquisitions, not samples, and is left out.
 */
function sampleMetadata(rows: { sampleId: string; block: IoBlock; row: number }[], reserved: ReadonlySet<string>, sourceIds: readonly string[]): InputMetadata | undefined {
  // IO prefixes a colliding metadata column with its source id ("train_m__y"); one name per column.
  const plain = (name: string) => {
    const owner = sourceIds.find((id) => name.startsWith(`${id}__`));
    return owner ? name.slice(owner.length + 2) : name;
  };
  const names = [...new Set(rows.flatMap(({ block }) => (block.metadata?.columns ?? []).map((c) => plain(c.name))))].filter((name) => !reserved.has(name) && !RESERVED_METADATA.has(name));
  const columns: InputMetadata["columns"] = [];
  const values: InputMetadata["values"] = {};
  for (const name of names) {
    const perSample = new Map<string, string | number>();
    let consistent = true;
    for (const { sampleId, block, row } of rows) {
      const value = block.metadata?.columns.find((c) => plain(c.name) === name)?.values[row];
      if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) continue;
      const previous = perSample.get(sampleId);
      if (previous !== undefined && previous !== value) { consistent = false; break; }
      perSample.set(sampleId, value);
    }
    if (!consistent || !perSample.size) continue;
    const continuous = [...perSample.values()].every((v) => typeof v === "number");
    // A text column with one level per sample is an identifier, not a factor.
    if (!continuous && perSample.size > 1 && new Set(perSample.values()).size === perSample.size) continue;
    columns.push({ name, kind: continuous ? "continuous" : "categorical" });
    for (const [sampleId, value] of perSample) (values[sampleId] ??= {})[name] = continuous ? value : String(value);
  }
  return columns.length ? { columns, values } : undefined;
}

/** Contract adapter only. IO already decoded, aligned and partitioned every row. */
export function toEngineInput(full: AssembledDataset, sourceIds: readonly string[] = []): EngineInput {
  if (full.assembled_schema_version !== 2) throw new Error("Expected nirs4all-io assembled dataset v2.");
  const sources: InputSource[] = [];
  const samples = new Map<string, InputSample>();
  const targets = new Map<string, InputTarget>();
  const identity = full.identity?.provenance;
  const metadataRows: { sampleId: string; block: IoBlock; row: number }[] = [];
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
      metadataRows.push({ sampleId: sample_id, block, row });
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
      const values = headers.map(Number);
      // The engine needs a strictly monotonic axis; concatenated detector ranges fall back to the band index.
      const monotonic = values.every((v, i) => i === 0 || v > values[i - 1]!) || values.every((v, i) => i === 0 || v < values[i - 1]!);
      const numericAxis = headers.length === matrix.n_cols && headers.every((h) => h.trim() !== "" && Number.isFinite(Number(h))) && monotonic;
      const axis = numericAxis ? values : Array.from({ length: matrix.n_cols }, (_, i) => i);
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
          // A missing reference is no reference: each target keeps its own samples.
          const value = numberOrNull(block.y.data[row * block.y.n_cols + col]);
          const category = categories && value !== null ? categories[value] ?? null : null;
          if (value === null || (categories && category === null)) continue;
          target.values.push({ sample_id: ids[row]!, status: "exact", ...(categories ? { category } : { value }) });
        }
      }
    }
  }
  if (!sources.length || !samples.size) throw new Error("No spectra found in the dataset.");
  const reserved = new Set([identity?.sample_id, identity?.observation_id, identity?.group_id].filter((name): name is string => typeof name === "string"));
  const metadata = sampleMetadata(metadataRows, reserved, sourceIds);
  // Spectral signatures (T²/Q, distance to the mean spectrum, spikes, jumps, noise) on the development
  // spectra, and the X-only audit of a retained test set against development (test Y is never read).
  const options: InputOptions = { independence_unit: "unknown", intrinsic_qc: {} };
  if ([...samples.values()].some((s) => s.partition === "retained_test")) options.domain_shift = { external_domain_audit: true };
  return { schema_version: 1, data_origin: "user_provided", sources, samples: [...samples.values()], targets: [...targets.values()].filter((t) => t.values.length), ...(metadata ? { metadata } : {}), options };
}

export interface SavedDataset {
  id: string;
  name: string;
  savedAt: string;
  input: EngineInput;
  /** How nirs4all-io read each file. */
  tables?: DetectedTable[];
}
