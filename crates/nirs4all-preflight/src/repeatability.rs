//! Technical-repeat measurement protocols per technical context (repeat
//! type x instrument x campaign): repeat counts, pooled repeatability, the
//! balanced ICC(1,1), the REML ICC(1) for unbalanced designs and their
//! uncertainty (protocol `repeatability_uncertainty.v1`). The engine builds
//! contexts, groups, resampling units, seeds and statuses; Methods computes.
use crate::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub(crate) const PROTOCOL: &str = "repeatability_uncertainty.v1";
/// Two-sided confidence level of every published interval.
pub(crate) const CONFIDENCE: f64 = 0.95;
/// Cluster-bootstrap replicates per context.
pub(crate) const BOOTSTRAP_REPLICATES: usize = 999;
/// Fewer resampling units leave the bootstrap uncertainty insufficient.
pub(crate) const MIN_BOOTSTRAP_UNITS: usize = 20;
/// Methods refuses bootstraps above B x bands x (groups + 512) = 2.5e9.
const BOOTSTRAP_WORK_BUDGET: f64 = 2.5e9;
const COUNTS_ID: &str = "measurement.repeat_counts";
const REML_ID: &str = "measurement.icc_1_reml";
const SD_CHI2_ID: &str = "measurement.repeatability_sd_ci_chi_square";
const ICC_F_ID: &str = "measurement.icc_1_1_ci_exact_f";
const SD_BOOT_ID: &str = "measurement.repeatability_sd_ci_cluster_bootstrap";
const ICC_BOOT_ID: &str = "measurement.icc_1_reml_ci_cluster_bootstrap";
const REML_STATUS: &str = "0_interior_1_insufficient_2_between_variance_zero_3_zero_total_4_within_variance_zero_5_not_converged";

/// Repeat type, instrument and campaign of one technical context.
type Context<'a> = (&'a str, &'a str, &'a str);

fn with_context(mut m: Metric, context: Context) -> Metric {
    m.parameters.insert("repeat_type".into(), json!(context.0));
    m.parameters.insert("instrument".into(), json!(context.1));
    m.parameters.insert("campaign".into(), json!(context.2));
    m
}

