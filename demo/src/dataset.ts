import type { DetectedTable } from "./dataset-io";
import type { EngineInput, InputMetadata, InputOptions, InputSample, InputSource, InputTarget, Partition, RepetitionType } from "./input";

import { numericCoordinates } from "../vendor/io-browser-owner/numeric-wire.mjs";
import type { AssembledBlock as IoBlock, AssembledDataset } from "../vendor/io-browser-owner/types/nirs4all-io";
export type { AssembledDataset } from "../vendor/io-browser-owner/types/nirs4all-io";

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
    const perSample = new Map<string, string | number | boolean>();
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
    for (const [sampleId, value] of perSample) (values[sampleId] ??= {})[name] = continuous && typeof value === "number" ? value : String(value);
  }
  return columns.length ? { columns, values } : undefined;
}

/** Technical repetition types a user can declare for a whole repetition column. */
export const DECLARABLE_REPETITIONS = ["rescan", "repositioning", "repreparation"] as const satisfies readonly RepetitionType[];

/**
 * A metadata column naming the physical sample of each row (IO's `repetition` column, e.g.
 * `Sample_ID`): rows sharing a value are repeated acquisitions of the declared type.
 */
export interface RepetitionDeclaration {
  column: string;
  type: (typeof DECLARABLE_REPETITIONS)[number];
}

