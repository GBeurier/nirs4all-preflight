// "Shift between domains" model: engine values of every comparison (read through the nirs4all-ui selector
// `extractDomainShift` plus the raw metric values it does not expose), the display-level relative metrics
// derived from them, the inference status and the deterministic interpretation rules.
//
// Retained-test protection: nothing in this folder reads `input.targets`. The only target information shown
// is the engine's own development-only `domain_shift.target_change` value of non-audit comparisons.
import { extractDomainShift, type DomainComparison, type DomainShiftFactor, type DomainShiftTest, type MetricState, type QualificationMetricView, type QualificationReportView } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";
import { BLOCKING_REASONS } from "./strings";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Display name of a domain level (the audit's partitions read as populations). */
export const domainName = (d: string) => (d === "retained_test" ? "Retained test" : d === "development" ? "Calibration (development)" : d);

export interface CentreModel {
  /** Engine: Euclidean norm of the centroid difference in the monitor input space (signal unit). */
  distance: number | null;
  subspace: number | null;
  residual: number | null;
  /** Engine: T² of the centroid difference with the reference eigenvalues (not comparable to individual limits). */
  centroidT2: number | null;
  /** distance / sqrt(reference total variance): reference RMS distance to its centroid, ddof 1, same space. */
  relative: number | null;
  /** residual² / distance² (squared fraction of the displacement outside the reference PCA subspace). */
  outsideSquaredShare: number | null;
}

export interface DispersionModel {
  referenceTotal: number | null;
  comparedTotal: number | null;
  ratio: number | null;
  /** 100 × ratio. */
  relativePercent: number | null;
  /** sqrt(ratio). */
  relativeSd: number | null;
  /** 100 × (ratio − 1). */
  differencePercent: number | null;
}

export interface EnergyModel {
  value: number | null;
  interval: [number, number] | null;
  meanBetween: number | null;
  meanWithinReference: number | null;
  meanWithinCompared: number | null;
  /** energy_e / mean within-reference pairwise distance (V-statistic, self-pairs included). */
  relative: number | null;
}

export interface CoverageModel {
  t2Limit: number | null;
  qLimit: number | null;
  nBeyondT2: number | null;
  nBeyondQ: number | null;
  nBeyondEither: number | null;
  /** nBeyondT2 + nBeyondQ − nBeyondEither. */
  nBeyondBoth: number | null;
  nCompared: number | null;
  nominal: number | null;
  components: number | null;
  limitType: string | null;
  retainedVariance: number | null;
}

export interface ComparisonModel {
  key: string;
  factor: string;
  audit: boolean;
  referenceName: string;
  comparedName: string;
  referenceLevels: readonly string[];
  comparedLevel: string;
  nReferenceUnits: number | null;
  nComparedUnits: number | null;
  nReferenceSamples: number | null;
  nComparedSamples: number | null;
  centre: CentreModel;
  dispersion: DispersionModel;
  energy: EnergyModel;
  coverage: CoverageModel;
  /** Engine development-only target change (never for the retained-test audit). */
  target: { medianDifference: number; unit: string | null } | null;
  /** Monitor / energy input spaces as declared by the engine. */
  monitorSpace: string | null;
  energySpace: string | null;
  unavailable: Readonly<Record<string, MetricState>>;
}

export interface InferenceModel {
  status: "valid" | "unavailable" | "absent";
  test: DomainShiftTest | null;
  reasonCode: string | null;
  missing: string[];
}

export interface FactorModel {
  factor: string;
  audit: boolean;
  comparisons: ComparisonModel[];
  inference: InferenceModel;
  raw: DomainShiftFactor;
}

const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function metricOf(view: QualificationReportView, sourceId: string, id: string, c: DomainComparison): QualificationMetricView | undefined {
  return view.metrics.find((m) => m.sourceId === sourceId && m.id === id && m.status === "computed"
    && (str(m.parameters.factor) ?? "—") === c.factor && str(m.parameters.target_domain) === c.targetDomain
    && Array.isArray(m.parameters.reference_domains) && sameStrings(m.parameters.reference_domains as string[], c.referenceDomains));
}

const spaceOf = (m: QualificationMetricView | undefined, key: string): string | null => {
  const s = m?.parameters[key];
  return str(s) ?? str(rec(s).space);
};

export function comparisonModel(view: QualificationReportView, sourceId: string, c: DomainComparison): ComparisonModel {
  const disp = metricOf(view, sourceId, "domain_shift.dispersion", c);
  const dist = metricOf(view, sourceId, "domain_shift.distribution_distance", c);
  const cov = metricOf(view, sourceId, "domain_shift.coverage", c);
  const centre = metricOf(view, sourceId, "domain_shift.center_shift", c);
  const dv = rec(disp?.value);
  const ev = rec(dist?.value);
  const cv = rec(cov?.value);
  const refTotal = num(dv.reference_total_variance);
  const ratio = c.varianceRatio ?? num(dv.variance_ratio);
  const refSd = refTotal !== null && refTotal > 0 ? Math.sqrt(refTotal) : null;
  const withinRef = num(ev.mean_within_reference_distance);
  const nT2 = num(cv.n_target_beyond_t2_limit);
  const nQ = num(cv.n_target_beyond_q_limit);
  const nEither = num(cv.n_target_beyond_either_limit);
  const comp = rec(rec(cov?.parameters.composition ?? centre?.parameters.composition));
  const refComp = rec(comp.reference);
  const cmpComp = rec(comp.target);
  return {
    key: c.key,
    factor: c.factor,
    audit: c.audit,
    referenceName: c.referenceDomains.map(domainName).join(" + "),
    comparedName: domainName(c.targetDomain),
    referenceLevels: c.referenceDomains,
    comparedLevel: c.targetDomain,
    nReferenceUnits: c.nReference ?? num(refComp.n_units),
    nComparedUnits: c.nTarget ?? num(cmpComp.n_units),
    nReferenceSamples: num(refComp.n_aggregated_samples),
    nComparedSamples: num(cmpComp.n_aggregated_samples),
    centre: {
      distance: c.centroidDistance,
      subspace: c.subspaceDistance,
      residual: c.residualDistance,
      centroidT2: c.hotellingT2,
      relative: c.centroidDistance !== null && refSd !== null ? c.centroidDistance / refSd : null,
      outsideSquaredShare: c.centroidDistance !== null && c.residualDistance !== null && c.centroidDistance > 0 ? (c.residualDistance / c.centroidDistance) ** 2 : null,
    },
    dispersion: {
      referenceTotal: refTotal,
      comparedTotal: num(dv.target_total_variance),
      ratio,
      relativePercent: ratio === null ? null : 100 * ratio,
      relativeSd: ratio === null || ratio < 0 ? null : Math.sqrt(ratio),
      differencePercent: ratio === null ? null : 100 * (ratio - 1),
    },
    energy: {
      value: c.energy,
      interval: c.energyInterval,
      meanBetween: num(ev.mean_between_distance),
      meanWithinReference: withinRef,
      meanWithinCompared: num(ev.mean_within_target_distance),
      relative: c.energy !== null && withinRef !== null && withinRef > 0 ? Math.max(0, c.energy) / withinRef : null,
    },
    coverage: {
      t2Limit: num(cv.t2_limit),
      qLimit: num(cv.q_limit),
      nBeyondT2: nT2,
      nBeyondQ: nQ,
      nBeyondEither: nEither,
      nBeyondBoth: nT2 !== null && nQ !== null && nEither !== null ? nT2 + nQ - nEither : null,
      nCompared: c.nTarget,
      nominal: c.nominalFraction,
      components: num(cov?.parameters.n_components_effective),
      limitType: str(cov?.parameters.limit_type),
      retainedVariance: num(cv.reference_retained_variance_fraction),
    },
    // Development-only engine value; the audit never carries one (RETAINED_TEST_Y_NEVER_READ).
    target: !c.audit && c.medianDifference !== null ? { medianDifference: c.medianDifference, unit: c.targetUnit } : null,
    monitorSpace: spaceOf(cov, "input_space"),
    energySpace: spaceOf(dist, "space"),
    unavailable: c.unavailable,
  };
}

/** Declarations the energy test needs that the input does not carry (listed with the engine's blocking reason). */
export function missingDeclarations(input: EngineInput, sourceId: string, reasonCode: string | null): string[] {
  const out: string[] = [];
  if (reasonCode && BLOCKING_REASONS[reasonCode]) out.push(BLOCKING_REASONS[reasonCode]!);
  const unit = input.options.independence_unit ?? "unknown";
  if (unit === "unknown" && reasonCode !== "INDEPENDENCE_UNIT_UNKNOWN") out.push(BLOCKING_REASONS.INDEPENDENCE_UNIT_UNKNOWN!);
  if (!input.samples.some((s) => s.physical_sample_id)) out.push("Physical sample identifier: no sample declares one, so technical repeats cannot be told apart from independent samples.");
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (source && new Set(source.sample_ids).size < source.sample_ids.length && !source.repetition_types?.length) out.push("Technical replicate grouping: repeated acquisitions carry no declared repetition type.");
  if (unit === "group" && input.samples.some((s) => !s.independence_group) && reasonCode !== "MISSING_INDEPENDENCE_GROUP") out.push(BLOCKING_REASONS.MISSING_INDEPENDENCE_GROUP!);
  if (!input.options.exchangeable_units && reasonCode !== "EXCHANGEABILITY_NOT_DECLARED") out.push(BLOCKING_REASONS.EXCHANGEABILITY_NOT_DECLARED!);
  return [...new Set(out)];
}

export function inferenceModel(f: DomainShiftFactor, input: EngineInput, sourceId: string): InferenceModel {
  const t = f.test;
  if (!t) return { status: "absent", test: null, reasonCode: null, missing: [] };
  if (t.state.status === "computed" && t.pValue !== null) return { status: "valid", test: t, reasonCode: null, missing: [] };
  return { status: "unavailable", test: t, reasonCode: t.state.reasonCode, missing: missingDeclarations(input, sourceId, t.state.reasonCode) };
}

/** Every factor with at least one comparison, the audit last. */
export function domainModel(view: QualificationReportView, input: EngineInput, sourceId: string): FactorModel[] {
  return extractDomainShift(view, sourceId)
    .filter((f) => f.comparisons.length)
    .map((f) => ({ factor: f.factor, audit: f.audit, comparisons: f.comparisons.map((c) => comparisonModel(view, sourceId, c)), inference: inferenceModel(f, input, sourceId), raw: f }))
    .sort((a, b) => Number(a.audit) - Number(b.audit));
}

// --- per-sample diagnostics summaries (computed in kernels.ts) ----------------------------------------------

export interface CoverageSupport {
  /** Share of compared units whose nearest reference distance ≤ P95 of reference→reference nearest distances. */
  supported: number | null;
  /** Share of reference units whose nearest compared distance ≤ P95 of compared→compared nearest distances. */
  represented: number | null;
}

export interface EnergyContext {
  status: "available" | "approximate" | "unavailable";
  reason: string | null;
  percentile: number | null;
  typical: number | null;
}

// --- deterministic interpretation (§14) -----------------------------------------------------------------------

export interface Interpretation {
  findings: { id: string; text: string; tone: "attention" | "info" | "neutral" }[];
  investigate: string[];
}

const pct = (v: number, digits = 4) => `${Number((v * 100).toPrecision(digits))}%`;

/**
 * Deterministic statements, only when the values support them. Thresholds are mathematical reference points
 * (ratio 1, half / double variance, one tenth of compared units), never calibrated risk limits.
 */
export function interpret(c: ComparisonModel, inference: InferenceModel, extra: { support?: CoverageSupport | null; energy?: EnergyContext | null; region?: string | null } = {}): Interpretation {
  const findings: Interpretation["findings"] = [];
  const investigate: string[] = [];
  const r = c.dispersion.ratio;
  const n = c.coverage.nCompared;
  const either = c.coverage.nBeyondEither;
  const mostlyWithin = either !== null && n !== null && n > 0 && either / n <= 0.1;
  const restricted = r !== null && r < 0.5 && mostlyWithin && extra.support?.represented !== null && extra.support?.represented !== undefined && extra.support.represented < 0.5;
  if (r !== null) {
    findings.push({ id: "variance-share", text: `The compared population has ${pct(r)} of the total spectral variance observed in the reference population.`, tone: "neutral" });
    if (r < 0.5) {
      findings.push({ id: "narrower", text: restricted
        ? "The compared domain exhibits substantially lower spectral diversity than the reference domain. It may cover only a restricted part of the calibration population."
        : "The compared domain exhibits substantially lower spectral diversity than the reference domain.", tone: "attention" });
    } else if (r < 1) findings.push({ id: "narrower", text: "The compared domain is narrower than the reference domain.", tone: "info" });
    else if (r > 2) findings.push({ id: "broader", text: "The compared domain is substantially broader than the reference domain: part of its diversity may not be represented in the reference.", tone: "attention" });
    else if (r > 1) findings.push({ id: "broader", text: "The compared domain is broader than the reference domain.", tone: "info" });
  }
  const rel = c.centre.relative;
  if (rel !== null) {
    const cmp = rel < 0.9 ? "smaller than" : rel <= 1.1 ? "comparable to" : "larger than";
    findings.push({ id: "centre", text: `The distance between the domain centres is ${cmp} the typical spread of the reference population (relative centre shift ${Number(rel.toPrecision(3))}).`, tone: rel > 1.1 ? "attention" : "neutral" });
  }
  if (extra.region) findings.push({ id: "region", text: `The domain centres differ primarily in the ${extra.region} region.`, tone: "info" });
  if (mostlyWithin) findings.push({ id: "within", text: "Most compared samples remain within the reference T² and Q limits.", tone: "info" });
  if (c.coverage.nBeyondQ !== null && n !== null && n > 0 && c.coverage.nBeyondQ >= 2 && c.coverage.nBeyondQ / n > 0.1) {
    findings.push({ id: "high-q", text: "Several samples exhibit elevated Q residuals, indicating spectral structures poorly represented by the reference subspace.", tone: "attention" });
  }
  if (c.audit && r !== null && r < 0.5 && mostlyWithin) {
    findings.push({ id: "audit-restricted", text: restricted
      ? "Most retained-test samples are compatible with the calibration spectral space, but the retained-test population has substantially lower spectral diversity. This may limit the representativeness of the validation dataset."
      : "The retained test population appears to be concentrated within a restricted region of calibration space.", tone: "attention" });
  }
  if (extra.energy && extra.energy.status !== "unavailable" && extra.energy.percentile !== null && extra.energy.percentile >= 0.95) {
    findings.push({ id: "energy", text: `The energy distance is larger than typical differences observed between comparable reference subsets${extra.energy.status === "approximate" ? " (approximate reference)" : ""}.`, tone: "attention" });
  }
  if (inference.status === "unavailable") findings.push({ id: "inference", text: "Statistical inference is unavailable because independent experimental units and exchangeability conditions have not been established.", tone: "neutral" });
  if (inference.status === "valid" && inference.test?.rejects === false) findings.push({ id: "test", text: "No statistically significant evidence of distribution shift under the specified test.", tone: "neutral" });
  if (inference.status === "valid" && inference.test?.rejects === true) findings.push({ id: "test", text: "The energy permutation test rejects exchangeability of the two domains at the family level (Holm).", tone: "attention" });

  if (rel !== null && rel > 1.1) investigate.push("Compare acquisition conditions, instrument settings, baseline and sample preparation between the two domains.");
  if (r !== null && r < 0.5) investigate.push("Check whether the compared domain samples only part of the composition range of the reference.");
  if (c.coverage.nBeyondQ !== null && c.coverage.nBeyondQ > 0) investigate.push("Inspect the spectra of the samples beyond the Q limit for structures absent from the reference.");
  if (inference.status === "unavailable") investigate.push("Declare independent units, technical replicate grouping and exchangeability in the dataset settings to enable the permutation test.");
  return { findings, investigate };
}

// --- engine permutation plan of a valid test (input of the local null distribution) ----------------------------

export interface TestPlan {
  factor: string;
  /** Decimal u64 seed of the engine plan (derived per source and factor). */
  seed: string;
  permutations: number;
  statistic: number | null;
  pValue: number | null;
  pValueHolm: number | null;
  atLeast: number | null;
  family: string | null;
  /** Engine p-values entered in the Holm family, with this test at `member`. */
  familyPValues: number[] | null;
  familyFactors: string[];
  member: number;
  familyAlpha: number | null;
  exchangeableUnit: string | null;
  restrictions: string | null;
  drawMethod: string | null;
  rng: string | null;
  convention: string | null;
  seedDerivation: string | null;
  space: string | null;
}

/** Plan of a computed energy test of one factor (the audit is factor `partition`), or null when not valid. */
export function testPlan(view: QualificationReportView, sourceId: string, factor: string): TestPlan | null {
  const t = view.metrics.find((m) => m.sourceId === sourceId && m.id === "domain_shift.energy_test" && m.status === "computed" && str(m.parameters.factor) === factor);
  if (!t) return null;
  const plan = rec(t.parameters.permutation_plan);
  const v = rec(t.value);
  const seed = plan.seed;
  const permutations = num(plan.n_permutations_executed);
  if ((typeof seed !== "string" && typeof seed !== "number") || permutations === null || permutations < 1) return null;
  const family = str(t.parameters.family);
  const fm = view.metrics.find((m) => m.sourceId === sourceId && m.id === "domain_shift.test_family" && str(m.parameters.family) === family);
  const members = Array.isArray(rec(fm?.value).members) ? (rec(fm?.value).members as unknown[]).map(rec) : [];
  const ps = members.map((x) => num(x.p_value_entered));
  const member = members.findIndex((x) => str(x.factor) === factor);
  return {
    factor,
    seed: String(seed),
    permutations,
    statistic: num(v.statistic),
    pValue: num(v.p_value),
    pValueHolm: num(v.p_value_holm),
    atLeast: num(v.n_at_least_observed),
    family,
    familyPValues: member >= 0 && ps.every((p) => p !== null) ? (ps as number[]) : null,
    familyFactors: members.map((x) => str(x.factor) ?? "—"),
    member,
    familyAlpha: num(rec(fm?.value).family_alpha),
    exchangeableUnit: str(plan.exchangeable_unit),
    restrictions: str(plan.restrictions),
    drawMethod: str(plan.draw_method),
    rng: str(plan.rng_algorithm),
    convention: str(plan.p_value_convention),
    seedDerivation: str(plan.seed_derivation),
    space: spaceOf(t, "space"),
  };
}
