// Canonical engine input (schema v1) types + boundary validation of an uploaded file.
// Mirrors `nirs4all-preflight-core` `QualificationInput` exactly: Rust denies unknown fields.
// Shape checks only: scientific validation (alignment, identities, leakage) is the Rust engine's job.

export type IndependenceUnit = "sample" | "reference_group" | "group" | "unknown";
export type RepetitionType = "rescan" | "repositioning" | "repreparation" | "biological" | "unknown";
export type Partition = "development" | "retained_test" | "prediction";

export interface InputSource {
  source_id: string;
  observation_ids: string[];
  sample_ids: string[];
  x: (number | null)[][];
  axis: number[];
  axis_unit?: string;
  signal_unit?: string;
  signal_type?: string;
  valid_mask?: boolean[][];
  /** One declared repetition type per X row; technical = rescan/repositioning/repreparation. */
  repetition_types?: RepetitionType[];
}

export interface InputSample {
  sample_id: string;
  physical_sample_id?: string;
  /** Rust default: development. */
  partition?: Partition;
  /** Used when options.independence_unit is "group". */
  independence_group?: string;
  instrument?: string;
  campaign?: string;
  individual_id?: string;
  augmentation_parent_id?: string;
}

export interface InputTargetValue {
  sample_id: string;
  value?: number | null;
  category?: string | null;
  status: "exact" | "censored" | "composite";
  reference_id?: string | null;
  reference_group_id?: string | null;
}

export interface InputTarget {
  target_id: string;
  kind: "continuous" | "categorical";
  values: InputTargetValue[];
  unit?: string | null;
}

export interface InputOptions {
  independence_unit?: IndependenceUnit;
  assume_one_observation_per_sample?: boolean;
  /** u64 in Rust; JS numbers are exact only up to Number.MAX_SAFE_INTEGER. */
  seed?: number;
  max_cells?: number;
  max_samples?: number;
}

export interface EngineInput {
  data_origin?: "unknown" | "synthetic" | "user_provided";
  schema_version: 1;
  sources: InputSource[];
  samples: InputSample[];
  targets: InputTarget[];
  options: InputOptions;
}

export type ParseResult = { ok: true; input: EngineInput } | { ok: false; code: "not_json" | "not_object" | "schema_version" | "missing_field"; detail: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Checks only the fields the page itself dereferences; everything else is left to the engine. */
export function parseCanonicalInput(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: "not_json", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(raw)) return { ok: false, code: "not_object", detail: "" };
  if (raw.schema_version !== 1) return { ok: false, code: "schema_version", detail: String(raw.schema_version) };
  for (const key of ["sources", "samples"] as const) {
    if (!Array.isArray(raw[key])) return { ok: false, code: "missing_field", detail: key };
  }
  if (raw.targets !== undefined && !Array.isArray(raw.targets)) return { ok: false, code: "missing_field", detail: "targets" };
  if (raw.options !== undefined && !isObject(raw.options)) return { ok: false, code: "missing_field", detail: "options" };
  const sources = raw.sources as unknown[];
  for (const [i, s] of sources.entries()) {
    if (!isObject(s) || typeof s.source_id !== "string") return { ok: false, code: "missing_field", detail: `sources[${i}].source_id` };
    for (const key of ["observation_ids", "sample_ids"] as const) {
      if (!isStringArray(s[key])) return { ok: false, code: "missing_field", detail: `sources[${i}].${key}` };
    }
    if (!Array.isArray(s.x) || !s.x.every(Array.isArray)) return { ok: false, code: "missing_field", detail: `sources[${i}].x` };
    if (!Array.isArray(s.axis)) return { ok: false, code: "missing_field", detail: `sources[${i}].axis` };
  }
  for (const [i, s] of (raw.samples as unknown[]).entries()) {
    if (!isObject(s) || typeof s.sample_id !== "string") return { ok: false, code: "missing_field", detail: `samples[${i}].sample_id` };
  }
  for (const [i, t] of ((raw.targets ?? []) as unknown[]).entries()) {
    if (!isObject(t) || typeof t.target_id !== "string" || !Array.isArray(t.values)) return { ok: false, code: "missing_field", detail: `targets[${i}]` };
  }
  return { ok: true, input: { ...(raw as unknown as EngineInput), targets: (raw.targets ?? []) as InputTarget[], options: (raw.options ?? {}) as InputOptions } };
}

/** Engine options edited on the page. Sources and targets are never subset: the engine analyses the whole input. */
export interface AnalysisConfig {
  independenceUnit: IndependenceUnit;
  assumeOneObservationPerSample: boolean;
  seed: number | null;
}

export function defaultConfig(input: EngineInput): AnalysisConfig {
  return {
    independenceUnit: input.options.independence_unit ?? "unknown",
    assumeOneObservationPerSample: input.options.assume_one_observation_per_sample ?? false,
    seed: input.options.seed ?? null,
  };
}

/** Accepts a seed only when it is a nonnegative integer that JS can carry exactly to the u64 field. */
export function parseSeed(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? n : "invalid";
}

/** Applies the edited options; data and declared budgets are passed through untouched. */
export function buildEngineInput(input: EngineInput, config: AnalysisConfig): EngineInput {
  const options: InputOptions = { ...input.options, independence_unit: config.independenceUnit };
  delete options.assume_one_observation_per_sample;
  delete options.seed;
  if (config.assumeOneObservationPerSample) options.assume_one_observation_per_sample = true;
  if (config.seed !== null) options.seed = config.seed;
  return { schema_version: 1, ...(input.data_origin ? { data_origin: input.data_origin } : {}), sources: input.sources, samples: input.samples, targets: input.targets, options };
}

/** Number of declared samples carrying an `independence_group` (display hint for the "group" unit). */
export function countIndependenceGroups(input: EngineInput): number {
  return input.samples.filter((s) => typeof s.independence_group === "string" && s.independence_group !== "").length;
}
