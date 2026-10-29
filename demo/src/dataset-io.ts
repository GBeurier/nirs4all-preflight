import { autoDetectSource, type DatasetExportConfig, type DatasetRole, type DatasetSource } from "nirs4all-ui/datasetBuilder";
import type { DatasetPlan, DatasetSpec, NamedFile, RecordSet, SourceSpec } from "@nirs4all/io-wasm/types";
import { toEngineInput, type AssembledDataset } from "./dataset";

export interface IoRuntime {
  inferDataset: typeof import("@nirs4all/io-wasm").inferDataset;
  assembleDataset: typeof import("@nirs4all/io-wasm").assembleDataset;
  validate: typeof import("@nirs4all/io-wasm").validate;
}
export interface FormatsRuntime { openWithSidecars: typeof import("@nirs4all/formats-wasm").openWithSidecars }
export interface DatasetDraft {
  files: NamedFile[];
  records: RecordSet[];
  spec: DatasetSpec;
  sources: DatasetSource[];
  warnings: string[];
}

let runtime: Promise<{ io: IoRuntime; formats: FormatsRuntime }> | undefined;
export function loadDatasetRuntime() {
  return runtime ??= Promise.all([import("virtual:nirs4all-io"), import("virtual:nirs4all-formats")]).then(async ([io, formats]) => {
    await Promise.all([io.init(), formats.init()]);
    return { io, formats };
  }).catch((error) => { runtime = undefined; throw error; });
}

/** Never impute, drop or aggregate rows while diagnosing raw datasets. */
function diagnosticSpec(spec: DatasetSpec): DatasetSpec {
  const next = structuredClone(spec);
  next.params = { ...next.params, na: { policy: "ignore" } };
  delete next.aggregate;
  next.sources = next.sources.map((s) => ({ ...s, params: { ...s.params, na: { policy: "ignore" } } }));
  return next;
}

const roleMap: Record<string, DatasetRole> = { features: "x", targets: "y", metadata: "metadata", id: "id", ignore: "ignored" };

