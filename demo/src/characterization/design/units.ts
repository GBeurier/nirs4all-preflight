// Independence-unit coordinates of the confounding analysis, rebuilt in the demo because the engine report
// does not publish them (interim, Preflight engine debt: docs/implementation/debt/characterization-design.md).
// Mirrors crates/nirs4all-preflight/src/confounding.rs `build_units` and nirs4all-preflight-core
// `independence_components`: union-find over every identity link (sample, physical sample, individual,
// augmentation parent, independence group when it is the declared unit, reference groups of every target),
// projected onto the rows of the published canonical PCA scores (`structure.pca_scores`); a unit's coordinate is
// the mean of its rows' scores; units with a missing level or a level that varies inside the unit are excluded;
// units are ordered by their first row. Level codes follow the engine's level order (confounding.design).
//
// Per-unit distances to the level centroids then come from the Methods PERMDISP kernel (`statsPermdisp`, the
// engine's own kernel, run without permutations). The caller compares unit counts and per-level mean distances
// with the engine values and withholds the local values on any mismatch.
//
// Retained-test protection: only identity fields of target values (`reference_group_id`) are read, never Y.
import type { QualificationReportView } from "nirs4all-ui/qualification";
import { metadataValue, type EngineInput } from "../../input";
import type { DesignModel } from "./model";

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Smallest sample index of each sample's identity component (mirror of `identity_components`). */
export function identityComponents(input: EngineInput): number[] {
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
    if (j === undefined) {
      first.set(key, i);
      return;
    }
    const a = root(i);
    const b = root(j);
    parent[Math.max(a, b)] = Math.min(a, b);
  };
  const groups = input.options.independence_unit === "group";
  input.samples.forEach((s, i) => {
    link(`s\u0000${s.sample_id}`, i);
    if (s.physical_sample_id != null) link(`p\u0000${s.physical_sample_id}`, i);
    if (s.individual_id != null) link(`i\u0000${s.individual_id}`, i);
    if (s.augmentation_parent_id != null) link(`s\u0000${s.augmentation_parent_id}`, i);
    if (groups && s.independence_group != null) link(`g\u0000${s.independence_group}`, i);
  });
  const index = new Map(input.samples.map((s, i) => [s.sample_id, i]));
  for (const t of input.targets) {
    for (const v of t.values) {
      const i = index.get(v.sample_id);
      if (v.reference_group_id != null && i !== undefined) link(`r\u0000${t.target_id}\u0000${v.reference_group_id}`, i);
    }
  }
  return parent.map((_, i) => root(i));
}

export interface DesignUnits {
  /** Mean canonical PCA scores per analysed unit (engine unit order). */
  coordinates: number[][];
  /** Level of each declared factor, per analysed unit. */
  levels: Record<string, string>[];
  /** Sample ids of each analysed unit. */
  members: string[][];
  nUnits: number;
  nMissing: number;
  nVaries: number;
  scoreColumns: number;
}

export type UnitsResult = { ok: true; units: DesignUnits } | { ok: false; reason: "NO_SCORES" | "COUNT_MISMATCH" | "LEVEL_MISMATCH" };

