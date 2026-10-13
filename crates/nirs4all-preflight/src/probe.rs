//! Grouped predictability probe (`validation_probe.v1`, PF-04, exploratory).
//!
//! The engine selects the population, aggregates homogeneous technical
//! repeats, builds the indivisible identity components, fixes the plan and
//! the component grid, validates what the provider returns and owns statuses
//! and findings. The validation provider (DAG-ML) owns every CV loop, the
//! inner selection and the scores; Methods fits PLS/PCR inside DAG-ML.
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

/// Stable per-probe seed: SplitMix64 finalizer of the root seed XOR the
/// FNV-1a 64 hash of the DAG-ML derivation domain.
pub(crate) fn derive_seed(root: u64, source: &str, target: &str, estimator: &str) -> u64 {
    let domain = format!("nirs4all-preflight\0dag-ml\0{PROTOCOL}\0{source}\0{target}\0{estimator}");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in domain.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mut z = root ^ hash;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

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
/// the grid is `1..=min(10, p, floor(B) - 1)`.
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

/// One aggregated sample of the probe population.
struct Row {
    sample_id: String,
    component: String,
    domain: String,
    x: Vec<f64>,
    y: f64,
}

struct Population {
    rows: Vec<Row>,
    denominators: BTreeMap<String, usize>,
}

fn push_all(
    report: &mut QualificationReport,
    source: &str,
    target: &str,
    estimator: Option<ProbeEstimator>,
    status: Availability,
    reason: &str,
) {
    for id in METRIC_IDS {
        let mut m = Metric::unavailable(id, status.clone(), reason, Some(source), Some(target));
        m.protocol_version = PROTOCOL.into();
        m.view_id = VIEW.into();
        m.population_id = POPULATION.into();
        if let Some(e) = estimator {
            m.parameters.insert("estimator".into(), json!(e.id()));
        }
        report.metrics.push(m);
    }
}

pub(crate) fn analyze(
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    validation: &impl ValidationProvider,
    report: &mut QualificationReport,
) {
    let options = &input.options.validation_probe;
    let available = validation
        .capabilities()
        .into_iter()
        .find(|c| c.capability_id == VALIDATION_CAPABILITY_ID);
    for source in &input.sources {
        for target in &input.targets {
            let (src, tgt) = (source.source_id.as_str(), target.target_id.as_str());
            if !options.enabled {
                push_all(
                    report,
                    src,
                    tgt,
                    None,
                    Availability::NotApplicable,
                    "VALIDATION_PROBE_DISABLED",
                );
                continue;
            }
            if target.kind == TargetKind::Categorical {
                push_all(
                    report,
                    src,
                    tgt,
                    None,
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
                    push_all(report, src, tgt, None, Availability::Unsupported, &reason);
                    continue;
                }
            }
            let population = match population(source, target, input, samples) {
                Ok(p) => p,
                Err((status, reason)) => {
                    push_all(report, src, tgt, None, status, reason);
                    continue;
                }
            };
            for &estimator in &options.estimators {
                run_probe(
                    input,
                    source,
                    target,
                    estimator,
                    &population,
                    validation,
                    report,
                );
            }
        }
    }
}

/// Exact development references, homogeneous technical aggregation per
/// physical sample × instrument × campaign, and indivisible components.
fn population(
    source: &SpectralSource,
    target: &Target,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
) -> Result<Population, (Availability, &'static str)> {
    let unit = input.options.independence_unit;
    if unit == IndependenceUnit::Unknown {
        return Err((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN"));
    }
    let references = exact_development_references(target, samples);
    let y_of: BTreeMap<&str, f64> = references
        .eligible
        .iter()
        .filter_map(|v| Some((v.sample_id.as_str(), v.value?)))
        .collect();
    let mut reference_groups: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for v in &target.values {
        if let Some(g) = &v.reference_group_id {
            reference_groups
                .entry(v.sample_id.as_str())
                .or_default()
                .insert(g);
        }
    }
    let p = source.axis.len();
    let physical_of = |s: &Sample| {
        s.physical_sample_id
            .clone()
            .unwrap_or_else(|| s.sample_id.clone())
    };
    let mut groups: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    let mut n_dev = 0usize;
    for (r, id) in source.sample_ids.iter().enumerate() {
        let s = samples[id.as_str()];
        if s.partition != Partition::Development || s.augmentation_parent_id.is_some() {
            continue;
        }
        n_dev += 1;
        groups
            .entry((
                physical_of(s),
                s.instrument.clone().unwrap_or_default(),
                s.campaign.clone().unwrap_or_default(),
            ))
            .or_default()
            .push(r);
    }
    let mut contexts_per_physical = BTreeMap::<&str, usize>::new();
    for (physical, _, _) in groups.keys() {
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
    let mut rows = Vec::new();
    let mut row_observations = Vec::new();
    for ((physical, instrument, campaign), obs) in &groups {
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
        let sample_id = source.sample_ids[obs[0]].clone();
        let x = (0..p)
            .map(|c| {
                obs.iter()
                    .filter_map(|&r| crate::valid_cell(source, r, c))
                    .sum::<f64>()
                    / obs.len() as f64
            })
            .collect();
        rows.push(Row {
            y: y_of[sample_id.as_str()],
            sample_id,
            component: String::new(),
            domain: format!("{instrument}|{campaign}"),
            x,
        });
        row_observations.push(obs.clone());
    }
    for key in [
        "n_excluded_multicontext_observations",
        "n_excluded_ambiguous_repeat_observations",
        "n_excluded_without_exact_reference_observations",
        "n_excluded_incomplete_observations",
    ] {
        denominators.insert(key.into(), excluded.get(key).copied().unwrap_or(0));
    }
    // Indivisible components over every development sample (augmented ones
    // included, through their parent), so links through an excluded sample
    // still hold: physical object, individual, reference group of this
    // target, augmentation parent and the declared group stay together.
    let linked: Vec<&Sample> = input
        .samples
        .iter()
        .filter(|s| s.partition == Partition::Development)
        .collect();
    let mut parent: Vec<usize> = (0..linked.len()).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let in_rows: BTreeSet<&str> = rows.iter().map(|r| r.sample_id.as_str()).collect();
    let mut first_for_key = BTreeMap::<String, usize>::new();
    for (i, s) in linked.iter().enumerate() {
        let mut keys = vec![
            format!("sample:{}", s.sample_id),
            format!("physical:{}", physical_of(s)),
        ];
        keys.extend(s.individual_id.iter().map(|v| format!("individual:{v}")));
        keys.extend(
            s.augmentation_parent_id
                .iter()
                .map(|v| format!("sample:{v}")),
        );
        keys.extend(
            reference_groups
                .get(s.sample_id.as_str())
                .into_iter()
                .flatten()
                .map(|g| format!("reference:{g}")),
        );
        if unit == IndependenceUnit::Group {
            match &s.independence_group {
                Some(g) => keys.push(format!("group:{g}")),
                None if in_rows.contains(s.sample_id.as_str()) => {
                    return Err((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"))
                }
                None => {}
            }
        }
        for key in keys {
            match first_for_key.get(&key) {
                Some(&first) => {
                    let (a, b) = (root(&mut parent, i), root(&mut parent, first));
                    parent[a] = b;
                }
                None => {
                    first_for_key.insert(key, i);
                }
            }
        }
    }
    // A component is named by its smallest probe sample ID.
    let index: HashMap<&str, usize> = linked
        .iter()
        .enumerate()
        .map(|(i, s)| (s.sample_id.as_str(), i))
        .collect();
    let mut names = BTreeMap::<usize, String>::new();
    for row in &rows {
        let name = names
            .entry(root(&mut parent, index[row.sample_id.as_str()]))
            .or_insert_with(|| row.sample_id.clone());
        if row.sample_id < *name {
            name.clone_from(&row.sample_id);
        }
    }
    for row in &mut rows {
        row.component = format!(
            "component:{}",
            names[&root(&mut parent, index[row.sample_id.as_str()])]
        );
    }
    // An exact spectrum shared by two components is an undeclared repeat that
    // would cross a fold boundary: the probe is refused until it is resolved.
    let mut owner = BTreeMap::<Vec<u64>, &str>::new();
    for (row, obs) in rows.iter().zip(&row_observations) {
        for &r in obs {
            if let Some(key) = crate::exact_spectrum_key(source, r) {
                if *owner.entry(key).or_insert(&row.component) != row.component {
                    return Err((
                        Availability::NotIdentifiable,
                        "EXACT_DUPLICATE_SPECTRUM_ACROSS_COMPONENTS",
                    ));
                }
            }
        }
    }
    if rows.windows(2).all(|w| w[0].y == w[1].y) && !rows.is_empty() {
        return Err((Availability::NotApplicable, "CONSTANT_TARGET"));
    }
    denominators.insert("n_samples".into(), rows.len());
    denominators.insert(
        "n_independent_components".into(),
        rows.iter()
            .map(|r| &r.component)
            .collect::<BTreeSet<_>>()
            .len(),
    );
    Ok(Population { rows, denominators })
}

fn validate_result(
    request: &ProbeRequest,
    plan: &ProbePlan,
    result: &ProbeResult,
) -> Result<(), &'static str> {
    let component: BTreeMap<&str, &str> = request
        .sample_ids
        .iter()
        .map(String::as_str)
        .zip(request.group_ids.iter().map(String::as_str))
        .collect();
    let all: BTreeSet<&str> = component.keys().copied().collect();
    let check_partition = |universe: &BTreeSet<&str>,
                           folds: &[&ProbeFoldAssignment]|
     -> Result<(), &'static str> {
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
                return Err("PROVIDER_FOLDS_NOT_A_PARTITION");
            }
            let train_groups: BTreeSet<&str> = train.iter().map(|s| component[s]).collect();
            if val.iter().any(|s| train_groups.contains(component[s])) {
                return Err("PROVIDER_FOLD_SPLITS_IDENTITY_COMPONENT");
            }
            for s in val {
                if !validated.insert(s) {
                    return Err("PROVIDER_FOLDS_NOT_A_PARTITION");
                }
            }
        }
        if validated != *universe {
            return Err("PROVIDER_FOLDS_NOT_A_PARTITION");
        }
        Ok(())
    };
    if result.outer_folds.len() != plan.outer_splits {
        return Err("PROVIDER_PLAN_MISMATCH");
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
            return Err("PROVIDER_PLAN_MISMATCH");
        }
        check_partition(&train, &outer.inner_folds.iter().collect::<Vec<_>>())?;
        if outer
            .candidates
            .iter()
            .map(|c| c.n_components)
            .collect::<Vec<_>>()
            != plan.components
            || outer.candidates.iter().any(|c| !c.inner_rmse.is_finite())
            || !plan.components.contains(&outer.selected_components)
            || !outer.train_mean.is_finite()
        {
            return Err("INVALID_PROVIDER_RESULT");
        }
    }
    let y: BTreeMap<&str, f64> = request
        .sample_ids
        .iter()
        .map(String::as_str)
        .zip(request.targets.iter().copied())
        .collect();
    let fold_of: BTreeMap<&str, &ProbeOuterFold> = result
        .outer_folds
        .iter()
        .flat_map(|f| {
            f.fold
                .validation_sample_ids
                .iter()
                .map(move |s| (s.as_str(), f))
        })
        .collect();
    let mut seen = BTreeSet::new();
    for row in &result.oof {
        let Some(fold) = fold_of.get(row.sample_id.as_str()) else {
            return Err("INVALID_PROVIDER_RESULT");
        };
        if !seen.insert(row.sample_id.as_str())
            || fold.fold.fold_id != row.fold_id
            || y[row.sample_id.as_str()].to_bits() != row.y_true.to_bits()
            || !row.prediction.is_finite()
            || row.train_mean_prediction.to_bits() != fold.train_mean.to_bits()
        {
            return Err("INVALID_PROVIDER_RESULT");
        }
    }
    let finite = |s: &ProbeScores| {
        [s.mse, s.rmse, s.mae, s.r2].iter().all(|v| v.is_finite()) && s.mse >= 0.0
    };
    if seen != all || !finite(&result.model) || !finite(&result.train_mean) {
        return Err("INVALID_PROVIDER_RESULT");
    }
    Ok(())
}

fn run_probe(
    input: &QualificationInput,
    source: &SpectralSource,
    target: &Target,
    estimator: ProbeEstimator,
    population: &Population,
    validation: &impl ValidationProvider,
    report: &mut QualificationReport,
) {
    let (src, tgt) = (source.source_id.as_str(), target.target_id.as_str());
    let rows = &population.rows;
    let mut sizes = BTreeMap::<&str, usize>::new();
    for r in rows {
        *sizes.entry(&r.component).or_default() += 1;
    }
    let plan = match plan(
        rows.len(),
        sizes.len(),
        sizes.values().copied().max().unwrap_or(0),
        source.axis.len(),
    ) {
        Ok(p) => p,
        Err((status, reason)) => {
            push_all(report, src, tgt, Some(estimator), status, reason);
            return;
        }
    };
    let max_fits = input.options.validation_probe.max_fits;
    if plan.n_fits > max_fits {
        push_all(
            report,
            src,
            tgt,
            Some(estimator),
            Availability::Unsupported,
            "FIT_BUDGET_EXCEEDED",
        );
        return;
    }
    let seed = derive_seed(input.options.seed, src, tgt, estimator.id());
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
    let result = match validation.probe(&request) {
        Ok(r) => match validate_result(&request, &plan, &r) {
            Ok(()) => r,
            Err(reason) => {
                push_all(
                    report,
                    src,
                    tgt,
                    Some(estimator),
                    Availability::Error,
                    reason,
                );
                return;
            }
        },
        Err(e) => {
            push_all(
                report,
                src,
                tgt,
                Some(estimator),
                Availability::Unsupported,
                &e.0,
            );
            return;
        }
    };
    let mut parameters = BTreeMap::from([
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
            json!("outer_fold_train_mean_of_y"),
        ),
        (
            "aggregation".into(),
            json!("equal_mean_of_technical_repeats_within_physical_instrument_campaign_before_fit"),
        ),
        (
            "independence_unit".into(),
            json!(input.options.independence_unit),
        ),
        (
            "indivisible_components".into(),
            json!("physical_sample+individual+reference_group+declared_independence_unit"),
        ),
        ("seed".into(), json!(seed.to_string())),
        (
            "seed_derivation".into(),
            json!(format!("splitmix64_finalizer(options.seed xor fnv1a64(nirs4all-preflight/dag-ml/{PROTOCOL}/source/target/estimator))")),
        ),
        ("validation_backend".into(), json!(result.backend_version)),
        ("n_fits".into(), json!(result.n_fits)),
        ("max_fits".into(), json!(max_fits)),
        ("uncertainty".into(), Value::Null),
        (
            "uncertainty_reason".into(),
            json!("NOT_ESTIMATED_FOLDS_ARE_NOT_INDEPENDENT_OBSERVATIONS"),
        ),
    ]);
    if result.n_fits != plan.n_fits {
        parameters.insert("planned_fits".into(), json!(plan.n_fits));
    }
    let unit = (!target.unit.as_deref().unwrap_or("").trim().is_empty())
        .then(|| target.unit.clone())
        .flatten();
    let push = |report: &mut QualificationReport,
                id: &str,
                value: Result<Value, (Availability, &str)>,
                with_unit: bool| {
        let mut m = match value {
            Ok(v) => Metric::computed(id, v, Some(src), Some(tgt)),
            Err((status, reason)) => Metric::unavailable(id, status, reason, Some(src), Some(tgt)),
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
            "outer_target": OUTER_TARGET,
            "inner_target": INNER_TARGET,
        })),
        false,
    );
    let folds = json!(result
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
            "train_mean": f.train_mean,
        }))
        .collect::<Vec<_>>());
    let inline = result.oof.len() <= INLINE_ROWS;
    push(
        report,
        "probe.folds",
        if inline {
            Ok(folds)
        } else {
            Err((Availability::Unsupported, "INLINE_ROW_BUDGET_EXCEEDED"))
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
                "y_true": result.oof.iter().map(|r| r.y_true).collect::<Vec<_>>(),
                "prediction": result.oof.iter().map(|r| r.prediction).collect::<Vec<_>>(),
                "train_mean_prediction": result.oof.iter().map(|r| r.train_mean_prediction).collect::<Vec<_>>(),
                "selected_components": result.oof.iter().map(|r| selected[r.fold_id.as_str()]).collect::<Vec<_>>(),
            }))
        } else {
            Err((Availability::Unsupported, "INLINE_ROW_BUDGET_EXCEEDED"))
        },
        true,
    );
    push(report, "probe.rmse", Ok(json!(result.model.rmse)), true);
    push(report, "probe.mae", Ok(json!(result.model.mae)), true);
    let y_varies = result.oof.windows(2).any(|w| w[0].y_true != w[1].y_true);
    push(
        report,
        "probe.r2_oof",
        if y_varies {
            Ok(json!(result.model.r2))
        } else {
            Err((Availability::Undefined, "ZERO_EVALUATION_TARGET_VARIANCE"))
        },
        false,
    );
    let skill_value = skill(&result.model, &result.train_mean);
    push(
        report,
        "probe.skill_vs_train_mean",
        skill_value.clone().map(|v| json!(v)),
        false,
    );
    push(
        report,
        "probe.train_mean_rmse",
        Ok(json!(result.train_mean.rmse)),
        true,
    );
    push(
        report,
        "probe.train_mean_mae",
        Ok(json!(result.train_mean.mae)),
        true,
    );
    push(
        report,
        "probe.domain_scores",
        domain_scores(rows, &result, validation),
        false,
    );
    if let Ok(v) = skill_value {
        if v <= 0.0 {
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
    }
}

