//! Domain shift between declared domains (protocol `domain_shift.v1`,
//! exploratory). Methods computes energy distances, the K-sample energy
//! permutation test, reference PCA monitoring (effective rank, T², Q,
//! out-of-fold limits, exceedance counts), summaries and Holm; this module
//! owns the populations, independence units, comparisons, permutation plans,
//! seeds, statuses and findings.
//!
//! Domains are the levels of declared categorical factors among real
//! development samples, and, under the declared `external_domain_audit`
//! profile, development versus retained-test X. Retained-test Y is never read.
//!
//! Estimand: every comparison is between distributions of independence-unit
//! mean spectra (a unit is the equal-weight mean of its aggregated samples).
//! With one sample per unit this is the distribution of sample spectra.
use crate::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROTOCOL: &str = "domain_shift.v1";
/// Monte Carlo budget per global test (specification section 6).
const PERMUTATIONS: usize = 999;
/// Holm family-wise error rate of each per-source test family.
const FAMILY_ALPHA: f64 = 0.05;
/// Coverage limits are the (1 - alpha) quantiles of out-of-fold statistics.
const COVERAGE_ALPHA: f64 = 0.05;
const MAX_FOLDS: usize = 10;
const MAX_COMPONENTS: usize = 10;
/// sqrt(f64::EPSILON), applied by Methods relative to T (energy scale).
const TIE_TOLERANCE: f64 = 1.490_116_119_384_765_6e-8;
const VIEW: &str = "canonical:centered";
/// Factor name of the development versus retained-test comparison.
const PARTITION: &str = "partition";
const ESTIMAND: &str = "distribution_of_independence_unit_mean_spectra";
/// Listed identifiers in a refusal, at most.
const MAX_LISTED_IDS: usize = 20;

/// Identity component (smallest linked sample index) of every sample ID,
/// from every identity and reference link (`independence_components`).
fn components(input: &QualificationInput) -> HashMap<&str, usize> {
    let targets: Vec<&Target> = input.targets.iter().collect();
    let roots = independence_components(input, &targets);
    input
        .samples
        .iter()
        .zip(roots)
        .map(|(s, r)| (s.sample_id.as_str(), r))
        .collect()
}

/// Categorical domain factors, in report order.
fn domain_factors(input: &QualificationInput) -> Vec<MetadataFactor<'_>> {
    input
        .metadata_factors()
        .into_iter()
        .filter(|f| f.kind == MetadataKind::Categorical)
        .collect()
}

fn level<'a>(
    input: &'a QualificationInput,
    factor: &MetadataFactor<'_>,
    sample: &'a Sample,
) -> Option<&'a str> {
    match input.metadata_value(factor, sample)? {
        MetadataLevel::Category(c) => Some(c),
        MetadataLevel::Value(_) => None,
    }
}

/// Independence units of one partition: unit-mean aggregated spectra.
struct Population {
    aggregation: Aggregation,
    /// Aggregated rows of each unit, units ordered by their first row.
    units: Vec<Vec<usize>>,
    coordinates: Vec<Vec<f64>>,
    missing_group: bool,
}

fn population(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    input: &QualificationInput,
    component: &HashMap<&str, usize>,
    partition: Partition,
) -> Population {
    let aggregation = aggregate(source, samples, &real_rows(source, samples, partition));
    let mut by_component = BTreeMap::<usize, Vec<usize>>::new();
    for (row, id) in aggregation.sample_ids.iter().enumerate() {
        by_component
            .entry(component[id.as_str()])
            .or_default()
            .push(row);
    }
    let mut units: Vec<Vec<usize>> = by_component.into_values().collect();
    units.sort_by_key(|rows| rows[0]);
    let p = source.axis.len();
    let coordinates = units
        .iter()
        .map(|rows| {
            (0..p)
                .map(|c| {
                    rows.iter().map(|&r| aggregation.matrix[r][c]).sum::<f64>() / rows.len() as f64
                })
                .collect()
        })
        .collect();
    let missing_group = input.options.independence_unit == IndependenceUnit::Group
        && aggregation
            .sample_ids
            .iter()
            .any(|id| samples[id.as_str()].independence_group.is_none());
    Population {
        aggregation,
        units,
        coordinates,
        missing_group,
    }
}

/// Composition of a set of units: their number, aggregated samples and the
/// range of samples per unit.
fn composition(population: &Population, units: &[usize]) -> Value {
    let sizes: Vec<usize> = units.iter().map(|&u| population.units[u].len()).collect();
    json!({
        "n_units": sizes.len(),
        "n_aggregated_samples": sizes.iter().sum::<usize>(),
        "min_samples_per_unit": sizes.iter().min(),
        "max_samples_per_unit": sizes.iter().max(),
    })
}

/// True when every listed unit holds the same number of aggregated samples,
/// so unit means are exchangeable whenever the samples are.
fn equal_composition(population: &Population, units: &[usize]) -> bool {
    units
        .windows(2)
        .all(|w| population.units[w[0]].len() == population.units[w[1]].len())
}

/// Unit levels of one factor: Some(level) when every member sample carries
/// the same level; counts of units with a missing or varying level.
fn unit_levels<'a>(
    population: &Population,
    input: &'a QualificationInput,
    samples: &HashMap<&str, &'a Sample>,
    factor: &MetadataFactor<'_>,
) -> (Vec<Option<&'a str>>, usize, usize) {
    let (mut missing, mut varies) = (0, 0);
    let levels = population
        .units
        .iter()
        .map(|rows| {
            let values: Vec<Option<&str>> = rows
                .iter()
                .map(|&r| {
                    level(
                        input,
                        factor,
                        samples[population.aggregation.sample_ids[r].as_str()],
                    )
                })
                .collect();
            if values.iter().any(Option::is_none) {
                missing += 1;
                return None;
            }
            let distinct: BTreeSet<&str> = values.into_iter().flatten().collect();
            if distinct.len() > 1 {
                varies += 1;
                return None;
            }
            distinct.first().copied()
        })
        .collect();
    (levels, missing, varies)
}

fn tag(metric: &mut Metric, scope: &str, factor: &str) {
    metric.view_id = VIEW.into();
    metric.scope = scope.into();
    metric.parameters.insert("protocol".into(), json!(PROTOCOL));
    metric.parameters.insert("factor".into(), json!(factor));
    metric.parameters.insert("estimand".into(), json!(ESTIMAND));
    metric
        .parameters
        .insert("numerical_domain".into(), json!(DIFFERENCE_NUMERICAL_DOMAIN));
}

fn unavailable_metric(
    id: &str,
    status: Availability,
    reason: &str,
    source_id: &str,
    factor: &str,
) -> Metric {
    let mut metric = Metric::unavailable(id, status, reason, Some(source_id), None);
    tag(&mut metric, "source_factor", factor);
    metric
}

/// One comparison: a target domain against the reference domain, in a space
/// learned on the reference only.
struct Comparison<'a> {
    factor: &'a str,
    /// `level_vs_rest` or `development_vs_retained_test`.
    kind: &'static str,
    target_level: String,
    reference_levels: Vec<String>,
    reference: Vec<&'a Vec<f64>>,
    target: Vec<&'a Vec<f64>>,
    /// Unit counts and samples per unit on each side.
    composition: Value,
    /// Crossing of the compared units with the other declared factors.
    crossing: Value,
}

