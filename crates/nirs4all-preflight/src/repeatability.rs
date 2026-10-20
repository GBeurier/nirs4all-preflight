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
/// Methods refuses bootstraps above B x bands x (groups + 1024) = 2.5e9.
const BOOTSTRAP_WORK_BUDGET: f64 = 2.5e9;
/// Measured coverage of the percentile cluster bootstrap (not calibrated).
const COVERAGE_NOTE: &str =
    "not_qualified_percentile_interval_measured_coverage_in_docs_REUSE_ENGINE";
/// Numerical domain of the Methods kernel, published with the REML metric.
const NUMERICAL_DOMAIN: &str = "rules_13_15: nonzero |x| in [2^-256, 2^256], spread <= 2^32 over values and the differences used; outside: unsupported NUMERICAL_DOMAIN_EXCEEDED; inside: exact power-of-two scaling from centred variation, per-group residuals from original values";
const COUNTS_ID: &str = "measurement.repeat_counts";
const REML_ID: &str = "measurement.icc_1_reml";
const SD_CHI2_ID: &str = "measurement.repeatability_sd_ci_chi_square";
const ICC_F_ID: &str = "measurement.icc_1_1_ci_exact_f";
const SD_BOOT_ID: &str = "measurement.repeatability_sd_ci_cluster_bootstrap";
const ICC_BOOT_ID: &str = "measurement.icc_1_reml_ci_cluster_bootstrap";
/// Shared Methods constant N4M_DOMAIN_MAX_SPREAD_LOG2 (lead rule 15).
const DOMAIN_MAX_SPREAD_LOG2: i32 = 32;
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
                icc.denominators.insert("n_observations".into(), rows.len());
                icc.denominators
                    .insert("n_physical_groups".into(), counts.len());
                icc.parameters.insert("repeat_type".into(), json!(kind));
                icc.parameters
                    .insert("instrument".into(), json!(instrument));
                icc.parameters.insert("campaign".into(), json!(campaign));
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

/// Per-band reason codes of the protocol.
const INSUFFICIENT: &str = "INSUFFICIENT_GROUPS_OR_REPEATS";
const ZERO_TOTAL: &str = "ZERO_TOTAL_VARIANCE";
const NOT_CONVERGED: &str = "REML_NOT_CONVERGED";
const SHARED_UNIT: &str = "GROUPS_SHARE_INDEPENDENCE_UNIT";
const UNBALANCED: &str = "UNBALANCED_BAND";
const NO_WITHIN_DF: &str = "NO_WITHIN_GROUP_DF";
const FEW_UNITS: &str = "FEWER_THAN_20_RESAMPLING_UNITS";
const FEW_WITHIN_UNITS: &str = "FEWER_THAN_20_UNITS_WITH_WITHIN_DF";
const REPLICATES: &str = "BOOTSTRAP_REPLICATES_NOT_ESTIMABLE";

