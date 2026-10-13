// Display joins between the canonical input and engine results. No statistics: rows are
// selected, labelled and coloured; every number shown comes from the input or the engine.
import type { PcaStructure, ScorePoint, TargetPoint } from "nirs4all-ui/qualification";
import type { EngineInput, InputSample, InputSource } from "./input";

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

/** Exact reference value of a real development sample for one target (null otherwise). Test Y is never read. */
export function developmentTargetValues(input: EngineInput, targetId: string): Map<string, number> {
  const samples = sampleIndex(input);
  const target = input.targets.find((t) => t.target_id === targetId);
  const out = new Map<string, number>();
  for (const v of target?.values ?? []) {
    if (v.status === "exact" && typeof v.value === "number" && Number.isFinite(v.value) && rowKind(samples, v.sample_id) === "development") out.set(v.sample_id, v.value);
  }
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

export function spectraPreview(input: EngineInput, source: InputSource, max: number): SpectraPreview {
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
    if (rows.length < max) rows.push({ index: i, observationId: source.observation_ids[i] ?? String(i), sampleId, values, complete });
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

export type PcaColorBy = "none" | "target" | "campaign" | "instrument";

/**
 * Score points joined to declared metadata. A unit is coloured by a target value only when its
 * representative sample is the single development sample of its physical × instrument × campaign key.
 */
export function pcaPoints(input: EngineInput, pca: PcaStructure, xi: number, yi: number, colorBy: PcaColorBy, targetId: string | null): ScorePoint[] {
  const samples = sampleIndex(input);
  const values = targetId ? developmentTargetValues(input, targetId) : new Map<string, number>();
  const keyOf = (s: InputSample) => `${s.physical_sample_id ?? s.sample_id}|${s.instrument ?? ""}|${s.campaign ?? ""}`;
  const members = new Map<string, number>();
  for (const s of input.samples) if (rowKind(samples, s.sample_id) === "development") members.set(keyOf(s), (members.get(keyOf(s)) ?? 0) + 1);
  return pca.sampleIds.map((id, i) => {
    const s = samples.get(id);
    const row = pca.scores[i] ?? [];
    const single = s ? members.get(keyOf(s)) === 1 : false;
    const point: ScorePoint = {
      id,
      x: row[xi] ?? Number.NaN,
      y: row[yi] ?? Number.NaN,
      details: [pca.aggregationKeys[i] ?? "", s?.instrument ? `instrument: ${s.instrument}` : "", s?.campaign ? `campaign: ${s.campaign}` : ""].filter(Boolean),
    };
    if (colorBy === "campaign") point.group = s?.campaign ?? null;
    if (colorBy === "instrument") point.group = s?.instrument ?? null;
    if (colorBy === "target") point.value = single ? (values.get(id) ?? null) : null;
    return point;
  });
}
