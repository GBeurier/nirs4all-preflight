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
  seed?: number | string;
  max_cells?: number;
  max_samples?: number;
  clustering?: { subsample_refit?: boolean };
  domain_shift?: { energy_on_spectra?: boolean; monitor_on_spectra?: boolean; external_domain_audit?: boolean; [key: string]: unknown };
  /** Descriptive per-spectrum signatures; `{}` keeps the engine defaults. */
  intrinsic_qc?: Record<string, unknown>;
  metadata_roles?: Record<string, MetadataRole>;
  analysis_families?: Partial<AnalysisFamilies>;
  exchangeable_units?: boolean;
  snv_sensitivity?: boolean;
  quasi_duplicates?: { tolerance: number; view?: "native" | "snv"; context?: "source" | "instrument" | "instrument_campaign" };
  quasi_tolerance_from_repeats?: boolean;
  reference_contradiction_tolerances?: Record<string, { kind: "absolute" | "relative"; value: number } | { kind: "different_class" }>;
}

export interface InputMetadataColumn {
  name: string;
  kind: "categorical" | "continuous";
  unit?: string;
}

/** Sample-level metadata beyond instrument and campaign: strings are categorical, numbers continuous. */
export interface InputMetadata {
  columns: InputMetadataColumn[];
  values: Record<string, Record<string, string | number | null>>;
}

export interface EngineInput {
  data_origin?: "unknown" | "synthetic" | "user_provided";
  schema_version: 1;
  sources: InputSource[];
  samples: InputSample[];
  targets: InputTarget[];
  metadata?: InputMetadata;
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

export type MetadataRole = "analysis" | "identifier" | "excluded";
export const ANALYSIS_FAMILIES = ["spectral_quality", "sensitivity", "repeatability", "clustering", "association", "confounding", "domain_shift", "probe"] as const;
export type AnalysisFamily = typeof ANALYSIS_FAMILIES[number];
export type AnalysisFamilies = Record<AnalysisFamily, boolean>;

/** All original columns and identities stay in the input; roles control analytical use. */
export interface AnalysisConfig {
  independenceUnit: IndependenceUnit;
  assumeOneObservationPerSample: boolean;
  seed: number | string | null;
  metadataRoles: Record<string, MetadataRole>;
  families: AnalysisFamilies;
  clusterRefit: boolean;
  fullSpectrumEnergy: boolean;
  fullSpectrumMonitor: boolean;
  exchangeableUnits: boolean;
  eventThreshold: number;
  quasiTolerance: number | null;
  quasiToleranceFromRepeats: boolean;
  referenceTolerances: NonNullable<InputOptions["reference_contradiction_tolerances"]>;
}

export function metadataColumns(input: EngineInput): InputMetadataColumn[] {
  return [
    ...(["instrument", "campaign"] as const).filter((key) => input.samples.some((s) => s[key] != null)).map((name) => ({ name, kind: "categorical" as const })),
    ...(input.metadata?.columns ?? []),
  ];
}

export function metadataValue(input: EngineInput, sampleId: string, name: string, sample?: InputSample): string | number | null {
  if (name === "instrument" || name === "campaign") return (sample ?? input.samples.find((s) => s.sample_id === sampleId))?.[name] ?? null;
  return input.metadata?.values[sampleId]?.[name] ?? null;
}

/** ID-like names qualify only with distinct non-null sample values; every role remains editable. */
export function defaultMetadataRole(input: EngineInput, name: string): MetadataRole {
  if (!/(^id($|[_ -])|[_ -]id$|^(sample|scan|spectr(um|a|e|es))[_ -]?id$)/i.test(name)) return "analysis";
  const values = input.samples.map((sample) => metadataValue(input, sample.sample_id, name, sample)).filter((value) => value !== null);
  return values.length > 0 && new Set(values).size === values.length ? "identifier" : "analysis";
}

export function defaultConfig(input: EngineInput): AnalysisConfig {
  return {
    independenceUnit: input.options.independence_unit ?? "unknown",
    assumeOneObservationPerSample: input.options.assume_one_observation_per_sample ?? false,
    seed: input.options.seed ?? null,
    metadataRoles: Object.fromEntries(metadataColumns(input).map((c) => [c.name, input.options.metadata_roles?.[c.name] ?? defaultMetadataRole(input, c.name)])),
    families: Object.fromEntries(ANALYSIS_FAMILIES.map((name) => [name, input.options.analysis_families?.[name] ?? true])) as AnalysisFamilies,
    clusterRefit: input.options.clustering?.subsample_refit ?? false,
    fullSpectrumEnergy: input.options.domain_shift?.energy_on_spectra ?? false,
    fullSpectrumMonitor: input.options.domain_shift?.monitor_on_spectra ?? false,
    exchangeableUnits: input.options.exchangeable_units ?? false,
    eventThreshold: typeof input.options.intrinsic_qc?.outlier_threshold === "number" ? input.options.intrinsic_qc.outlier_threshold : 8,
    referenceTolerances: input.options.reference_contradiction_tolerances ?? Object.fromEntries(input.targets.filter((t) => t.kind === "categorical").map((t) => [t.target_id, { kind: "different_class" as const }])),
    quasiTolerance: input.options.quasi_duplicates?.tolerance ?? null,
    quasiToleranceFromRepeats: input.options.quasi_tolerance_from_repeats ?? (input.options.quasi_duplicates === undefined && input.sources.some((s) => s.repetition_types?.some((r) => ["rescan", "repositioning", "repreparation"].includes(r)))),
  };
}

/** Decimal strings preserve the complete u64 range without a browser precision caveat. */
export function parseSeed(text: string): number | string | null | "invalid" {
  if (text.trim() === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) return "invalid";
  return BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}

export function buildEngineInput(input: EngineInput, config: AnalysisConfig): EngineInput {
  const options: InputOptions = {
    ...input.options,
    independence_unit: config.independenceUnit,
    metadata_roles: config.metadataRoles,
    analysis_families: config.families,
    exchangeable_units: config.exchangeableUnits,
    quasi_tolerance_from_repeats: config.quasiToleranceFromRepeats,
    reference_contradiction_tolerances: config.referenceTolerances,
    intrinsic_qc: { ...input.options.intrinsic_qc, outlier_threshold: config.eventThreshold },
  };
  delete options.assume_one_observation_per_sample;
  delete options.seed;
  if (config.assumeOneObservationPerSample) options.assume_one_observation_per_sample = true;
  if (config.seed !== null) options.seed = config.seed;
  options.clustering = { subsample_refit: config.clusterRefit };
  options.domain_shift = { ...options.domain_shift, energy_on_spectra: config.fullSpectrumEnergy, monitor_on_spectra: config.fullSpectrumMonitor };
  if (config.quasiToleranceFromRepeats || config.quasiTolerance === null) delete options.quasi_duplicates;
  else options.quasi_duplicates = { ...input.options.quasi_duplicates, tolerance: config.quasiTolerance };
  return { ...input, options };
}

/** Number of declared samples carrying an `independence_group` (display hint for the "group" unit). */
export function countIndependenceGroups(input: EngineInput): number {
  return input.samples.filter((s) => typeof s.independence_group === "string" && s.independence_group !== "").length;
}