impl Comparison<'_> {
    fn metric(&self, id: &str, value: Value, source: &SpectralSource) -> Metric {
        let mut metric = Metric::computed(id, value, Some(&source.source_id), None);
        self.describe(&mut metric);
        metric
    }
    fn unavailable(
        &self,
        id: &str,
        status: Availability,
        reason: &str,
        source: &SpectralSource,
    ) -> Metric {
        let mut metric = Metric::unavailable(id, status, reason, Some(&source.source_id), None);
        self.describe(&mut metric);
        metric
    }
    fn describe(&self, metric: &mut Metric) {
        tag(metric, "source_comparison", self.factor);
        metric
            .parameters
            .insert("comparison".into(), json!(self.kind));
        metric
            .parameters
            .insert("target_domain".into(), json!(self.target_level));
        metric
            .parameters
            .insert("reference_domains".into(), json!(self.reference_levels));
        metric
            .parameters
            .insert("composition".into(), self.composition.clone());
        metric
            .denominators
            .insert("n_reference_units".into(), self.reference.len());
        metric
            .denominators
            .insert("n_target_units".into(), self.target.len());
        if !self.crossing.is_null() {
            metric
                .parameters
                .insert("crossing".into(), self.crossing.clone());
        }
    }
}

const SPECTRAL_METRICS: [&str; 4] = [
    "domain_shift.distribution_distance",
    "domain_shift.center_shift",
    "domain_shift.dispersion",
    "domain_shift.coverage",
];

/// Folds and requested components of the reference PCA: K = min(10, n_r)
/// folds and k = min(10, n_r - ceil(n_r / K) - 1, p). Methods lowers k to
/// the smallest numerical rank of the fold and full fits.
fn monitor_shape(n_reference: usize, p: usize) -> (usize, usize) {
    let folds = MAX_FOLDS.min(n_reference);
    let train = n_reference - n_reference.div_ceil(folds);
    (folds, MAX_COMPONENTS.min(train - 1).min(p))
}

/// Unit labels of a signal unit and of its square and square root.
fn units(source: &SpectralSource) -> (Option<String>, Option<String>, Option<String>) {
    let u = (!source.signal_unit.trim().is_empty()).then(|| source.signal_unit.clone());
    let squared = u.as_ref().map(|u| format!("({u})^2"));
    let root = u.as_ref().map(|u| format!("({u})^(1/2)"));
    (u, squared, root)
}

/// Spectral metrics of one comparison: distribution distance, centre shift,
/// dispersion and coverage.
fn compare(
    source: &SpectralSource,
    comparison: &Comparison,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let n_r = comparison.reference.len();
    if n_r < 3 {
        for id in SPECTRAL_METRICS {
            report.metrics.push(comparison.unavailable(
                id,
                Availability::InsufficientData,
                "FEWER_THAN_THREE_REFERENCE_UNITS",
                source,
            ));
        }
        return;
    }
    let p = source.axis.len();
    let (unit, squared, root) = units(source);
    let energy_request = EnergyDistanceRequest {
        matrix: comparison
            .reference
            .iter()
            .chain(&comparison.target)
            .map(|row| (*row).clone())
            .collect(),
        group_codes: (0..n_r + comparison.target.len())
            .map(|i| i64::from(i >= n_r))
            .collect(),
        n_groups: 2,
        n_permutations: 0,
        seed: 0,
    };
    match energy(provider, &energy_request) {
        Ok(d) => {
            let (e, bound) = (d.energy[0][1], d.energy_bounds[0][1]);
            let mut m = comparison.metric(
                "domain_shift.distribution_distance",
                json!({
                    "energy_e": e,
                    "energy_e_error_bound": bound,
                    "energy_e_interval": [(e - bound).max(0.0), e + bound],
                    "scipy_energy_distance": e.sqrt(),
                    "mean_between_distance": d.mean_distances[0][1],
                    "mean_within_reference_distance": d.mean_distances[0][0],
                    "mean_within_target_distance": d.mean_distances[1][1],
                }),
                source,
            );
            m.parameters.insert(
                "value_units".into(),
                json!({
                    "energy_e": unit, "energy_e_error_bound": unit, "energy_e_interval": unit,
                    "scipy_energy_distance": root,
                    "mean_between_distance": unit, "mean_within_reference_distance": unit,
                    "mean_within_target_distance": unit,
                }),
            );
            m.parameters.insert(
                "space".into(),
                json!("complete_canonical_spectra_euclidean_equal_to_all_reference_components_plus_residual"),
            );
            m.parameters.insert(
                "definition".into(),
                json!("energy_e = 2 E|X-Y| - E|X-X'| - E|Y-Y'| over unit means (V-statistic, self-pairs included; unit of the signal), from local pairwise differences with double-double sums; energy_e_error_bound = (8u + 2^-80)(2 E|X-Y| + E|X-X'| + E|Y-Y'|) bounds the rounding, and a computed value in [-bound, 0) is published as 0; scipy_energy_distance = sqrt(energy_e), as scipy.stats.energy_distance in one dimension"),
            );
            m.parameters
                .insert("backend_version".into(), json!(d.backend_version));
            report.metrics.push(m);
        }
        Err(e) => report.metrics.push(comparison.unavailable(
            "domain_shift.distribution_distance",
            e.availability(),
            &e.reason,
            source,
        )),
    }
    let (folds, k) = monitor_shape(n_r, p);
    let request = PcaMonitorRequest {
        reference: comparison.reference.iter().map(|r| (*r).clone()).collect(),
        monitored: comparison.target.iter().map(|r| (*r).clone()).collect(),
        max_components: k,
        n_folds: folds,
        alpha: COVERAGE_ALPHA,
    };
    let d = match monitor(provider, &request) {
        Ok(d) => d,
        Err(e) => {
            for id in &SPECTRAL_METRICS[1..] {
                report.metrics.push(comparison.unavailable(
                    id,
                    e.availability(),
                    &e.reason,
                    source,
                ));
            }
            return;
        }
    };
    let k_eff = d.effective_components;
    let describe_space = |m: &mut Metric| {
        m.parameters.insert(
            "space".into(),
            json!("pca_fitted_on_reference_units_only_then_applied_to_target_units"),
        );
        m.parameters
            .insert("n_components_requested".into(), json!(k));
        m.parameters
            .insert("n_components_effective".into(), json!(k_eff));
        m.parameters.insert(
            "component_rule".into(),
            json!("requested min(10, n_reference - ceil(n_reference / n_folds) - 1, n_bands); effective = smallest numerical rank (numpy matrix_rank tolerance) of the out-of-fold and full reference fits"),
        );
        m.parameters
            .insert("backend_version".into(), json!(d.backend_version));
    };
    let t2_reason = (k_eff == 0).then_some("REFERENCE_NUMERICAL_RANK_ZERO");
    let mut center = comparison.metric(
        "domain_shift.center_shift",
        json!({
            "centroid_distance": d.centroid_distance,
            "reference_subspace_distance": d.centroid_subspace_distance,
            "residual_distance": d.centroid_residual_distance,
            "centroid_hotelling_t2": d.centroid_t2,
            "centroid_hotelling_t2_reason_code": t2_reason,
        }),
        source,
    );
    describe_space(&mut center);
    center.parameters.insert(
        "value_units".into(),
        json!({
            "centroid_distance": unit, "reference_subspace_distance": unit,
            "residual_distance": unit, "centroid_hotelling_t2": "dimensionless",
        }),
    );
    center.parameters.insert(
        "definition".into(),
        json!("target unit-mean centroid minus reference centroid (double-double means): Euclidean norm, its norm inside the reference PCA subspace, its explicit residual norm, and its T² with the reference eigenvalues"),
    );
    report.metrics.push(center);

    let mut dispersion = match d.monitored_total_variance {
        Some(_) if d.reference_total_variance <= 0.0 => comparison.unavailable(
            "domain_shift.dispersion",
            Availability::Undefined,
            "ZERO_REFERENCE_VARIANCE",
            source,
        ),
        Some(target) => comparison.metric(
            "domain_shift.dispersion",
            json!({
                "reference_total_variance": d.reference_total_variance,
                "target_total_variance": target,
                "variance_ratio": target / d.reference_total_variance,
            }),
            source,
        ),
        None => comparison.unavailable(
            "domain_shift.dispersion",
            Availability::InsufficientData,
            "FEWER_THAN_TWO_TARGET_UNITS",
            source,
        ),
    };
    dispersion.parameters.insert(
        "definition".into(),
        json!("trace of each domain's covariance of unit means about its own double-double centroid, from the input values, ddof 1, complete canonical spectra; ratio target / reference"),
    );
    dispersion.parameters.insert(
        "value_units".into(),
        json!({
            "reference_total_variance": squared, "target_total_variance": squared,
            "variance_ratio": "dimensionless",
        }),
    );
    report.metrics.push(dispersion);

    let n_t = comparison.target.len();
    let fraction = |c: usize| c as f64 / n_t as f64;
    let t2 = k_eff > 0;
    let mut coverage = comparison.metric(
        "domain_shift.coverage",
        json!({
            "t2_limit": d.t2_limit,
            "q_limit": d.q_limit,
            "t2_limit_interval": d.t2_limit_interval,
            "q_limit_interval": d.q_limit_interval,
            "n_target_beyond_t2_limit": t2.then_some(d.n_beyond_t2),
            "n_target_beyond_q_limit": d.n_beyond_q,
            "n_target_beyond_either_limit": t2.then_some(d.n_beyond_either),
            "n_target_undetermined_t2": t2.then_some(d.n_undetermined_t2),
            "n_target_undetermined_q": d.n_undetermined_q,
            "n_target_undetermined_either": t2.then_some(d.n_undetermined_either),
            "fraction_target_beyond_t2_limit": t2.then(|| fraction(d.n_beyond_t2)),
            "fraction_target_beyond_q_limit": fraction(d.n_beyond_q),
            "fraction_target_beyond_either_limit": t2.then(|| fraction(d.n_beyond_either)),
            "t2_reason_code": t2_reason,
            "either_reason_code": (!t2).then_some("T2_UNAVAILABLE_COMBINED_COVERAGE_INCOMPLETE"),
            "nominal_fraction_per_limit": COVERAGE_ALPHA,
            "reference_retained_variance_fraction": d.retained_fraction,
            "reference_eigenvalues": d.eigenvalues,
        }),
        source,
    );
    describe_space(&mut coverage);
    coverage.parameters.insert(
        "limit_type".into(),
        json!("empirical_type7_quantile_of_out_of_fold_reference_statistics"),
    );
    coverage
        .parameters
        .insert("limit_quantile".into(), json!(1.0 - COVERAGE_ALPHA));
    coverage.parameters.insert("n_folds".into(), json!(folds));
    coverage.parameters.insert(
        "fold_rule".into(),
        json!("reference unit at canonical position i belongs to fold i mod n_folds"),
    );
    coverage.parameters.insert(
        "statistics".into(),
        json!("T² = sum_a t_a² / lambda_a over the effective components; Q = squared norm of the explicit residual outside the reference subspace (compensated); each value carries a rounding interval (score and residual-norm errors from the operations and the measured orthonormality defect of the components; eigenvalue rounding not propagated); a target unit is beyond a limit when its interval lies above the limit interval, undetermined when they overlap, decided by Methods"),
    );
    coverage.parameters.insert(
        "interpretation".into(),
        json!("descriptive_coverage_not_a_probability_of_failure"),
    );
    coverage.parameters.insert(
        "value_units".into(),
        json!({
            "t2_limit": "dimensionless", "q_limit": squared, "q_limit_interval": squared,
            "reference_eigenvalues": squared, "fractions": "dimensionless",
        }),
    );
    report.metrics.push(coverage);
}

