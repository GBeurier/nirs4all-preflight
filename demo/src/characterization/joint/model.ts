// Typed results of the metadata–target associations (engine `association.*`) and of the joint X–Y landscape.
// Every number is an engine value except the fields marked LOCAL (display arithmetic or the §11 consistency check).
// The spectral side is the design module's typed adapter (`designModel`, engine `confounding.*`).
// Statistics are joined by (target, metadata) only within one metric family, so the descriptive and test metrics of
// one pair come from the same population and model; spectral (confounding) and target (association) results are
// never combined into one score.
import type { AvailabilityStatus, QualificationMetricView, QualificationReportView } from "nirs4all-ui/qualification";
import { associationRows, type AssociationRow as DesignAssociationRow, type Check } from "../design/consistency";
import type { DesignModel, FactorDesign, TestEvidence } from "../design/model";

export interface Summary {
  count: number | null;
  min: number | null;
  q25: number | null;
  median: number | null;
  q75: number | null;
  max: number | null;
  mean: number | null;
  sd: number | null;
}

export interface LevelResult {
  level: string;
  nUnits: number | null;
  /** Target summary of the level (continuous target). */
  target: Summary | null;
  /** Class counts of the level (categorical target). */
  classCounts: Record<string, number> | null;
}

export interface ClassResult {
  label: string;
  nUnits: number | null;
  /** Summary of the continuous metadata within the target class. */
  metadata: Summary | null;
}

export type Measure = "eta_squared" | "spearman_rho" | "cramers_v" | "other";

export interface TestResult {
  status: AvailabilityStatus;
  reasonCode: string | null;
  pRaw: number | null;
  pHolm: number | null;
  pBh: number | null;
  rejects: boolean | null;
  nPermutations: number | null;
  resolution: number | null;
  nullHypothesis: string | null;
}

export interface AssociationResult {
  targetId: string;
  metadata: string;
  metadataKind: "categorical" | "continuous" | null;
  metadataUnit: string | null;
  targetUnit: string | null;
  associationType: string | null;
  status: AvailabilityStatus;
  reasonCode: string | null;
  /** Engine population id (e.g. development_real) and analysis unit. */
  populationId: string;
  analysisUnit: string | null;
  denominators: Readonly<Record<string, number>>;
  measure: Measure;
  effect: number | null;
  statisticName: string | null;
  statistic: number | null;
  df1: number | null;
  df2: number | null;
  nLevels: number | null;
  levels: LevelResult[];
  classes: ClassResult[];
  pearsonR: number | null;
  metadataSummary: Summary | null;
  test: TestResult | null;
  /** §11 display checks of the design module (F identity, df, level units, test join). */
  checks: readonly Check[];
  consistent: boolean | null;
  /** The test metric refers to another population or model: its values are withheld. */
  joinMismatch: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function summary(v: unknown): Summary | null {
  if (!v || typeof v !== "object") return null;
  const s = obj(v);
  return { count: num(s.count), min: num(s.min), q25: num(s.q25), median: num(s.median), q75: num(s.q75), max: num(s.max), mean: num(s.mean), sd: num(s.sample_sd) };
}

/** Effect measure of a pair from its declared association type (also for pairs that were not computed). */
const MEASURE_OF_TYPE: Record<string, Measure> = {
  categorical_metadata_continuous_target: "eta_squared",
  continuous_metadata_categorical_target: "eta_squared",
  continuous_metadata_continuous_target: "spearman_rho",
  categorical_metadata_categorical_target: "cramers_v",
};
const measureOf = (type: string | null, name: string | null): Measure => (type && MEASURE_OF_TYPE[type]) || (name === "eta_squared" || name === "spearman_rho" || name === "cramers_v" ? name : "other");

/** Factors the engine skipped because they are not declared for any sample (`METADATA_NOT_DECLARED`). */
export const NOT_DECLARED = "METADATA_NOT_DECLARED";

function testOf(m: QualificationMetricView | undefined, row: DesignAssociationRow): TestResult | null {
  // The design module's join accepts the test only for the same population and model (§11); else no test values.
  if (!m || !row.test) return null;
  const plan = obj(m.parameters.permutation_plan);
  return {
    status: row.test.state.status,
    reasonCode: row.test.state.reasonCode,
    pRaw: row.test.pRaw,
    pHolm: row.test.pHolm,
    pBh: row.test.pBhExploratory,
    rejects: row.test.rejects,
    nPermutations: num(plan.n_permutations_executed),
    resolution: num(plan.resolution),
    nullHypothesis: str(plan.null_hypothesis),
  };
}

/**
 * Metadata–target associations of the report (all targets when `targetId` is null), in report order. Factors not
 * declared for any sample are left out unless `includeUndeclared`.
 */
export function associationResults(view: QualificationReportView, targetId: string | null, includeUndeclared = false): AssociationResult[] {
  const key = (m: QualificationMetricView) => `${m.targetId ?? ""}\u0000${str(m.parameters.metadata) ?? ""}\u0000${str(m.parameters.association_type) ?? ""}`;
  const tests = new Map(view.metrics.filter((m) => m.id === "association.metadata_target_test").map((m) => [key(m), m]));
  // Same metric filter and order as the design module's `associationRows` (§11 checks and test join).
  const checked = associationRows(view);
  return view.metrics
    .filter((m) => m.id === "association.metadata_target")
    .map((m, i) => ({ m, row: checked[i]! }))
    .filter(({ m }) => (targetId === null || m.targetId === targetId) && (includeUndeclared || m.reasonCode !== NOT_DECLARED))
    .map(({ m, row }) => {
      const v = obj(m.value);
      const p = m.parameters;
      const effectName = str(v.effect_size_name);
      const measure = measureOf(str(p.association_type), effectName);
      const levels = Array.isArray(v.levels)
        ? v.levels.map((l) => {
            const o = obj(l);
            const counts = obj(o.class_counts);
            return {
              level: String(o.level ?? ""),
              nUnits: num(o.n_units),
              target: summary(o.target_summary),
              classCounts: o.class_counts ? Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, Number(c)])) : null,
            };
          })
        : [];
      const classes = Array.isArray(v.classes) ? v.classes.map((c) => { const o = obj(c); return { label: String(o.class ?? ""), nUnits: num(o.n_units), metadata: summary(o.metadata_summary) }; }) : [];
      const effect = num(v.effect_size);
      const statistic = num(v.statistic);
      const df1 = num(v.df1);
      const df2 = num(v.df2);
      const kind = str(p.metadata_kind);
      return {
        targetId: m.targetId ?? "",
        metadata: str(p.metadata) ?? "",
        metadataKind: kind === "categorical" || kind === "continuous" ? kind : null,
        metadataUnit: str(p.metadata_unit),
        targetUnit: str(p.target_unit),
        associationType: str(p.association_type),
        status: m.status,
        reasonCode: m.reasonCode,
        populationId: m.populationId,
        analysisUnit: str(p.analysis_unit),
        denominators: m.denominators,
        measure,
        effect,
        statisticName: str(v.statistic_name),
        statistic,
        df1,
        df2,
        nLevels: num(v.n_levels) ?? num(v.n_classes),
        levels,
        classes,
        pearsonR: num(v.pearson_r),
        metadataSummary: summary(v.metadata_summary),
        test: testOf(tests.get(key(m)), row),
        checks: row.checks,
        consistent: row.consistent,
        joinMismatch: row.joinMismatch,
      };
    });
}

