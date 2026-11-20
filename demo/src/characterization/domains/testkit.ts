// Synthetic engine report and input for the domain-shift tests (shapes of domain_shift.v2 metrics).
import type { QualificationMetricView, QualificationReportView } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";

type Over = Partial<{ centroid: number; residual: number; subspace: number; refVar: number; tgtVar: number; energy: number; within: number; nT2: number; nQ: number; nEither: number; nRef: number; nTgt: number; testStatus: string; testReason: string | null; pValue: number | null }>;

export function metric(id: string, value: unknown, params: Record<string, unknown>, over: Partial<QualificationMetricView> = {}): QualificationMetricView {
  return { id, status: "computed", reasonCode: null, scope: "source_comparison", sourceId: "nir", targetId: null, viewId: "v", populationId: "p", value: value as QualificationMetricView["value"], unit: null, denominators: {}, parameters: params, protocolVersion: "domain_shift.v2", ...over };
}

export function auditView(o: Over = {}): QualificationReportView {
  const p = { factor: "partition", comparison: "development_vs_retained_test", target_domain: "retained_test", reference_domains: ["development"], test_access: "X_only_no_fit_no_Y", composition: { reference: { n_units: o.nRef ?? 40, n_aggregated_samples: o.nRef ?? 40 }, target: { n_units: o.nTgt ?? 20, n_aggregated_samples: o.nTgt ?? 20 } } };
  const den = { n_reference_units: o.nRef ?? 40, n_target_units: o.nTgt ?? 20 };
  const metrics = [
    metric("domain_shift.center_shift", { centroid_distance: o.centroid ?? 2, reference_subspace_distance: o.subspace ?? 1.6, residual_distance: o.residual ?? 1.2, centroid_hotelling_t2: 3 }, { ...p, input_space: { space: "complete_canonical_spectra" } }, { denominators: den }),
    metric("domain_shift.dispersion", { reference_total_variance: o.refVar ?? 16, target_total_variance: (o.refVar ?? 16) * 0.1487, variance_ratio: o.tgtVar ?? 0.1487 }, p, { denominators: den }),
    metric("domain_shift.distribution_distance", { energy_e: o.energy ?? 1.5, energy_e_interval: [1.4, 1.6], mean_within_reference_distance: o.within ?? 3, mean_between_distance: 3.5, mean_within_target_distance: 1 }, { ...p, space: { space: "complete_canonical_spectra" } }, { denominators: den }),
    metric("domain_shift.coverage", { t2_limit: 9, q_limit: 2, n_target_beyond_t2_limit: o.nT2 ?? 1, n_target_beyond_q_limit: o.nQ ?? 1, n_target_beyond_either_limit: o.nEither ?? 1, fraction_target_beyond_t2_limit: (o.nT2 ?? 1) / (o.nTgt ?? 20), fraction_target_beyond_q_limit: (o.nQ ?? 1) / (o.nTgt ?? 20), fraction_target_beyond_either_limit: (o.nEither ?? 1) / (o.nTgt ?? 20), nominal_fraction_per_limit: 0.05 }, { ...p, n_components_effective: 4, limit_type: "empirical_type7_quantile_of_out_of_fold_reference_statistics", input_space: { space: "complete_canonical_spectra" } }, { denominators: den }),
    metric("domain_shift.target_change", null, { ...p }, { status: "not_applicable" as QualificationMetricView["status"], reasonCode: "RETAINED_TEST_Y_NEVER_READ", targetId: "y" }),
    metric("domain_shift.energy_test", o.testStatus === "computed" ? { statistic: 12, p_value: o.pValue ?? 0.2, p_value_conservative: o.pValue ?? 0.2, p_value_holm: o.pValue ?? 0.2, rejects_null_at_family_alpha: (o.pValue ?? 0.2) < 0.05 } : null, { ...p, permutation_plan: { n_permutations_executed: 999 }, family: "external_domain_audit" }, o.testStatus === "computed" ? {} : { status: "not_identifiable" as QualificationMetricView["status"], reasonCode: o.testReason ?? "INDEPENDENCE_UNIT_UNKNOWN" }),
  ];
  return { metrics } as unknown as QualificationReportView;
}

/** Development / retained-test input with smooth spectra; retained-test rows optionally shifted or narrowed. */
export function auditInput(opts: { nDev?: number; nTest?: number; p?: number; shift?: number; scale?: number; outside?: number } = {}): EngineInput {
  const nDev = opts.nDev ?? 24;
  const nTest = opts.nTest ?? 10;
  const p = opts.p ?? 40;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const x: number[][] = [];
  const ids: string[] = [];
  for (let i = 0; i < nDev + nTest; i++) {
    const test = i >= nDev;
    const a = rnd() * (test ? (opts.scale ?? 1) : 1);
    const b = rnd() * (test ? (opts.scale ?? 1) : 1);
    x.push(Array.from({ length: p }, (_, j) => 1 + a * Math.sin(j / 6) + b * Math.cos(j / 9) + 0.01 * rnd() + (test ? (opts.shift ?? 0) + (opts.outside ?? 0) * (j % 2 ? 1 : -1) : 0)));
    ids.push(`s${i}`);
  }
  return {
    schema_version: 1,
    sources: [{ source_id: "nir", observation_ids: ids.map((s) => `o-${s}`), sample_ids: ids, x, axis: Array.from({ length: p }, (_, j) => 1000 + 2 * j), axis_unit: "nm", signal_unit: "A" }],
    samples: ids.map((s, i) => ({ sample_id: s, partition: i >= nDev ? "retained_test" : "development" })),
    targets: [{ target_id: "y", kind: "continuous", values: ids.map((s, i) => ({ sample_id: s, value: i, status: "exact" })) }],
    options: { domain_shift: { external_domain_audit: true } },
  };
}