/// Energy result checked for shape, finiteness and sign: Methods returns
/// non-negative energies or an explicit numerical error.
fn energy(
    provider: &impl MethodsProvider,
    request: &EnergyDistanceRequest,
) -> Result<EnergyDistanceDiagnostics, ProviderError> {
    let g = request.n_groups;
    let square = |m: &[Vec<f64>]| {
        m.len() == g
            && m.iter()
                .all(|row| row.len() == g && row.iter().all(|v| v.is_finite() && *v >= 0.0))
    };
    let d = provider.energy_distance(request)?;
    if square(&d.energy)
        && square(&d.energy_bounds)
        && square(&d.mean_distances)
        && (0..g).all(|a| (0..g).all(|b| d.energy[a][b] == d.energy[b][a]))
        && d.statistic_bound.is_finite()
        && d.statistic_bound >= 0.0
        && (0..g).all(|a| d.energy[a][a] == 0.0)
        && d.statistic.is_finite()
        && d.statistic >= 0.0
        && d.log10_distinct_permutations.is_finite()
        && d.log10_distinct_permutations >= 0.0
        && d.n_permutations_executed == request.n_permutations
        && d.n_at_least_observed <= d.n_permutations_executed
        && d.p_value.is_some() == (request.n_permutations > 0)
        && d.p_value.is_none_or(|p| p > 0.0 && p <= 1.0)
    {
        Ok(d)
    } else {
        Err(ProviderError::internal("INVALID_PROVIDER_RESULT"))
    }
}