/// `1 - SSE_model / SSE_train_mean` on identical rows and weights.
fn skill(model: &ProbeScores, baseline: &ProbeScores) -> Result<f64, (Availability, &'static str)> {
    if baseline.mse > 0.0 {
        Ok(1.0 - model.mse / baseline.mse)
    } else {
        Err((Availability::Undefined, "ZERO_TRAIN_MEAN_ERROR"))
    }
}

/// Provider scores per instrument × campaign domain of the OOF rows.
fn domain_scores(
    rows: &[Row],
    result: &ProbeResult,
    validation: &impl ValidationProvider,
) -> Result<Value, (Availability, &'static str)> {
    let domain: BTreeMap<&str, &str> = rows
        .iter()
        .map(|r| (r.sample_id.as_str(), r.domain.as_str()))
        .collect();
    let mut by_domain: BTreeMap<&str, Vec<&ProbeOofRow>> = BTreeMap::new();
    for row in &result.oof {
        by_domain
            .entry(domain[row.sample_id.as_str()])
            .or_default()
            .push(row);
    }
    let mut out = Vec::new();
    for (name, oof) in by_domain {
        let y_true: Vec<f64> = oof.iter().map(|r| r.y_true).collect();
        let score = |predictions: Vec<f64>| {
            validation
                .score(&ProbeScoreRequest {
                    y_true: y_true.clone(),
                    predictions,
                })
                .ok()
                .filter(|s| [s.mse, s.rmse, s.mae].iter().all(|v| v.is_finite()))
                .ok_or((Availability::Error, "INVALID_PROVIDER_RESULT"))
        };
        let model = score(oof.iter().map(|r| r.prediction).collect())?;
        let baseline = score(oof.iter().map(|r| r.train_mean_prediction).collect())?;
        let (instrument, campaign) = name.split_once('|').unwrap_or((name, ""));
        out.push(json!({
            "instrument": instrument,
            "campaign": campaign,
            "n_samples": oof.len(),
            "rmse": model.rmse,
            "mae": model.mae,
            "train_mean_rmse": baseline.rmse,
            "train_mean_mae": baseline.mae,
            "skill_vs_train_mean": skill(&model, &baseline).ok(),
        }));
    }
    Ok(json!(out))
}