/** Native IO owns inference, table parsing, joins and assembly; UI gets only previews. */
export function prepareDataset(files: NamedFile[], io: IoRuntime, formats: FormatsRuntime): DatasetDraft {
  if (new Set(files.map((f) => f.name)).size !== files.length) throw new Error("Duplicate input filenames. Keep their relative folder paths.");
  const records: RecordSet[] = [];
  const sidecars = Object.fromEntries(files.map((f) => [f.name, f.bytes]));
  for (const file of files) {
    // IO reads tables directly so subsequent column/parsing edits use the raw file.
    if (/\.(csv|tsv|txt)$/i.test(file.name)) continue;
    try {
      const decoded = formats.openWithSidecars(file.name, file.bytes, sidecars) as unknown[];
      if (decoded?.length) records.push({ source: file.name, records: decoded });
    } catch {
      // The IO inference below diagnoses files it cannot consume (including sidecars).
    }
  }
  const plan = io.inferDataset(files, records, {}) as DatasetPlan;
  if (!plan.resolved_spec?.sources.length) throw new Error("nirs4all-io could not infer a dataset from these files.");
  const spec = diagnosticSpec(plan.resolved_spec);
  // Convention-named X/Y files may receive row-order joins from the global
  // plan. Ask IO to inspect each table independently so shared IDs are available
  // in the builder and lookup joins preserve repeated X observations.
  for (const source of spec.sources) {
    const input = files.find((file) => file.name === source.input);
    if (!input || !/\.(csv|tsv|txt)$/i.test(input.name)) continue;
    const extension = input.name.split(".").pop();
    const local = io.inferDataset([{ ...input, name: `preview.${extension}` }], [], {}) as DatasetPlan;
    const key = (local.resolved_spec?.sample_index as { key?: string } | undefined)?.key;
    if (key) source.key = key;
  }
  for (const source of spec.sources) {
    const join = source.join as { right?: string } | undefined;
    const anchor = spec.sources.find((candidate) => candidate.id === join?.right);
    if (typeof source.key === "string" && typeof anchor?.key === "string") {
      source.join = { left: source.id, right: anchor.id, left_on: source.key, right_on: anchor.key,
        cardinality: source.role === "targets" || source.role === "metadata" ? "m:1" : "1:1", coverage: "complete" };
    }
  }
  const decodedNames = new Set(records.map((r) => r.source));
  const raw = files.filter((f) => !decodedNames.has(f.name));
  const full = io.assembleDataset(raw, records, JSON.stringify(spec)) as AssembledDataset;
  const sources = spec.sources.map((s): DatasetSource => {
    const names = Array.isArray(s.input) ? s.input as string[] : [s.input];
    const blocks = Object.entries(full.blocks).filter(([p]) => !s.partition || p === s.partition).map(([, b]) => b);
    const block = blocks[0];
    const sourceIndex = block?.source_ids.indexOf(s.id) ?? -1;
    const inferred = (plan.columns as { ref: string; column_roles: { col: string; role: string }[] }[]).find((c) => names.includes(c.ref));
    const columns = new Map<string, DatasetRole>();
    for (const c of inferred?.column_roles ?? []) columns.set(c.col, roleMap[c.role] ?? "metadata");
    const selectors = s.columns as { role: string; select: string[] }[] | undefined;
    for (const selector of selectors ?? []) {
      if (Array.isArray(selector.select)) for (const name of selector.select) columns.set(name, roleMap[selector.role] ?? "metadata");
    }
    if (sourceIndex >= 0) for (const name of block?.feature_headers[sourceIndex] ?? []) columns.set(name, columns.get(name) ?? "x");
    if (s.role === "targets" || s.role === "mixed") for (const name of block?.y_headers ?? []) columns.set(name, columns.get(name) ?? "y");
    if (s.role === "metadata" || s.role === "mixed") for (const c of block?.metadata?.columns ?? []) columns.set(c.name, columns.get(c.name) ?? "metadata");
    if (typeof s.key === "string") columns.set(s.key, "id");
    const declaredKey = (spec.sample_index as { key?: string } | undefined)?.key;
    if (typeof declaredKey === "string" && block?.metadata?.columns.some((column) =>
      (sourceIndex >= 0 && column.name === declaredKey) || column.name === `${s.id}__${declaredKey}`)) columns.set(declaredKey, "id");
    const params = s.params ?? {};
    const source: DatasetSource = {
      id: s.id, name: names.join(", "), kind: "file", fileType: names[0]?.split(".").pop() ?? "unknown",
      signalType: sourceIndex >= 0 ? "spectra" : s.role === "targets" ? "target" : "metadata", status: "parsed",
      rowCount: blocks.reduce((n, b) => n + b.n_samples, 0), columnCount: columns.size,
      sizeBytes: files.filter((f) => names.includes(f.name)).reduce((n, f) => n + f.bytes.byteLength, 0),
      parsing: { ...(typeof params.delimiter === "string" ? { separator: params.delimiter } : {}),
        headerMode: params.has_header === false ? "none" : "horizontal", decimal: params.decimal_separator === "," ? "," : "." },
      usage: { useAs: s.partition === "predict" ? "auxiliary" : s.role === "targets" ? (s.partition === "test" ? "y_test" : "y_train") : s.role === "metadata" ? "metadata" : s.partition === "test" ? "x_test" : "x_train" },
      columns: [...columns].map(([name, assignedRole], i) => {
        const metadata = block?.metadata?.columns.find((c) => c.name === name)?.values[0];
        const xcol = block?.feature_headers[sourceIndex]?.indexOf(name) ?? -1;
        const ycol = block?.y_headers.indexOf(name) ?? -1;
        const rawValue = metadata ?? (xcol >= 0 ? block?.x[sourceIndex]?.data[xcol] : ycol >= 0 ? block?.y?.data[ycol] : null) ?? null;
        const categories = block?.y_categorical?.[name]?.categories;
        const value = categories && typeof rawValue === "number" ? categories[rawValue] ?? null : rawValue;
        return { id: `${s.id}:${i}`, name, assignedRole, manual: true, detectedType: typeof value === "number" ? "float" as const : typeof value === "string" ? "text" as const : "unknown" as const, previewValue: value };
      }),
    };
    // Reuse shared semantic detection while keeping native IO's role assignments.
    const detected = autoDetectSource({ ...source, columns: source.columns.map((c) => ({ ...c, manual: false })) });
    return { ...source, columns: source.columns.map((c, i) => ({ ...c, ...detected.columns[i]!, assignedRole: s.role === "mixed" ? detected.columns[i]!.assignedRole : c.assignedRole, manual: true })) };
  });
  return { files, records, spec, sources, warnings: plan.warnings ?? [] };
}