export function designUnits(view: QualificationReportView, input: EngineInput, model: DesignModel): UnitsResult {
  const scoresMetric = view.metrics.find((m) => m.id === "structure.pca_scores" && m.sourceId === model.sourceId && m.status === "computed");
  const sv = rec(scoresMetric?.value);
  const sampleIds = Array.isArray(sv.sample_ids) ? (sv.sample_ids as string[]) : null;
  const scores = Array.isArray(sv.scores) ? (sv.scores as number[][]) : null;
  if (!sampleIds || !scores || sampleIds.length !== scores.length || !scores.length) return { ok: false, reason: "NO_SCORES" };
  const component = identityComponents(input);
  const index = new Map(input.samples.map((s, i) => [s.sample_id, i]));
  const byId = new Map(input.samples.map((s) => [s.sample_id, s]));
  const members = new Map<number, number[]>();
  sampleIds.forEach((id, row) => {
    const i = index.get(id);
    if (i === undefined) return;
    const c = component[i]!;
    const list = members.get(c);
    if (list) list.push(row);
    else members.set(c, [row]);
  });
  const units = [...members.values()].sort((a, b) => a[0]! - b[0]!);
  const factors = model.factors.map((f) => f.factor);
  const out: DesignUnits = { coordinates: [], levels: [], members: [], nUnits: units.length, nMissing: 0, nVaries: 0, scoreColumns: scores[0]!.length };
  unit: for (const rows of units) {
    const levels: Record<string, string> = {};
    for (const f of factors) {
      const values = rows.map((r) => {
        const v = metadataValue(input, sampleIds[r]!, f, byId.get(sampleIds[r]!));
        return v === null || v === undefined ? null : String(v);
      });
      if (values.some((v) => v === null)) {
        out.nMissing++;
        continue unit;
      }
      const distinct = new Set(values as string[]);
      if (distinct.size > 1) {
        out.nVaries++;
        continue unit;
      }
      levels[f] = values[0]!;
    }
    const k = scores[rows[0]!]!.length;
    const mean = new Array<number>(k).fill(0);
    rows.forEach((r, count) => {
      for (let j = 0; j < k; j++) mean[j]! += (scores[r]![j]! - mean[j]!) / (count + 1);
    });
    out.coordinates.push(mean);
    out.levels.push(levels);
    out.members.push(rows.map((r) => sampleIds[r]!));
  }
  if (out.coordinates.length !== model.nUnitsAnalyzed || out.nUnits !== model.nIndependenceUnits) return { ok: false, reason: "COUNT_MISMATCH" };
  for (const f of model.factors) {
    for (const l of f.levels) {
      if (l.nUnits !== null && out.levels.filter((u) => u[f.factor] === l.level).length !== l.nUnits) return { ok: false, reason: "LEVEL_MISMATCH" };
    }
  }
  return { ok: true, units: out };
}

type Methods = typeof import("@nirs4all/methods");

export interface FactorDistances {
  factor: string;
  /** Distance of each analysed unit to its level centroid (engine unit order). */
  distances: number[];
  codes: number[];
  levels: string[];
  groupMeans: number[];
  /** Local per-level means agree with the engine's `mean_distance_to_centroid`. */
  matchesEngine: boolean;
}

export const DISTANCE_TOLERANCE = 1e-9;

/** Methods PERMDISP (no permutation) on the rebuilt unit coordinates of one factor. */
export function factorDistances(m: Methods, units: DesignUnits, model: DesignModel, factor: string): FactorDistances | null {
  const f = model.factors.find((x) => x.factor === factor);
  if (!f || !f.varying) return null;
  const levels = f.levels.map((l) => l.level);
  const codes = units.levels.map((u) => levels.indexOf(u[factor]!));
  if (codes.some((c) => c < 0)) return null;
  const n = units.coordinates.length;
  const k = units.scoreColumns;
  const data = new Float64Array(n * k);
  units.coordinates.forEach((row, i) => data.set(row, i * k));
  const r = m.statsPermdisp({ data, rows: n, cols: k }, codes, 0, 0);
  const scale = 2 ** r.distanceExponent;
  const distances = Array.from(r.distances, (d) => d * scale);
  const groupMeans = Array.from(r.groupMeanDistances, (d) => d * scale);
  const engine = f.dispersion?.levels ?? [];
  const engineScale = 2 ** (f.dispersion?.distanceExponent ?? 0);
  const matchesEngine = engine.length === groupMeans.length && engine.every((l, i) => l.level === levels[i] && l.meanDistance !== null && Math.abs(l.meanDistance * engineScale - groupMeans[i]!) <= DISTANCE_TOLERANCE * Math.max(1, Math.abs(groupMeans[i]!)));
  return { factor, distances, codes, levels, groupMeans, matchesEngine };
}