fn monitor(
    provider: &impl MethodsProvider,
    request: &PcaMonitorRequest,
) -> Result<PcaMonitorDiagnostics, ProviderError> {
    let (n_r, n_m) = (request.reference.len(), request.monitored.len());
    let nonnegative = |v: f64| v.is_finite() && v >= 0.0;
    let d = provider.pca_monitor(request)?;
    let k = d.effective_components;
    let t2_defined = |v: &Option<f64>| v.is_some() == (k > 0) && v.is_none_or(nonnegative);
    if k <= request.max_components
        && d.eigenvalues.len() == k
        && d.eigenvalues.iter().all(|v| v.is_finite() && *v > 0.0)
        && d.reference_t2.len() == n_r
        && d.reference_q.len() == n_r
        && d.monitored_t2.len() == n_m
        && d.monitored_q.len() == n_m
        && d.reference_q
            .iter()
            .chain(&d.monitored_q)
            .all(|v| nonnegative(*v))
        && d.reference_t2.iter().chain(&d.monitored_t2).all(t2_defined)
        && t2_defined(&d.t2_limit)
        && t2_defined(&d.centroid_t2)
        && nonnegative(d.q_limit)
        && d.n_beyond_q <= n_m
        && d.n_beyond_t2 <= n_m
        && d.n_beyond_either <= n_m
        && d.n_beyond_either >= d.n_beyond_q
        && d.n_beyond_either >= d.n_beyond_t2
        && d.n_beyond_q + d.n_undetermined_q <= n_m
        && d.n_beyond_t2 + d.n_undetermined_t2 <= n_m
        && d.n_beyond_either + d.n_undetermined_either <= n_m
        && (k > 0 || d.n_beyond_t2 + d.n_undetermined_t2 == 0)
        && d.t2_limit_interval.is_some() == (k > 0)
        && d.t2_limit_interval.is_none_or(|[lo, hi]| {
            nonnegative(lo)
                && lo <= hi
                && hi.is_finite()
                && d.t2_limit.is_some_and(|t| lo <= t && t <= hi)
        })
        && nonnegative(d.q_limit_interval[0])
        && d.q_limit_interval[1].is_finite()
        && d.q_limit_interval[0] <= d.q_limit
        && d.q_limit <= d.q_limit_interval[1]
        && nonnegative(d.reference_total_variance)
        && d.monitored_total_variance.is_some() == (n_m >= 2)
        && d.monitored_total_variance.is_none_or(nonnegative)
        && [
            d.centroid_distance,
            d.centroid_subspace_distance,
            d.centroid_residual_distance,
        ]
        .into_iter()
        .all(nonnegative)
        && d.retained_fraction.is_none_or(nonnegative)
    {
        Ok(d)
    } else {
        Err(ProviderError::internal("INVALID_PROVIDER_RESULT"))
    }
}

/// Exact development references of every unit for one target: the common
/// value of its referenced member samples, None when no member is
/// referenced, and Err when members disagree.
#[derive(Clone, PartialEq)]
enum UnitTarget {
    Value(f64),
    Class(String),
}

fn unit_targets(
    population: &Population,
    target: &Target,
    samples: &HashMap<&str, &Sample>,
) -> Vec<Result<Option<UnitTarget>, ()>> {
    let mut exact = BTreeMap::<&str, Vec<UnitTarget>>::new();
    for v in &target.values {
        // Only development samples enter: retained-test Y is never read.
        let Some(sample) = samples.get(v.sample_id.as_str()) else {
            continue;
        };
        if sample.partition != Partition::Development || v.status != ReferenceStatus::Exact {
            continue;
        }
        let label = match target.kind {
            TargetKind::Continuous => v.value.map(UnitTarget::Value),
            TargetKind::Categorical => v.category.clone().map(UnitTarget::Class),
        };
        if let Some(label) = label {
            exact.entry(v.sample_id.as_str()).or_default().push(label);
        }
    }
    population
        .units
        .iter()
        .map(|rows| {
            let mut labels = rows
                .iter()
                .flat_map(|&r| {
                    exact
                        .get(population.aggregation.sample_ids[r].as_str())
                        .into_iter()
                        .flatten()
                })
                .peekable();
            let Some(first) = labels.peek().cloned() else {
                return Ok(None);
            };
            if labels.all(|l| *l == *first) {
                Ok(Some(first.clone()))
            } else {
                Err(())
            }
        })
        .collect()
}

/// Y of the development reference and target units (descriptive).
fn target_change(
    source: &SpectralSource,
    comparison: &Comparison,
    sides: (&[usize], &[usize]),
    labels: &[Result<Option<UnitTarget>, ()>],
    target: &Target,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let (reference_units, target_units) = sides;
    let side = |units: &[usize]| {
        let (mut values, mut missing, mut varies) = (Vec::new(), 0, 0);
        for &u in units {
            match &labels[u] {
                Ok(Some(l)) => values.push(l.clone()),
                Ok(None) => missing += 1,
                Err(()) => varies += 1,
            }
        }
        (values, missing, varies)
    };
    let (reference, ref_missing, ref_varies) = side(reference_units);
    let (targets, target_missing, target_varies) = side(target_units);
    let mut metric = if reference.is_empty() || targets.is_empty() {
        comparison.unavailable(
            "domain_shift.target_change",
            Availability::InsufficientData,
            "NO_REFERENCED_UNITS_IN_A_DOMAIN",
            source,
        )
    } else {
        match target.kind {
            TargetKind::Continuous => {
                let values = |v: &[UnitTarget]| -> Vec<f64> {
                    v.iter()
                        .filter_map(|l| match l {
                            UnitTarget::Value(x) => Some(*x),
                            UnitTarget::Class(_) => None,
                        })
                        .collect()
                };
                let (r, t) = (values(&reference), values(&targets));
                let summary =
                    |v: &[f64]| match provider.summary(&SummaryRequest { values: v.to_vec() }) {
                        Ok(s)
                            if s.count == v.len()
                                && [s.min, s.max, s.mean, s.q25, s.median, s.q75]
                                    .iter()
                                    .all(|x| x.is_finite())
                                && s.sample_sd.is_none_or(f64::is_finite) =>
                        {
                            Ok(s)
                        }
                        Ok(_) => Err(ProviderError::internal("INVALID_PROVIDER_RESULT")),
                        Err(e) => Err(e),
                    };
                match (summary(&r), summary(&t)) {
                    (Ok(a), Ok(b)) if (b.median - a.median).is_finite() => {
                        let outside = t.iter().filter(|y| **y < a.min || **y > a.max).count();
                        let describe = |s: &SummaryDiagnostics| {
                            json!({"count": s.count, "min": s.min, "max": s.max, "mean": s.mean,
                                   "sample_sd": s.sample_sd, "q25": s.q25, "median": s.median,
                                   "q75": s.q75})
                        };
                        let mut m = comparison.metric(
                            "domain_shift.target_change",
                            json!({
                                "reference": describe(&a),
                                "target": describe(&b),
                                "median_difference": b.median - a.median,
                                "n_target_outside_reference_range": outside,
                                "fraction_target_outside_reference_range": outside as f64 / t.len() as f64,
                            }),
                            source,
                        );
                        m.parameters.insert(
                            "value_units".into(),
                            json!({"summaries": target.unit, "median_difference": target.unit,
                                   "fraction_target_outside_reference_range": "dimensionless"}),
                        );
                        m.parameters
                            .insert("backend_version".into(), json!(a.backend_version));
                        m
                    }
                    (Ok(_), Ok(_)) => comparison.unavailable(
                        "domain_shift.target_change",
                        Availability::Error,
                        "MEDIAN_DIFFERENCE_NOT_REPRESENTABLE",
                        source,
                    ),
                    (Err(e), _) | (_, Err(e)) => comparison.unavailable(
                        "domain_shift.target_change",
                        e.availability(),
                        &e.reason,
                        source,
                    ),
                }
            }
            TargetKind::Categorical => {
                let counts = |v: &[UnitTarget]| {
                    let mut c = BTreeMap::<String, usize>::new();
                    for l in v {
                        if let UnitTarget::Class(name) = l {
                            *c.entry(name.clone()).or_default() += 1;
                        }
                    }
                    c
                };
                let (a, b) = (counts(&reference), counts(&targets));
                let absent: Vec<&String> = b.keys().filter(|k| !a.contains_key(*k)).collect();
                comparison.metric(
                    "domain_shift.target_change",
                    json!({
                        "reference_class_counts": a,
                        "target_class_counts": b,
                        "target_classes_absent_from_reference": absent,
                    }),
                    source,
                )
            }
        }
    };
    metric.target_id = Some(target.target_id.clone());
    metric.scope = "source_comparison_target".into();
    for (key, value) in [
        ("n_reference_units_referenced", reference.len()),
        ("n_reference_units_unreferenced", ref_missing),
        ("n_reference_units_target_varies", ref_varies),
        ("n_target_units_referenced", targets.len()),
        ("n_target_units_unreferenced", target_missing),
        ("n_target_units_target_varies", target_varies),
    ] {
        metric.denominators.insert(key.into(), value);
    }
    metric.parameters.insert(
        "population".into(),
        json!("exact_development_references_one_vote_per_independence_unit"),
    );
    metric.parameters.insert(
        "interpretation".into(),
        json!("descriptive_change_of_y_between_domains"),
    );
    report.metrics.push(metric);
}

