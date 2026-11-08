// Display joins between the canonical input and engine results. No statistics: rows are
// selected, labelled and coloured; every number shown comes from the input or the engine.
import { extractIntrinsic, type IntrinsicSignal, type PcaStructure, type QualificationReportView, type ScorePoint, type TargetPoint } from "nirs4all-ui/qualification";
import { metadataColumns, metadataValue, type EngineInput, type InputSample, type InputSource } from "./input";

export type RowKind = "development" | "augmented" | "retained_test" | "prediction" | "undeclared";
export const ROW_KINDS: readonly RowKind[] = ["development", "augmented", "retained_test", "prediction", "undeclared"];

export function sampleIndex(input: EngineInput): Map<string, InputSample> {
  return new Map(input.samples.map((s) => [s.sample_id, s]));
}

export function rowKind(samples: Map<string, InputSample>, sampleId: string): RowKind {
  const s = samples.get(sampleId);
  if (!s) return "undeclared";
  const partition = s.partition ?? "development";
  return partition === "development" && s.augmentation_parent_id ? "augmented" : partition;
}

/**
 * Exact reference value of each real development sample for one target, for the samples the engine
 * keeps as eligible: a sample whose exact references disagree has none. Test Y is never read.
 */
export function developmentTargetValues(input: EngineInput, targetId: string): Map<string, number> {
  const samples = sampleIndex(input);
  const target = input.targets.find((t) => t.target_id === targetId);
  const out = new Map<string, number>();
  const conflicting = new Set<string>();
  for (const v of target?.values ?? []) {
    if (v.status !== "exact" || typeof v.value !== "number" || !Number.isFinite(v.value) || rowKind(samples, v.sample_id) !== "development") continue;
    const previous = out.get(v.sample_id);
    if (previous !== undefined && !Object.is(previous, v.value)) conflicting.add(v.sample_id);
    out.set(v.sample_id, v.value);
  }
  for (const id of conflicting) out.delete(id);
  return out;
}

/** Raw declared reference values of real development samples (exact, censored, composite). */
export function developmentTargetPoints(input: EngineInput, targetId: string): TargetPoint[] {
  const samples = sampleIndex(input);
  const target = input.targets.find((t) => t.target_id === targetId);
  return (target?.values ?? []).flatMap((v) =>
    rowKind(samples, v.sample_id) === "development" && typeof v.value === "number" && Number.isFinite(v.value)
      ? [{ id: v.sample_id, value: v.value, status: v.status }]
      : []);
}

export interface SpectraPreview {
  /** drawn rows: real development rows in file order (incomplete ones keep their gaps), at most `max` */
  rows: { index: number; observationId: string; sampleId: string; values: (number | null)[]; complete: boolean }[];
  /** real development rows available to draw */
  drawable: number;
  incompleteDevelopment: number;
  counts: Record<RowKind, number>;
}

/** Development rows in input order, at most `max` plus every row listed in `keep` (atypical scans stay drawn). */
export function spectraPreview(input: EngineInput, source: InputSource, max: number, keep?: ReadonlySet<string>): SpectraPreview {
  const samples = sampleIndex(input);
  const counts = Object.fromEntries(ROW_KINDS.map((k) => [k, 0])) as Record<RowKind, number>;
  const rows: SpectraPreview["rows"] = [];
  let incompleteDevelopment = 0;
  source.x.forEach((row, i) => {
    const sampleId = source.sample_ids[i] ?? "";
    const kind = rowKind(samples, sampleId);
    counts[kind] += 1;
    if (kind !== "development") return;
    const mask = source.valid_mask?.[i];
    const values = row.map((v, j) => (v !== null && Number.isFinite(v) && (mask?.[j] ?? true) ? v : null));
    const complete = values.every((v) => v !== null);
    if (!complete) incompleteDevelopment += 1;
    const observationId = source.observation_ids[i] ?? String(i);
    if (rows.length < max || keep?.has(observationId)) rows.push({ index: i, observationId, sampleId, values, complete });
  });
  return { rows, drawable: counts.development, incompleteDevelopment, counts };
}

export interface CountRow { label: string; count: number }

/** Declared composition of the samples (counts only): partitions, instruments, campaigns, observations per sample. */
export interface Composition {
  partitions: Record<RowKind, number>;
  instruments: CountRow[];
  campaigns: CountRow[];
  /** samples with 1, 2, 3+ observations in the source (declared samples with 0 are counted apart) */
  repeats: { one: number; two: number; more: number; none: number };
}