/// Status of a metric without any computed band, from its band reasons:
/// numerical failures first, then the most specific data shortage.
fn summary_status(
    reasons: &[Option<&'static str>],
    fallback: &'static str,
) -> (Availability, &'static str) {
    let has = |code: &str| reasons.iter().flatten().any(|r| *r == code);
    if has(NOT_CONVERGED) {
        (Availability::Error, NOT_CONVERGED)
    } else if !reasons.is_empty() && reasons.iter().all(|r| *r == Some(ZERO_TOTAL)) {
        (Availability::Undefined, ZERO_TOTAL)
    } else if has(SHARED_UNIT) {
        (Availability::Unsupported, SHARED_UNIT)
    } else if has(REPLICATES) {
        (Availability::InsufficientData, REPLICATES)
    } else if has(FEW_WITHIN_UNITS) && !has(FEW_UNITS) {
        (Availability::InsufficientData, FEW_WITHIN_UNITS)
    } else if has(FEW_UNITS) {
        (Availability::InsufficientData, FEW_UNITS)
    } else if !reasons.is_empty() && reasons.iter().all(|r| *r == Some(INSUFFICIENT)) {
        (Availability::InsufficientData, INSUFFICIENT)
    } else if !reasons.is_empty() && reasons.iter().all(|r| *r == Some(UNBALANCED)) {
        (Availability::Unsupported, "NO_BALANCED_BAND")
    } else {
        (Availability::InsufficientData, fallback)
    }
}

/// Per-band resampling-unit counts after the band masks.
struct BandUnits {
    /// Units with at least one valid value in the band.
    present: Vec<usize>,
    /// Units holding a group with at least two valid values (within df).
    within: Vec<usize>,
    /// Some unit holds two or more physical groups present in the band.
    shared: Vec<bool>,
}

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

    /// Independence unit of each row: the identity component of its sample
    /// (physical sample, individual, augmentation parent, declared group when
    /// the unit is `group`, reference groups of every target), as shared with
    /// association and confounding. The declared unit must be resolvable for
    /// every participating sample: `group` needs `independence_group` and
    /// `reference_group` needs a `reference_group_id`; nothing falls back to
    /// physical samples silently.
    fn resampling_units(&self) -> Result<Vec<i64>, (Availability, &'static str)> {
        let unit = self.input.options.independence_unit;
        if unit == IndependenceUnit::Unknown {
            return Err((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN"));
        }
        let mut referenced = std::collections::HashSet::<&str>::new();
        for target in &self.input.targets {
            for v in &target.values {
                if v.reference_group_id.is_some() {
                    referenced.insert(&v.sample_id);
                }
            }
        }
        let targets: Vec<&Target> = self.input.targets.iter().collect();
        let component = independence_components(self.input, &targets);
        let index: HashMap<&str, usize> = self
            .input
            .samples
            .iter()
            .enumerate()
            .map(|(i, s)| (s.sample_id.as_str(), i))
            .collect();
        let mut out = Vec::with_capacity(self.rows.len());
        for &r in self.rows {
            let s = self.samples[self.source.sample_ids[r].as_str()];
            match unit {
                IndependenceUnit::Group if s.independence_group.is_none() => {
                    return Err((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"))
                }
                IndependenceUnit::ReferenceGroup if !referenced.contains(s.sample_id.as_str()) => {
                    return Err((Availability::NotIdentifiable, "MISSING_REFERENCE_GROUP"))
                }
                _ => {}
            }
            out.push(component[index[s.sample_id.as_str()]] as i64);
        }
        Ok(out)
    }

    fn band_units(&self, request: &VarianceComponentsRequest, units: &[i64]) -> BandUnits {
        let p = self.source.axis.len();
        let mut out = BandUnits {
            present: vec![0; p],
            within: vec![0; p],
            shared: vec![false; p],
        };
        for j in 0..p {
            let mut per_group = BTreeMap::<i64, (i64, usize)>::new();
            for (i, &g) in request.group_ids.iter().enumerate() {
                if request.valid_mask[i][j] {
                    per_group.entry(g).or_insert((units[i], 0)).1 += 1;
                }
            }
            let mut present = std::collections::BTreeSet::new();
            let mut within = std::collections::BTreeSet::new();
            for &(unit, count) in per_group.values() {
                present.insert(unit);
                if count >= 2 {
                    within.insert(unit);
                }
            }
            out.present[j] = present.len();
            out.within[j] = within.len();
            out.shared[j] = present.len() < per_group.len();
        }
        out
    }

    fn bootstrap_plan(
        &self,
        units: usize,
        gate: &Gate,
        bands: Option<(&BandUnits, &[usize])>,
    ) -> Value {
        let domain = self.seed_domain();
        json!({
            "plan_version": "bootstrap_plan.v2",
            "resampling_unit": self.input.options.independence_unit,
            "unit_linking": "shared_independence_components",
            "n_resampling_units": units,
            "min_resampling_units_per_band": MIN_BOOTSTRAP_UNITS,
            "n_units_with_valid_value_per_band": bands.map(|b| &b.0.present),
            "n_units_with_within_df_per_band": bands.map(|b| &b.0.within),
            "n_replicates_requested": BOOTSTRAP_REPLICATES,
            "executed": gate.is_none(),
            "reason_code": gate.as_ref().map(|g| g.1),
            "draw_method": "units_with_replacement_each_drawn_unit_contributes_all_its_groups",
            "rng_algorithm": "methods_pcg64_numpy_default_rng_integers_0_U_size_B_by_U",
            "seed": derive_seed(self.input.options.seed, &domain).to_string(),
            "seed_derivation": format!("splitmix64_finalizer(options.seed XOR fnv1a64({domain:?}))"),
            "same_draws_for_every_band": true,
            "interval": "percentile_type7",
            "coverage": COVERAGE_NOTE,
            "replicate_validity": "reml_status_0_2_or_4_in_the_band",
            "band_reported_only_if_all_replicates_valid": true,
            "n_valid_replicates_per_band": bands.map(|b| b.1),
        })
    }

    fn seed_domain(&self) -> String {
        let (kind, instrument, campaign) = self.context;
        format!(
            "nirs4all-preflight\0methods\0{PROTOCOL}\0{}\0{kind}\0{instrument}\0{campaign}",
            self.source.source_id
        )
    }

    /// Interval metric from per-band intervals and reasons (null bands carry
    /// their reason; a metric without band gets `summary_status`).
    fn interval_metric(
        &self,
        id: &str,
        bands: &[Interval],
        reasons: &[Option<&'static str>],
        fallback: &'static str,
        backend: &str,
    ) -> Metric {
        let src = Some(self.source.source_id.as_str());
        let kept: Vec<Interval> = bands
            .iter()
            .zip(reasons)
            .map(|(b, r)| if r.is_none() { *b } else { [None, None] })
            .collect();
        let mut m = if reasons.iter().any(Option::is_none) {
            Metric::computed(
                id,
                json!({
                    "lower": kept.iter().map(|b| b[0]).collect::<Vec<_>>(),
                    "upper": kept.iter().map(|b| b[1]).collect::<Vec<_>>(),
                }),
                src,
                None,
            )
        } else {
            let (status, reason) = summary_status(reasons, fallback);
            Metric::unavailable(id, status, reason, src, None)
        };
        m.parameters.insert("confidence".into(), json!(CONFIDENCE));
        m.parameters.insert("band_reason".into(), json!(reasons));
        m.parameters
            .insert("backend_version".into(), json!(backend));
        self.metric(m)
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
        let mut vc_request = VarianceComponentsRequest {
            matrix: request.matrix,
            group_ids: request.group_ids,
            cluster_ids: None,
            valid_mask: request.valid_mask,
            confidence: CONFIDENCE,
            n_bootstrap: 0,
            seed: derive_seed(self.input.options.seed, &self.seed_domain()),
        };
        let bands = units.as_ref().ok().map(|u| self.band_units(&vc_request, u));
        let work = BOOTSTRAP_REPLICATES as f64 * p as f64 * (self.n_groups as f64 + 1024.0);
        let gate: Gate = match (&units, &bands) {
            (Err(e), _) => Some(e.clone()),
            (Ok(_), Some(b)) if b.present.iter().all(|&u| u < MIN_BOOTSTRAP_UNITS) => {
                Some((Availability::InsufficientData, FEW_UNITS))
            }
            _ if work > BOOTSTRAP_WORK_BUDGET => {
                Some((Availability::Unsupported, "BOOTSTRAP_WORK_BUDGET_EXCEEDED"))
            }
            _ => None,
        };
        if gate.is_none() {
            vc_request.cluster_ids = units.as_ref().ok().cloned();
            vc_request.n_bootstrap = BOOTSTRAP_REPLICATES;
        }
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
                    let mut m = self.unavailable(id, e.availability(), &e.reason);
                    m.parameters
                        .insert("numerical_domain".into(), json!(NUMERICAL_DOMAIN));
                    report.metrics.push(m);
                }
                return;
            }
        };
        let src = Some(self.source.source_id.as_str());
        let signal_unit =
            (!self.source.signal_unit.trim().is_empty()).then(|| self.source.signal_unit.clone());
        let reml_reason: Vec<Option<&'static str>> = d
            .status
            .iter()
            .map(|s| match s {
                0 | 2 | 4 => None,
                1 => Some(INSUFFICIENT),
                3 => Some(ZERO_TOTAL),
                _ => Some(NOT_CONVERGED),
            })
            .collect();
        let icc: Vec<Option<f64>> = d
            .icc
            .iter()
            .zip(&reml_reason)
            .map(|(v, r)| v.filter(|_| r.is_none()))
            .collect();
        let mut reml = if reml_reason.iter().any(Option::is_none) {
            Metric::computed(REML_ID, json!(icc), src, None)
        } else {
            let (status, reason) = summary_status(&reml_reason, "NO_BAND_WITH_ESTIMABLE_REML");
            Metric::unavailable(REML_ID, status, reason, src, None)
        };
        let count_status = |code: i32| d.status.iter().filter(|&&s| s == code).count();
        for (key, value) in [
            (
                "model",
                json!("x_ij = mu + u_i + e_ij, u_i ~ N(0, s2_between), e_ij ~ N(0, s2_within)"),
            ),
            (
                "estimator",
                json!("reml_profiled_grid_candidates_detected_by_the_grid_refined_largest_likelihood_kept"),
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
            ("band_reason", json!(reml_reason)),
            ("n_bands_between_variance_zero", json!(count_status(2))),
            ("n_bands_within_variance_zero", json!(count_status(4))),
            ("n_bands_not_converged", json!(count_status(5))),
            ("n_groups_per_band", json!(d.n_groups)),
            ("n_observations_per_band", json!(d.n_observations)),
            ("reml_candidates_per_band", json!(d.reml_candidates)),
            (
                "bisection_iterations_per_band",
                json!(d.bisection_iterations),
            ),
            ("numerical_domain", json!(NUMERICAL_DOMAIN)),
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
        let chi_reason: Vec<Option<&'static str>> = (0..p)
            .map(|j| if df[j] == 0 { Some(NO_WITHIN_DF) } else { None })
            .collect();
        let mut chi = self.interval_metric(
            SD_CHI2_ID,
            &d.sd_ci_chi_square,
            &chi_reason,
            "NO_BAND_WITH_WITHIN_GROUP_DF",
            &d.backend_version,
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
        report.metrics.push(chi);

        let mut exact = match (&units, &bands) {
            (Err(e), _) => self.unavailable(ICC_F_ID, e.0.clone(), e.1),
            (Ok(_), Some(b)) => {
                let reasons: Vec<Option<&'static str>> = (0..p)
                    .map(|j| {
                        // A missing bound is explained by the band itself:
                        // no variation at all, too few groups or repeats,
                        // or unequal repeat counts after the mask.
                        if d.icc_ci_exact_f[j][0].is_some() {
                            if b.shared[j] {
                                Some(SHARED_UNIT)
                            } else {
                                None
                            }
                        } else if d.status[j] == 3 {
                            Some(ZERO_TOTAL)
                        } else if d.status[j] == 1 {
                            Some(INSUFFICIENT)
                        } else if b.shared[j] {
                            Some(SHARED_UNIT)
                        } else {
                            Some(UNBALANCED)
                        }
                    })
                    .collect();
                let mut m = self.interval_metric(
                    ICC_F_ID,
                    &d.icc_ci_exact_f,
                    &reasons,
                    "NO_BALANCED_BAND",
                    &d.backend_version,
                );
                m.parameters.insert(
                    "groups_share_independence_unit_per_band".into(),
                    json!(b.shared),
                );
                m
            }
            (Ok(_), None) => unreachable!("band units exist for resolved units"),
        };
        exact.parameters.insert(
            "method".into(),
            json!("searle_exact_f: F=MSB/MSW, FL=F/F_{1-a/2}(g-1,N-g), FU=F*F_{1-a/2}(N-g,g-1), (F*-1)/(F*+r-1)"),
        );
        exact.parameters.insert(
            "eligibility".into(),
            json!("balanced_band_and_every_physical_group_its_own_independence_unit"),
        );
        exact
            .parameters
            .insert("truncation".into(), json!("none_bounds_may_be_negative"));
        report.metrics.push(exact);

        let valid = d.n_valid_replicates.as_slice();
        for (id, intervals, unit) in [
            (SD_BOOT_ID, &d.sd_ci_bootstrap, signal_unit.clone()),
            (ICC_BOOT_ID, &d.icc_ci_bootstrap, None),
        ] {
            let mut m = match (&gate, &bands) {
                (Some((status, reason)), _) => self.unavailable(id, status.clone(), reason),
                (None, Some(b)) => {
                    let reasons: Vec<Option<&'static str>> = (0..p)
                        .map(|j| {
                            if b.present[j] < MIN_BOOTSTRAP_UNITS {
                                Some(FEW_UNITS)
                            } else if id == SD_BOOT_ID && b.within[j] < MIN_BOOTSTRAP_UNITS {
                                Some(FEW_WITHIN_UNITS)
                            } else if valid[j] < BOOTSTRAP_REPLICATES {
                                Some(REPLICATES)
                            } else {
                                None
                            }
                        })
                        .collect();
                    self.interval_metric(id, intervals, &reasons, REPLICATES, &d.backend_version)
                }
                (None, None) => unreachable!("an executed bootstrap has resolved units"),
            };
            m.unit = unit;
            m.parameters.insert(
                "bootstrap_plan".into(),
                self.bootstrap_plan(
                    n_units,
                    &gate,
                    bands
                        .as_ref()
                        .filter(|_| gate.is_none())
                        .map(|b| (b, valid)),
                ),
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
            &d.reml_candidates,
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

/// Rules 13/15 supported domain of an engine computation: every nonzero |x|
/// in [2^-256, 2^256] and max/min nonzero |x| <= 2^32 (exact comparisons).
fn in_domain(values: impl Iterator<Item = f64>) -> bool {
    let (lowest, highest) = (2f64.powi(-256), 2f64.powi(256));
    let (mut lo, mut hi) = (f64::INFINITY, 0.0f64);
    for v in values.map(f64::abs).filter(|v| *v != 0.0) {
        if !(lowest..=highest).contains(&v) {
            return false;
        }
        lo = lo.min(v);
        hi = hi.max(v);
    }
    hi == 0.0 || hi <= lo * 2f64.powi(DOMAIN_MAX_SPREAD_LOG2)
}

/// Mean from a Neumaier (Kahan-Babuska) compensated sum: each addition's
/// rounding error is accumulated exactly and added back, so the sum is
/// exact whenever it needs no more than double precision for the result
/// (for example [2^60, 1, -2^60] sums to 1 in every order). Inside the
/// supported domain the sum cannot overflow. One rounding for the sum and
/// one for the division remain: relative error of a few ulps.
fn compensated_mean(values: &[f64]) -> f64 {
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for &v in values {
        let t = sum + v;
        compensation += if sum.abs() >= v.abs() {
            (sum - t) + v
        } else {
            (v - t) + sum
        };
        sum = t;
    }
    (sum + compensation) / values.len() as f64
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
    const SENSITIVITY_DOMAIN: &str = "rules_13_15: per band, nonzero |x| in [2^-256, 2^256] and spread <= 2^32 over the acquisitions of the aggregated samples; means from a Neumaier compensated sum";
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
    let p = source.axis.len();
    let within_domain = (0..p).all(|c| {
        in_domain(
            group_rows
                .iter()
                .flatten()
                .filter_map(|&r| valid_cell(source, r, c)),
        )
    });
    if !within_domain {
        let mut m = Metric::unavailable(
            ID,
            Availability::Unsupported,
            NUMERICAL_DOMAIN_EXCEEDED,
            src,
            None,
        );
        m.parameters
            .insert("numerical_domain".into(), json!(SENSITIVITY_DOMAIN));
        push(report, m);
        return;
    }
    let mut rng = SplitMix64(seed);
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
                    let values: Vec<f64> = chosen
                        .iter()
                        .filter_map(|&r| valid_cell(source, r, c))
                        .collect();
                    compensated_mean(&values)
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
    // Unresolved components (below Methods' resolution) are not variance.
    let result = match provider.pca(&request) {
        Ok(r) if pca_result_valid(&r, k, n) => r.resolved(),
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
        ("numerical_domain", json!(SENSITIVITY_DOMAIN)),
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

/// SplitMix64 stream for the seeded replicate subsets of the sensitivity view.
struct SplitMix64(u64);
impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Unbiased integer in [0, bound) by rejection.
    fn below(&mut self, bound: usize) -> usize {
        let bound = bound as u64;
        let zone = u64::MAX - u64::MAX % bound;
        loop {
            let v = self.next();
            if v < zone {
                return (v % bound) as usize;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::compensated_mean;

    /// Exact mean of doubles as a rational S / (n 2^E) with an i128
    /// numerator (spread <= 2^32 keeps it far below 2^127), rounded once
    /// through f64 for the comparison.
    fn rational_mean(values: &[f64]) -> f64 {
        let parts: Vec<(i128, i32)> = values
            .iter()
            .map(|&v| {
                if v == 0.0 {
                    return (0, 0);
                }
                let bits = v.to_bits();
                let exponent = ((bits >> 52) & 0x7ff) as i32;
                let mantissa = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
                let signed = if v < 0.0 {
                    -(mantissa as i128)
                } else {
                    mantissa as i128
                };
                (signed, exponent - 1075)
            })
            .collect();
        let e = parts
            .iter()
            .filter(|p| p.0 != 0)
            .map(|p| p.1)
            .min()
            .unwrap_or(0);
        let s: i128 = parts
            .iter()
            .map(|&(m, x)| if m == 0 { 0 } else { m << (x - e) })
            .sum();
        s as f64 * 2f64.powi(e) / values.len() as f64
    }

    fn permutations(values: &[f64]) -> Vec<Vec<f64>> {
        if values.len() <= 1 {
            return vec![values.to_vec()];
        }
        let mut out = Vec::new();
        for i in 0..values.len() {
            let mut rest = values.to_vec();
            let head = rest.remove(i);
            for mut tail in permutations(&rest) {
                tail.insert(0, head);
                out.push(tail);
            }
        }
        out
    }

    /// Review b9fix P0: [2^60, 1, -2^60] must give 1/3 in every order (the
    /// residual-mean correction gave 0 or 5/9).
    #[test]
    fn neumaier_mean_recovers_lost_terms_in_every_order() {
        let x = 2f64.powi(60);
        for p in permutations(&[x, 1.0, -x]) {
            assert_eq!(compensated_mean(&p), 1.0 / 3.0, "{p:?}");
        }
    }

    /// Rational oracle inside the supported domain (spread <= 2^32):
    /// decimal values, offsets and mixed signs, every permutation within one
    /// ulp of the exact mean rounded through f64.
    #[test]
    fn compensated_mean_matches_rational_oracle_in_every_order() {
        let sets: [&[f64]; 4] = [
            &[0.1, 0.2, 0.3, 0.7],
            &[1e9 + 0.1, 1e9 - 0.3, 1e9 + 0.7, 1e9],
            &[4.2e9, 1.0, -4.2e9, 3.7],
            &[2.5e-3, -7.3e-4, 1.1e-2, 9.9e-3, -3.3e-3],
        ];
        for set in sets {
            let exact = rational_mean(set);
            for p in permutations(set) {
                let got = compensated_mean(&p);
                let ulp = f64::from_bits(exact.abs().to_bits() + 1) - exact.abs();
                assert!((got - exact).abs() <= ulp, "{p:?}: {got} vs {exact}");
            }
        }
    }
}