/// An identifiable test waiting for its family's resolution check.
struct Candidate {
    factor: String,
    request: EnergyDistanceRequest,
    log10_distinct: f64,
    statistic: f64,
    plan: PermutationPlan,
    metric: Metric,
}

fn plan(
    input: &QualificationInput,
    source_id: &str,
    factor: &str,
    block_size: usize,
    reason: Option<&str>,
) -> PermutationPlan {
    let domain = format!("nirs4all-preflight\0methods\0{PROTOCOL}\0{source_id}\0{factor}");
    let (null, effect) = if factor == PARTITION {
        (
            format!("development and retained-test independence units of source {source_id} are exchangeable (identical distributions of unit-mean complete canonical spectra)"),
            format!("difference between the development and retained-test distributions of unit-mean spectra of source {source_id}"),
        )
    } else {
        (
            format!("independence units of source {source_id} are exchangeable across {factor} levels (identical distributions of unit-mean complete canonical spectra)"),
            format!("difference between the distributions of unit-mean spectra of the {factor} levels of source {source_id}"),
        )
    };
    PermutationPlan {
        plan_version: PERMUTATION_PLAN_VERSION.into(),
        null_hypothesis: null,
        tested_effect: effect,
        statistic: "energy_k_sample_sum_n_a_n_b_over_n_a_plus_n_b_energy_e".into(),
        exchangeable_unit: input.options.independence_unit,
        exchangeability_declared: input.options.exchangeable_units,
        restrictions: "none_single_block".into(),
        block_sizes: vec![block_size],
        reduced_model: None,
        draw_method: "monte_carlo_uniform_unit_label_permutation_with_replacement_between_draws"
            .into(),
        rng_algorithm: "methods_pcg64_numpy_seedsequence_permutation".into(),
        seed: derive_seed(input.options.seed, &domain),
        seed_derivation: format!("splitmix64_finalizer(options.seed XOR fnv1a64({domain:?}))"),
        log10_distinct_admissible_permutations: None,
        n_permutations_requested: PERMUTATIONS,
        n_permutations_executed: 0,
        monte_carlo_step: 1.0 / (PERMUTATIONS as f64 + 1.0),
        n_enumerated_arrangements: None,
        exact_minimum_p_value: None,
        resolution: None,
        resolution_basis: None,
        p_value_convention: "(1+b)/(1+B)".into(),
        tie_tolerance: TIE_TOLERANCE,
        executed: false,
        reason_code: reason.map(str::to_owned),
    }
}

/// Reason that blocks the permutation test of a population, if any.
fn blocking_reason(
    input: &QualificationInput,
    missing_group: bool,
    varies: usize,
    equal_units: bool,
) -> Option<&'static str> {
    if input.options.independence_unit == IndependenceUnit::Unknown {
        Some("INDEPENDENCE_UNIT_UNKNOWN")
    } else if missing_group {
        Some("MISSING_INDEPENDENCE_GROUP")
    } else if !input.options.exchangeable_units {
        Some("EXCHANGEABILITY_NOT_DECLARED")
    } else if varies > 0 {
        Some("FACTOR_VARIES_WITHIN_INDEPENDENCE_UNIT")
    } else if !equal_units {
        // Means of units of different sizes have different dispersions even
        // when their samples are exchangeable; no balanced test is qualified.
        Some("UNEQUAL_UNIT_COMPOSITION")
    } else {
        None
    }
}

/// Descriptive K-sample energy statistic, then either a blocked metric or a
/// candidate for the family.
#[allow(clippy::too_many_arguments)]
fn test_candidate(
    input: &QualificationInput,
    source: &SpectralSource,
    factor: &str,
    matrix: Vec<Vec<f64>>,
    codes: Vec<i64>,
    n_groups: usize,
    blocked: Option<&str>,
    context: (&BTreeMap<String, usize>, Value),
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) -> Option<Candidate> {
    let n = codes.len();
    let mut plan = plan(input, &source.source_id, factor, n, blocked);
    let mut metric = unavailable_metric(
        "domain_shift.energy_test",
        Availability::NotIdentifiable,
        blocked.unwrap_or(""),
        &source.source_id,
        factor,
    );
    metric.reason_code = blocked.map(str::to_owned);
    metric.denominators = context.0.clone();
    metric.parameters.insert("composition".into(), context.1);
    metric.parameters.insert(
        "value_units".into(),
        json!({"statistic": units(source).0, "p_values": "dimensionless"}),
    );
    let request = EnergyDistanceRequest {
        matrix,
        group_codes: codes,
        n_groups,
        n_permutations: 0,
        seed: plan.seed,
    };
    let descriptive = match energy(provider, &request) {
        Ok(d) => d,
        Err(e) => {
            metric.status = e.availability();
            metric.reason_code = Some(e.reason);
            plan.reason_code.clone_from(&metric.reason_code);
            metric
                .parameters
                .insert("permutation_plan".into(), json!(plan));
            report.metrics.push(metric);
            return None;
        }
    };
    plan.log10_distinct_admissible_permutations = Some(descriptive.log10_distinct_permutations);
    metric
        .parameters
        .insert("energy_statistic".into(), json!(descriptive.statistic));
    metric.parameters.insert(
        "energy_statistic_error_bound".into(),
        json!(descriptive.statistic_bound),
    );
    metric
        .parameters
        .insert("backend_version".into(), json!(descriptive.backend_version));
    metric.parameters.insert(
        "space".into(),
        json!("complete_canonical_spectra_euclidean_one_row_per_independence_unit"),
    );
    if blocked.is_some() {
        metric
            .parameters
            .insert("permutation_plan".into(), json!(plan));
        report.metrics.push(metric);
        return None;
    }
    Some(Candidate {
        factor: factor.into(),
        log10_distinct: descriptive.log10_distinct_permutations,
        statistic: descriptive.statistic,
        request,
        plan,
        metric,
    })
}