pub(crate) fn analyze_repeats(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    dev_rows: &[usize],
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let Some(types) = &source.repetition_types else {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::NotApplicable,
            "REPETITION_TYPE_NOT_DECLARED",
            Some(&source.source_id),
            None,
        ));
        return;
    };
    let mut contexts: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for &r in dev_rows {
        let kind = match types[r] {
            RepetitionType::Rescan => "rescan",
            RepetitionType::Repositioning => "repositioning",
            RepetitionType::Repreparation => "repreparation",
            _ => continue,
        };
        let s = samples[source.sample_ids[r].as_str()];
        contexts
            .entry((
                kind.into(),
                s.instrument.clone().unwrap_or_default(),
                s.campaign.clone().unwrap_or_default(),
            ))
            .or_default()
            .push(r);
    }
    if contexts.is_empty() {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::NotApplicable,
            "NO_DECLARED_TECHNICAL_REPEATS",
            Some(&source.source_id),
            None,
        ));
        return;
    }
    let mut attempted = false;
    for ((kind, instrument, campaign), rows) in contexts {
        let mut group_map = BTreeMap::<String, i64>::new();
        let group_ids: Vec<i64> = rows
            .iter()
            .map(|&r| {
                let s = samples[source.sample_ids[r].as_str()];
                let physical = s
                    .physical_sample_id
                    .clone()
                    .unwrap_or_else(|| s.sample_id.clone());
                if let Some(id) = group_map.get(&physical) {
                    *id
                } else {
                    let id = group_map.len() as i64;
                    group_map.insert(physical, id);
                    id
                }
            })
            .collect();
        let counts: BTreeMap<i64, usize> = group_ids.iter().fold(BTreeMap::new(), |mut m, id| {
            *m.entry(*id).or_default() += 1;
            m
        });
        let context = (kind.as_str(), instrument.as_str(), campaign.as_str());
        report
            .metrics
            .push(repeat_counts(source, context, &counts, provider));
        if counts.values().filter(|&&n| n >= 2).count() < 2 {
            continue;
        }
        attempted = true;
        let request = RepeatabilityRequest {
            source_id: source.source_id.clone(),
            matrix: rows
                .iter()
                .map(|&r| source.x[r].iter().map(|v| v.unwrap_or(0.0)).collect())
                .collect(),
            group_ids,
            valid_mask: rows
                .iter()
                .map(|&r| {
                    (0..source.axis.len())
                        .map(|c| valid_cell(source, r, c).is_some())
                        .collect()
                })
                .collect(),
        };
        let uncertainty = Uncertainty {
            source,
            input,
            samples,
            context,
            rows: &rows,
            n_groups: counts.len(),
        };
        match provider.repeatability(&request) {
            Ok(d)
                if d.pooled_sd.len() == source.axis.len()
                    && d.icc.len() == source.axis.len()
                    && d.band_status.len() == source.axis.len()
                    && d.n_complete_groups.len() == source.axis.len()
                    && d.pooled_sd
                        .iter()
                        .flatten()
                        .all(|v| v.is_finite() && *v >= 0.0)
                    && d.icc.iter().flatten().all(|v| v.is_finite())
                    && d.band_status.iter().all(|&s| (0..=3).contains(&s))
                    && d.band_status
                        .iter()
                        .zip(&d.icc)
                        .all(|(&s, v)| (s == 0) == v.is_some()) =>
            {
                let mut m = if d.pooled_sd.iter().any(Option::is_some) {
                    Metric::computed(
                        "measurement.repeatability_sd",
                        json!(d.pooled_sd),
                        Some(&source.source_id),
                        None,
                    )
                } else {
                    Metric::unavailable(
                        "measurement.repeatability_sd",
                        Availability::InsufficientData,
                        "NO_BAND_WITH_REPEATS",
                        Some(&source.source_id),
                        None,
                    )
                };
                m.unit =
                    (!source.signal_unit.trim().is_empty()).then(|| source.signal_unit.clone());
                m.denominators.insert("n_observations".into(), rows.len());
                m.denominators
                    .insert("n_physical_groups".into(), counts.len());
                m.parameters.insert("repeat_type".into(), json!(kind));
                m.parameters.insert("instrument".into(), json!(instrument));
                m.parameters.insert("campaign".into(), json!(campaign));
                m.parameters
                    .insert("backend_version".into(), json!(d.backend_version));
                m.parameters.insert(
                    "band_status_0_icc_1_insufficient_2_unbalanced_3_zero_total".into(),
                    json!(d.band_status),
                );
                m.parameters.insert(
                    "n_groups_with_valid_observations_per_band".into(),
                    json!(d.n_complete_groups),
                );
                report.metrics.push(m);
                let mut icc = if d.band_status.contains(&0) {
                    Metric::computed(
                        "measurement.icc_1_1",
                        json!(d.icc),
                        Some(&source.source_id),
                        None,
                    )
                } else {
                    Metric::unavailable(
                        "measurement.icc_1_1",
                        Availability::Unsupported,
                        "UNBALANCED_OR_UNDEFINED_ALL_BANDS",
                        Some(&source.source_id),
                        None,
                    )
                };
                icc.parameters.insert(
                    "band_status_0_computed_1_insufficient_2_unbalanced_3_zero_total".into(),
                    json!(d.band_status),
                );
                icc.parameters.insert(
                    "n_groups_with_valid_observations_per_band".into(),
                    json!(d.n_complete_groups),
                );
                report.metrics.push(icc);
            }
            Ok(_) => report.metrics.push(Metric::unavailable(
                "measurement.repeatability_sd",
                Availability::Error,
                "INVALID_PROVIDER_RESULT",
                Some(&source.source_id),
                None,
            )),
            Err(e) => report.metrics.push(Metric::unavailable(
                "measurement.repeatability_sd",
                e.availability(),
                &e.reason,
                Some(&source.source_id),
                None,
            )),
        }
        uncertainty.analyze(request, provider, report);
    }
    if !attempted {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::InsufficientData,
            "FEWER_THAN_TWO_REPEATED_PHYSICAL_GROUPS",
            Some(&source.source_id),
            None,
        ));
    }
}

