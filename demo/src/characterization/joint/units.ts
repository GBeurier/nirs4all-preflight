// Independence units of the metadata–target association, mirrored from the engine (read-only sources):
// - crates/nirs4all-preflight-core/src/lib.rs `metadata_factors`, `metadata_value`, `independence_components`
//   (union-find over every identity link: sample, physical sample, individual, augmentation parent, declared group
//   when it is the unit, and the target's reference groups);
// - crates/nirs4all-preflight/src/lib.rs `exact_development_references` (development partition, no augmentation,
//   exact status, one consistent value per sample);
// - crates/nirs4all-preflight/src/association.rs `build_units` and `analyze_pair` (one row per unit with a constant
//   metadata value and a homogeneous target).
// The engine report carries per-level summaries only; these rows feed the per-unit plots. The caller compares the
// local denominators with the engine's and labels any mismatch (debt: docs/implementation/debt/characterization-joint.md).
//
// Retained-test protection: target values (`value`, `category`) are read only after the sample is known to be a
// non-augmented development sample with an exact reference. Identity fields (sample id, reference group) are read
// for every row, as the engine does.
import type { EngineInput, InputSample, InputTarget, InputTargetValue } from "../../input";

export type FactorKind = "categorical" | "continuous";

export interface Factor {
  name: string;
  kind: FactorKind;
  unit: string | null;
  /** "sample_field" (instrument, campaign) or "declared" (metadata column). */
  origin: "sample_field" | "declared";
}

const SAMPLE_FIELDS = ["instrument", "campaign"] as const;

/** Analysed metadata factors in the engine order: sample fields, then declared columns; roles other than analysis are dropped. */
export function metadataFactors(input: EngineInput): Factor[] {
  const roles = input.options.metadata_roles ?? {};
  const all: Factor[] = [
    ...SAMPLE_FIELDS.map((name) => ({ name, kind: "categorical" as const, unit: null, origin: "sample_field" as const })),
    ...(input.metadata?.columns ?? []).map((c) => ({ name: c.name, kind: c.kind, unit: c.unit ?? null, origin: "declared" as const })),
  ];
  return all.filter((f) => (roles[f.name] ?? "analysis") === "analysis");
}

export type MetadataValue = { kind: "level"; level: string } | { kind: "value"; value: number };

/** Value of `factor` for `sample` (engine `metadata_value`); null when missing or of the wrong JSON type. */
export function metadataValue(input: EngineInput, factor: Factor, sample: InputSample): MetadataValue | null {
  if (factor.origin === "sample_field") {
    const v = factor.name === "instrument" ? sample.instrument : factor.name === "campaign" ? sample.campaign : undefined;
    return typeof v === "string" ? { kind: "level", level: v } : null;
  }
  const v = input.metadata?.values[sample.sample_id]?.[factor.name];
  if (factor.kind === "categorical" && typeof v === "string") return { kind: "level", level: v };
  if (factor.kind === "continuous" && typeof v === "number" && Number.isFinite(v)) return { kind: "value", value: v + 0 };
  return null;
}

const sameValue = (a: MetadataValue, b: MetadataValue) => (a.kind === "level" ? b.kind === "level" && a.level === b.level : b.kind === "value" && Object.is(a.value + 0, b.value + 0));