/** Translate shared builder choices to IO's native spec; do no joining in JS. */
export function builderSpec(draft: DatasetDraft, config: DatasetExportConfig, sources: DatasetSource[]): DatasetSpec {
  const spec = diagnosticSpec(draft.spec);
  spec.name = config.name;
  const identity: Record<string, unknown> = {};
  const idColumn = sources.flatMap((source) => source.columns).find((column) => column.assignedRole === "id");
  if (idColumn) { identity.by = "id"; identity.key = idColumn.name; }
  delete spec.sample_index;
  if (draft.sources.some((source) => source.columns.some((column) => column.assignedRole === "partition")) && !sources.some((source) => source.columns.some((column) => column.assignedRole === "partition"))) delete spec.partitions;
  spec.sources = sources.map((source) => {
    if (source.parsing.headerMode === "vertical") throw new Error("Vertical headers are not supported by this preflight import.");
    if (["image", "hyperspectral", "timeseries"].includes(source.signalType)) throw new Error("Preflight requires a two-dimensional spectral matrix.");
    const original = spec.sources.find((s) => s.id === source.id);
    if (!original) throw new Error(`Unknown source: ${source.id}`);
    const columns: Record<string, string[]> = {};
    const roles: Record<DatasetRole, string> = { x: "features", y: "targets", metadata: "metadata", id: "metadata", partition: "metadata", replicate: "metadata", group: "metadata", ignored: "ignore" };
    for (const col of source.columns) (columns[roles[col.assignedRole]] ??= []).push(col.name);
    const next: SourceSpec = { ...original, role: "mixed", columns, params: { ...original.params, na: { policy: "ignore" },
      ...(source.parsing.separator ? { delimiter: source.parsing.separator } : {}),
      has_header: source.parsing.headerMode !== "none", decimal_separator: source.parsing.decimal ?? "." } };
    const id = source.columns.find((c) => c.assignedRole === "id");
    if (id) { next.key = id.name; identity.by = "id"; identity.key = id.name; }
    else delete next.key;
    const group = source.columns.find((c) => c.assignedRole === "group");
    if (group) identity.group_id = group.name;
    const repeat = source.columns.find((c) => c.assignedRole === "replicate");
    if (repeat) identity.repetition_id = repeat.name;
    const partition = source.columns.find((c) => c.assignedRole === "partition");
    if (partition) spec.partitions = { by: "column", column: partition.name, train_values: ["train", "calibration", "cal", "val", "validation", "dev", "development"], test_values: ["test", "retained_test"], predict_values: ["predict", "prediction"], unknown_policy: "error" };
    const use = source.usage.useAs;
    if (use === "x_test" || use === "y_test") next.partition = "test";
    else if (use === "x_train" || use === "y_train") next.partition = "train";
    const join = config.joins.find((candidate) => candidate.right === source.name);
    const nativeAnchor = (original.join as { right?: string } | undefined)?.right;
    if ((join || nativeAnchor) && id) {
      const left = sources.find((candidate) => candidate.id === nativeAnchor) ?? sources.find((candidate) => candidate.name === join?.left);
      const leftUsage = left?.usage.useAs;
      const leftPartition = leftUsage === "x_test" || leftUsage === "y_test" ? "test" : leftUsage === "x_train" || leftUsage === "y_train" ? "train" : spec.sources.find((candidate) => candidate.id === left?.id)?.partition;
      const leftId = left?.columns.find((column) => column.assignedRole === "id");
      if (left && leftId && leftPartition === next.partition) next.join = { left: source.id, right: left.id, left_on: id.name, right_on: leftId.name, cardinality: source.columns.some((column) => column.assignedRole === "x") ? "1:1" : "m:1", coverage: "complete" };
    }
    if (partition) delete next.partition;
    if (!Object.keys(columns).length) throw new Error(`No columns selected for ${source.name}`);
    return next;
  });
  if (Object.keys(identity).length) spec.sample_index = identity;
  return spec;
}

export function assembleDraft(draft: DatasetDraft, config: DatasetExportConfig, sources: DatasetSource[], io: IoRuntime) {
  const spec = builderSpec(draft, config, sources);
  io.validate(JSON.stringify(spec));
  const names = new Set(draft.records.map((r) => r.source));
  return toEngineInput(io.assembleDataset(draft.files.filter((f) => !names.has(f.name)), draft.records, JSON.stringify(spec)) as AssembledDataset);
}
