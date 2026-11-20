// Deterministic joint-interpretation rules (spec §9): actual results in, parameterized i18n template keys out.
// No causal, predictive-performance or relevance claim; unavailable or non-significant results never read as absence.
import type { TextKey } from "../../i18n";
import type { DesignModel } from "../design/model";
import type { AssociationResult, JointRow } from "./model";

export interface Sentence {
  key: TextKey;
  vars: Record<string, string | number>;
  /** Factor the sentence is about (null for global sentences). */
  factor: string | null;
}

/** Heuristic η² landmarks (Cohen); context-dependent and not NIR-specific. */
export const ETA_LANDMARKS = [0.01, 0.06, 0.14] as const;
const SMALL_ETA = ETA_LANDMARKS[1];

export function jointSentences(rows: readonly JointRow[], design: DesignModel | null, associations: readonly AssociationResult[], targetId: string | null, fmt: (v: number) => string): Sentence[] {
  const out: Sentence[] = [];
  for (const r of rows) {
    const f = r.factor;
    if (r.spectralSignificant && r.targetSignificant) out.push({ key: "jtIBoth", vars: { factor: f }, factor: f });
    if (r.spectralSignificant && r.spectral?.aliasedWithCells) {
      out.push(r.spectral.determinedBy.length ? { key: "jtIConfounded", vars: { factor: f, other: r.spectral.determinedBy.join(", ") }, factor: f } : { key: "jtIAliased", vars: { factor: f }, factor: f });
    }
    if (r.targetSignificant && r.dispersionSignificant) out.push({ key: "jtITargetDispersion", vars: { factor: f }, factor: f });
    if (r.targetSignificant && r.eta2 !== null && r.eta2 < SMALL_ETA) out.push({ key: "jtISmallTarget", vars: { factor: f, eta: fmt(r.eta2), landmark: fmt(SMALL_ETA) }, factor: f });
    if (r.targetSignificant && r.spectralSignificant === false) out.push({ key: "jtITargetOnly", vars: { factor: f }, factor: f });
    const ny = r.target?.denominators.n_units_analyzed;
    if (r.spectralUnits !== null && ny !== undefined && r.target?.status === "computed" && ny !== r.spectralUnits) out.push({ key: "jtIDifferentPop", vars: { factor: f, nx: r.spectralUnits, ny }, factor: f });
  }
  const adjusted = rows.flatMap((r) => [r.spectral?.tests.within_cell, r.spectral?.tests.freedman_lane]).filter((t) => t && (t.state === "significant" || t.state === "not_significant"));
  if (adjusted.length && !adjusted.some((t) => t!.state === "significant")) out.push({ key: "jtINoAdjusted", vars: {}, factor: null });
  const cells = design?.joint?.r2AllCells ?? null;
  const marginals = (design?.factors ?? []).map((f) => f.r2?.marginal ?? null).filter((v): v is number => v !== null);
  const sum = marginals.reduce((a, v) => a + v, 0);
  if (cells !== null && marginals.length >= 2 && sum > cells + 1e-9) out.push({ key: "jtIOverlap", vars: { sum: fmt(sum), cells: fmt(cells) }, factor: null });
  const targetTests = associations.filter((a) => a.targetId === targetId && a.test?.status === "computed");
  if (targetId !== null && targetTests.length && !targetTests.some((a) => a.test!.rejects)) out.push({ key: "jtINoTarget", vars: { target: targetId }, factor: null });
  return out;
}
