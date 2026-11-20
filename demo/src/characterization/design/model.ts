// Experimental design model of one source: typed view of the engine's `confounding.*` metrics (design,
// variance partition, dispersion, PERMANOVA / PERMDISP tests and their Holm families), the directional factor
// relations and crossing coverage derived from the engine's own unit counts, and the evidence state of every
// test. Every number is an engine value except `pBhExploratory` (local BH over the engine family, interim,
// mirrors Methods n4m_stats_bh_adjust) and the descriptive coverage counts (display arithmetic on engine
// crossings). Dataset-agnostic: factors, levels and counts come from the report only.
//
// Retained-test protection: nothing here reads `input.targets` values.
import type { AvailabilityStatus, MetricState, QualificationMetricView, QualificationReportView } from "nirs4all-ui/qualification";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

export type TestKind = "marginal" | "within_cell" | "freedman_lane" | "permdisp";
export const TEST_KINDS: readonly TestKind[] = ["marginal", "within_cell", "freedman_lane", "permdisp"];
export const TEST_METRIC: Record<TestKind, string> = {
  marginal: "confounding.permanova_marginal_test",
  within_cell: "confounding.permanova_conditional_test",
  freedman_lane: "confounding.permanova_freedman_lane_test",
  permdisp: "confounding.permdisp_test",
};

export type EvidenceState = "significant" | "not_significant" | "not_identifiable" | "insufficient_resolution" | "blocked" | "not_applicable" | "error";
export const EVIDENCE_STATES: readonly EvidenceState[] = ["significant", "not_significant", "not_identifiable", "insufficient_resolution", "blocked", "not_applicable", "error"];

/** Reasons that block every test of a source (engine `blocking_reason`): assumptions, not the data. */
export const BLOCKING_REASONS = new Set(["INDEPENDENCE_UNIT_UNKNOWN", "MISSING_INDEPENDENCE_GROUP", "REFERENCE_GROUP_UNRESOLVED", "EXCHANGEABILITY_NOT_DECLARED", "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT"]);
const ALIASING_REASONS = new Set(["FACTOR_ALIASED_WITH_OTHER_FACTORS", "SATURATED_DESIGN", "REDUCED_MODEL_SATURATED"]);

export type ResolutionCause = "admissible_permutations" | "requested_draws" | "multiplicity";

export interface PlanView {
  requested: number | null;
  executed: number | null;
  restrictions: string | null;
  blockSizes: number[];
  log10Distinct: number | null;
  /** Smallest attainable p-value bound (engine plan.resolution). */
  resolution: number | null;
  /** Holm per-test threshold alpha / m (engine multiplicity parameters). */
  threshold: number | null;
  resolutionBasis: string | null;
  resolutionCause: ResolutionCause | null;
  nullHypothesis: string | null;
  testedEffect: string | null;
  reducedModel: string | null;
  seed: string | null;
  drawMethod: string | null;
  monteCarloStep: number | null;
  exchangeableUnit: string | null;
}

export interface TestEvidence {
  kind: TestKind;
  metricId: string;
  factor: string;
  state: EvidenceState;
  status: AvailabilityStatus;
  reasonCode: string | null;
  statistic: number | null;
  statisticName: string | null;
  pRaw: number | null;
  pHolm: number | null;
  rejects: boolean | null;
  /** LOCAL exploratory BH over the engine family's entered p-values (never used for decisions). */
  pBhExploratory: number | null;
  family: { id: string; method: "holm"; alpha: number | null; size: number | null } | null;
  plan: PlanView | null;
}

export interface FactorDesign {
  factor: string;
  nLevels: number;
  levels: { level: string; nUnits: number | null }[];
  /** false: a single observed level (constant factor). */
  varying: boolean;
  dfNominal: number | null;
  dfGivenCells: number | null;
  dfGivenMainEffects: number | null;
  dfReasonCode: string | null;
  aliasedWithCells: boolean | null;
  identifiableAdditive: boolean | null;
  additiveReasonCode: string | null;
  partiallyConfounded: boolean | null;
  determinedBy: string[];
  nOtherCells: number | null;
  r2: {
    marginal: number | null;
    uniqueGivenCells: number | null;
    uniqueAdditive: number | null;
    partialGivenCells: number | null;
    partialAdditive: number | null;
    dfMarginal: number | null;
    dfGivenCells: number | null;
    dfAdditive: number | null;
    pseudoFMarginal: number | null;
    reasonCode: string | null;
  } | null;
  tests: Record<TestKind, TestEvidence | null>;
  dispersion: { state: MetricState; levels: { level: string; meanDistance: number | null; nUnits: number | null }[]; anovaF: number | null; df1: number | null; df2: number | null; distanceExponent: number | null } | null;
}

