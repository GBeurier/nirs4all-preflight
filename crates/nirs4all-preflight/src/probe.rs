//! Grouped predictability probe (`validation_probe.v1`, PF-04, exploratory).
//!
//! The engine selects the population, builds the indivisible identity
//! components, fixes the plan and the component grid, re-verifies everything
//! the validation provider returns and owns statuses and findings. The
//! validation provider (DAG-ML) owns every CV loop and the inner selection;
//! Methods fits PLS/PCR inside DAG-ML and computes the repeat aggregation,
//! the fold-train means and every reported score.
use crate::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROTOCOL: &str = "validation_probe.v1";
const POPULATION: &str = "development_real_exact_reference_aggregated";
const VIEW: &str = "canonical:centered_in_fit";
const OUTER_TARGET: usize = 5;
const INNER_TARGET: usize = 3;
const MAX_COMPONENTS: usize = 10;
const INLINE_ROWS: usize = 100_000;
/// Relative tolerance between provider scores and their Methods recomputation.
const SCORE_TOLERANCE: f64 = 1e-9;
pub(crate) const METRIC_IDS: [&str; 10] = [
    "probe.plan",
    "probe.folds",
    "probe.oof_predictions",
    "probe.rmse",
    "probe.mae",
    "probe.r2_oof",
    "probe.skill_vs_train_mean",
    "probe.train_mean_rmse",
    "probe.train_mean_mae",
    "probe.domain_scores",
];
/// Methods operations the probe needs besides the validation provider.
pub(crate) const METHODS_NEEDED: [&str; 4] = [
    "methods.pca",
    "methods.group_means",
    "methods.summary",
    "methods.regression_scores",
];

/// Plan fixed before any fit; a smaller valid plan or a refusal.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProbePlan {
    pub outer_splits: usize,
    pub inner_splits: usize,
    pub components: Vec<usize>,
    pub n_fits: usize,
}

/// Outer `min(5, G)` and inner `min(3, outer - 1)` grouped folds. Greedy
/// grouped K-fold puts at least one group in every fold, so each outer
/// training pool keeps at least `outer - 1` groups. A fold receives at most
/// `n / k + s_max` rows (lightest-fold assignment), which bounds the smallest
/// inner training pool by `B = (n (1 - 1/outer) - s_max)(1 - 1/inner) - s_max`;
/// the grid is `1..=min(10, r, floor(B) - 1)` with `r` the smaller of the
/// band count and the numerical rank.
pub(crate) fn plan(
    n_rows: usize,
    n_groups: usize,
    largest_group: usize,
    n_bands: usize,
) -> Result<ProbePlan, (Availability, &'static str)> {
    if n_groups < 3 {
        return Err((
            Availability::InsufficientData,
            "FEWER_THAN_THREE_INDEPENDENT_GROUPS",
        ));
    }
    let outer = OUTER_TARGET.min(n_groups);
    let inner = INNER_TARGET.min(outer - 1);
    let n = n_rows as f64;
    let s = largest_group as f64;
    let bound = ((n * (1.0 - 1.0 / outer as f64) - s) * (1.0 - 1.0 / inner as f64) - s).floor();
    let k_max = if bound >= 2.0 {
        MAX_COMPONENTS.min(n_bands).min(bound as usize - 1)
    } else {
        0
    };
    if k_max == 0 {
        return Err((
            Availability::InsufficientData,
            "TOO_FEW_SAMPLES_FOR_COMPONENT_GRID",
        ));
    }
    Ok(ProbePlan {
        outer_splits: outer,
        inner_splits: inner,
        components: (1..=k_max).collect(),
        n_fits: outer * (k_max * inner + 1),
    })
}

/// Instrument and campaign of a homogeneous context; `None` is absent, never
/// conflated with a present value.
type Domain = (Option<String>, Option<String>);

/// One aggregated sample of the probe population.
struct Row {
    sample_id: String,
    component: String,
    domain: Domain,
    x: Vec<f64>,
    y: f64,
}

struct Population {
    rows: Vec<Row>,
    denominators: BTreeMap<String, usize>,
    aggregation_backend: String,
    /// Numerical rank of the centered aggregated matrix (Methods PCA): PLS
    /// and PCR beyond it are ill-posed, so the grid never exceeds it.
    rank: usize,
}

struct Failure {
    status: Availability,
    reason: String,
    detail: Option<String>,
}

impl From<(Availability, &str)> for Failure {
    fn from((status, reason): (Availability, &str)) -> Self {
        Self {
            status,
            reason: reason.into(),
            detail: None,
        }
    }
}

impl From<ProviderError> for Failure {
    fn from(e: ProviderError) -> Self {
        Self {
            status: e.availability(),
            reason: e.reason,
            detail: e.detail,
        }
    }
}