/// Repeat counts r_i of the physical groups of one context and their
/// dispersion (Methods summary); nothing is removed to balance the design.
fn repeat_counts(
    source: &SpectralSource,
    context: Context,
    counts: &BTreeMap<i64, usize>,
    provider: &impl MethodsProvider,
) -> Metric {
    let src = Some(source.source_id.as_str());
    let r: Vec<f64> = counts.values().map(|&n| n as f64).collect();
    let mut histogram = BTreeMap::<usize, usize>::new();
    for &n in counts.values() {
        *histogram.entry(n).or_default() += 1;
    }
    let repeated = counts.values().filter(|&&n| n >= 2).count();
    let mut m = match provider.summary(&SummaryRequest { values: r }) {
        Ok(d) if d.count == counts.len() => Metric::computed(
            COUNTS_ID,
            json!({
                "n_groups": counts.len(),
                "n_repeated_groups": repeated,
                "fraction_groups_repeated": repeated as f64 / counts.len() as f64,
                "r_min": d.min,
                "r_max": d.max,
                "r_mean": d.mean,
                "r_sd": d.sample_sd,
                "r_q25": d.q25,
                "r_median": d.median,
                "r_q75": d.q75,
                "histogram": histogram
                    .iter()
                    .map(|(r, n)| json!({"r": r, "n_groups": n}))
                    .collect::<Vec<_>>(),
            }),
            src,
            None,
        ),
        Ok(_) => Metric::unavailable(
            COUNTS_ID,
            Availability::Error,
            "INVALID_PROVIDER_RESULT",
            src,
            None,
        ),
        Err(e) => Metric::unavailable(COUNTS_ID, e.availability(), &e.reason, src, None),
    };
    m.denominators
        .insert("n_observations".into(), counts.values().sum());
    m.denominators
        .insert("n_physical_groups".into(), counts.len());
    m.parameters.insert(
        "counting".into(),
        json!("observations_per_physical_group_before_band_masks_sd_ddof_1_type7_quartiles"),
    );
    with_context(m, context)
}

/// Uncertainty of repeatability and REML ICC for one technical context.
struct Uncertainty<'a> {
    source: &'a SpectralSource,
    input: &'a QualificationInput,
    samples: &'a HashMap<&'a str, &'a Sample>,
    context: Context<'a>,
    rows: &'a [usize],
    n_groups: usize,
}

