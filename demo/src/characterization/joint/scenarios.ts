// Validation scenario audit (spec §10): candidate development / validation splits generated from the declared
// metadata and the independence structure, then described fold by fold. Nothing is optimised and no scenario is
// ranked or called unsuitable. Construction uses development units and their metadata only (never target values);
// target coverage reads development targets only (`readableTargetLabels`), never retained-test Y.
//
// Units: the development spectral units of the domain module (`domains/populations.ts`: real rows grouped by physical
// sample and context, merged by declared group when it is the independence unit). Interim demo computation
// (debt: docs/implementation/debt/characterization-joint.md).
import type { EngineInput } from "../../input";
import { testPopulation, type Unit } from "../domains/populations";
import { metadataFactors, metadataValue, readableTargetLabels, type Factor, type TargetLabel } from "./units";

export interface ScenarioUnit {
  index: number;
  members: string[];
  /** Shared categorical level per factor (null: missing or varying within the unit). */
  levels: Record<string, string | null>;
  /** Shared continuous value per factor (null: missing or varying). */
  values: Record<string, number | null>;
}

export interface ScenarioBase {
  units: ScenarioUnit[];
  /** Unit-mean spectra (same order as `units`). */
  spectra: number[][];
  categorical: Factor[];
  continuous: Factor[];
}

export function scenarioBase(input: EngineInput, sourceId: string): ScenarioBase | null {
  const pop = testPopulation(input, sourceId, "", false);
  if (!pop || !pop.development.length) return null;
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const factors = metadataFactors(input);
  const shared = (u: Unit, f: Factor) => {
    const vs = u.members.map((id) => metadataValue(input, f, samples.get(id)!));
    if (vs.some((v) => v === null)) return null;
    const keys = new Set(vs.map((v) => (v!.kind === "level" ? v!.level : String(v!.value))));
    return keys.size === 1 ? vs[0]! : null;
  };
  const units = pop.development.map((u, index) => {
    const levels: Record<string, string | null> = {};
    const values: Record<string, number | null> = {};
    for (const f of factors) {
      const v = shared(u, f);
      if (f.kind === "categorical") levels[f.name] = v?.kind === "level" ? v.level : null;
      else values[f.name] = v?.kind === "value" ? v.value : null;
    }
    return { index, members: u.members, levels, values };
  });
  const varies = (f: Factor) => new Set(units.map((u) => (f.kind === "categorical" ? u.levels[f.name] : u.values[f.name])).filter((v) => v !== null)).size >= 2;
  return {
    units,
    spectra: pop.development.map((u) => u.spectrum),
    categorical: factors.filter((f) => f.kind === "categorical" && varies(f)),
    continuous: factors.filter((f) => f.kind === "continuous" && varies(f)),
  };
}

export type ScenarioKind = "grouped_cv" | "leave_level_out" | "interval" | "combination" | "custom";

export interface Fold {
  id: string;
  /** Held-out description parts (level names, interval or fold number), rendered by the UI. */
  heldOut: string;
  development: number[];
  validation: number[];
}

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  /** Factor(s) the scenario is built on (empty for grouped CV). */
  factors: string[];
  folds: Fold[];
  /** Units outside both sides (factor value missing or varying within the unit). */
  unassigned: number;
  /** Folds omitted by the fold cap (largest held-out groups kept). */
  omitted: number;
}

export const MAX_FOLDS = 24;
export const MAX_LEVELS = 50;
const CV_FOLDS = 5;