const UNDECLARED = "\u2014";

function tally(values: (string | undefined)[]): CountRow[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v || UNDECLARED, (m.get(v || UNDECLARED) ?? 0) + 1);
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));
}

export function composition(input: EngineInput, source: InputSource | undefined): Composition {
  const samples = sampleIndex(input);
  const partitions = Object.fromEntries(ROW_KINDS.map((k) => [k, 0])) as Record<RowKind, number>;
  for (const s of input.samples) partitions[rowKind(samples, s.sample_id)] += 1;
  const perSample = new Map<string, number>();
  for (const id of source?.sample_ids ?? []) perSample.set(id, (perSample.get(id) ?? 0) + 1);
  const repeats = { one: 0, two: 0, more: 0, none: 0 };
  for (const s of input.samples) {
    const n = perSample.get(s.sample_id) ?? 0;
    if (n === 0) repeats.none += 1;
    else if (n === 1) repeats.one += 1;
    else if (n === 2) repeats.two += 1;
    else repeats.more += 1;
  }
  return {
    partitions,
    instruments: tally(input.samples.map((s) => s.instrument)),
    campaigns: tally(input.samples.map((s) => s.campaign)),
    repeats,
  };
}

export interface SampleRow {
  sampleId: string;
  kind: RowKind;
  instrument: string | null;
  campaign: string | null;
  observations: number;
  incomplete: number;
  /** declared reference of real development samples only; retained-test/prediction values are never read */
  targets: Record<string, { value: number | string | null; status: string } | "hidden">;
}

export function sampleRows(input: EngineInput, source: InputSource | undefined): SampleRow[] {
  const samples = sampleIndex(input);
  const obs = new Map<string, { n: number; incomplete: number }>();
  source?.x.forEach((row, i) => {
    const id = source.sample_ids[i] ?? "";
    const entry = obs.get(id) ?? { n: 0, incomplete: 0 };
    entry.n += 1;
    if (!row.every((v, j) => v !== null && Number.isFinite(v) && (source.valid_mask?.[i]?.[j] ?? true))) entry.incomplete += 1;
    obs.set(id, entry);
  });
  const refs = new Map<string, Map<string, { value: number | string | null; status: string }>>();
  for (const t of input.targets) {
    const m = new Map<string, { value: number | string | null; status: string }>();
    for (const v of t.values) m.set(v.sample_id, { value: t.kind === "categorical" ? (v.category ?? null) : (v.value ?? null), status: v.status });
    refs.set(t.target_id, m);
  }
  return input.samples.map((s) => {
    const kind = rowKind(samples, s.sample_id);
    const targets: SampleRow["targets"] = {};
    for (const t of input.targets) targets[t.target_id] = kind === "development" ? (refs.get(t.target_id)?.get(s.sample_id) ?? { value: null, status: "missing" }) : "hidden";
    return {
      sampleId: s.sample_id,
      kind,
      instrument: s.instrument ?? null,
      campaign: s.campaign ?? null,
      observations: obs.get(s.sample_id)?.n ?? 0,
      incomplete: obs.get(s.sample_id)?.incomplete ?? 0,
      targets,
    };
  });
}

export type PcaColorBy = "none" | "target" | "quality" | "campaign" | "instrument" | `metadata:${string}`;
export interface QualityColoring { flagged: ReadonlySet<string>; typical: string; atypical: string }

/** Exact, consistent calibration references only. Retained-test Y is never used. */
export function targetColorValues(input: EngineInput, targetId: string): Map<string, number | string> {
  const samples = sampleIndex(input);
  const target = input.targets.find((t) => t.target_id === targetId);
  const values = new Map<string, number | string>();
  const conflicts = new Set<string>();
  for (const v of target?.values ?? []) {
    const value = target?.kind === "categorical" ? v.category : v.value;
    if (v.status !== "exact" || value == null || (typeof value === "number" && !Number.isFinite(value)) || rowKind(samples, v.sample_id) !== "development") continue;
    if (values.has(v.sample_id) && values.get(v.sample_id) !== value) conflicts.add(v.sample_id);
    values.set(v.sample_id, value);
  }
  for (const id of conflicts) values.delete(id);
  return values;
}

/** Only varying, selected metadata appears in visual controls. */
export function varyingMetadata(input: EngineInput) {
  return metadataColumns(input).filter((c) =>
    (input.options.metadata_roles?.[c.name] ?? "analysis") === "analysis"
    && new Set(input.samples.filter((s) => (s.partition ?? "development") === "development" && !s.augmentation_parent_id).map((s) => metadataValue(input, s.sample_id, c.name, s)).filter((v) => v !== null)).size > 1);
}