fn push_all(
    report: &mut QualificationReport,
    source: &str,
    target: &str,
    estimator: Option<ProbeEstimator>,
    failure: &Failure,
) {
    for id in METRIC_IDS {
        let mut m = Metric::unavailable(
            id,
            failure.status.clone(),
            &failure.reason,
            Some(source),
            Some(target),
        );
        m.protocol_version = PROTOCOL.into();
        m.view_id = VIEW.into();
        m.population_id = POPULATION.into();
        if let Some(e) = estimator {
            m.parameters.insert("estimator".into(), json!(e.id()));
        }
        if let Some(detail) = &failure.detail {
            m.parameters
                .insert("provider_error_detail".into(), json!(detail));
        }
        if failure.reason == NUMERICAL_DOMAIN_EXCEEDED {
            m.parameters
                .insert("numerical_domain".into(), json!(PROBE_NUMERICAL_DOMAIN));
        }
        report.metrics.push(m);
    }
}

pub(crate) fn analyze(
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    methods: &impl MethodsProvider,
    validation: &impl ValidationProvider,
    report: &mut QualificationReport,
) {
    let options = &input.options.validation_probe;
    let available = validation
        .capabilities()
        .into_iter()
        .find(|c| c.capability_id == VALIDATION_CAPABILITY_ID);
    let methods_capabilities = methods.capabilities();
    let methods_missing = METHODS_NEEDED.iter().find(|id| {
        !methods_capabilities
            .iter()
            .any(|c| c.capability_id == **id && c.available)
    });
    for source in &input.sources {
        for target in &input.targets {
            let (src, tgt) = (source.source_id.as_str(), target.target_id.as_str());
            let refuse = |report: &mut QualificationReport, status, reason: &str| {
                push_all(report, src, tgt, None, &(status, reason).into());
            };
            if !options.enabled {
                refuse(
                    report,
                    Availability::NotApplicable,
                    "VALIDATION_PROBE_DISABLED",
                );
                continue;
            }
            if target.kind == TargetKind::Categorical {
                refuse(
                    report,
                    Availability::Unsupported,
                    "CLASSIFICATION_PROBE_NOT_QUALIFIED",
                );
                continue;
            }
            match &available {
                Some(c) if c.available => {}
                other => {
                    let reason = other
                        .as_ref()
                        .and_then(|c| c.reason.clone())
                        .unwrap_or_else(|| "VALIDATION_PROVIDER_NOT_CONFIGURED".into());
                    refuse(report, Availability::Unsupported, &reason);
                    continue;
                }
            }
            if methods_missing.is_some() {
                refuse(
                    report,
                    Availability::Unsupported,
                    "PROBE_METHODS_KERNELS_NOT_CONFIGURED",
                );
                continue;
            }
            let population = match population(source, target, input, samples, methods) {
                Ok(p) => p,
                Err(failure) => {
                    push_all(report, src, tgt, None, &failure);
                    continue;
                }
            };
            for &estimator in &options.estimators {
                if let Err(failure) = run_probe(
                    input,
                    source,
                    target,
                    estimator,
                    &population,
                    methods,
                    validation,
                    report,
                ) {
                    push_all(report, src, tgt, Some(estimator), &failure);
                }
            }
        }
    }
}