function seedOf(input: EngineInput): number {
  const s = String(input.options.seed ?? "0");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shuffle(n: number, seed: number): number[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

const sortText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function capFolds(folds: Fold[]): { folds: Fold[]; omitted: number } {
  if (folds.length <= MAX_FOLDS) return { folds, omitted: 0 };
  const kept = [...folds].sort((a, b) => b.validation.length - a.validation.length || sortText(a.heldOut, b.heldOut)).slice(0, MAX_FOLDS);
  const ids = new Set(kept.map((f) => f.id));
  return { folds: folds.filter((f) => ids.has(f.id)), omitted: folds.length - MAX_FOLDS };
}

/** Held-out side = units whose key equals the fold key; development = every other unit with a known key. */
function byKey(base: ScenarioBase, id: string, kind: ScenarioKind, factors: string[], key: (u: ScenarioUnit) => string | null): Scenario {
  const keyed = base.units.map((u) => ({ u: u.index, k: key(u) }));
  const known = keyed.filter((x) => x.k !== null);
  const keys = [...new Set(known.map((x) => x.k!))].sort(sortText);
  const folds = keys.map((k, i) => ({ id: `${id}:${i}`, heldOut: k, validation: known.filter((x) => x.k === k).map((x) => x.u), development: known.filter((x) => x.k !== k).map((x) => x.u) }));
  const capped = capFolds(folds);
  return { id, kind, factors, folds: capped.folds, unassigned: keyed.length - known.length, omitted: capped.omitted };
}

export function groupedCv(base: ScenarioBase, seed: number): Scenario | null {
  const n = base.units.length;
  if (n < 2) return null;
  const k = Math.min(CV_FOLDS, n);
  const order = shuffle(n, seed);
  const fold = new Array<number>(n);
  order.forEach((u, pos) => (fold[u] = pos % k));
  const all = base.units.map((u) => u.index);
  return {
    id: "cv",
    kind: "grouped_cv",
    factors: [],
    folds: Array.from({ length: k }, (_, f) => ({ id: `cv:${f}`, heldOut: String(f + 1), validation: all.filter((u) => fold[u] === f), development: all.filter((u) => fold[u] !== f) })),
    unassigned: 0,
    omitted: 0,
  };
}

/** Interval bins of a continuous factor: up to four rank-based bins; tied values stay in one bin. */
export function intervalScenario(base: ScenarioBase, factor: string, fmt: (v: number) => string): Scenario {
  const known = base.units.filter((u) => u.values[factor] !== null).sort((a, b) => a.values[factor]! - b.values[factor]!);
  const n = known.length;
  const distinct = new Set(known.map((u) => u.values[factor]!)).size;
  const bins = Math.min(4, distinct);
  const binOf = new Map<number, number>();
  let first = 0;
  known.forEach((u, i) => {
    if (i > 0 && u.values[factor] !== known[i - 1]!.values[factor]) first = i;
    binOf.set(u.index, Math.min(bins - 1, Math.floor((first * bins) / n)));
  });
  const used = [...new Set(binOf.values())].sort((a, b) => a - b);
  const folds = used.map((b, i) => {
    const members = known.filter((u) => binOf.get(u.index) === b);
    const lo = members[0]!.values[factor]!;
    const hi = members[members.length - 1]!.values[factor]!;
    return { id: `int:${factor}:${i}`, heldOut: lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`, validation: members.map((u) => u.index), development: known.filter((u) => binOf.get(u.index) !== b).map((u) => u.index) };
  });
  return { id: `int:${factor}`, kind: "interval", factors: [factor], folds, unassigned: base.units.length - n, omitted: 0 };
}

/** Every candidate scenario, in a fixed order: grouped CV, leave-one-level-out, intervals, level combinations. */
export function candidateScenarios(input: EngineInput, base: ScenarioBase, fmt: (v: number) => string): Scenario[] {
  const out: Scenario[] = [];
  const cv = groupedCv(base, seedOf(input));
  if (cv) out.push(cv);
  const levelCount = (f: Factor) => new Set(base.units.map((u) => u.levels[f.name]).filter((v) => v !== null)).size;
  const usable = base.categorical.filter((f) => levelCount(f) <= MAX_LEVELS);
  for (const f of usable) out.push(byKey(base, `lolo:${f.name}`, "leave_level_out", [f.name], (u) => u.levels[f.name] ?? null));
  for (const f of base.continuous) out.push(intervalScenario(base, f.name, fmt));
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!.name;
      const b = usable[j]!.name;
      out.push(byKey(base, `combo:${a}:${b}`, "combination", [a, b], (u) => (u.levels[a] !== null && u.levels[b] !== null ? `${u.levels[a]} × ${u.levels[b]}` : null)));
    }
  }
  // A fold needs units on both sides.
  return out.map((s) => ({ ...s, folds: s.folds.filter((f) => f.development.length && f.validation.length) })).filter((s) => s.folds.length > 0);
}

export type CustomDomain = { factor: string; kind: "categorical"; levels: string[] } | { factor: string; kind: "continuous"; lo: number; hi: number };

/** One user-defined validation domain; development = every other unit with a known value of the factor. */
export function customScenario(base: ScenarioBase, d: CustomDomain, fmt: (v: number) => string): Scenario | null {
  const inside = (u: ScenarioUnit): boolean | null => {
    if (d.kind === "categorical") {
      const l = u.levels[d.factor];
      return l === null || l === undefined ? null : d.levels.includes(l);
    }
    const v = u.values[d.factor];
    return v === null || v === undefined ? null : v >= d.lo && v <= d.hi;
  };
  const flags = base.units.map((u) => ({ u: u.index, f: inside(u) }));
  const validation = flags.filter((x) => x.f === true).map((x) => x.u);
  const development = flags.filter((x) => x.f === false).map((x) => x.u);
  if (!validation.length || !development.length) return null;
  const heldOut = d.kind === "categorical" ? d.levels.join(", ") : `${fmt(d.lo)} – ${fmt(d.hi)}`;
  return { id: "custom", kind: "custom", factors: [d.factor], folds: [{ id: "custom:0", heldOut, validation, development }], unassigned: flags.filter((x) => x.f === null).length, omitted: 0 };
}

// --- per-fold structural audit -----------------------------------------------------------------------------------

export interface LevelGap {
  factor: string;
  levels: string[];
}

export type TargetCoverage =
  | { kind: "continuous"; devRange: [number, number]; valRange: [number, number] | null; nValUnits: number; nOutside: number }
  | { kind: "categorical"; absentFromDev: string[]; nValUnits: number }
  | { kind: "none"; reason: "no_target" | "no_development_target" };

export interface FoldAudit {
  fold: Fold;
  nDev: number;
  nVal: number;
  /** Units per level of each scenario factor on each side. */
  groupSizes: { factor: string; dev: { level: string; n: number }[]; val: { level: string; n: number }[] }[];
  absentFromDev: LevelGap[];
  absentFromVal: LevelGap[];
  /** Other factors with levels present only in validation (entire levels held out with the scenario). */
  simultaneous: LevelGap[];
  /** Observed level combinations of all categorical factors: total, present in development, validation ones unseen in development. */
  cells: { total: number; inDev: number; valUnseen: number; val: number };
  target: TargetCoverage;
}

const levelCounts = (units: readonly ScenarioUnit[], factor: string) => {
  const m = new Map<string, number>();
  for (const u of units) {
    const l = u.levels[factor];
    if (l !== null && l !== undefined) m.set(l, (m.get(l) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => sortText(a[0], b[0])).map(([level, n]) => ({ level, n }));
};

export function auditFold(base: ScenarioBase, scenario: Scenario, fold: Fold, targets: ReadonlyMap<string, TargetLabel> | null, targetKind: "continuous" | "categorical" | null): FoldAudit {
  const dev = fold.development.map((i) => base.units[i]!);
  const val = fold.validation.map((i) => base.units[i]!);
  const gaps = (a: readonly ScenarioUnit[], b: readonly ScenarioUnit[]) =>
    base.categorical
      .map((f) => {
        const inB = new Set(b.map((u) => u.levels[f.name]).filter((v) => v !== null));
        return { factor: f.name, levels: [...new Set(a.map((u) => u.levels[f.name]).filter((v): v is string => v !== null && !inB.has(v)))].sort(sortText) };
      })
      .filter((g) => g.levels.length);
  const absentFromDev = gaps(val, dev);
  const absentFromVal = gaps(dev, val);
  const cellKey = (u: ScenarioUnit) => (base.categorical.every((f) => u.levels[f.name] !== null) ? base.categorical.map((f) => u.levels[f.name]).join("\u0000") : null);
  const all = new Set(base.units.map(cellKey).filter((k) => k !== null));
  const devCells = new Set(dev.map(cellKey).filter((k) => k !== null));
  const valCells = new Set(val.map(cellKey).filter((k) => k !== null));
  return {
    fold,
    nDev: dev.length,
    nVal: val.length,
    groupSizes: scenario.factors.filter((f) => base.categorical.some((c) => c.name === f)).map((f) => ({ factor: f, dev: levelCounts(dev, f), val: levelCounts(val, f) })),
    absentFromDev,
    absentFromVal,
    simultaneous: absentFromDev.filter((g) => !scenario.factors.includes(g.factor)),
    cells: { total: base.categorical.length ? all.size : 0, inDev: devCells.size, val: valCells.size, valUnseen: [...valCells].filter((k) => !devCells.has(k)).length },
    target: targetCoverage(dev, val, targets, targetKind),
  };
}

function targetCoverage(dev: readonly ScenarioUnit[], val: readonly ScenarioUnit[], targets: ReadonlyMap<string, TargetLabel> | null, kind: "continuous" | "categorical" | null): TargetCoverage {
  if (!targets || kind === null) return { kind: "none", reason: "no_target" };
  const labels = (u: ScenarioUnit) => u.members.map((id) => targets.get(id)).filter((l): l is TargetLabel => l !== undefined);
  if (kind === "continuous") {
    const values = (u: ScenarioUnit) => labels(u).flatMap((l) => (l.kind === "value" ? [l.value] : []));
    const devValues = dev.flatMap(values);
    if (!devValues.length) return { kind: "none", reason: "no_development_target" };
    const lo = Math.min(...devValues);
    const hi = Math.max(...devValues);
    const valUnits = val.map(values).filter((v) => v.length);
    const valValues = valUnits.flat();
    return {
      kind: "continuous",
      devRange: [lo, hi],
      valRange: valValues.length ? [Math.min(...valValues), Math.max(...valValues)] : null,
      nValUnits: valUnits.length,
      nOutside: valUnits.filter((v) => v.some((x) => x < lo || x > hi)).length,
    };
  }
  const classes = (u: ScenarioUnit) => labels(u).flatMap((l) => (l.kind === "class" ? [l.label] : []));
  const devClasses = new Set(dev.flatMap(classes));
  if (!devClasses.size) return { kind: "none", reason: "no_development_target" };
  const valUnits = val.map(classes).filter((c) => c.length);
  return { kind: "categorical", absentFromDev: [...new Set(valUnits.flat().filter((c) => !devClasses.has(c)))].sort(sortText), nValUnits: valUnits.length };
}

/** Development-only target labels of the selected target (retained-test rows are never read). */
export function scenarioTargets(input: EngineInput, targetId: string | null): { labels: Map<string, TargetLabel> | null; kind: "continuous" | "categorical" | null } {
  const t = targetId === null ? undefined : input.targets.find((x) => x.target_id === targetId);
  if (!t) return { labels: null, kind: null };
  return { labels: readableTargetLabels(input, t.target_id), kind: t.kind };
}