/** Contract adapter only. IO already decoded, aligned and partitioned every row. */
export function toEngineInput(full: AssembledDataset, sourceIds: readonly string[] = [], repetition?: RepetitionDeclaration): EngineInput {
  if (full.assembled_schema_version !== 3) throw new Error("Expected nirs4all-io assembled dataset v3.");
  const sources: InputSource[] = [];
  const samples = new Map<string, InputSample>();
  const targets = new Map<string, InputTarget>();
  const identity = full.identity?.provenance;
  const metadataRows: { sampleId: string; block: IoBlock; row: number }[] = [];
  let repetitionFound = false;
  // Spectral headers of each source: a band-index axis must still describe the same bands everywhere.
  const sourceHeaders: (readonly string[])[] = [];
  for (const [part, block] of full.partition_order.map((part) => [part, full.blocks[part]!] as const)) {
    if (!block.n_samples) continue;
    const partition = partitionOf(part);
    const metadata = (name: string | null | undefined, row: number): string | undefined => {
      if (!name) return undefined;
      const value = block.metadata?.columns.find((c) => c.name === name)?.values[row];
      return value === null || value === undefined || value === "" ? undefined : String(value);
    };
    // IO prefixes a metadata column with its source id when the name collides ("train_m__Sample_ID").
    const repetitionColumn = repetition && block.metadata?.columns.find((c) => c.name === repetition.column || sourceIds.some((id) => c.name === `${id}__${repetition.column}`))?.name;
    if (repetitionColumn) repetitionFound = true;
    const ids: string[] = [];
    const declared: boolean[] = [];
    for (let row = 0; row < block.n_samples; row++) {
      const repeated = metadata(repetitionColumn, row);
      declared.push(repeated !== undefined);
      const physical = repeated ?? metadata(identity?.sample_id, row);
      const instrument = metadata("instrument", row);
      const campaign = metadata("campaign", row);
      // Separate records preserve a physical sample appearing in both development and test, or
      // acquired on several instruments or campaigns; they share its physical_sample_id.
      const sample_id = JSON.stringify(instrument === undefined && campaign === undefined ? [part, physical ?? row] : [part, physical ?? row, instrument ?? null, campaign ?? null]);
      ids.push(sample_id);
      metadataRows.push({ sampleId: sample_id, block, row });
      const sample: InputSample = { sample_id, partition };
      if (physical !== undefined) sample.physical_sample_id = physical;
      if (instrument !== undefined) sample.instrument = instrument;
      if (campaign !== undefined) sample.campaign = campaign;
      for (const field of ["individual_id", "augmentation_parent_id"] as const) {
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
      if (matrix.n_rows !== block.n_samples || matrix.data.length !== matrix.n_rows * matrix.n_cols || matrix.validity.length !== matrix.data.length) throw new Error("Misaligned IO feature matrix.");
      const headers = block.feature_headers[index] ?? [];
      const ownerAxis = block.feature_axes[index]?.[0];
      const coordinates = ownerAxis?.coordinates;
      const values = coordinates?.kind === "numeric" ? Array.from(numericCoordinates(coordinates, matrix.n_cols)) : [];
      // Preflight requires a monotonic numeric axis; retain the established index mapping for other bands.
      const monotonic = values.every((v, i) => i === 0 || v > values[i - 1]!) || values.every((v, i) => i === 0 || v < values[i - 1]!);
      const numericAxis = values.length === matrix.n_cols && monotonic;
      const axis = numericAxis ? values : Array.from({ length: matrix.n_cols }, (_, i) => i);
      const unit = numericAxis ? (ownerAxis?.unit || block.header_units[index] || "unknown") : "index";
      let source = sources[index];
      if (!source) {
        source = { source_id: `source_${index + 1}`, observation_ids: [], sample_ids: [], x: [], axis, axis_unit: unit, repetition_types: [] };
        const signal = block.signal_types[index];
        if (signal) source.signal_type = signal;
        sources[index] = source;
      }
      sourceHeaders[index] ??= headers;
      const sameBands = numericAxis || JSON.stringify(sourceHeaders[index]) === JSON.stringify(headers);
      if (!sameBands || JSON.stringify(source.axis) !== JSON.stringify(axis) || source.axis_unit !== unit) throw new Error("Spectral axes differ across partitions; align them in nirs4all-io before analysis.");
      for (let row = 0; row < matrix.n_rows; row++) {
        source.sample_ids.push(ids[row]!);
        source.observation_ids.push(JSON.stringify([index, part, row, metadata(identity?.observation_id, row) ?? null]));
        source.x.push(Array.from({ length: matrix.n_cols }, (_, col) => { const cell = row * matrix.n_cols + col; return matrix.validity[cell] ? numberOrNull(matrix.data[cell]) : null; }));
        // A per-row `repetition_type` column wins over the type declared for the repetition column.
        const kind = metadata("repetition_type", row);
        source.repetition_types!.push((["rescan", "repositioning", "repreparation", "biological"] as string[]).includes(kind ?? "") ? kind as RepetitionType : repetition && declared[row] ? repetition.type : "unknown");
      }
    });
    if (block.y) {
      const y = block.y;
      if (y.data.length !== block.n_samples * y.columns.length) throw new Error("Misaligned IO target matrix.");
      for (let col = 0; col < y.columns.length; col++) {
        const column = y.columns[col]!;
        if (column.block.n_rows !== block.n_samples || column.block.n_cols !== 1 || column.block.validity.length !== block.n_samples) throw new Error("Misaligned IO target matrix.");
        const name = column.name;
        const categories = column.kind === "classification_string" ? block.y_categorical[name]?.categories : undefined;
        const kind = column.kind === "classification_string" ? "categorical" : "continuous";
        let target = targets.get(name);
        if (!target) { target = { target_id: name, kind, values: [] }; targets.set(name, target); }
        if (target.kind !== kind) throw new Error(`Target kind differs across partitions: ${name}`);
        for (let row = 0; row < block.n_samples; row++) {
          const value = column.block.validity[row] ? numberOrNull(y.data[row * y.columns.length + col]) : null;
          if (value === null) continue;
          const category = column.kind === "classification_string" ? categories?.[value] : undefined;
          if (column.kind === "classification_string" && category === undefined) throw new Error(`Missing IO category label for target: ${name}`);
          target.values.push({ sample_id: ids[row]!, status: "exact", ...(kind === "categorical" ? { category: category! } : { value }) });
        }
      }
    }
  }
  if (!sources.length || !samples.size) throw new Error("No spectra found in the dataset.");
  if (repetition && !repetitionFound) throw new Error(`Repetition column not found in the dataset metadata: ${repetition.column}`);
  const reserved = new Set([identity?.sample_id, identity?.observation_id, identity?.group_id, repetition?.column].filter((name): name is string => typeof name === "string"));
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
  /** Metadata columns IO carried, offered as repetition columns. */
  columns?: string[];
  /** Repetition column the input was assembled with. */
  repetition?: RepetitionDeclaration;
}