export type RelationKind = "determines" | "mutual" | "partial" | "aliasing" | "unknown";
export interface DesignRelation {
  /** Factor name, or for aliasing / unknown the other factors whose cells are involved. */
  from: string;
  to: string;
  kind: RelationKind;
  /** Factors on the `from` side (one for pairwise relations). */
  fromFactors: string[];
  /** Pairwise crossing coverage (occupied / possible), null for multivariate relations. */
  coverage: number | null;
}

export interface Crossing {
  a: string;
  b: string;
  levelsA: string[];
  levelsB: string[];
  /** counts[i][j]: analysed independence units at (levelsA[i], levelsB[j]). */
  counts: number[][];
  occupied: number;
  possible: number;
  coverage: number;
  minOccupied: number | null;
  maxOccupied: number | null;
  /** Occupied cells holding a single independence unit. */
  singletons: number;
  nUnits: number;
}

export interface DesignModel {
  sourceId: string;
  state: MetricState;
  nEligibleSamples: number | null;
  nIndependenceUnits: number | null;
  nUnitsAnalyzed: number | null;
  nMissing: number | null;
  nVaries: number | null;
  nOccupiedCells: number | null;
  analysisUnit: string | null;
  aliasingRule: string | null;
  factors: FactorDesign[];
  undeclared: string[];
  relations: DesignRelation[];
  crossings: Crossing[];
  joint: { r2AllCells: number | null; df: number | null; nCells: number | null; pseudoF: number | null; reasonCode: string | null } | null;
  partition: { state: MetricState; ssTotal: number | null; ssExponent: number | null; unit: string | null; definitions: Record<string, string>; geometry: string | null } | null;
  families: { id: string; alpha: number | null; size: number | null; holmAvailable: boolean | null; members: { test: string; factor: string }[] }[];
  /** Reason shared by every non-computed test of the source when it is an assumption block. */
  blockedReason: string | null;
}

const state = (m: QualificationMetricView): MetricState => ({ status: m.status, reasonCode: m.reasonCode });

/** Mirrors Methods n4m_stats_bh_adjust (stable sort, step-up running minimum). */
export function bhAdjust(p: readonly number[]): number[] {
  const m = p.length;
  const order = p.map((_, i) => i).sort((a, b) => (p[a]! < p[b]! ? -1 : p[a]! > p[b]! ? 1 : a - b));
  const out = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const i = order[rank - 1]!;
    running = Math.min(running, (m / rank) * p[i]!);
    out[i] = running;
  }
  return out;
}

/** Mirrors Methods n4m_preflight_holm_adjust (stable sort, step-down running maximum, capped at 1). */
export function holmAdjust(p: readonly number[]): number[] {
  const m = p.length;
  const order = p.map((_, i) => i).sort((a, b) => (p[a]! < p[b]! ? -1 : p[a]! > p[b]! ? 1 : a - b));
  const out = new Array<number>(m);
  let running = 0;
  order.forEach((i, rank) => {
    running = Math.max(running, (m - rank) * p[i]!);
    out[i] = Math.min(1, running);
  });
  return out;
}

export function evidenceState(status: AvailabilityStatus, reason: string | null, rejects: boolean | null): EvidenceState {
  if (status === "computed") return rejects === true ? "significant" : rejects === false ? "not_significant" : "error";
  if (reason && BLOCKING_REASONS.has(reason)) return "blocked";
  if (reason === "PERMUTATION_RESOLUTION_INSUFFICIENT") return "insufficient_resolution";
  if (status === "not_identifiable" || (reason && ALIASING_REASONS.has(reason))) return "not_identifiable";
  if (status === "not_applicable") return "not_applicable";
  return "error";
}