/// Runs one Holm family of energy tests and returns the rejected factors.
fn run_family(
    source: &SpectralSource,
    candidates: Vec<Candidate>,
    family: &str,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) -> Vec<(String, f64)> {
    let m = candidates.len();
    if m == 0 {
        return Vec::new();
    }
    let step = 1.0 / (PERMUTATIONS + 1) as f64;
    let mut done = Vec::new();
    for mut c in candidates {
        let resolution = step.max(10f64.powf(-c.log10_distinct));
        c.plan.resolution = Some(resolution);
        c.plan.resolution_basis = Some("lower_bound_from_combinatorial_bound".into());
        let outcome = if resolution > FAMILY_ALPHA / m as f64 {
            Err(ProviderError {
                kind: ProviderErrorKind::Unsupported,
                reason: "PERMUTATION_RESOLUTION_INSUFFICIENT".into(),
            })
        } else {
            energy(
                provider,
                &EnergyDistanceRequest {
                    n_permutations: PERMUTATIONS,
                    ..c.request.clone()
                },
            )
        };
        done.push((c, outcome));
    }
    // Unexecuted tests enter Holm as p = 1.
    let p_values: Vec<f64> = done
        .iter()
        .map(|(_, o)| o.as_ref().ok().and_then(|d| d.p_value).unwrap_or(1.0))
        .collect();
    let holm = match provider.holm_adjust(&HolmRequest {
        p_values: p_values.clone(),
    }) {
        Ok(h) if h.adjusted.len() == m && h.adjusted.iter().all(|p| (0.0..=1.0).contains(p)) => {
            Ok(h.adjusted)
        }
        Ok(_) => Err("INVALID_PROVIDER_RESULT".to_string()),
        Err(e) => Err(e.reason),
    };
    let mut family_metric = Metric::computed(
        "domain_shift.test_family",
        json!({
            "method": "holm",
            "family_alpha": FAMILY_ALPHA,
            "family_size": m,
            "members": done.iter().zip(&p_values).enumerate().map(|(i, ((c, _), p))| json!({
                "factor": c.factor, "p_value_entered": p,
                "p_value_holm": holm.as_ref().ok().map(|a| a[i]),
            })).collect::<Vec<_>>(),
            "holm_available": holm.is_ok(),
            "holm_reason_code": holm.as_ref().err(),
        }),
        Some(&source.source_id),
        None,
    );
    family_metric.view_id = VIEW.into();
    family_metric.scope = "source".into();
    family_metric
        .parameters
        .insert("protocol".into(), json!(PROTOCOL));
    family_metric
        .parameters
        .insert("numerical_domain".into(), json!(DIFFERENCE_NUMERICAL_DOMAIN));
    family_metric
        .parameters
        .insert("family".into(), json!(family));
    let mut rejected = Vec::new();
    for (i, (mut c, outcome)) in done.into_iter().enumerate() {
        match outcome {
            Err(e) => {
                c.metric.status = if e.reason == "PERMUTATION_RESOLUTION_INSUFFICIENT" {
                    Availability::InsufficientData
                } else {
                    e.availability()
                };
                c.metric.reason_code = Some(e.reason);
                c.plan.reason_code.clone_from(&c.metric.reason_code);
            }
            Ok(d) => {
                c.plan.executed = true;
                c.plan.n_permutations_executed = d.n_permutations_executed;
                let adjusted = holm.as_ref().ok().map(|a| a[i]);
                let rejects = adjusted.map(|a| a <= FAMILY_ALPHA);
                c.metric.status = Availability::Computed;
                c.metric.reason_code = None;
                c.metric.value = Some(json!({
                    "statistic": c.statistic,
                    "p_value": d.p_value,
                    "p_value_holm": adjusted,
                    "rejects_null_at_family_alpha": rejects,
                    "multiplicity_reason_code": holm.as_ref().err(),
                    "n_at_least_observed": d.n_at_least_observed,
                    "log10_distinct_permutations": d.log10_distinct_permutations,
                }));
                if let Some(a) = adjusted.filter(|a| *a <= FAMILY_ALPHA) {
                    rejected.push((c.factor.clone(), a));
                }
            }
        }
        c.metric.parameters.insert("family".into(), json!(family));
        c.metric
            .parameters
            .insert("permutation_plan".into(), json!(c.plan));
        report.metrics.push(c.metric);
    }
    report.metrics.push(family_metric);
    rejected
}

/// Targets whose metadata–target association test with `factor` was
/// rejected by Holm.
fn associated_targets(report: &QualificationReport, factor: &str) -> Vec<String> {
    report
        .metrics
        .iter()
        .filter(|m| {
            m.metric_id == "association.metadata_target_test"
                && m.parameters.get("metadata").and_then(Value::as_str) == Some(factor)
                && m.value
                    .as_ref()
                    .and_then(|v| v.get("rejects_null_at_family_alpha"))
                    .and_then(Value::as_bool)
                    == Some(true)
        })
        .filter_map(|m| m.target_id.clone())
        .collect()
}

fn intended_use(input: &QualificationInput, factor: &str) -> Option<&'static str> {
    let intended = input.options.domain_shift.intended_use.as_ref()?;
    if intended.new_levels.iter().any(|f| f == factor) {
        Some("new_levels")
    } else if intended.seen_levels.iter().any(|f| f == factor) {
        Some("seen_levels")
    } else {
        None
    }
}

/// Sample IDs of identity components or declared independence groups that
/// contain both development and retained-test samples, checked on whole
/// components before any split by partition (at most MAX_LISTED_IDS).
fn audit_crossing(input: &QualificationInput) -> Vec<String> {
    let component = components(input);
    let mut roles = BTreeMap::<String, BTreeSet<bool>>::new();
    let mut members = BTreeMap::<String, Vec<&str>>::new();
    for sample in &input.samples {
        let test = match sample.partition {
            Partition::Development => false,
            Partition::RetainedTest => true,
            Partition::Prediction => continue,
        };
        let mut keys = vec![format!(
            "component:{}",
            component[sample.sample_id.as_str()]
        )];
        if let Some(group) = &sample.independence_group {
            keys.push(format!("group:{group}"));
        }
        for key in keys {
            roles.entry(key.clone()).or_default().insert(test);
            members.entry(key).or_default().push(&sample.sample_id);
        }
    }
    let mut ids = BTreeSet::new();
    for (key, r) in &roles {
        if r.len() > 1 {
            ids.extend(members[key].iter().map(|s| s.to_string()));
        }
    }
    ids.into_iter().take(MAX_LISTED_IDS).collect()
}

pub(crate) fn analyze(
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let component = components(input);
    for source in &input.sources {
        analyze_source(source, input, samples, &component, provider, report);
    }
}