export interface AssociationFamily {
  alpha: number | null;
  size: number | null;
  holmAvailable: boolean | null;
  bhAvailable: boolean | null;
}

export function associationFamily(view: QualificationReportView): AssociationFamily | null {
  const m = view.metrics.find((x) => x.id === "association.metadata_target_family");
  if (!m) return null;
  const v = obj(m.value);
  const bh = obj(v.exploratory_secondary);
  return { alpha: num(v.family_alpha), size: num(v.family_size), holmAvailable: typeof v.holm_available === "boolean" ? v.holm_available : null, bhAvailable: typeof bh.available === "boolean" ? bh.available : null };
}

/** Engine η² of a categorical metadata against a continuous target (the only effect placed on the η² axis). */
export const isEtaOfCategorical = (a: AssociationResult) => a.associationType === "categorical_metadata_continuous_target";

// --- joint landscape ---------------------------------------------------------------------------------------------

export interface JointRow {
  factor: string;
  spectral: FactorDesign | null;
  /** Units of the spectral analysis (sum of level units). */
  spectralUnits: number | null;
  target: AssociationResult | null;
  /** Engine eta² of the categorical factor against the continuous target; null otherwise. */
  eta2: number | null;
  r2Marginal: number | null;
  /** True when the spectral effect is independently identifiable (adjusted given the other factor cells). */
  identifiable: boolean | null;
  spectralSignificant: boolean | null;
  targetSignificant: boolean | null;
  dispersionSignificant: boolean | null;
}

const significant = (t: TestEvidence | null | undefined): boolean | null => (!t ? null : t.state === "significant" ? true : t.state === "not_significant" ? false : null);
const targetSignificant = (a: AssociationResult | null): boolean | null => (!a?.test || a.test.status !== "computed" ? null : a.test.rejects);

/**
 * One row per categorical factor found in the spectral design or in the target associations of `targetId`.
 * Different response spaces (spectra vs target) and possibly different populations: values are kept side by side.
 */
export function jointRows(design: DesignModel | null, associations: readonly AssociationResult[], targetId: string | null): JointRow[] {
  const assoc = associations.filter((a) => a.targetId === targetId && a.metadataKind === "categorical");
  const names = [...new Set([...(design?.factors.map((f) => f.factor) ?? []), ...assoc.map((a) => a.metadata)])];
  return names.map((factor) => {
    const spectral = design?.factors.find((f) => f.factor === factor) ?? null;
    const target = assoc.find((a) => a.metadata === factor) ?? null;
    const units = spectral ? spectral.levels.reduce<number | null>((s, l) => (s === null || l.nUnits === null ? null : s + l.nUnits), 0) : null;
    return {
      factor,
      spectral,
      spectralUnits: units,
      target,
      eta2: target && isEtaOfCategorical(target) && target.status === "computed" ? target.effect : null,
      r2Marginal: spectral?.r2?.marginal ?? null,
      identifiable: spectral ? (spectral.aliasedWithCells === null ? null : !spectral.aliasedWithCells) : null,
      spectralSignificant: significant(spectral?.tests.marginal),
      targetSignificant: targetSignificant(target),
      dispersionSignificant: significant(spectral?.tests.permdisp),
    };
  });
}