function resolutionCause(plan: Record<string, unknown>, threshold: number | null, alpha: number | null): ResolutionCause | null {
  const resolution = num(plan.resolution);
  if (resolution === null || threshold === null || resolution <= threshold) return null;
  const log10 = num(plan.log10_distinct_admissible_permutations);
  const structural = log10 === null ? null : 10 ** -log10;
  if (structural !== null && structural > (alpha ?? threshold)) return "admissible_permutations";
  if (structural !== null && structural > threshold) return "multiplicity";
  return "requested_draws";
}

function readPlan(m: QualificationMetricView): PlanView | null {
  const plan = rec(m.parameters.permutation_plan);
  if (!Object.keys(plan).length) return null;
  const mult = rec(m.parameters.multiplicity);
  const threshold = num(mult.per_test_resolution_threshold);
  return {
    requested: num(plan.n_permutations_requested),
    executed: num(plan.n_permutations_executed),
    restrictions: str(plan.restrictions),
    blockSizes: arr(plan.block_sizes).map(num).filter((v): v is number => v !== null),
    log10Distinct: num(plan.log10_distinct_admissible_permutations),
    resolution: num(plan.resolution),
    threshold,
    resolutionBasis: str(plan.resolution_basis),
    resolutionCause: resolutionCause(plan, threshold, num(mult.family_alpha)),
    nullHypothesis: str(plan.null_hypothesis),
    testedEffect: str(plan.tested_effect),
    reducedModel: str(plan.reduced_model),
    seed: plan.seed === undefined || plan.seed === null ? null : String(plan.seed),
    drawMethod: str(plan.draw_method),
    monteCarloStep: num(plan.monte_carlo_step),
    exchangeableUnit: str(plan.exchangeable_unit),
  };
}

/** Directional relations of every analysed factor pair from the engine's unit counts. */
export function pairRelations(crossings: readonly Crossing[]): DesignRelation[] {
  const out: DesignRelation[] = [];
  for (const c of crossings) {
    // a determines b when every level of a holds a single level of b (among occupied cells).
    const aDetB = c.counts.every((row) => row.filter((n) => n > 0).length <= 1);
    const bDetA = c.levelsB.every((_, j) => c.counts.filter((row) => row[j]! > 0).length <= 1);
    if (aDetB && bDetA) out.push({ from: c.a, to: c.b, kind: "mutual", fromFactors: [c.a], coverage: c.coverage });
    else if (aDetB) out.push({ from: c.a, to: c.b, kind: "determines", fromFactors: [c.a], coverage: c.coverage });
    else if (bDetA) out.push({ from: c.b, to: c.a, kind: "determines", fromFactors: [c.b], coverage: c.coverage });
    else if (c.occupied < c.possible) out.push({ from: c.a, to: c.b, kind: "partial", fromFactors: [c.a], coverage: c.coverage });
  }
  return out;
}

function crossing(raw: Record<string, unknown>, levelsOf: Map<string, string[]>): Crossing | null {
  const [a, b] = strings(raw.factors);
  if (!a || !b) return null;
  const table = rec(raw.unit_counts);
  const levelsA = levelsOf.get(a) ?? Object.keys(table).sort();
  const levelsB = levelsOf.get(b) ?? [...new Set(Object.values(table).flatMap((r) => Object.keys(rec(r))))].sort();
  const counts = levelsA.map((la) => levelsB.map((lb) => num(rec(table[la])[lb]) ?? 0));
  const cells = counts.flat();
  const occupiedCells = cells.filter((n) => n > 0);
  return {
    a, b, levelsA, levelsB, counts,
    occupied: occupiedCells.length,
    possible: levelsA.length * levelsB.length,
    coverage: levelsA.length * levelsB.length ? occupiedCells.length / (levelsA.length * levelsB.length) : 0,
    minOccupied: occupiedCells.length ? Math.min(...occupiedCells) : null,
    maxOccupied: occupiedCells.length ? Math.max(...occupiedCells) : null,
    singletons: occupiedCells.filter((n) => n === 1).length,
    nUnits: cells.reduce((s, n) => s + n, 0),
  };
}