export function pcaPoints(input: EngineInput, pca: PcaStructure, xi: number, yi: number, colorBy: PcaColorBy, targetId: string | null, quality?: QualityColoring): ScorePoint[] {
  const samples = sampleIndex(input);
  const values = targetId ? targetColorValues(input, targetId) : new Map<string, number | string>();
  // This matches the engine's physical × instrument × campaign aggregation, with collision-safe keys.
  const keyOf = (s: InputSample) => JSON.stringify([s.physical_sample_id ?? s.sample_id, s.instrument ?? "", s.campaign ?? ""]);
  const members = new Map<string, InputSample[]>();
  for (const s of input.samples) if (rowKind(samples, s.sample_id) === "development") {
    const key = keyOf(s);
    members.set(key, [...(members.get(key) ?? []), s]);
  }
  const name = colorBy.startsWith("metadata:") ? colorBy.slice(9) : colorBy;
  const continuous = colorBy === "target" ? input.targets.find((t) => t.target_id === targetId)?.kind === "continuous" : metadataColumns(input).find((c) => c.name === name)?.kind === "continuous";
  const points = pca.sampleIds.map((id, i) => {
    const sample = samples.get(id);
    const unit = sample ? members.get(keyOf(sample)) ?? [] : [];
    const row = pca.scores[i] ?? [];
    const point: ScorePoint = { id, x: row[xi] ?? Number.NaN, y: row[yi] ?? Number.NaN, details: [pca.aggregationKeys[i] ?? ""] };
    if (colorBy === "quality" && quality) point.group = unit.some((s) => quality.flagged.has(s.sample_id)) ? quality.atypical : quality.typical;
    else if (colorBy !== "none") {
      const unitValues = unit.map((s) => colorBy === "target" ? values.get(s.sample_id) ?? null : metadataValue(input, s.sample_id, name, s));
      const value = unitValues.length && unitValues.every((v) => v !== null && v === unitValues[0]) ? unitValues[0] : null;
      if (continuous) point.value = typeof value === "number" ? value : null;
      else point.group = value === null || value === undefined ? null : String(value);
    }
    return point;
  });
  return colorBy === "quality" && quality ? [...points.filter((p) => p.group === quality.typical), ...points.filter((p) => p.group !== quality.typical)] : points;
}

/**
 * Development spectra beyond the engine's 95th percentile of in-sample T² or Q, most atypical first.
 * Each statistic is compared with its own percentile, so a degenerate one (e.g. Q = 0 everywhere) flags nothing alone.
 */
export interface AtypicalSpectrum { sampleId: string; observationId: string; t2: number; q: number; ratio: number }
export function atypicalSpectra(t2: IntrinsicSignal, q: IntrinsicSignal): AtypicalSpectrum[] {
  if (t2.p95 === null || q.p95 === null) return [];
  const excess = (value: number, p95: number) => (value <= p95 ? 0 : p95 > 0 ? value / p95 : Number.POSITIVE_INFINITY);
  const out: AtypicalSpectrum[] = [];
  t2.values.forEach((value, i) => {
    const residual = q.values[i];
    if (value === null || residual === null || residual === undefined) return;
    const ratio = Math.max(excess(value, t2.p95!), excess(residual, q.p95!));
    if (ratio > 0) out.push({ sampleId: t2.sampleIds[i] ?? "", observationId: t2.observationIds[i] ?? "", t2: value, q: residual, ratio });
  });
  return out.sort((a, b) => b.ratio - a.ratio);
}

/** T²/Q outcome of a source's development scans: the observations evaluated and those flagged. */
export interface QualityScan { evaluated: ReadonlySet<string>; atypical: AtypicalSpectrum[] }

/** Atypical development scans of a source; null until the report carries computed T² and Q. */
export function atypicalScans(view: QualificationReportView, sourceId: string): QualityScan | null {
  const intrinsic = extractIntrinsic(view, sourceId);
  const t2 = intrinsic?.signals["pca.pca_t2"];
  const q = intrinsic?.signals["pca.pca_q"];
  if (t2?.state.status !== "computed" || q?.state.status !== "computed") return null;
  const evaluated = new Set(t2.observationIds.filter((_, i) => t2.values[i] !== null && q.values[i] !== null && q.values[i] !== undefined));
  return { evaluated, atypical: atypicalSpectra(t2, q) };
}