/** For each sample index, the smallest sample index of its identity component (engine `independence_components`). */
export function identityComponents(input: EngineInput, targets: readonly InputTarget[]): number[] {
  const parent = input.samples.map((_, i) => i);
  const root = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const first = new Map<string, number>();
  const link = (key: string, i: number) => {
    const j = first.get(key);
    if (j === undefined) first.set(key, i);
    else {
      const a = root(i);
      const b = root(j);
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  };
  const groups = input.options.independence_unit === "group";
  input.samples.forEach((s, i) => {
    link(`s\u0000${s.sample_id}`, i);
    if (s.physical_sample_id !== undefined) link(`p\u0000${s.physical_sample_id}`, i);
    if (s.individual_id !== undefined) link(`i\u0000${s.individual_id}`, i);
    if (s.augmentation_parent_id !== undefined) link(`s\u0000${s.augmentation_parent_id}`, i);
    if (groups && s.independence_group !== undefined) link(`g\u0000${s.independence_group}`, i);
  });
  const index = new Map(input.samples.map((s, i) => [s.sample_id, i]));
  for (const t of targets) {
    for (const v of t.values) {
      const i = index.get(v.sample_id);
      if (v.reference_group_id !== undefined && v.reference_group_id !== null && i !== undefined) link(`r\u0000${t.target_id}\u0000${v.reference_group_id}`, i);
    }
  }
  return parent.map((_, i) => root(i));
}

export type TargetLabel = { kind: "value"; value: number } | { kind: "class"; label: string };

export interface EligibleReference {
  sampleId: string;
  label: TargetLabel;
}

export interface ExactReferences {
  /** Sorted by sample id. */
  eligible: EligibleReference[];
  excludedRetainedPredictionOrAugmented: number;
  excludedCensored: number;
  excludedComposite: number;
  inconsistent: number;
}

/** True when a target value of this sample may be read (non-augmented development sample). */
export function targetReadable(sample: InputSample | undefined): boolean {
  return !!sample && (sample.partition ?? "development") === "development" && sample.augmentation_parent_id === undefined;
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Engine `exact_development_references`: target values never read outside non-augmented development samples. */
export function exactDevelopmentReferences(target: InputTarget, samples: ReadonlyMap<string, InputSample>): ExactReferences {
  const out: ExactReferences = { eligible: [], excludedRetainedPredictionOrAugmented: 0, excludedCensored: 0, excludedComposite: 0, inconsistent: 0 };
  const bySample = new Map<string, InputTargetValue[]>();
  for (const v of target.values) {
    if (!targetReadable(samples.get(v.sample_id))) {
      out.excludedRetainedPredictionOrAugmented += 1;
      continue;
    }
    if (v.status === "exact") bySample.set(v.sample_id, [...(bySample.get(v.sample_id) ?? []), v]);
    else if (v.status === "censored") out.excludedCensored += 1;
    else out.excludedComposite += 1;
  }
  for (const id of [...bySample.keys()].sort(byteOrder)) {
    const values = bySample.get(id)!;
    const labels: TargetLabel[] = values.map((v) => (target.kind === "continuous" ? { kind: "value", value: (v.value ?? 0) + 0 } : { kind: "class", label: v.category ?? "" }));
    const keys = new Set(labels.map(labelKey));
    if (keys.size === 1) out.eligible.push({ sampleId: id, label: labels[0]! });
    else out.inconsistent += 1;
  }
  return out;
}

const labelKey = (l: TargetLabel) => (l.kind === "value" ? `v${Object.is(l.value, -0) ? 0 : l.value}` : `c${l.label}`);

export interface AssociationUnit {
  /** Eligible member samples (sorted). */
  sampleIds: string[];
  /** Homogeneous target of the unit; null when it varies within the unit. */
  target: TargetLabel | null;
}

export interface TargetUnits {
  targetId: string;
  kind: "continuous" | "categorical";
  unit: string | null;
  units: AssociationUnit[];
  nEligibleSamples: number;
  nTargetVaries: number;
  references: ExactReferences;
}

/** Engine `build_units`: identity components of the eligible development references, ordered by their smallest sample id. */
export function targetUnits(input: EngineInput, targetId: string): TargetUnits | null {
  const target = input.targets.find((t) => t.target_id === targetId);
  if (!target) return null;
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const references = exactDevelopmentReferences(target, samples);
  const component = identityComponents(input, [target]);
  const index = new Map(input.samples.map((s, i) => [s.sample_id, i]));
  const members = new Map<number, number[]>();
  references.eligible.forEach((r, i) => {
    const c = component[index.get(r.sampleId)!]!;
    members.set(c, [...(members.get(c) ?? []), i]);
  });
  const groups = [...members.values()].sort((a, b) => a[0]! - b[0]!);
  let nTargetVaries = 0;
  const units = groups.map((rows) => {
    const labels = rows.map((i) => references.eligible[i]!.label);
    const homogeneous = labels.every((l) => labelKey(l) === labelKey(labels[0]!));
    if (!homogeneous) nTargetVaries += 1;
    return { sampleIds: rows.map((i) => references.eligible[i]!.sampleId), target: homogeneous ? labels[0]! : null };
  });
  return { targetId, kind: target.kind, unit: target.unit ?? null, units, nEligibleSamples: references.eligible.length, nTargetVaries, references };
}

export interface AssociationRow {
  sampleIds: string[];
  metadata: MetadataValue;
  target: TargetLabel;
}

export interface AssociationRows {
  factor: Factor;
  rows: AssociationRow[];
  /** Same keys as the engine denominators of `association.metadata_target`. */
  denominators: {
    n_eligible_samples: number;
    n_independence_units: number;
    n_units_analyzed: number;
    n_units_missing_metadata: number;
    n_units_metadata_varies_within_unit: number;
    n_units_target_varies_within_unit: number;
  };
}

/** Engine `analyze_pair` rows: units whose metadata is present and constant and whose target is homogeneous. */
export function associationRows(input: EngineInput, units: TargetUnits, factor: Factor): AssociationRows {
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  let missing = 0;
  let varies = 0;
  const rows: AssociationRow[] = [];
  for (const u of units.units) {
    const values = u.sampleIds.map((id) => metadataValue(input, factor, samples.get(id)!));
    if (values.some((v) => v === null)) {
      missing += 1;
      continue;
    }
    const vs = values as MetadataValue[];
    if (vs.some((v) => !sameValue(v, vs[0]!))) {
      varies += 1;
      continue;
    }
    if (u.target) rows.push({ sampleIds: u.sampleIds, metadata: vs[0]!, target: u.target });
  }
  return {
    factor,
    rows,
    denominators: {
      n_eligible_samples: units.nEligibleSamples,
      n_independence_units: units.units.length,
      n_units_analyzed: rows.length,
      n_units_missing_metadata: missing,
      n_units_metadata_varies_within_unit: varies,
      n_units_target_varies_within_unit: units.nTargetVaries,
    },
  };
}

/** Per-sample readable target labels (development, exact, consistent): used by the scenario audit. */
export function readableTargetLabels(input: EngineInput, targetId: string): Map<string, TargetLabel> {
  const target = input.targets.find((t) => t.target_id === targetId);
  if (!target) return new Map();
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  return new Map(exactDevelopmentReferences(target, samples).eligible.map((r) => [r.sampleId, r.label]));
}
