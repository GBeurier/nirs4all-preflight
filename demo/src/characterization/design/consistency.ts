// Statistical consistency checks of the engine's association and design outputs (joint interpretation §11).
// Display-level identities only; a failed check is reported next to the values, never used to replace them.
//
// One-way ANOVA (unweighted): F = (η² / (1 − η²)) · (df2 / df1), df1 = levels − 1, df2 = units − levels.
// PERMANOVA (one term, Euclidean): pseudo-F = (R² / df) / ((1 − R²) / (n − df − 1)) with the same units.
//
// Joins: the descriptive metric (`association.metadata_target`) and its test (`..._test`) are joined on
// (target id, metadata, association type) and the test row is accepted only when its effect size equals the
// descriptive one (same population and model); otherwise the row carries `joinMismatch` and no test values.
// Retained-test protection: target values are never read; engine summaries only.
import type { MetricState, QualificationReportView } from "nirs4all-ui/qualification";
import type { FactorDesign } from "./model";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Relative agreement used by the display checks (engine values are published at full double precision). */
export const CHECK_TOLERANCE = 1e-9;
const close = (a: number, b: number) => Math.abs(a - b) <= CHECK_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

export function anovaF(eta2: number, df1: number, df2: number): number | null {
  if (!(df1 > 0) || !(df2 > 0) || !(eta2 >= 0) || !(eta2 < 1)) return null;
  return (eta2 / (1 - eta2)) * (df2 / df1);
}

export function pseudoF(r2: number, df: number, n: number): number | null {
  const dfr = n - df - 1;
  if (!(df > 0) || !(dfr > 0) || !(r2 >= 0) || !(r2 < 1)) return null;
  return (r2 / df) / ((1 - r2) / dfr);
}

export interface Check {
  id: "f_identity" | "df1_levels" | "df2_units" | "level_units_sum" | "test_join";
  ok: boolean;
  expected: number | null;
  observed: number | null;
}

export interface AssociationRow {
  targetId: string;
  metadata: string;
  metadataKind: string | null;
  associationType: string | null;
  state: MetricState;
  effectSize: number | null;
  effectSizeName: string | null;
  statistic: number | null;
  statisticName: string | null;
  df1: number | null;
  df2: number | null;
  nLevels: number | null;
  levels: { level: string; nUnits: number | null }[];
  /** Units of this pair's population (engine denominators of the descriptive metric). */
  nUnitsAnalyzed: number | null;
  denominators: Readonly<Record<string, number>>;
  test: { state: MetricState; pRaw: number | null; pHolm: number | null; pBhExploratory: number | null; rejects: boolean | null } | null;
  /** The test metric exists but refers to another population or model: its values are withheld. */
  joinMismatch: boolean;
  checks: Check[];
  /** Every applicable check passed (null when none applies). */
  consistent: boolean | null;
}