fn analyze_source(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    component: &HashMap<&str, usize>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let source_id = source.source_id.as_str();
    let dev = population(source, samples, input, component, Partition::Development);
    let mut base = BTreeMap::from([
        (
            "n_development_aggregated_samples".to_string(),
            dev.aggregation.matrix.len(),
        ),
        ("n_development_units".to_string(), dev.units.len()),
        (
            "n_excluded_incomplete_observations".to_string(),
            dev.aggregation.excluded_incomplete,
        ),
        (
            "n_excluded_ambiguous_repeat_observations".to_string(),
            dev.aggregation.excluded_ambiguous,
        ),
        (
            "n_excluded_multicontext_observations".to_string(),
            dev.aggregation.excluded_multicontext,
        ),
    ]);
    let factors = domain_factors(input);
    let levels: Vec<(Vec<Option<&str>>, usize, usize)> = factors
        .iter()
        .map(|f| unit_levels(&dev, input, samples, f))
        .collect();
    let unit_labels: Vec<Vec<Result<Option<UnitTarget>, ()>>> = input
        .targets
        .iter()
        .map(|t| unit_targets(&dev, t, samples))
        .collect();
    let mut candidates = Vec::new();
    let mut aliased = BTreeMap::<&str, BTreeSet<&str>>::new();
    for (fi, factor) in factors.iter().enumerate() {
        let name = factor.name;
        let (unit_level, missing, varies) = &levels[fi];
        let mut denominators = base.clone();
        denominators.insert("n_units_missing_level".into(), *missing);
        denominators.insert("n_units_level_varies".into(), *varies);
        let analyzed: Vec<usize> = (0..dev.units.len())
            .filter(|&u| unit_level[u].is_some())
            .collect();
        denominators.insert("n_units_analyzed".into(), analyzed.len());
        let names: BTreeSet<&str> = analyzed.iter().filter_map(|&u| unit_level[u]).collect();
        if names.len() < 2 {
            let reason = if names.is_empty() {
                "FACTOR_NOT_DECLARED"
            } else {
                "SINGLE_DOMAIN_LEVEL"
            };
            let mut m = unavailable_metric(
                "domain_shift.design",
                Availability::NotApplicable,
                reason,
                source_id,
                name,
            );
            m.denominators = denominators;
            report.metrics.push(m);
            continue;
        }
        let names: Vec<&str> = names.into_iter().collect();
        let code = |u: usize| {
            names
                .iter()
                .position(|n| Some(*n) == unit_level[u])
                .unwrap_or(0)
        };
        // Crossing with the other declared factors, unit counts per cell.
        let mut crossing = serde_json::Map::new();
        for (oi, other) in factors.iter().enumerate().filter(|(oi, _)| *oi != fi) {
            let mut table = BTreeMap::<&str, BTreeMap<&str, usize>>::new();
            for &u in &analyzed {
                if let (Some(a), Some(b)) = (unit_level[u], levels[oi].0[u]) {
                    *table.entry(a).or_default().entry(b).or_default() += 1;
                }
            }
            crossing.insert(other.name.into(), json!(table));
        }
        let mut design = Metric::computed(
            "domain_shift.design",
            json!({
                "levels": names.iter().map(|n| {
                    let units: Vec<usize> =
                        analyzed.iter().copied().filter(|&u| unit_level[u] == Some(*n)).collect();
                    json!({"level": n, "composition": composition(&dev, &units)})
                }).collect::<Vec<_>>(),
                "crossing_unit_counts": crossing,
            }),
            Some(source_id),
            None,
        );
        tag(&mut design, "source_factor", name);
        design.denominators = denominators.clone();
        design.parameters.insert(
            "unit_rule".into(),
            json!("independence units of linked identities; a unit enters only when all its samples share one level; its spectrum is the equal-weight mean of its aggregated samples"),
        );
        report.metrics.push(design);
        // One comparison per level: that level against all other levels.
        for (li, level_name) in names.iter().enumerate() {
            let target_units: Vec<usize> = analyzed
                .iter()
                .copied()
                .filter(|&u| code(u) == li)
                .collect();
            let reference_units: Vec<usize> = analyzed
                .iter()
                .copied()
                .filter(|&u| code(u) != li)
                .collect();
            let mut cross = serde_json::Map::new();
            for (oi, other) in factors.iter().enumerate().filter(|(oi, _)| *oi != fi) {
                let set = |units: &[usize]| -> BTreeSet<&str> {
                    units.iter().filter_map(|&u| levels[oi].0[u]).collect()
                };
                let (t, r) = (set(&target_units), set(&reference_units));
                let shared: Vec<&&str> = t.intersection(&r).collect();
                let is_aliased = !t.is_empty() && !r.is_empty() && shared.is_empty();
                if is_aliased {
                    aliased.entry(name).or_default().insert(other.name);
                }
                cross.insert(
                    other.name.into(),
                    json!({"target_levels": t, "reference_levels": r,
                           "shared_levels": shared, "aliased": is_aliased}),
                );
            }
            let comparison = Comparison {
                factor: name,
                kind: "level_vs_rest",
                target_level: (*level_name).into(),
                reference_levels: names
                    .iter()
                    .filter(|n| *n != level_name)
                    .map(|n| (*n).to_string())
                    .collect(),
                reference: reference_units
                    .iter()
                    .map(|&u| &dev.coordinates[u])
                    .collect(),
                target: target_units.iter().map(|&u| &dev.coordinates[u]).collect(),
                composition: json!({
                    "reference": composition(&dev, &reference_units),
                    "target": composition(&dev, &target_units),
                }),
                crossing: Value::Object(cross),
            };
            compare(source, &comparison, provider, report);
            for (target, labels) in input.targets.iter().zip(&unit_labels) {
                target_change(
                    source,
                    &comparison,
                    (&reference_units, &target_units),
                    labels,
                    target,
                    provider,
                    report,
                );
            }
        }
        let blocked = blocking_reason(
            input,
            dev.missing_group,
            *varies,
            equal_composition(&dev, &analyzed),
        );
        if let Some(c) = test_candidate(
            input,
            source,
            name,
            analyzed
                .iter()
                .map(|&u| dev.coordinates[u].clone())
                .collect(),
            analyzed.iter().map(|&u| code(u) as i64).collect(),
            names.len(),
            blocked,
            (&denominators, composition(&dev, &analyzed)),
            provider,
            report,
        ) {
            candidates.push(c);
        }
    }
    let rejected = run_family(source, candidates, "domain_factors", provider, report);
    for (factor, adjusted) in rejected {
        let associated = associated_targets(report, &factor);
        let mut action = match intended_use(input, &factor) {
            Some("new_levels") => format!(
                "The intended use includes new {factor} levels: validate with whole {factor} levels held out; a random split does not represent unseen {factor} levels"
            ),
            Some(_) => format!(
                "The intended use is limited to the development {factor} levels: keep every {factor} level represented in calibration and in each validation fold; performance on new {factor} levels is not covered"
            ),
            None => format!(
                "Declare whether calibrations must serve new {factor} levels (options.domain_shift.intended_use): that choice decides between holding out whole {factor} levels and stratifying by them"
            ),
        };
        if !associated.is_empty() {
            action.push_str(&format!(
                ". Target(s) {} also differ across {factor} levels: part of the spectral shift may follow Y, so compare levels on overlapping Y ranges before attributing it to the domain",
                associated.join(", ")
            ));
        }
        if let Some(others) = aliased.get(factor.as_str()) {
            action.push_str(&format!(
                ". The {factor} comparison is aliased with {}: the shift cannot be attributed to {factor} alone",
                others.iter().copied().collect::<Vec<_>>().join(", ")
            ));
        }
        let mut evidence = vec![
            "domain_shift.energy_test".into(),
            "domain_shift.test_family".into(),
            "domain_shift.coverage".into(),
        ];
        if !associated.is_empty() {
            evidence.push("association.metadata_target_test".into());
        }
        report.findings.push(Finding {
            rule_id: "domain_shift.detected.v1".into(),
            severity: "warning".into(),
            confidence: "unknown".into(),
            evidence,
            message: format!(
                "Distributions of unit-mean spectra differ across {factor} levels in {source_id} (energy test, Holm-adjusted permutation p={adjusted:.3}); a spectral difference does not prove a performance loss"
            ),
            action,
        });
    }
    for (factor, others) in &aliased {
        let others = others.iter().copied().collect::<Vec<_>>().join(", ");
        report.findings.push(Finding {
            rule_id: "domain_shift.aliased_domains.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence: vec!["domain_shift.design".into()],
            message: format!(
                "Some {factor} levels of {source_id} share no {others} level with the other {factor} levels"
            ),
            action: format!("Collect crossed {factor} × {others} data before separating their effects"),
        });
    }
    analyze_audit(
        source, input, samples, component, &dev, &mut base, provider, report,
    );
}