export function designModel(view: QualificationReportView, sourceId: string): DesignModel | null {
  const mine = view.metrics.filter((m) => m.sourceId === sourceId && m.id.startsWith("confounding."));
  if (!mine.length) return null;
  const design = mine.find((m) => m.id === "confounding.design");
  if (!design) return null;
  const dv = design.status === "computed" ? rec(design.value) : {};
  const vp = mine.find((m) => m.id === "confounding.variance_partition");
  const pv = vp?.status === "computed" ? rec(vp.value) : null;
  const shares = new Map(arr(pv?.factors).map(rec).map((f) => [String(f.factor), f]));
  const dispersions = new Map(mine.filter((m) => m.id === "confounding.dispersion").map((m) => [str(m.parameters.factor) ?? "", m]));

  const families = mine.filter((m) => m.id.endsWith("_family")).map((m) => {
    const v = rec(m.value);
    return { id: m.id, alpha: num(v.family_alpha), size: num(v.family_size), holmAvailable: bool(v.holm_available), members: arr(v.members).map(rec).map((x) => ({ test: String(x.test), factor: String(x.factor) })) };
  });
  const tests = mine.filter((m) => Object.values(TEST_METRIC).includes(m.id));
  // Exploratory BH over each family's entered p-values (unreported members enter as 1, as for Holm).
  const bh = new Map<string, number>();
  for (const f of families) {
    if (!f.members.length) continue;
    const entered = f.members.map((mem) => {
      const t = tests.find((x) => x.id === mem.test && x.parameters.factor === mem.factor && x.status === "computed");
      return num(rec(t?.value).p_value) ?? 1;
    });
    bhAdjust(entered).forEach((v, i) => bh.set(`${f.members[i]!.test}|${f.members[i]!.factor}`, v));
  }
  const familyOf = (id: string) => families.find((f) => f.id === (id === TEST_METRIC.permdisp ? "confounding.permdisp_family" : "confounding.permanova_family")) ?? null;
  const evidence = (factor: string, kind: TestKind): TestEvidence | null => {
    const m = tests.find((x) => x.id === TEST_METRIC[kind] && x.parameters.factor === factor);
    if (!m) return null;
    const v = rec(m.value);
    const rejects = bool(v.rejects_null_at_family_alpha);
    const fam = familyOf(m.id);
    const pRaw = m.status === "computed" ? num(v.p_value) : null;
    return {
      kind, metricId: m.id, factor,
      state: evidenceState(m.status, m.reasonCode, rejects),
      status: m.status,
      reasonCode: m.reasonCode ?? str(v.multiplicity_reason_code),
      statistic: num(v.statistic),
      statisticName: str(v.statistic_name),
      pRaw,
      pHolm: m.status === "computed" ? num(v.p_value_holm) : null,
      rejects,
      pBhExploratory: pRaw === null ? null : (bh.get(`${m.id}|${factor}`) ?? null),
      family: fam && fam.members.some((x) => x.test === m.id && x.factor === factor) ? { id: fam.id, method: "holm", alpha: fam.alpha, size: fam.size } : null,
      plan: readPlan(m),
    };
  };

  const factors: FactorDesign[] = arr(dv.factors).map(rec).map((f) => {
    const factor = String(f.factor);
    const levels = arr(f.levels).map(rec).map((l) => ({ level: String(l.level), nUnits: num(l.n_units) }));
    const share = shares.get(factor);
    const disp = dispersions.get(factor);
    const dvv = disp?.status === "computed" ? rec(disp.value) : {};
    return {
      factor,
      nLevels: num(f.n_levels) ?? levels.length,
      levels,
      varying: str(f.status) !== "single_level" && levels.length >= 2,
      dfNominal: num(f.df_nominal),
      dfGivenCells: num(f.df_identifiable_given_other_factors),
      dfGivenMainEffects: num(f.df_identifiable_given_other_main_effects),
      dfReasonCode: str(f.df_identifiable_reason_code),
      aliasedWithCells: bool(f.aliased_with_other_factor_cells),
      identifiableAdditive: bool(f.identifiable_under_additive_model),
      additiveReasonCode: str(f.additive_identifiability_reason_code),
      partiallyConfounded: bool(f.partially_confounded),
      determinedBy: strings(f.determined_by),
      nOtherCells: num(f.n_other_factor_cells),
      r2: share ? {
        marginal: num(share.r2_marginal),
        uniqueGivenCells: num(share.r2_unique_given_other_factors),
        uniqueAdditive: num(share.r2_unique_given_other_main_effects),
        partialGivenCells: num(share.partial_r2_given_other_factors),
        partialAdditive: num(share.partial_r2_given_other_main_effects),
        dfMarginal: num(share.df_marginal),
        dfGivenCells: num(share.df_given_other_factors),
        dfAdditive: num(share.df_given_other_main_effects),
        pseudoFMarginal: num(share.pseudo_f_marginal),
        reasonCode: str(share.reason_code),
      } : null,
      tests: { marginal: evidence(factor, "marginal"), within_cell: evidence(factor, "within_cell"), freedman_lane: evidence(factor, "freedman_lane"), permdisp: evidence(factor, "permdisp") },
      dispersion: disp ? {
        state: state(disp),
        levels: arr(dvv.levels).map(rec).map((l) => ({ level: String(l.level), meanDistance: num(l.mean_distance_to_centroid), nUnits: num(l.n_units) })),
        anovaF: num(dvv.anova_f), df1: num(dvv.df1), df2: num(dvv.df2), distanceExponent: num(dvv.distance_binary_exponent),
      } : null,
    };
  });

  const levelsOf = new Map(factors.map((f) => [f.factor, f.levels.map((l) => l.level)]));
  const crossings = arr(dv.crossings).map(rec).map((c) => crossing(c, levelsOf)).filter((c): c is Crossing => c !== null);
  const relations = pairRelations(crossings);
  const varying = factors.filter((f) => f.varying).map((f) => f.factor);
  for (const f of factors.filter((x) => x.varying)) {
    const others = varying.filter((o) => o !== f.factor);
    if (!others.length) continue;
    const explained = relations.some((r) => r.to === f.factor && (r.kind === "determines" || r.kind === "mutual")) || relations.some((r) => r.kind === "mutual" && r.from === f.factor);
    if (f.aliasedWithCells === true && !explained) relations.push({ from: others.join(" × "), to: f.factor, kind: "aliasing", fromFactors: others, coverage: null });
    else if (f.aliasedWithCells === null || (f.aliasedWithCells === true && f.identifiableAdditive === null)) relations.push({ from: others.join(" × "), to: f.factor, kind: "unknown", fromFactors: others, coverage: null });
  }

  const reasons = tests.filter((t) => t.status !== "computed").map((t) => t.reasonCode);
  const blockedReason = reasons.find((r) => r && BLOCKING_REASONS.has(r)) ?? null;
  const joint = rec(pv?.joint);
  const d = design.denominators;
  return {
    sourceId,
    state: state(design),
    nEligibleSamples: d.n_eligible_samples ?? null,
    nIndependenceUnits: d.n_independence_units ?? null,
    nUnitsAnalyzed: d.n_units_analyzed ?? null,
    nMissing: d.n_units_missing_factor ?? null,
    nVaries: d.n_units_factor_varies_within_unit ?? null,
    nOccupiedCells: d.n_occupied_cells ?? null,
    analysisUnit: str(design.parameters.analysis_unit),
    aliasingRule: str(design.parameters.aliasing_rule),
    factors,
    undeclared: strings(dv.undeclared_factors),
    relations,
    crossings,
    joint: pv && pv.joint !== null && pv.joint !== undefined ? { r2AllCells: num(joint.r2_all_factor_cells), df: num(joint.df), nCells: num(joint.n_cells), pseudoF: num(joint.pseudo_f), reasonCode: str(joint.reason_code) } : null,
    partition: vp ? {
      state: state(vp),
      ssTotal: num(pv?.ss_total),
      ssExponent: num(pv?.ss_binary_exponent),
      unit: vp.unit,
      definitions: Object.fromEntries(Object.entries(rec(vp.parameters.r2_definitions)).map(([k, v]) => [k, String(v)])),
      geometry: str(vp.parameters.geometry),
    } : null,
    families,
    blockedReason,
  };
}

/** Marginal → adjusted comparison of one factor (display only; the difference is never labelled confounded variance). */
export function adjustmentDrop(f: FactorDesign): { marginal: number; adjusted: number; basis: "cells" | "additive" } | null {
  const m = f.r2?.marginal ?? null;
  if (m === null) return null;
  const cells = f.r2?.uniqueGivenCells ?? null;
  const additive = f.r2?.uniqueAdditive ?? null;
  const pick = cells !== null && f.aliasedWithCells !== true ? { adjusted: cells, basis: "cells" as const } : additive !== null && f.identifiableAdditive === true ? { adjusted: additive, basis: "additive" as const } : null;
  if (!pick || !(pick.adjusted < m)) return null;
  return { marginal: m, ...pick };
}