/// Why the cluster bootstrap did not run, when it did not.
type Gate = Option<(Availability, &'static str)>;

impl Uncertainty<'_> {
    fn metric(&self, m: Metric) -> Metric {
        let mut m = with_context(m, self.context);
        m.parameters.insert("protocol".into(), json!(PROTOCOL));
        m.denominators
            .insert("n_observations".into(), self.rows.len());
        m.denominators
            .insert("n_physical_groups".into(), self.n_groups);
        m
    }
    fn unavailable(&self, id: &str, status: Availability, reason: &str) -> Metric {
        self.metric(Metric::unavailable(
            id,
            status,
            reason,
            Some(&self.source.source_id),
            None,
        ))
    }

    /// Resampling unit of each row: the declared independence unit, linking
    /// physical samples that share an individual, a declared group (unit
    /// `group`) or a reference group (unit `reference_group`). IDs follow the
    /// first row of each unit, so Methods orders units by appearance.
    fn resampling_units(&self) -> Result<Vec<i64>, (Availability, &'static str)> {
        let unit = self.input.options.independence_unit;
        if unit == IndependenceUnit::Unknown {
            return Err((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN"));
        }
        let mut references = HashMap::<&str, Vec<&str>>::new();
        if unit == IndependenceUnit::ReferenceGroup {
            for target in &self.input.targets {
                for v in &target.values {
                    if let Some(group) = &v.reference_group_id {
                        references.entry(&v.sample_id).or_default().push(group);
                    }
                }
            }
        }
        let n = self.rows.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        let mut first = BTreeMap::<String, usize>::new();
        for (i, &r) in self.rows.iter().enumerate() {
            let s = self.samples[self.source.sample_ids[r].as_str()];
            let physical = s.physical_sample_id.as_ref().unwrap_or(&s.sample_id);
            let mut keys = vec![format!("physical:{physical}")];
            if let Some(individual) = &s.individual_id {
                keys.push(format!("individual:{individual}"));
            }
            if unit == IndependenceUnit::Group {
                match &s.independence_group {
                    Some(group) => keys.push(format!("group:{group}")),
                    None => {
                        return Err((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"))
                    }
                }
            }
            for group in references.get(s.sample_id.as_str()).into_iter().flatten() {
                keys.push(format!("reference:{group}"));
            }
            for key in keys {
                if let Some(&j) = first.get(&key) {
                    let (a, b) = (root(&mut parent, i), root(&mut parent, j));
                    parent[a.max(b)] = a.min(b);
                } else {
                    first.insert(key, i);
                }
            }
        }
        Ok((0..n).map(|i| root(&mut parent, i) as i64).collect())
    }

    fn bootstrap_plan(&self, units: usize, gate: Gate, valid: Option<&[usize]>) -> Value {
        let domain = self.seed_domain();
        json!({
            "plan_version": "bootstrap_plan.v1",
            "resampling_unit": self.input.options.independence_unit,
            "unit_linking": "physical_sample_individual_and_declared_group_or_reference_group",
            "n_resampling_units": units,
            "min_resampling_units": MIN_BOOTSTRAP_UNITS,
            "n_replicates_requested": BOOTSTRAP_REPLICATES,
            "executed": gate.is_none(),
            "reason_code": gate.map(|g| g.1),
            "draw_method": "units_with_replacement_each_drawn_unit_contributes_all_its_groups",
            "rng_algorithm": "methods_pcg64_numpy_default_rng_integers_0_U_size_B_by_U",
            "seed": derive_seed(self.input.options.seed, &domain).to_string(),
            "seed_derivation": format!("splitmix64_finalizer(options.seed XOR fnv1a64({domain:?}))"),
            "same_draws_for_every_band": true,
            "interval": "percentile_type7",
            "replicate_validity": "reml_status_0_2_or_4_in_the_band",
            "band_reported_only_if_all_replicates_valid": true,
            "n_valid_replicates_per_band": valid,
        })
    }

    fn seed_domain(&self) -> String {
        let (kind, instrument, campaign) = self.context;
        format!(
            "nirs4all-preflight\0methods\0{PROTOCOL}\0{}\0{kind}\0{instrument}\0{campaign}",
            self.source.source_id
        )
    }

    fn analyze(
        &self,
        request: RepeatabilityRequest,
        provider: &impl MethodsProvider,
        report: &mut QualificationReport,
    ) {
        let p = self.source.axis.len();
        let units = self.resampling_units();
        let n_units = units.as_ref().map_or(0, |u| {
            u.iter().collect::<std::collections::BTreeSet<_>>().len()
        });
        let work = BOOTSTRAP_REPLICATES as f64 * p as f64 * (self.n_groups as f64 + 512.0);
        let gate: Gate = match &units {
            Err(e) => Some(e.clone()),
            Ok(_) if n_units < MIN_BOOTSTRAP_UNITS => Some((
                Availability::InsufficientData,
                "FEWER_THAN_20_RESAMPLING_UNITS",
            )),
            Ok(_) if work > BOOTSTRAP_WORK_BUDGET => {
                Some((Availability::Unsupported, "BOOTSTRAP_WORK_BUDGET_EXCEEDED"))
            }
            Ok(_) => None,
        };
        let vc_request = VarianceComponentsRequest {
            matrix: request.matrix,
            group_ids: request.group_ids,
            cluster_ids: units.as_ref().ok().filter(|_| gate.is_none()).cloned(),
            valid_mask: request.valid_mask,
            confidence: CONFIDENCE,
            n_bootstrap: if gate.is_none() {
                BOOTSTRAP_REPLICATES
            } else {
                0
            },
            seed: derive_seed(self.input.options.seed, &self.seed_domain()),
        };
        let ids = [REML_ID, SD_CHI2_ID, ICC_F_ID, SD_BOOT_ID, ICC_BOOT_ID];
        let d = match provider.variance_components(&vc_request) {
            Ok(d) if valid_result(&d, p, vc_request.n_bootstrap) => d,
            Ok(_) => {
                for id in ids {
                    report.metrics.push(self.unavailable(
                        id,
                        Availability::Error,
                        "INVALID_PROVIDER_RESULT",
                    ));
                }
                return;
            }
            Err(e) => {
                for id in ids {
                    report
                        .metrics
                        .push(self.unavailable(id, e.availability(), &e.reason));
                }
                return;
            }
        };
        let src = Some(self.source.source_id.as_str());
        let signal_unit =
            (!self.source.signal_unit.trim().is_empty()).then(|| self.source.signal_unit.clone());
        let usable = |s: i32| matches!(s, 0 | 2 | 4);
        let icc: Vec<Option<f64>> = d
            .icc
            .iter()
            .zip(&d.status)
            .map(|(v, &s)| v.filter(|_| usable(s)))
            .collect();
        let mut reml = if icc.iter().any(Option::is_some) {
            Metric::computed(REML_ID, json!(icc), src, None)
        } else if d.status.iter().all(|&s| s == 3) {
            Metric::unavailable(
                REML_ID,
                Availability::Undefined,
                "ZERO_TOTAL_VARIANCE",
                src,
                None,
            )
        } else {
            Metric::unavailable(
                REML_ID,
                Availability::InsufficientData,
                "NO_BAND_WITH_ESTIMABLE_REML",
                src,
                None,
            )
        };
        let count_status = |code: i32| d.status.iter().filter(|&&s| s == code).count();
        for (key, value) in [
            (
                "model",
                json!("x_ij = mu + u_i + e_ij, u_i ~ N(0, s2_between), e_ij ~ N(0, s2_within)"),
            ),
            (
                "estimator",
                json!("reml_profiled_grid_then_derivative_bisection"),
            ),
            (
                "icc_definition",
                json!("s2_between / (s2_between + s2_within), single acquisition"),
            ),
            (
                "groups",
                json!("physical_samples_with_valid_band_value_singletons_included"),
            ),
            ("sigma2_between", json!(d.sigma2_between)),
            ("sigma2_within", json!(d.sigma2_within)),
            (
                "variance_unit",
                json!(signal_unit.as_ref().map(|u| format!("({u})^2"))),
            ),
            ("reml_log_likelihood", json!(d.reml_log_likelihood)),
            (
                "reml_log_likelihood_convention",
                json!("statsmodels_mixedlm_reml"),
            ),
            ("band_status", json!(d.status)),
            ("band_status_codes", json!(REML_STATUS)),
            ("n_bands_between_variance_zero", json!(count_status(2))),
            ("n_bands_within_variance_zero", json!(count_status(4))),
            ("n_bands_not_converged", json!(count_status(5))),
            ("n_groups_per_band", json!(d.n_groups)),
            ("n_observations_per_band", json!(d.n_observations)),
            ("grid_local_minima_per_band", json!(d.grid_local_minima)),
            (
                "bisection_iterations_per_band",
                json!(d.bisection_iterations),
            ),
            ("backend_version", json!(d.backend_version)),
        ] {
            reml.parameters.insert(key.into(), value);
        }
        report.metrics.push(self.metric(reml));

        let df: Vec<usize> = d
            .n_observations
            .iter()
            .zip(&d.n_groups)
            .map(|(n, g)| n.saturating_sub(*g))
            .collect();
        let interval_metric = |id: &str, bands: &[Interval], empty: (Availability, &str)| {
            let mut m = if bands.iter().any(|b| b[0].is_some() && b[1].is_some()) {
                Metric::computed(
                    id,
                    json!({
                        "lower": bands.iter().map(|b| b[0]).collect::<Vec<_>>(),
                        "upper": bands.iter().map(|b| b[1]).collect::<Vec<_>>(),
                    }),
                    src,
                    None,
                )
            } else {
                Metric::unavailable(id, empty.0, empty.1, src, None)
            };
            m.parameters.insert("confidence".into(), json!(CONFIDENCE));
            m.parameters
                .insert("backend_version".into(), json!(d.backend_version));
            m
        };
        let mut chi = interval_metric(
            SD_CHI2_ID,
            &d.sd_ci_chi_square,
            (
                Availability::InsufficientData,
                "NO_BAND_WITH_WITHIN_GROUP_DF",
            ),
        );
        chi.unit = signal_unit.clone();
        chi.parameters.insert(
            "method".into(),
            json!("exact_chi_square_on_pooled_within_ss: sqrt(SSW/chi2_{1-a/2,df}), sqrt(SSW/chi2_{a/2,df})"),
        );
        chi.parameters.insert("df_per_band".into(), json!(df));
        chi.parameters.insert(
            "assumptions".into(),
            json!(
                "normal_homoscedastic_within_group_errors_independent_of_between_group_dependence"
            ),
        );
        report.metrics.push(self.metric(chi));

        let mut exact = if self.input.options.independence_unit == IndependenceUnit::Unknown {
            self.unavailable(
                ICC_F_ID,
                Availability::NotIdentifiable,
                "INDEPENDENCE_UNIT_UNKNOWN",
            )
        } else {
            self.metric(interval_metric(
                ICC_F_ID,
                &d.icc_ci_exact_f,
                (Availability::Unsupported, "NO_BALANCED_BAND"),
            ))
        };
        exact.parameters.insert(
            "method".into(),
            json!("searle_exact_f: F=MSB/MSW, FL=F/F_{1-a/2}(g-1,N-g), FU=F*F_{1-a/2}(N-g,g-1), (F*-1)/(F*+r-1)"),
        );
        exact
            .parameters
            .insert("truncation".into(), json!("none_bounds_may_be_negative"));
        exact.parameters.insert(
            "applies_to".into(),
            json!("measurement.icc_1_1 bands with equal r >= 2 after the band mask"),
        );
        report.metrics.push(exact);

        let valid = d.n_valid_replicates.as_slice();
        let complete = |bands: &[Interval]| -> Vec<Interval> {
            bands
                .iter()
                .zip(valid)
                .map(|(b, &v)| {
                    if v == BOOTSTRAP_REPLICATES {
                        *b
                    } else {
                        [None, None]
                    }
                })
                .collect()
        };
        for (id, bands, unit) in [
            (SD_BOOT_ID, &d.sd_ci_bootstrap, signal_unit.clone()),
            (ICC_BOOT_ID, &d.icc_ci_bootstrap, None),
        ] {
            let mut m = match &gate {
                Some((status, reason)) => self.unavailable(id, status.clone(), reason),
                None => self.metric(interval_metric(
                    id,
                    &complete(bands),
                    (
                        Availability::InsufficientData,
                        "BOOTSTRAP_REPLICATES_NOT_ESTIMABLE",
                    ),
                )),
            };
            m.unit = unit;
            m.parameters.insert(
                "bootstrap_plan".into(),
                self.bootstrap_plan(n_units, gate.clone(), gate.is_none().then_some(valid)),
            );
            report.metrics.push(m);
        }
    }
}

fn valid_result(d: &VarianceComponentsDiagnostics, p: usize, b: usize) -> bool {
    let finite_nonnegative =
        |v: &[Option<f64>]| v.len() == p && v.iter().flatten().all(|x| x.is_finite() && *x >= 0.0);
    let intervals =
        |v: &[Interval]| v.len() == p && v.iter().flatten().flatten().all(|x| x.is_finite());
    finite_nonnegative(&d.sigma2_between)
        && finite_nonnegative(&d.sigma2_within)
        && d.icc.len() == p
        && d.icc.iter().flatten().all(|v| (0.0..=1.0).contains(v))
        && d.reml_log_likelihood.len() == p
        && d.status.len() == p
        && d.status.iter().all(|s| (0..=5).contains(s))
        && [
            &d.n_groups,
            &d.n_observations,
            &d.grid_local_minima,
            &d.bisection_iterations,
        ]
        .iter()
        .all(|v| v.len() == p)
        && intervals(&d.sd_ci_chi_square)
        && intervals(&d.icc_ci_exact_f)
        && intervals(&d.sd_ci_bootstrap)
        && intervals(&d.icc_ci_bootstrap)
        && d.n_valid_replicates.len() == p
        && d.n_valid_replicates.iter().all(|&v| v <= b)
}

/// Structure sensitivity to unequal repeat counts: each aggregated sample
/// keeps r* = min r_i of its acquisitions, drawn without replacement with a
/// declared seed, before the same mean, centering and PCA. Samples with a
/// single acquisition stay; nothing is removed to fabricate balance.
pub(crate) fn balanced_repeat_sensitivity(
    source: &SpectralSource,
    group_rows: &[Vec<usize>],
    k: usize,
    canonical: Result<&PcaDiagnostics, (Availability, &str)>,
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    const ID: &str = "structure.balanced_repeat_sensitivity";
    const SENSITIVITY: &str = "balanced_repeat_sensitivity.v1";
    let src = Some(source.source_id.as_str());
    let push = |report: &mut QualificationReport, mut m: Metric| {
        m.view_id = "canonical:centered".into();
        m.parameters.insert("protocol".into(), json!(SENSITIVITY));
        report.metrics.push(m);
    };
    let canonical = match canonical {
        Ok(c) => c,
        Err((status, reason)) => {
            push(report, Metric::unavailable(ID, status, reason, src, None));
            return;
        }
    };
    let counts: Vec<usize> = group_rows.iter().map(Vec::len).collect();
    let (Some(&r_star), Some(&r_max)) = (counts.iter().min(), counts.iter().max()) else {
        return;
    };
    if r_star == r_max {
        push(
            report,
            Metric::unavailable(
                ID,
                Availability::NotApplicable,
                "REPEAT_COUNTS_ALREADY_EQUAL",
                src,
                None,
            ),
        );
        return;
    }
    if canonical.full_moments[0] <= 0.0 {
        push(
            report,
            Metric::unavailable(
                ID,
                Availability::Undefined,
                "ZERO_TOTAL_VARIANCE",
                src,
                None,
            ),
        );
        return;
    }
    let domain = format!("nirs4all-preflight\0{SENSITIVITY}\0{}", source.source_id);
    let seed = derive_seed(input.options.seed, &domain);
    let mut rng = crate::clustering::SplitMix64(seed);
    let p = source.axis.len();
    let matrix: Vec<Vec<f64>> = group_rows
        .iter()
        .map(|rows| {
            let mut chosen = rows.clone();
            for i in 0..r_star {
                let j = i + rng.below(chosen.len() - i);
                chosen.swap(i, j);
            }
            chosen.truncate(r_star);
            (0..p)
                .map(|c| {
                    chosen
                        .iter()
                        .filter_map(|&r| valid_cell(source, r, c))
                        .sum::<f64>()
                        / r_star as f64
                })
                .collect()
        })
        .collect();
    let n = matrix.len();
    let request = PcaRequest {
        source_id: source.source_id.clone(),
        sample_ids: Vec::new(),
        matrix,
        n_components: k,
    };
    let result = match provider.pca(&request) {
        Ok(r) if pca_result_valid(&r, k, n) => r,
        Ok(_) => {
            push(
                report,
                Metric::unavailable(
                    ID,
                    Availability::Error,
                    "INVALID_PROVIDER_RESULT",
                    src,
                    None,
                ),
            );
            return;
        }
        Err(e) => {
            push(
                report,
                Metric::unavailable(ID, e.availability(), &e.reason, src, None),
            );
            return;
        }
    };
    if result.full_moments[0] <= 0.0 {
        push(
            report,
            Metric::unavailable(
                ID,
                Availability::Undefined,
                "ZERO_BALANCED_TOTAL_VARIANCE",
                src,
                None,
            ),
        );
        return;
    }
    let reference = pca_structure(canonical);
    let balanced = pca_structure(&result);
    let delta = |key: &str| match (reference[key].as_f64(), balanced[key].as_f64()) {
        (Some(a), Some(b)) => json!(b - a),
        _ => Value::Null,
    };
    let mut histogram = BTreeMap::<usize, usize>::new();
    for &r in &counts {
        *histogram.entry(r).or_default() += 1;
    }
    let mut m = Metric::computed(
        ID,
        json!({
            "canonical": reference,
            "balanced": balanced,
            "delta_first_component_share": delta("first_component_share"),
            "delta_retained_share": delta("retained_share"),
            "delta_effective_dimension": delta("effective_dimension"),
        }),
        src,
        None,
    );
    m.denominators.insert("n_aggregated_samples".into(), n);
    m.denominators.insert(
        "n_aggregated_samples_subsampled".into(),
        counts.iter().filter(|&&r| r > r_star).count(),
    );
    m.denominators
        .insert("n_observations_used".into(), n * r_star);
    for (key, value) in [
        ("r_star", json!(r_star)),
        (
            "r_star_rule",
            json!("min_repeat_count_over_aggregated_samples"),
        ),
        (
            "repeat_count_histogram",
            json!(histogram
                .iter()
                .map(|(r, n)| json!({"r": r, "n_samples": n}))
                .collect::<Vec<_>>()),
        ),
        (
            "policy",
            json!(
                "subsample_each_aggregated_sample_to_r_star_without_replacement_no_sample_removed"
            ),
        ),
        ("n_subsamples", json!(1)),
        (
            "rng_algorithm",
            json!("splitmix64_partial_fisher_yates_per_sample_in_aggregation_order"),
        ),
        ("seed", json!(seed.to_string())),
        (
            "seed_derivation",
            json!(format!(
                "splitmix64_finalizer(options.seed XOR fnv1a64({domain:?}))"
            )),
        ),
        ("reference_view", json!("canonical:centered")),
        ("n_components", json!(k)),
        ("shares_denominator", json!("full_variance_trace")),
        ("backend_version", json!(result.backend_version)),
        (
            "interpretation",
            json!("descriptive_change_only_unequal_mean_noise_not_attributed"),
        ),
    ] {
        m.parameters.insert(key.into(), value);
    }
    push(report, m);
}