/// Development versus retained-test X under the declared audit profile.
/// The space and limits are learned on development only, retained-test Y is
/// never read, and the outcome feeds no recommendation.
#[allow(clippy::too_many_arguments)]
fn analyze_audit(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    component: &HashMap<&str, usize>,
    dev: &Population,
    base: &mut BTreeMap<String, usize>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let source_id = source.source_id.as_str();
    let has_test = !real_rows(source, samples, Partition::RetainedTest).is_empty();
    if !input.options.domain_shift.external_domain_audit {
        if has_test {
            report.metrics.push(unavailable_metric(
                "domain_shift.energy_test",
                Availability::NotApplicable,
                "EXTERNAL_DOMAIN_AUDIT_NOT_DECLARED",
                source_id,
                PARTITION,
            ));
        }
        return;
    }
    // Whole components and declared groups are checked before the split by
    // partition: a dependent pair of populations is never compared.
    let crossing = audit_crossing(input);
    if !crossing.is_empty() {
        for id in SPECTRAL_METRICS.iter().chain(&["domain_shift.energy_test"]) {
            let mut m = unavailable_metric(
                id,
                Availability::NotIdentifiable,
                "AUDIT_UNITS_SPAN_PARTITIONS",
                source_id,
                PARTITION,
            );
            m.parameters
                .insert("crossing_sample_ids".into(), json!(crossing));
            report.metrics.push(m);
        }
        return;
    }
    if dev.units.is_empty() {
        let mut m = unavailable_metric(
            "domain_shift.energy_test",
            Availability::InsufficientData,
            "NO_DEVELOPMENT_UNITS",
            source_id,
            PARTITION,
        );
        m.denominators = base.clone();
        report.metrics.push(m);
        return;
    }
    let test = population(source, samples, input, component, Partition::RetainedTest);
    base.insert("n_retained_test_units".into(), test.units.len());
    base.insert(
        "n_retained_test_aggregated_samples".into(),
        test.aggregation.matrix.len(),
    );
    if test.units.is_empty() {
        let mut m = unavailable_metric(
            "domain_shift.energy_test",
            Availability::NotApplicable,
            "NO_RETAINED_TEST_UNITS",
            source_id,
            PARTITION,
        );
        m.denominators = base.clone();
        report.metrics.push(m);
        return;
    }
    let dev_units: Vec<usize> = (0..dev.units.len()).collect();
    let test_units: Vec<usize> = (0..test.units.len()).collect();
    let comparison = Comparison {
        factor: PARTITION,
        kind: "development_vs_retained_test",
        target_level: "retained_test".into(),
        reference_levels: vec!["development".into()],
        reference: dev.coordinates.iter().collect(),
        target: test.coordinates.iter().collect(),
        composition: json!({
            "reference": composition(dev, &dev_units),
            "target": composition(&test, &test_units),
        }),
        crossing: Value::Null,
    };
    let start = report.metrics.len();
    compare(source, &comparison, provider, report);
    for target in &input.targets {
        let mut m = comparison.unavailable(
            "domain_shift.target_change",
            Availability::NotApplicable,
            "RETAINED_TEST_Y_NEVER_READ",
            source,
        );
        m.target_id = Some(target.target_id.clone());
        m.scope = "source_comparison_target".into();
        report.metrics.push(m);
    }
    for m in &mut report.metrics[start..] {
        m.population_id = "development_real_vs_retained_test_real".into();
        m.parameters
            .insert("test_access".into(), json!("X_only_no_fit_no_Y"));
    }
    let sizes_equal = dev
        .units
        .iter()
        .chain(&test.units)
        .all(|u| u.len() == dev.units[0].len());
    let blocked = blocking_reason(
        input,
        dev.missing_group || test.missing_group,
        0,
        sizes_equal,
    );
    let matrix: Vec<Vec<f64>> = dev
        .coordinates
        .iter()
        .chain(&test.coordinates)
        .cloned()
        .collect();
    let codes = (0..matrix.len())
        .map(|i| i64::from(i >= dev.units.len()))
        .collect();
    let start = report.metrics.len();
    let rejected = test_candidate(
        input,
        source,
        PARTITION,
        matrix,
        codes,
        2,
        blocked,
        (base, comparison.composition.clone()),
        provider,
        report,
    )
    .map(|c| run_family(source, vec![c], "external_domain_audit", provider, report))
    .unwrap_or_default();
    for m in &mut report.metrics[start..] {
        m.population_id = "development_real_vs_retained_test_real".into();
        m.parameters
            .insert("test_access".into(), json!("X_only_no_fit_no_Y"));
    }
    if let Some((_, adjusted)) = rejected.first() {
        report.findings.push(Finding {
            rule_id: "domain_shift.external_domain_audit.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence: vec![
                "domain_shift.energy_test".into(),
                "domain_shift.coverage".into(),
            ],
            message: format!(
                "Retained-test spectra of {source_id} differ from development (energy test, permutation p={adjusted:.3}); the audit read retained-test X only"
            ),
            action: "Interpret retained-test performance as an external-domain evaluation; do not tune models, thresholds or recommendations on this audit".into(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_shape_requests_components_below_the_fold_rank_bound() {
        assert_eq!(monitor_shape(3, 100), (3, 1));
        assert_eq!(monitor_shape(10, 100), (10, 8));
        assert_eq!(monitor_shape(11, 100), (10, 8));
        assert_eq!(monitor_shape(30, 100), (10, 10));
        assert_eq!(monitor_shape(30, 4), (10, 4));
    }

    fn sample(id: &str, partition: Partition, group: Option<&str>) -> Sample {
        Sample {
            sample_id: id.into(),
            physical_sample_id: None,
            partition,
            independence_group: group.map(str::to_owned),
            instrument: None,
            campaign: None,
            individual_id: None,
            augmentation_parent_id: None,
        }
    }

    /// The audit's own guard: whole components and declared groups are
    /// checked before the split by partition (validation blocks these inputs
    /// first, so the guard is exercised directly).
    #[test]
    fn audit_refuses_units_spanning_partitions() {
        let mut input: QualificationInput = serde_json::from_value(json!({
            "schema_version": 1,
            "sources": [],
            "samples": [],
        }))
        .unwrap();
        input.samples = vec![
            sample("d1", Partition::Development, Some("lot1")),
            sample("d2", Partition::Development, Some("lot2")),
            sample("t1", Partition::RetainedTest, Some("lot1")),
            sample("t2", Partition::RetainedTest, Some("lot3")),
        ];
        assert_eq!(audit_crossing(&input), vec!["d1", "t1"]);
        input.samples[2].independence_group = Some("lot3".into());
        assert!(audit_crossing(&input).is_empty());
        // A shared individual links the components, whatever the unit.
        input.samples[1].individual_id = Some("cow".into());
        input.samples[3].individual_id = Some("cow".into());
        assert_eq!(audit_crossing(&input), vec!["d2", "t2"]);
    }
}
