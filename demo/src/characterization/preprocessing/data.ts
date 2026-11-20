// Explorer input: a deterministic, immutable copy of complete spectra from one source.
import type { EngineInput } from "../../input";
import { developmentRows } from "../repeatability/profiles";
import { axisStep, type Matrix } from "./metrics";

const TECHNICAL = new Set(["rescan", "repositioning", "repreparation"]);

/**
 * Replicate-group key per row, as the engine's `analyze_repeats` builds groups: development rows
 * declaring a technical repeat type, grouped by (type, instrument, campaign, physical sample id,
 * else sample id). Other rows get null (their own group), so undeclared, biological or unknown repeats
 * never count as technical repeatability.
 */
export function replicateKeys(input: EngineInput, source: EngineInput["sources"][number]): (string | null)[] {
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const dev = new Set(developmentRows(input, source));
  const types = source.repetition_types;
  return source.sample_ids.map((id, r) => {
    const s = samples.get(id);
    const type = types?.[r];
    if (!s || !dev.has(r) || !type || !TECHNICAL.has(type)) return null;
    return JSON.stringify([type, s.instrument ?? "", s.campaign ?? "", s.physical_sample_id ?? s.sample_id]);
  });
}

/** Spectra processed in the interactive view (and benchmark); stated in the UI. */
export const EXPLORER_SPECTRA_CAP = 300;

export interface ExplorerData {
  sourceId: string;
  /** Raw spectra copied from the input (never the input's own arrays). */
  matrix: Matrix;
  axis: number[];
  axisUnit: string;
  signalUnit: string;
  /** Signed median axis step (negative for a descending axis); null when not defined. */
  step: number | null;
  irregularAxis: boolean;
  observationIds: string[];
  sampleIds: string[];
  /** Integer replicate group per row (declared technical repeats only, see `replicateKeys`). */
  groups: number[];
  /** Technical replicate groups with ≥ 2 rows in the subset. */
  replicatedSamples: number;
  /** Rows in the source, complete rows (every band finite and valid), rows used. */
  counts: { total: number; complete: number; used: number };
}

const complete = (x: readonly (number | null)[], mask: readonly boolean[] | undefined, p: number) =>
  x.length === p && x.every((v, j) => v !== null && Number.isFinite(v) && (mask ? mask[j] !== false : true));

/**
 * Deterministic subset of at most `cap` rows. Whole sample groups are kept together (replicates stay
 * paired), taken at evenly spaced positions in first-appearance order; no random draw.
 */
export function sampleRows(rows: readonly number[], sampleIds: readonly string[], cap: number): number[] {
  if (rows.length <= cap) return [...rows];
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = sampleIds[r] ?? `#${r}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const list = [...groups.values()];
  const target = Math.max(1, Math.round((list.length * cap) / rows.length));
  const chosen: number[] = [];
  for (let k = 0; k < target; k++) {
    const g = list[Math.floor((k * list.length) / target)]!;
    if (chosen.length && chosen.length + g.length > cap) break;
    chosen.push(...g.slice(0, cap));
  }
  return chosen.sort((a, b) => a - b);
}

export function prepareExplorerData(input: EngineInput, sourceId: string | null, cap = EXPLORER_SPECTRA_CAP): ExplorerData | null {
  const source = input.sources.find((s) => s.source_id === sourceId) ?? input.sources[0];
  if (!source || source.axis.length < 5) return null;
  const p = source.axis.length;
  const completeRows = source.x.map((x, i) => (complete(x, source.valid_mask?.[i], p) ? i : -1)).filter((i) => i >= 0);
  const keys = replicateKeys(input, source);
  // Sampling keeps sample-level groups together, and technical replicate groups (keyed apart).
  const sampling = source.sample_ids.map((id, r) => keys[r] ?? id);
  const used = sampleRows(completeRows, sampling, cap);
  if (used.length < 2) return null;
  const data = new Float64Array(used.length * p);
  used.forEach((r, i) => data.set(source.x[r] as number[], i * p));
  const sampleIds = used.map((r) => source.sample_ids[r] ?? "");
  const code = new Map<string, number>();
  const groups = used.map((r) => keys[r] ?? `row:${r}`).map((s) => code.get(s) ?? (code.set(s, code.size), code.size - 1));
  const sizes = new Map<number, number>();
  for (const g of groups) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  const { step: spacing, irregular } = axisStep(source.axis);
  // Signed: a derivative is taken with respect to the axis, so a descending axis flips d/dλ.
  const step = spacing !== null && source.axis[p - 1]! < source.axis[0]! ? -spacing : spacing;
  return {
    sourceId: source.source_id,
    matrix: { data, rows: used.length, cols: p },
    axis: [...source.axis],
    axisUnit: source.axis_unit ?? "",
    signalUnit: source.signal_unit ?? "",
    step,
    irregularAxis: irregular,
    observationIds: used.map((r) => source.observation_ids[r] ?? String(r)),
    sampleIds,
    groups,
    replicatedSamples: [...sizes.values()].filter((n) => n >= 2).length,
    counts: { total: source.x.length, complete: completeRows.length, used: used.length },
  };
}

/** Fixed diagnostic parameters, identical before and after preprocessing. */
export interface DiagnosticSettings {
  eventThreshold: number;
  eventMinSpectra: number;
  noiseWindow: number;
  noisePolyorder: number;
}

export function diagnosticSettings(input: EngineInput): DiagnosticSettings {
  const qc = input.options.intrinsic_qc ?? {};
  const np = (input.options as { noise_proxy?: { window_bands?: number; polyorder?: number } }).noise_proxy ?? {};
  return {
    eventThreshold: typeof qc.outlier_threshold === "number" ? qc.outlier_threshold : 8,
    eventMinSpectra: 5,
    noiseWindow: np.window_bands ?? 11,
    noisePolyorder: np.polyorder ?? 2,
  };
}