export function associationRows(view: QualificationReportView): AssociationRow[] {
  const tests = view.metrics.filter((m) => m.id === "association.metadata_target_test");
  return view.metrics.filter((m) => m.id === "association.metadata_target").map((m) => {
    const v = m.status === "computed" ? rec(m.value) : {};
    const metadata = str(m.parameters.metadata) ?? "—";
    const associationType = str(m.parameters.association_type);
    const levelsRaw = arr(v.levels).length ? arr(v.levels) : arr(v.classes);
    const levels = levelsRaw.map(rec).map((l) => ({ level: String(l.level ?? l.class), nUnits: num(l.n_units) }));
    const effectSize = num(v.effect_size);
    const statistic = num(v.statistic);
    const df1 = num(v.df1);
    const df2 = num(v.df2);
    const nLevels = num(v.n_levels) ?? num(v.n_classes);
    const n = m.denominators.n_units_analyzed ?? null;
    const checks: Check[] = [];
    if (m.status === "computed" && str(v.statistic_name) === "anova_f" && effectSize !== null && df1 !== null && df2 !== null) {
      const expected = anovaF(effectSize, df1, df2);
      checks.push({ id: "f_identity", ok: expected !== null && statistic !== null && close(expected, statistic), expected, observed: statistic });
      if (nLevels !== null) checks.push({ id: "df1_levels", ok: df1 === nLevels - 1, expected: nLevels - 1, observed: df1 });
      if (nLevels !== null && n !== null) checks.push({ id: "df2_units", ok: df2 === n - nLevels, expected: n - nLevels, observed: df2 });
    }
    if (m.status === "computed" && levels.length && n !== null && levels.every((l) => l.nUnits !== null)) {
      const sum = levels.reduce((s, l) => s + l.nUnits!, 0);
      checks.push({ id: "level_units_sum", ok: sum === n, expected: n, observed: sum });
    }
    const t = tests.find((x) => x.targetId === m.targetId && str(x.parameters.metadata) === metadata && str(x.parameters.association_type) === associationType);
    let test: AssociationRow["test"] = null;
    let joinMismatch = false;
    if (t) {
      const tv = rec(t.value);
      const sameEffect = t.status !== "computed" || effectSize === null || (num(tv.effect_size) !== null && close(num(tv.effect_size)!, effectSize));
      const sameUnits = (t.denominators.n_units_analyzed ?? null) === n;
      if (t.status === "computed") checks.push({ id: "test_join", ok: sameEffect && sameUnits, expected: effectSize, observed: num(tv.effect_size) });
      joinMismatch = !(sameEffect && sameUnits);
      test = joinMismatch ? null : { state: { status: t.status, reasonCode: t.reasonCode }, pRaw: num(tv.p_value), pHolm: num(tv.p_value_holm), pBhExploratory: num(tv.p_value_bh_exploratory), rejects: bool(tv.rejects_null_at_family_alpha) };
    }
    return {
      targetId: m.targetId ?? "—",
      metadata,
      metadataKind: str(m.parameters.metadata_kind),
      associationType,
      state: { status: m.status, reasonCode: m.reasonCode },
      effectSize,
      effectSizeName: str(v.effect_size_name),
      statistic,
      statisticName: str(v.statistic_name),
      df1, df2, nLevels, levels,
      nUnitsAnalyzed: n,
      denominators: m.denominators,
      test,
      joinMismatch,
      checks,
      consistent: checks.length ? checks.every((c) => c.ok) : null,
    };
  });
}

/** Marginal PERMANOVA identity of one factor: pseudo-F from R², df and the analysed units. */
export function permanovaChecks(f: FactorDesign, nUnits: number | null): Check[] {
  const out: Check[] = [];
  const r2 = f.r2;
  if (r2 && r2.marginal !== null && r2.dfMarginal !== null && nUnits !== null && r2.pseudoFMarginal !== null) {
    const expected = pseudoF(r2.marginal, r2.dfMarginal, nUnits);
    out.push({ id: "f_identity", ok: expected !== null && close(expected, r2.pseudoFMarginal), expected, observed: r2.pseudoFMarginal });
    out.push({ id: "df1_levels", ok: r2.dfMarginal === f.nLevels - 1, expected: f.nLevels - 1, observed: r2.dfMarginal });
  }
  if (nUnits !== null && f.levels.every((l) => l.nUnits !== null)) {
    const sum = f.levels.reduce((s, l) => s + l.nUnits!, 0);
    out.push({ id: "level_units_sum", ok: sum === nUnits, expected: nUnits, observed: sum });
  }
  const d = f.dispersion;
  if (d && d.state.status === "computed" && d.df1 !== null && d.df2 !== null && nUnits !== null) {
    out.push({ id: "df2_units", ok: d.df1 === d.levels.length - 1 && d.df2 === nUnits - d.levels.length, expected: nUnits - d.levels.length, observed: d.df2 });
  }
  return out;
}