/// Exact development references, homogeneous technical aggregation per
/// physical sample × instrument × campaign (Methods group means), and the
/// shared indivisible identity components.
fn population(
    source: &SpectralSource,
    target: &Target,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    methods: &impl MethodsProvider,
) -> Result<Population, Failure> {
    let unit = input.options.independence_unit;
    if unit == IndependenceUnit::Unknown {
        return Err((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN").into());
    }
    let references = exact_development_references(target, samples);
    let y_of: BTreeMap<&str, f64> = references
        .eligible
        .iter()
        .filter_map(|v| Some((v.sample_id.as_str(), v.value?)))
        .collect();
    // Components over every identity and reference link of all samples,
    // before any analytic exclusion.
    let roots = independence_components(input, &[target]);
    let index: HashMap<&str, usize> = input
        .samples
        .iter()
        .enumerate()
        .map(|(i, s)| (s.sample_id.as_str(), i))
        .collect();
    let p = source.axis.len();
    let physical_of = |s: &Sample| {
        s.physical_sample_id
            .clone()
            .unwrap_or_else(|| s.sample_id.clone())
    };
    let mut groups: BTreeMap<(String, Domain), Vec<usize>> = BTreeMap::new();
    let mut n_dev = 0usize;
    for (r, id) in source.sample_ids.iter().enumerate() {
        let s = samples[id.as_str()];
        if s.partition != Partition::Development || s.augmentation_parent_id.is_some() {
            continue;
        }
        n_dev += 1;
        groups
            .entry((physical_of(s), (s.instrument.clone(), s.campaign.clone())))
            .or_default()
            .push(r);
    }
    let mut contexts_per_physical = BTreeMap::<&str, usize>::new();
    for (physical, _) in groups.keys() {
        *contexts_per_physical.entry(physical).or_default() += 1;
    }
    let mut denominators = BTreeMap::from([
        ("n_development_observations".to_string(), n_dev),
        (
            "n_excluded_censored_references".to_string(),
            references.excluded_censored,
        ),
        (
            "n_excluded_composite_references".to_string(),
            references.excluded_composite,
        ),
        (
            "n_excluded_inconsistent_reference_samples".to_string(),
            references.inconsistent,
        ),
    ]);
    let mut excluded = BTreeMap::<&str, usize>::new();
    let mut kept: Vec<(String, Domain, Vec<usize>)> = Vec::new();
    for ((physical, domain), obs) in &groups {
        let ids: BTreeSet<&str> = obs.iter().map(|&r| source.sample_ids[r].as_str()).collect();
        let reason = if contexts_per_physical[physical.as_str()] > 1 {
            Some("n_excluded_multicontext_observations")
        } else if ids.len() > 1
            || (obs.len() > 1
                && !obs.iter().all(|&r| {
                    source
                        .repetition_types
                        .as_ref()
                        .is_some_and(|t| t[r].is_technical())
                }))
        {
            Some("n_excluded_ambiguous_repeat_observations")
        } else if !y_of.contains_key(ids.first().copied().unwrap_or_default()) {
            Some("n_excluded_without_exact_reference_observations")
        } else if obs
            .iter()
            .any(|&r| (0..p).any(|c| crate::valid_cell(source, r, c).is_none()))
        {
            Some("n_excluded_incomplete_observations")
        } else {
            None
        };
        if let Some(reason) = reason {
            *excluded.entry(reason).or_default() += obs.len();
            continue;
        }
        kept.push((
            source.sample_ids[obs[0]].clone(),
            domain.clone(),
            obs.clone(),
        ));
    }
    for key in [
        "n_excluded_multicontext_observations",
        "n_excluded_ambiguous_repeat_observations",
        "n_excluded_without_exact_reference_observations",
        "n_excluded_incomplete_observations",
    ] {
        denominators.insert(key.into(), excluded.get(key).copied().unwrap_or(0));
    }
    // With `reference_group` units, every retained component must carry a
    // resolved reference group of this target, possibly through another
    // (even excluded) sample of the component; an unresolved one would act as
    // a singleton and could hide a dependence across folds.
    let resolved_reference: BTreeSet<usize> = target
        .values
        .iter()
        .filter(|v| v.reference_group_id.is_some())
        .filter_map(|v| index.get(v.sample_id.as_str()).map(|&i| roots[i]))
        .collect();
    let mut rows = Vec::with_capacity(kept.len());
    for (sample_id, domain, _) in &kept {
        let s = samples[sample_id.as_str()];
        if unit == IndependenceUnit::Group && s.independence_group.is_none() {
            return Err((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP").into());
        }
        let root = roots[index[sample_id.as_str()]];
        if unit == IndependenceUnit::ReferenceGroup && !resolved_reference.contains(&root) {
            return Err((Availability::NotIdentifiable, "REFERENCE_GROUP_UNRESOLVED").into());
        }
        rows.push(Row {
            y: y_of[sample_id.as_str()],
            sample_id: sample_id.clone(),
            component: format!("component:{}", input.samples[root].sample_id),
            domain: domain.clone(),
            x: Vec::new(),
        });
    }
    // An exact spectrum shared by two components is an undeclared repeat that
    // would cross a fold boundary: the probe is refused until it is resolved.
    let mut owner = BTreeMap::<Vec<u64>, &str>::new();
    for (row, (_, _, obs)) in rows.iter().zip(&kept) {
        for &r in obs {
            if let Some(key) = crate::exact_spectrum_key(source, r) {
                if *owner.entry(key).or_insert(&row.component) != row.component {
                    return Err((
                        Availability::NotIdentifiable,
                        "EXACT_DUPLICATE_SPECTRUM_ACROSS_COMPONENTS",
                    )
                        .into());
                }
            }
        }
    }
    if rows.windows(2).all(|w| w[0].y == w[1].y) && !rows.is_empty() {
        return Err((Availability::NotApplicable, "CONSTANT_TARGET").into());
    }
    let mut aggregation_backend = String::new();
    if !rows.is_empty() {
        // Methods equal-weight means of the technical repeats of each sample.
        let request = GroupMeansRequest {
            matrix: kept
                .iter()
                .flat_map(|(_, _, obs)| obs.iter())
                .map(|&r| {
                    (0..p)
                        .map(|c| crate::valid_cell(source, r, c).unwrap_or(0.0))
                        .collect()
                })
                .collect(),
            group_codes: kept
                .iter()
                .enumerate()
                .flat_map(|(g, (_, _, obs))| std::iter::repeat_n(g as i64, obs.len()))
                .collect(),
            n_groups: kept.len(),
        };
        let means = methods.group_means(&request)?;
        if means.means.len() != kept.len()
            || means
                .means
                .iter()
                .any(|m| m.len() != p || m.iter().any(|v| !v.is_finite()))
            || means
                .counts
                .iter()
                .zip(&kept)
                .any(|(&c, (_, _, obs))| c != obs.len())
        {
            return Err(ProviderError::internal("INVALID_PROVIDER_RESULT").into());
        }
        for (row, x) in rows.iter_mut().zip(means.means) {
            row.x = x;
        }
        aggregation_backend = means.backend_version;
    }
    let rank = numerical_rank(&rows, p, methods)?;
    denominators.insert("n_samples".into(), rows.len());
    denominators.insert(
        "n_independent_components".into(),
        rows.iter()
            .map(|r| &r.component)
            .collect::<BTreeSet<_>>()
            .len(),
    );
    Ok(Population {
        rows,
        denominators,
        aggregation_backend,
        rank,
    })
}

/// Count of singular values above `s_1 * max(n, p) * eps` (the NumPy
/// `matrix_rank` rule) of the centered matrix, from Methods PCA eigenvalues
/// (`s_i^2 / (n - 1)`).
fn numerical_rank(
    rows: &[Row],
    p: usize,
    methods: &impl MethodsProvider,
) -> Result<usize, Failure> {
    let n = rows.len();
    if n < 2 {
        return Ok(0);
    }
    let k = (n - 1).min(p);
    let pca = methods.pca(&PcaRequest {
        source_id: String::new(),
        sample_ids: Vec::new(),
        matrix: rows.iter().map(|r| r.x.clone()).collect(),
        n_components: k,
    })?;
    if pca.eigenvalues.len() != k
        || pca
            .eigenvalues
            .iter()
            .any(|v| !(v.is_finite() && *v >= 0.0))
    {
        return Err(invalid("INVALID_PROVIDER_RESULT"));
    }
    let first = pca.eigenvalues.iter().copied().fold(0.0f64, f64::max);
    let ratio = n.max(p) as f64 * f64::EPSILON;
    Ok(pca
        .eigenvalues
        .iter()
        .filter(|v| first > 0.0 && (**v / first).sqrt() > ratio)
        .count())
}

fn invalid(reason: &str) -> Failure {
    Failure {
        status: Availability::Error,
        reason: reason.into(),
        detail: None,
    }
}

/// Everything returned by the provider is re-checked against the request,
/// the plan and the identity components before any value is published.
fn validate_result(
    request: &ProbeRequest,
    plan: &ProbePlan,
    result: &ProbeResult,
) -> Result<(), Failure> {
    let component: BTreeMap<&str, &str> = request
        .sample_ids
        .iter()
        .map(String::as_str)
        .zip(request.group_ids.iter().map(String::as_str))
        .collect();
    let all: BTreeSet<&str> = component.keys().copied().collect();
    let check_partition = |universe: &BTreeSet<&str>,
                           folds: &[&ProbeFoldAssignment]|
     -> Result<(), Failure> {
        let mut validated = BTreeSet::new();
        for f in folds {
            let train: BTreeSet<&str> = f.train_sample_ids.iter().map(String::as_str).collect();
            let val: BTreeSet<&str> = f.validation_sample_ids.iter().map(String::as_str).collect();
            if val.is_empty()
                || train.len() != f.train_sample_ids.len()
                || val.len() != f.validation_sample_ids.len()
                || train.union(&val).copied().collect::<BTreeSet<_>>() != *universe
                || !train.is_disjoint(&val)
            {
                return Err(invalid("PROVIDER_FOLDS_NOT_A_PARTITION"));
            }
            let train_groups: BTreeSet<&str> = train.iter().map(|s| component[s]).collect();
            if val.iter().any(|s| train_groups.contains(component[s])) {
                return Err(invalid("PROVIDER_FOLD_SPLITS_IDENTITY_COMPONENT"));
            }
            for s in val {
                if !validated.insert(s) {
                    return Err(invalid("PROVIDER_FOLDS_NOT_A_PARTITION"));
                }
            }
        }
        if validated != *universe {
            return Err(invalid("PROVIDER_FOLDS_NOT_A_PARTITION"));
        }
        Ok(())
    };
    if result.outer_folds.len() != plan.outer_splits {
        return Err(invalid("PROVIDER_PLAN_MISMATCH"));
    }
    let mut fold_ids = BTreeSet::new();
    for outer in &result.outer_folds {
        for f in std::iter::once(&outer.fold).chain(&outer.inner_folds) {
            if f.fold_id.is_empty() || !fold_ids.insert(f.fold_id.as_str()) {
                return Err(invalid("PROVIDER_FOLD_IDS_NOT_UNIQUE"));
            }
        }
    }
    check_partition(
        &all,
        &result
            .outer_folds
            .iter()
            .map(|f| &f.fold)
            .collect::<Vec<_>>(),
    )?;
    for outer in &result.outer_folds {
        let train: BTreeSet<&str> = outer
            .fold
            .train_sample_ids
            .iter()
            .map(String::as_str)
            .collect();
        if outer.inner_folds.len() != plan.inner_splits {
            return Err(invalid("PROVIDER_PLAN_MISMATCH"));
        }
        check_partition(&train, &outer.inner_folds.iter().collect::<Vec<_>>())?;
        if outer
            .candidates
            .iter()
            .map(|c| c.n_components)
            .collect::<Vec<_>>()
            != plan.components
            || outer
                .candidates
                .iter()
                .any(|c| !(c.inner_rmse.is_finite() && c.inner_rmse >= 0.0))
        {
            return Err(invalid("INVALID_PROVIDER_RESULT"));
        }
        // The winner is the minimum inner RMSE, ties to fewer components.
        let best = outer
            .candidates
            .iter()
            .fold(None::<&ProbeCandidateScore>, |best, c| match best {
                Some(b) if b.inner_rmse <= c.inner_rmse => Some(b),
                _ => Some(c),
            })
            .map(|c| c.n_components);
        if best != Some(outer.selected_components) {
            return Err(invalid("PROVIDER_SELECTION_NOT_MINIMUM"));
        }
    }
    if result.n_fits != plan.n_fits {
        return Err(invalid("PROVIDER_FIT_COUNT_MISMATCH"));
    }
    let y: BTreeMap<&str, f64> = request
        .sample_ids
        .iter()
        .map(String::as_str)
        .zip(request.targets.iter().copied())
        .collect();
    let fold_of: BTreeMap<&str, &str> = result
        .outer_folds
        .iter()
        .flat_map(|f| {
            f.fold
                .validation_sample_ids
                .iter()
                .map(move |s| (s.as_str(), f.fold.fold_id.as_str()))
        })
        .collect();
    let mut seen = BTreeSet::new();
    for row in &result.oof {
        if !seen.insert(row.sample_id.as_str())
            || fold_of.get(row.sample_id.as_str()) != Some(&row.fold_id.as_str())
            || y.get(row.sample_id.as_str()).map(|v| v.to_bits()) != Some(row.y_true.to_bits())
            || !row.prediction.is_finite()
        {
            return Err(invalid("INVALID_PROVIDER_RESULT"));
        }
    }
    let m = &result.model;
    if seen != all
        || ![m.mse, m.rmse, m.mae].iter().all(|v| v.is_finite())
        || m.mse < 0.0
        || m.rmse < 0.0
        || m.mae < 0.0
    {
        return Err(invalid("INVALID_PROVIDER_RESULT"));
    }
    Ok(())
}

fn close(a: f64, b: f64, scale: f64) -> bool {
    (a - b).abs() <= SCORE_TOLERANCE * a.abs().max(b.abs()).max(scale)
}

/// Methods scores of paired rows, checked finite and in range.
fn scores(
    methods: &impl MethodsProvider,
    y_true: Vec<f64>,
    y_pred: Vec<f64>,
) -> Result<RegressionScores, Failure> {
    let s = methods.regression_scores(&RegressionScoresRequest { y_true, y_pred })?;
    if !(s.rmse.is_finite() && s.mae.is_finite() && s.rmse >= 0.0 && s.mae >= 0.0)
        || s.r2.is_some_and(|v| !v.is_finite() || v > 1.0)
        || (s.r2_exponent != 0 && s.r2.is_none_or(|v| !(-1.0 < v && v <= -0.5)))
    {
        return Err(invalid("INVALID_PROVIDER_RESULT"));
    }
    Ok(s)
}

/// `significand * 2^exponent`, with exponent 0 for an ordinary double. Ratios
/// of finite errors can exceed the double range inside the numerical domain;
/// they are published scaled, never as an infinity or an absent value.
#[derive(Debug, Clone, Copy)]
struct Scaled {
    significand: f64,
    exponent: i32,
}

impl Scaled {
    fn value(self) -> Value {
        if self.exponent == 0 {
            json!(self.significand)
        } else {
            json!({"significand": self.significand, "exponent": self.exponent,
                   "representation": "significand_times_2_pow_exponent"})
        }
    }
    fn is_nonpositive(self) -> bool {
        self.significand <= 0.0
    }
}

/// Mantissa in [0.5, 1) and exponent of a positive normal double.
fn split(x: f64) -> (f64, i32) {
    let exponent = ((x.to_bits() >> 52) & 0x7ff) as i32 - 1022;
    (
        f64::from_bits((x.to_bits() & !(0x7ff << 52)) | (1022u64 << 52)),
        exponent,
    )
}

/// `1 - SSE_model / SSE_train_mean` on identical rows (ratio of mean
/// squares), scaled when the ratio exceeds the double range.
fn skill(model: &RegressionScores, baseline: &RegressionScores) -> Result<Scaled, Failure> {
    let (num, den) = (model.rmse * model.rmse, baseline.rmse * baseline.rmse);
    if den <= 0.0 {
        return Err((Availability::Undefined, "ZERO_TRAIN_MEAN_ERROR").into());
    }
    if num == 0.0 {
        return Ok(Scaled {
            significand: 1.0,
            exponent: 0,
        });
    }
    let ((mn, en), (md, ed)) = (split(num), split(den));
    if en - ed < 1000 {
        return Ok(Scaled {
            significand: 1.0 - num / den,
            exponent: 0,
        });
    }
    // 1 is below the resolution of a ratio >= 2^999: skill = -num/den.
    let (m, e) = split(mn / md);
    Ok(Scaled {
        significand: -m,
        exponent: en - ed + e,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_probe(
    input: &QualificationInput,
    source: &SpectralSource,
    target: &Target,
    estimator: ProbeEstimator,
    population: &Population,
    methods: &impl MethodsProvider,
    validation: &impl ValidationProvider,
    report: &mut QualificationReport,
) -> Result<(), Failure> {
    let (src, tgt) = (source.source_id.as_str(), target.target_id.as_str());
    let rows = &population.rows;
    let mut sizes = BTreeMap::<&str, usize>::new();
    for r in rows {
        *sizes.entry(&r.component).or_default() += 1;
    }
    if population.rank == 0 {
        return Err((Availability::Undefined, "ZERO_NUMERICAL_RANK").into());
    }
    let plan = plan(
        rows.len(),
        sizes.len(),
        sizes.values().copied().max().unwrap_or(0),
        source.axis.len().min(population.rank),
    )
    .map_err(Failure::from)?;
    let max_fits = input.options.validation_probe.max_fits;
    if plan.n_fits > max_fits {
        return Err((Availability::Unsupported, "FIT_BUDGET_EXCEEDED").into());
    }
    let seed = derive_seed(
        input.options.seed,
        &format!(
            "nirs4all-preflight\0dag-ml\0{PROTOCOL}\0{src}\0{tgt}\0{}",
            estimator.id()
        ),
    );
    let request = ProbeRequest {
        probe_id: format!("{PROTOCOL}:{src}:{tgt}:{}", estimator.id()),
        estimator,
        components: plan.components.clone(),
        sample_ids: rows.iter().map(|r| r.sample_id.clone()).collect(),
        group_ids: rows.iter().map(|r| r.component.clone()).collect(),
        matrix: rows.iter().map(|r| r.x.clone()).collect(),
        targets: rows.iter().map(|r| r.y).collect(),
        outer_splits: plan.outer_splits,
        inner_splits: plan.inner_splits,
        seed,
    };
    let result = validation.probe(&request)?;
    validate_result(&request, &plan, &result)?;
    // Fold-train means and every score come from Methods kernels on the
    // verified OOF rows; the provider's own scores must agree.
    let y_of: HashMap<&str, f64> = request
        .sample_ids
        .iter()
        .map(String::as_str)
        .zip(request.targets.iter().copied())
        .collect();
    let mut train_mean = BTreeMap::<&str, f64>::new();
    let mut summary_backend = String::new();
    for outer in &result.outer_folds {
        let values: Vec<f64> = outer
            .fold
            .train_sample_ids
            .iter()
            .map(|s| y_of[s.as_str()])
            .collect();
        let summary = methods.summary(&SummaryRequest { values })?;
        if summary.count != outer.fold.train_sample_ids.len() || !summary.mean.is_finite() {
            return Err(invalid("INVALID_PROVIDER_RESULT"));
        }
        train_mean.insert(&outer.fold.fold_id, summary.mean);
        summary_backend = summary.backend_version;
    }
    let y_true: Vec<f64> = result.oof.iter().map(|r| r.y_true).collect();
    let predictions: Vec<f64> = result.oof.iter().map(|r| r.prediction).collect();
    let baseline_predictions: Vec<f64> = result
        .oof
        .iter()
        .map(|r| train_mean[r.fold_id.as_str()])
        .collect();
    let model = scores(methods, y_true.clone(), predictions.clone())?;
    let baseline = scores(methods, y_true.clone(), baseline_predictions.clone())?;
    let reported = &result.model;
    let y_scale = y_true.iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1.0);
    if !close(reported.rmse, model.rmse, y_scale)
        || !close(reported.mae, model.mae, y_scale)
        || !close(reported.mse, model.rmse * model.rmse, y_scale * y_scale)
    {
        return Err(invalid("PROVIDER_SCORES_DISAGREE_WITH_METHODS"));
    }
    let parameters = BTreeMap::from([
        ("estimator".to_string(), json!(estimator.id())),
        (
            "recipe".into(),
            json!(match estimator {
                ProbeEstimator::Pls => "methods:models.pls.pls_regression;solver=nipals;center_x=true;scale_x=false;center_y=true;scale_y=false",
                ProbeEstimator::Pcr => "methods:models.pls.pcr;center_x=true;scale_x=false;center_y=true;scale_y=false",
            }),
        ),
        ("component_grid".into(), json!(plan.components)),
        ("outer_splits".into(), json!(plan.outer_splits)),
        ("inner_splits".into(), json!(plan.inner_splits)),
        (
            "fold_plan".into(),
            json!("dag_ml_group_kfold_largest_group_to_lightest_fold"),
        ),
        (
            "selection".into(),
            json!("min_pooled_inner_oof_rmse_ties_to_fewest_components"),
        ),
        (
            "baseline".into(),
            json!("outer_fold_train_mean_of_y_methods_summary"),
        ),
        (
            "aggregation".into(),
            json!("methods_group_means_of_technical_repeats_within_physical_instrument_campaign_before_fit"),
        ),
        (
            "scores".into(),
            json!("methods_stats_regression_scores_rmse_mae_r2; provider scores checked within relative tolerance"),
        ),
        ("score_tolerance".into(), json!(SCORE_TOLERANCE)),
        ("numerical_domain".into(), json!(PROBE_NUMERICAL_DOMAIN)),
        (
            "independence_unit".into(),
            json!(input.options.independence_unit),
        ),
        (
            "indivisible_components".into(),
            json!("independence_components: physical_sample+individual+augmentation_parent+reference_group+declared_group"),
        ),
        ("seed".into(), json!(seed.to_string())),
        (
            "seed_derivation".into(),
            json!(format!("derive_seed(options.seed, nirs4all-preflight/dag-ml/{PROTOCOL}/source/target/estimator)")),
        ),
        ("validation_backend".into(), json!(result.backend_version)),
        ("methods_backend".into(), json!(model.backend_version)),
        (
            "aggregation_backend".into(),
            json!(population.aggregation_backend),
        ),
        ("summary_backend".into(), json!(summary_backend)),
        ("n_fits".into(), json!(result.n_fits)),
        ("max_fits".into(), json!(max_fits)),
        ("uncertainty".into(), Value::Null),
        (
            "uncertainty_reason".into(),
            json!("NOT_ESTIMATED_FOLDS_ARE_NOT_INDEPENDENT_OBSERVATIONS"),
        ),
    ]);
    let unit = target
        .unit
        .as_ref()
        .filter(|u| !u.trim().is_empty())
        .cloned();
    let push = |report: &mut QualificationReport,
                id: &str,
                value: Result<Value, Failure>,
                with_unit: bool| {
        let mut m = match value {
            Ok(v) => Metric::computed(id, v, Some(src), Some(tgt)),
            Err(f) => Metric::unavailable(id, f.status, &f.reason, Some(src), Some(tgt)),
        };
        m.protocol_version = PROTOCOL.into();
        m.view_id = VIEW.into();
        m.population_id = POPULATION.into();
        m.denominators = population.denominators.clone();
        m.denominators.insert("n_oof_rows".into(), result.oof.len());
        m.parameters = parameters.clone();
        if with_unit {
            m.unit = unit.clone();
        }
        report.metrics.push(m);
    };
    push(
        report,
        "probe.plan",
        Ok(json!({
            "outer_splits": plan.outer_splits,
            "inner_splits": plan.inner_splits,
            "component_grid": plan.components,
            "planned_fits": plan.n_fits,
            "numerical_rank": population.rank,
            "outer_target": OUTER_TARGET,
            "inner_target": INNER_TARGET,
        })),
        false,
    );
    let inline = result.oof.len() <= INLINE_ROWS;
    let too_large = || -> Result<Value, Failure> {
        Err((Availability::Unsupported, "INLINE_ROW_BUDGET_EXCEEDED").into())
    };
    push(
        report,
        "probe.folds",
        if inline {
            Ok(json!(result
                .outer_folds
                .iter()
                .map(|f| json!({
                    "fold_id": f.fold.fold_id,
                    "fit_sample_ids": f.fold.train_sample_ids,
                    "eval_sample_ids": f.fold.validation_sample_ids,
                    "inner_folds": f.inner_folds.iter().map(|i| json!({
                        "fold_id": i.fold_id,
                        "fit_sample_ids": i.train_sample_ids,
                        "eval_sample_ids": i.validation_sample_ids,
                    })).collect::<Vec<_>>(),
                    "inner_rmse_by_components": f.candidates.iter().map(|c| json!([c.n_components, c.inner_rmse])).collect::<Vec<_>>(),
                    "selected_components": f.selected_components,
                    "train_mean": train_mean[f.fold.fold_id.as_str()],
                }))
                .collect::<Vec<_>>()))
        } else {
            too_large()
        },
        false,
    );
    let selected: BTreeMap<&str, usize> = result
        .outer_folds
        .iter()
        .map(|f| (f.fold.fold_id.as_str(), f.selected_components))
        .collect();
    push(
        report,
        "probe.oof_predictions",
        if inline {
            Ok(json!({
                "sample_ids": result.oof.iter().map(|r| &r.sample_id).collect::<Vec<_>>(),
                "fold_ids": result.oof.iter().map(|r| &r.fold_id).collect::<Vec<_>>(),
                "y_true": y_true,
                "prediction": predictions,
                "train_mean_prediction": baseline_predictions,
                "selected_components": result.oof.iter().map(|r| selected[r.fold_id.as_str()]).collect::<Vec<_>>(),
            }))
        } else {
            too_large()
        },
        true,
    );
    push(report, "probe.rmse", Ok(json!(model.rmse)), true);
    push(report, "probe.mae", Ok(json!(model.mae)), true);
    let y_varies = y_true.windows(2).any(|w| w[0] != w[1]);
    push(
        report,
        "probe.r2_oof",
        if let (true, Some(r2)) = (y_varies, model.r2) {
            Ok(Scaled {
                significand: r2,
                exponent: model.r2_exponent,
            }
            .value())
        } else {
            Err((Availability::Undefined, "ZERO_EVALUATION_TARGET_VARIANCE").into())
        },
        false,
    );
    let skill_value = skill(&model, &baseline);
    let skill_finding = skill_value.as_ref().ok().copied();
    push(
        report,
        "probe.skill_vs_train_mean",
        skill_value.map(Scaled::value),
        false,
    );
    push(
        report,
        "probe.train_mean_rmse",
        Ok(json!(baseline.rmse)),
        true,
    );
    push(
        report,
        "probe.train_mean_mae",
        Ok(json!(baseline.mae)),
        true,
    );
    push(
        report,
        "probe.domain_scores",
        domain_scores(rows, &result, &train_mean, methods),
        false,
    );
    if skill_finding.is_some_and(Scaled::is_nonpositive) {
        report.findings.push(Finding {
            rule_id: "probe.no_skill_over_train_mean.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence: vec!["probe.skill_vs_train_mean".into()],
            message: format!(
                "The grouped {} probe of {tgt} on {src} does not improve on the fold-train mean",
                estimator.id().to_uppercase()
            ),
            action: "Read as limited accessible signal for this fixed recipe; it does not show that every calibration is impossible".into(),
        });
    }
    Ok(())
}

/// Methods scores per instrument × campaign domain of the OOF rows. Absent
/// metadata stays `null`, distinct from any present value.
fn domain_scores(
    rows: &[Row],
    result: &ProbeResult,
    train_mean: &BTreeMap<&str, f64>,
    methods: &impl MethodsProvider,
) -> Result<Value, Failure> {
    let domain: BTreeMap<&str, &Domain> = rows
        .iter()
        .map(|r| (r.sample_id.as_str(), &r.domain))
        .collect();
    let mut by_domain: BTreeMap<&Domain, Vec<&ProbeOofRow>> = BTreeMap::new();
    for row in &result.oof {
        by_domain
            .entry(domain[row.sample_id.as_str()])
            .or_default()
            .push(row);
    }
    let mut out = Vec::new();
    for ((instrument, campaign), oof) in by_domain {
        let y_true: Vec<f64> = oof.iter().map(|r| r.y_true).collect();
        let model = scores(
            methods,
            y_true.clone(),
            oof.iter().map(|r| r.prediction).collect(),
        )?;
        let baseline = scores(
            methods,
            y_true,
            oof.iter().map(|r| train_mean[r.fold_id.as_str()]).collect(),
        )?;
        out.push(json!({
            "instrument": instrument,
            "campaign": campaign,
            "n_samples": oof.len(),
            "rmse": model.rmse,
            "mae": model.mae,
            "train_mean_rmse": baseline.rmse,
            "train_mean_mae": baseline.mae,
            "skill_vs_train_mean": skill(&model, &baseline).ok().map(Scaled::value),
        }));
    }
    Ok(json!(out))
}
