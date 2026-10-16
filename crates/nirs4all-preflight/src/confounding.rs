//! Marginal effects of declared categorical factors on the canonical spectral
//! structure (protocol `confounding.v1`, exploratory). Methods computes
//! PERMANOVA, PERMDISP and Holm; this module owns the population, the
//! independence units, the design and aliasing report, the permutation plans,
//! seeds, statuses and findings.
use crate::clustering::Geometry;
use crate::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROTOCOL: &str = "confounding.v1";
/// Monte Carlo budget per global test (specification section 6).
const PERMUTATIONS: usize = 999;
/// Holm family-wise error rate of each per-source test family.
const FAMILY_ALPHA: f64 = 0.05;
/// sqrt(f64::EPSILON), applied by Methods on the F scale: F_perm >= F_obs - tolerance (vegan).
const TIE_TOLERANCE: f64 = 1.490_116_119_384_765_6e-8;
const VIEW: &str = "canonical:centered";
/// Supported numerical domain of the Methods kernels (rules 13 and 15),
/// published with each metric; same bounds and keys as the association
/// metrics.
fn numerical_domain() -> Value {
    json!({"supported_domain": {
               "nonzero_abs_min": "2^-256", "nonzero_abs_max": "2^256",
               "max_over_min_nonzero_abs_per_array": "2^32",
               "zeros": "allowed",
               "checked_arrays": "unit coordinate matrix (canonical PCA scores averaged per unit), one array"},
           "outside_domain": "unsupported_NUMERICAL_DOMAIN_EXCEEDED",
           "invariance": "scale_2k_translation_and_constant_columns_inside_domain",
           "sums_of_squares": "explicit residuals; published as value x 2^binary_exponent, exponent 0 when every positive value is a normal double",
           "centring_rounding": "about n x f64 epsilon times the range of each coordinate",
           "f_resolution": "an F is undefined only for an exactly zero residual SS; otherwise it is published with residual_ss_resolution_ratio (Methods error estimate of the residual SS divided by it, a conservative first-order estimate) and numerically_unresolved = true when that ratio is >= 1"})
}

/// Resolution of a published F: the Methods ratio (error estimate of the
/// residual SS over it) and whether the F is numerically unresolved.
fn f_resolution(unresolved: bool, ratio: Option<f64>) -> Value {
    json!({"numerically_unresolved": unresolved, "residual_ss_resolution_ratio": ratio})
}

/// Categorical metadata factors in report order: `instrument`, `campaign`,
/// then the declared categorical columns of the typed metadata map
/// (`QualificationInput::metadata_factors`, shared with associations).
fn categorical_factors(input: &QualificationInput) -> Vec<MetadataFactor<'_>> {
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
        MetadataLevel::Category(level) => Some(level),
        MetadataLevel::Value(_) => None,
    }
}

fn seed(input: &QualificationInput, source_id: &str, test: &str, factor: &str) -> (u64, String) {
    let domain = format!("nirs4all-preflight\0methods\0{PROTOCOL}\0{source_id}\0{test}\0{factor}");
    (
        derive_seed(input.options.seed, &domain),
        format!("splitmix64_finalizer(options.seed XOR fnv1a64({domain:?}))"),
    )
}

fn tag(metric: &mut Metric, factor: Option<&str>) {
    metric.view_id = VIEW.into();
    metric.parameters.insert("protocol".into(), json!(PROTOCOL));
    metric
        .parameters
        .insert("numerical_domain".into(), numerical_domain());
    if let Some(factor) = factor {
        metric.scope = "source_factor".into();
        metric.parameters.insert("factor".into(), json!(factor));
    } else {
        metric.scope = "source".into();
    }
}

fn unavailable_metric(
    id: &str,
    status: Availability,
    reason: &str,
    source_id: &str,
    factor: Option<&str>,
) -> Metric {
    let mut metric = Metric::unavailable(id, status, reason, Some(source_id), None);
    tag(&mut metric, factor);
    metric
}

/// Source-level metrics when the canonical PCA geometry is unavailable.
pub(crate) fn unavailable(
    report: &mut QualificationReport,
    source_id: &str,
    status: Availability,
    reason: &str,
) {
    for id in ["confounding.design", "confounding.variance_partition"] {
        report.metrics.push(unavailable_metric(
            id,
            status.clone(),
            reason,
            source_id,
            None,
        ));
    }
}

/// Analysis rows: independence units with one coordinate each.
struct Units<'a> {
    /// Mean canonical PCA scores of the unit's eligible samples.
    coordinates: Vec<Vec<f64>>,
    /// Level of every declared factor, per analysed unit.
    levels: Vec<BTreeMap<&'a str, String>>,
    n_units: usize,
    n_missing: usize,
    n_varies: usize,
    missing_group: bool,
    /// Units (unit `reference_group`) whose identity component carries no
    /// reference group in any target.
    n_without_reference_group: usize,
}

/// Units are the identity components of every declared sample
/// (`independence_components` over all identity links and the reference
/// groups of every target, built before any exclusion, so intermediates that
/// are absent from this source, masked or augmented still link), projected
/// onto the eligible rows of the canonical structure.
fn build_units<'a>(
    input: &'a QualificationInput,
    samples: &HashMap<&str, &'a Sample>,
    geometry: &Geometry,
    declared: &[MetadataFactor<'a>],
) -> Units<'a> {
    let targets: Vec<&Target> = input.targets.iter().collect();
    let component = independence_components(input, &targets);
    let index: HashMap<&str, usize> = input
        .samples
        .iter()
        .enumerate()
        .map(|(i, s)| (s.sample_id.as_str(), i))
        .collect();
    let referenced: BTreeSet<usize> = input
        .targets
        .iter()
        .flat_map(|t| &t.values)
        .filter(|v| v.reference_group_id.is_some())
        .filter_map(|v| index.get(v.sample_id.as_str()).map(|&i| component[i]))
        .collect();
    let mut missing_group = false;
    let mut members = BTreeMap::<usize, Vec<usize>>::new();
    for (row, sample_id) in geometry.sample_ids.iter().enumerate() {
        if input.options.independence_unit == IndependenceUnit::Group
            && samples[sample_id.as_str()].independence_group.is_none()
        {
            missing_group = true;
        }
        members
            .entry(component[index[sample_id.as_str()]])
            .or_default()
            .push(row);
    }
    let n_without_reference_group =
        if input.options.independence_unit == IndependenceUnit::ReferenceGroup {
            members.keys().filter(|c| !referenced.contains(c)).count()
        } else {
            0
        };
    // Canonical unit order: smallest member row (rows follow structure order).
    let mut members: Vec<Vec<usize>> = members.into_values().collect();
    members.sort_by_key(|rows| rows[0]);
    let n_units = members.len();
    let (mut n_missing, mut n_varies) = (0, 0);
    let mut coordinates = Vec::new();
    let mut levels = Vec::new();
    'units: for unit in members {
        let mut unit_levels = BTreeMap::new();
        for factor in declared {
            let values: Vec<Option<&str>> = unit
                .iter()
                .map(|&row| level(input, factor, samples[geometry.sample_ids[row].as_str()]))
                .collect();
            if values.iter().any(Option::is_none) {
                n_missing += 1;
                continue 'units;
            }
            let distinct: BTreeSet<&str> = values.into_iter().flatten().collect();
            if distinct.len() > 1 {
                n_varies += 1;
                continue 'units;
            }
            unit_levels.insert(
                factor.name,
                distinct.first().expect("one level").to_string(),
            );
        }
        // Running mean: never forms a sum that could overflow.
        let k = geometry.scores[unit[0]].len();
        let mut mean = vec![0.0; k];
        for (count, &row) in unit.iter().enumerate() {
            for (m, v) in mean.iter_mut().zip(&geometry.scores[row]) {
                *m += (v - *m) / (count + 1) as f64;
            }
        }
        coordinates.push(mean);
        levels.push(unit_levels);
    }
    Units {
        coordinates,
        levels,
        n_units,
        n_missing,
        n_varies,
        missing_group,
        n_without_reference_group,
    }
}

/// Dense codes of level combinations of the given factors, in sorted order.
fn codes(levels: &[BTreeMap<&str, String>], factors: &[&str]) -> Vec<i64> {
    let keys: Vec<Vec<&str>> = levels
        .iter()
        .map(|l| factors.iter().map(|f| l[f].as_str()).collect())
        .collect();
    let order: BTreeMap<&Vec<&str>, i64> = keys
        .iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .enumerate()
        .map(|(i, k)| (k, i as i64))
        .collect();
    keys.iter().map(|k| order[k]).collect()
}

fn block_sizes(codes: &[i64]) -> Vec<usize> {
    let mut sizes = BTreeMap::<i64, usize>::new();
    for c in codes {
        *sizes.entry(*c).or_default() += 1;
    }
    sizes.into_values().collect()
}

fn permanova(
    provider: &impl MethodsProvider,
    request: &PermanovaRequest,
    n_permutations: usize,
) -> Result<PermanovaDiagnostics, (Availability, String)> {
    let request = PermanovaRequest {
        n_permutations,
        ..request.clone()
    };
    let n = request.term_codes.len();
    let ratio = |v: Option<f64>| v.is_none_or(|v| (0.0..=1.0).contains(&v));
    let nonnegative = |v: f64| v.is_finite() && v >= 0.0;
    match provider.permanova(&request) {
        Ok(d)
            if nonnegative(d.ss_total)
                && nonnegative(d.ss_strata)
                && nonnegative(d.ss_term)
                && nonnegative(d.ss_residual)
                && ratio(d.r2)
                && ratio(d.partial_r2)
                && d.pseudo_f.is_none_or(nonnegative)
                && d.df_term < d.n_levels.max(1)
                && d.df_term + d.df_residual + d.n_strata == n
                && d.log10_distinct_permutations.is_finite()
                && d.log10_distinct_permutations >= 0.0
                && d.n_at_least_observed <= d.n_permutations_executed
                && (d.n_permutations_executed == n_permutations
                    || (d.n_permutations_executed == 0 && d.pseudo_f.is_none()))
                && d.p_value.is_some() == (d.n_permutations_executed > 0)
                && d.residual_resolution
                    .is_none_or(|v| v.is_finite() && v >= 0.0) =>
        {
            Ok(d)
        }
        Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".into())),
        Err(e) => Err((e.availability(), e.reason)),
    }
}

fn permdisp(
    provider: &impl MethodsProvider,
    request: &PermdispRequest,
    n_permutations: usize,
) -> Result<PermdispDiagnostics, (Availability, String)> {
    let request = PermdispRequest {
        n_permutations,
        ..request.clone()
    };
    let n = request.group_codes.len();
    match provider.permdisp(&request) {
        Ok(d)
            if d.distances.len() == n
                && d.group_mean_distances.len() == d.n_groups
                && d.distances
                    .iter()
                    .chain(&d.group_mean_distances)
                    .all(|v| v.is_finite() && *v >= 0.0)
                && d.f.is_none_or(|v| v.is_finite() && v >= 0.0)
                && d.df1 + 1 == d.n_groups
                && d.df2 + d.n_groups == n
                && d.log10_distinct_permutations.is_finite()
                && d.n_at_least_observed <= d.n_permutations_executed
                && (d.n_permutations_executed == n_permutations
                    || (d.n_permutations_executed == 0 && d.f.is_none()))
                && d.p_value.is_some() == (d.n_permutations_executed > 0)
                && d.residual_resolution
                    .is_none_or(|v| v.is_finite() && v >= 0.0) =>
        {
            Ok(d)
        }
        Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".into())),
        Err(e) => Err((e.availability(), e.reason)),
    }
}

fn freedman_lane_call(
    provider: &impl MethodsProvider,
    request: &FreedmanLaneRequest,
    n_permutations: usize,
) -> Result<FreedmanLaneDiagnostics, (Availability, String)> {
    let request = FreedmanLaneRequest {
        n_permutations,
        ..request.clone()
    };
    let n = request.term_codes.len();
    let ratio = |v: Option<f64>| v.is_none_or(|v| (0.0..=1.0).contains(&v));
    let nonnegative = |v: f64| v.is_finite() && v >= 0.0;
    match provider.permanova_freedman_lane(&request) {
        Ok(d)
            if nonnegative(d.ss_total)
                && nonnegative(d.ss_reduced)
                && nonnegative(d.ss_term)
                && nonnegative(d.ss_residual)
                && ratio(d.r2)
                && ratio(d.partial_r2)
                && d.pseudo_f.is_none_or(nonnegative)
                && d.rank_reduced >= 1
                && d.rank_reduced + d.df_term + d.df_residual == n
                && d.log10_distinct_permutations.is_finite()
                && d.n_at_least_observed <= d.n_permutations_executed
                && (d.n_permutations_executed == n_permutations
                    || (d.n_permutations_executed == 0 && d.pseudo_f.is_none()))
                && d.p_value.is_some() == (d.n_permutations_executed > 0)
                && d.residual_resolution
                    .is_none_or(|v| v.is_finite() && v >= 0.0) =>
        {
            Ok(d)
        }
        Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".into())),
        Err(e) => Err((e.availability(), e.reason)),
    }
}

/// A term with no identifiable df given the other factors cannot be tested.
fn aliased_term(df_term: usize) -> Result<(), (Availability, String)> {
    if df_term == 0 {
        Err((
            Availability::NotIdentifiable,
            "FACTOR_ALIASED_WITH_OTHER_FACTORS".into(),
        ))
    } else {
        Ok(())
    }
}

/// A design without residual df leaves the pseudo-F undefined for any draw.
fn saturated(df_residual: usize) -> Result<(), (Availability, String)> {
    if df_residual == 0 {
        Err((Availability::NotIdentifiable, "SATURATED_DESIGN".into()))
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum TestKind {
    Marginal,
    /// Units permuted within the cells of the other factors.
    Conditional,
    /// Freedman-Lane permutation of residuals of the other main effects.
    FreedmanLane,
    Dispersion,
}

impl TestKind {
    fn metric_id(self) -> &'static str {
        match self {
            Self::Marginal => "confounding.permanova_marginal_test",
            Self::Conditional => "confounding.permanova_conditional_test",
            Self::FreedmanLane => "confounding.permanova_freedman_lane_test",
            Self::Dispersion => "confounding.permdisp_test",
        }
    }
    fn seed_name(self) -> &'static str {
        match self {
            Self::Marginal => "permanova_marginal",
            Self::Conditional => "permanova_conditional",
            Self::FreedmanLane => "permanova_freedman_lane",
            Self::Dispersion => "permdisp",
        }
    }
}

/// One test that passed identifiability checks and enters its Holm family.
struct Candidate<'a> {
    kind: TestKind,
    factor: &'a str,
    request: Request,
    log10_distinct: f64,
    plan: PermutationPlan,
    metric: Metric,
    /// Effect reported with the test (PERMANOVA pseudo-F or PERMDISP F).
    effect: (&'static str, f64),
    /// Its numerical resolution (`f_resolution`).
    effect_resolution: Value,
}

enum Request {
    Permanova(PermanovaRequest),
    FreedmanLane(FreedmanLaneRequest),
    Permdisp(PermdispRequest),
}

/// Descriptive call result of a test: request, log10 distinct outcomes,
/// observed statistic and block sizes, or the reason it cannot be tested.
type Outcome = Result<(Request, f64, Option<f64>, Value, Vec<usize>), (Availability, String)>;

struct PlanSpec<'a, 'b> {
    kind: TestKind,
    factor: &'b str,
    others: &'a [&'b str],
    block_sizes: Vec<usize>,
}

fn plan(
    input: &QualificationInput,
    source_id: &str,
    spec: &PlanSpec<'_, '_>,
    reason: Option<&str>,
) -> PermutationPlan {
    let factor = spec.factor;
    let others = spec.others.join("×");
    let (null, effect, statistic, restrictions, reduced, draw) = match spec.kind {
        TestKind::Marginal => (
            format!("independence units are exchangeable in the canonical PCA space of source {source_id}, independently of {factor} levels"),
            format!("marginal effect of {factor} on the canonical spectral structure of source {source_id} (fixed effects of the observed levels)"),
            "permanova_pseudo_f",
            "none_single_block",
            None,
            "monte_carlo_uniform_unit_permutation_with_replacement_between_draws",
        ),
        TestKind::Conditional => (
            format!("within each {others} level combination, independence units are exchangeable independently of {factor} levels (no {factor} effect at any combination)"),
            format!("effect of {factor} given {others} on the canonical spectral structure of source {source_id} (additive-model SS, adonis2 by = \"margin\" for one other factor)"),
            "permanova_pseudo_f_given_strata",
            "within_blocks",
            None,
            "monte_carlo_uniform_unit_permutation_within_blocks_with_replacement_between_draws",
        ),
        TestKind::FreedmanLane => (
            format!("{factor} has no main effect given the additive main effects of {others}: residuals of the reduced model are exchangeable across independence units (approximate test; interactions are not modelled)"),
            format!("main effect of {factor} given the main effects of {others} on the canonical spectral structure of source {source_id} (partial pseudo-F, Freedman-Lane)"),
            "permanova_pseudo_f_given_main_effects",
            "none_single_block",
            Some(format!("intercept + main effects of {} (no interaction); residuals permuted, reduced fit added back, both designs refitted", spec.others.join(" + "))),
            "monte_carlo_freedman_lane_permutation_of_reduced_model_residuals_with_replacement_between_draws",
        ),
        TestKind::Dispersion => (
            format!("distances to the {factor} level centroids have equal means across levels (residuals of their one-way ANOVA exchangeable)"),
            format!("difference in multivariate dispersion across {factor} levels in source {source_id}"),
            "permdisp_anova_f",
            "none_single_block",
            Some("one-way ANOVA of distances to level centroids; residuals permuted".to_string()),
            "monte_carlo_uniform_permutation_of_anova_residuals_with_replacement_between_draws",
        ),
    };
    let (seed, derivation) = seed(input, source_id, spec.kind.seed_name(), factor);
    PermutationPlan {
        plan_version: PERMUTATION_PLAN_VERSION.into(),
        null_hypothesis: null,
        tested_effect: effect,
        statistic: statistic.into(),
        exchangeable_unit: input.options.independence_unit,
        exchangeability_declared: input.options.exchangeable_units,
        restrictions: restrictions.into(),
        block_sizes: spec.block_sizes.clone(),
        reduced_model: reduced,
        draw_method: draw.into(),
        rng_algorithm: "methods_pcg64_numpy_seedsequence_permutation".into(),
        seed,
        seed_derivation: derivation,
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

fn test_metric(
    kind: TestKind,
    status: Availability,
    reason: Option<&str>,
    source_id: &str,
    factor: &str,
    plan: &PermutationPlan,
    denominators: &BTreeMap<String, usize>,
) -> Metric {
    let mut metric = Metric::unavailable(
        kind.metric_id(),
        status,
        reason.unwrap_or(""),
        Some(source_id),
        None,
    );
    metric.reason_code = reason.map(str::to_owned);
    tag(&mut metric, Some(factor));
    metric.denominators = denominators.clone();
    metric
        .parameters
        .insert("permutation_plan".into(), json!(plan));
    metric
}

/// Reason that blocks every test of this source, if any.
fn blocking_reason(input: &QualificationInput, units: &Units<'_>) -> Option<&'static str> {
    if input.options.independence_unit == IndependenceUnit::Unknown {
        Some("INDEPENDENCE_UNIT_UNKNOWN")
    } else if units.missing_group {
        Some("MISSING_INDEPENDENCE_GROUP")
    } else if units.n_without_reference_group > 0 {
        Some("REFERENCE_GROUP_UNRESOLVED")
    } else if !input.options.exchangeable_units {
        Some("EXCHANGEABILITY_NOT_DECLARED")
    } else if units.n_varies > 0 {
        Some("METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT")
    } else {
        None
    }
}

pub(crate) fn analyze(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    geometry: &Geometry,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let source_id = source.source_id.as_str();
    let all_factors = categorical_factors(input);
    let declared: Vec<MetadataFactor> = all_factors
        .iter()
        .copied()
        .filter(|factor| {
            geometry
                .sample_ids
                .iter()
                .any(|id| level(input, factor, samples[id.as_str()]).is_some())
        })
        .collect();
    if declared.is_empty() {
        unavailable(
            report,
            source_id,
            Availability::NotApplicable,
            "NO_DECLARED_FACTOR",
        );
        return;
    }
    let units = build_units(input, samples, geometry, &declared);
    let declared: Vec<&str> = declared.iter().map(|f| f.name).collect();
    let n = units.coordinates.len();
    let mut denominators = BTreeMap::from([
        ("n_eligible_samples".to_string(), geometry.sample_ids.len()),
        ("n_independence_units".to_string(), units.n_units),
        ("n_units_analyzed".to_string(), n),
        ("n_units_missing_factor".to_string(), units.n_missing),
        (
            "n_units_factor_varies_within_unit".to_string(),
            units.n_varies,
        ),
    ]);
    if n < 3 {
        unavailable(
            report,
            source_id,
            Availability::InsufficientData,
            "FEWER_THAN_THREE_INDEPENDENCE_UNITS",
        );
        return;
    }
    let level_sets: BTreeMap<&str, BTreeSet<&str>> = declared
        .iter()
        .map(|f| (*f, units.levels.iter().map(|l| l[f].as_str()).collect()))
        .collect();
    let effective: Vec<&str> = declared
        .iter()
        .copied()
        .filter(|f| level_sets[f].len() >= 2)
        .collect();
    let cells = codes(&units.levels, &declared);
    denominators.insert("n_occupied_cells".into(), block_sizes(&cells).len());
    if input.options.independence_unit == IndependenceUnit::ReferenceGroup {
        denominators.insert(
            "n_units_without_reference_group".into(),
            units.n_without_reference_group,
        );
    }

    // Descriptive PERMANOVA of each factor alone and given the others.
    let mut marginal = BTreeMap::new();
    let mut conditional = BTreeMap::new();
    let mut freedman_lane = BTreeMap::new();
    let mut dispersion = BTreeMap::new();
    let mut backend = String::new();
    for &factor in &effective {
        let others: Vec<&str> = effective.iter().copied().filter(|f| *f != factor).collect();
        let term = codes(&units.levels, &[factor]);
        let request = PermanovaRequest {
            matrix: units.coordinates.clone(),
            term_codes: term.clone(),
            strata_codes: None,
            n_permutations: 0,
            seed: seed(input, source_id, TestKind::Marginal.seed_name(), factor).0,
        };
        let result = permanova(provider, &request, 0);
        if let Ok(d) = &result {
            backend = d.backend_version.clone();
        }
        marginal.insert(factor, (request, result));
        if !others.is_empty() {
            let request = PermanovaRequest {
                matrix: units.coordinates.clone(),
                term_codes: term.clone(),
                strata_codes: Some(codes(&units.levels, &others)),
                n_permutations: 0,
                seed: seed(input, source_id, TestKind::Conditional.seed_name(), factor).0,
            };
            let result = permanova(provider, &request, 0);
            conditional.insert(factor, (request, result));
            let request = FreedmanLaneRequest {
                matrix: units.coordinates.clone(),
                term_codes: term.clone(),
                condition_codes: others
                    .iter()
                    .map(|other| codes(&units.levels, &[other]))
                    .collect(),
                n_permutations: 0,
                seed: seed(input, source_id, TestKind::FreedmanLane.seed_name(), factor).0,
            };
            let result = freedman_lane_call(provider, &request, 0);
            freedman_lane.insert(factor, (request, result));
        }
        let request = PermdispRequest {
            matrix: units.coordinates.clone(),
            group_codes: term,
            n_permutations: 0,
            seed: seed(input, source_id, TestKind::Dispersion.seed_name(), factor).0,
        };
        let result = permdisp(provider, &request, 0);
        dispersion.insert(factor, (request, result));
    }
    let joint = (effective.len() >= 2).then(|| {
        permanova(
            provider,
            &PermanovaRequest {
                matrix: units.coordinates.clone(),
                term_codes: codes(&units.levels, &effective),
                strata_codes: None,
                n_permutations: 0,
                seed: 0,
            },
            0,
        )
    });

    // Design: levels, crossings, identifiable df and aliasing.
    let mut factor_entries = Vec::new();
    let mut aliased = Vec::new();
    for &factor in &declared {
        let mut entry = json!({
            "factor": factor,
            "n_levels": level_sets[factor].len(),
            "levels": level_sets[factor].iter().map(|level| json!({
                "level": level,
                "n_units": units.levels.iter().filter(|l| l[factor] == *level).count(),
            })).collect::<Vec<_>>(),
        });
        let fields = entry.as_object_mut().expect("object");
        if level_sets[factor].len() < 2 {
            fields.insert("status".into(), json!("single_level"));
        } else if let Some((_, Ok(d))) = conditional.get(factor) {
            let others: Vec<&str> = effective.iter().copied().filter(|f| *f != factor).collect();
            let determined_by: Vec<&str> = others
                .iter()
                .copied()
                .filter(|other| {
                    let mut seen = BTreeMap::<&str, BTreeSet<&str>>::new();
                    for l in &units.levels {
                        seen.entry(l[other].as_str())
                            .or_default()
                            .insert(l[factor].as_str());
                    }
                    seen.values().all(|levels| levels.len() == 1)
                })
                .collect();
            fields.insert("df_nominal".into(), json!(level_sets[factor].len() - 1));
            fields.insert(
                "df_identifiable_given_other_factors".into(),
                json!(d.df_term),
            );
            if let Some((_, Ok(fl))) = freedman_lane.get(factor) {
                fields.insert(
                    "df_identifiable_given_other_main_effects".into(),
                    json!(fl.df_term),
                );
                fields.insert(
                    "rank_other_main_effects_with_intercept".into(),
                    json!(fl.rank_reduced),
                );
            }
            fields.insert(
                "design_rank_with_other_factor_cells".into(),
                json!(d.n_strata + d.df_term),
            );
            fields.insert("n_other_factor_cells".into(), json!(d.n_strata));
            // Aliasing is relative to the cells of the other factors
            // (interactions included); the additive model can still separate
            // the factor (for example A = B xor C).
            // Three states: identifiable, not identifiable, or unknown when
            // the additive (Freedman-Lane) computation is unavailable.
            let (additive, additive_reason) = match freedman_lane.get(factor) {
                Some((_, Ok(fl))) => (Some(fl.df_term > 0), None),
                Some((_, Err((_, reason)))) => (None, Some(reason.clone())),
                None => (None, None),
            };
            fields.insert(
                "aliased_with_other_factor_cells".into(),
                json!(d.df_term == 0),
            );
            fields.insert("identifiable_under_additive_model".into(), json!(additive));
            if let Some(reason) = &additive_reason {
                fields.insert("additive_identifiability_reason_code".into(), json!(reason));
            }
            fields.insert(
                "partially_confounded".into(),
                json!(d.df_term > 0 && d.df_term < level_sets[factor].len() - 1),
            );
            fields.insert("determined_by".into(), json!(determined_by));
            if d.df_term == 0 {
                aliased.push((factor, others.join(", "), additive, additive_reason));
            }
        } else if let Some((_, Err((_, reason)))) = conditional.get(factor) {
            fields.insert("df_nominal".into(), json!(level_sets[factor].len() - 1));
            fields.insert("df_identifiable_reason_code".into(), json!(reason));
        } else {
            fields.insert("df_nominal".into(), json!(level_sets[factor].len() - 1));
            fields.insert(
                "df_identifiable_given_other_factors".into(),
                json!(level_sets[factor].len() - 1),
            );
            fields.insert("aliased_with_other_factor_cells".into(), json!(false));
            fields.insert("identifiable_under_additive_model".into(), json!(true));
        }
        factor_entries.push(entry);
    }
    let mut crossings = Vec::new();
    for (i, &a) in effective.iter().enumerate() {
        for &b in &effective[i + 1..] {
            let mut table = BTreeMap::<String, BTreeMap<String, usize>>::new();
            for l in &units.levels {
                *table
                    .entry(l[a].clone())
                    .or_default()
                    .entry(l[b].clone())
                    .or_default() += 1;
            }
            crossings.push(json!({"factors": [a, b], "unit_counts": table}));
        }
    }
    let mut design = Metric::computed(
        "confounding.design",
        json!({
            "factors": factor_entries,
            "undeclared_factors": all_factors
                .iter()
                .map(|f| f.name)
                .filter(|n| !declared.contains(n))
                .collect::<Vec<_>>(),
            "crossings": crossings,
        }),
        Some(source_id),
        None,
    );
    tag(&mut design, None);
    design.denominators = denominators.clone();
    design.parameters.insert(
        "analysis_unit".into(),
        json!(format!(
            "{}_identity_components",
            association_unit_label(input.options.independence_unit)
        )),
    );
    design.parameters.insert(
        "aliasing_rule".into(),
        json!("df_identifiable = levels - connected components of the level x other-factor-cell occupancy graph (Methods n4m_stats_permanova)"),
    );
    report.metrics.push(design);

    // Variance partition: shares overlap and are never summed.
    let ss_total = marginal
        .values()
        .find_map(|(_, r)| r.as_ref().ok().map(|d| (d.ss_total, d.ss_binary_exponent)));
    let mut partition_factors = Vec::new();
    for &factor in &effective {
        let m = marginal[factor].1.as_ref().ok();
        let c = conditional.get(factor).and_then(|(_, r)| r.as_ref().ok());
        let fl = freedman_lane.get(factor).and_then(|(_, r)| r.as_ref().ok());
        partition_factors.push(json!({
            "factor": factor,
            "r2_marginal": m.and_then(|d| d.r2),
            "pseudo_f_marginal": m.and_then(|d| d.pseudo_f),
            "pseudo_f_marginal_resolution": m.map(|d| f_resolution(d.f_numerically_unresolved, d.residual_resolution)),
            "df_marginal": m.map(|d| d.df_term),
            "r2_unique_given_other_factors": c.and_then(|d| d.r2),
            "partial_r2_given_other_factors": c.and_then(|d| d.partial_r2),
            "pseudo_f_given_other_factors": c.and_then(|d| d.pseudo_f),
            "pseudo_f_given_other_factors_resolution": c.map(|d| f_resolution(d.f_numerically_unresolved, d.residual_resolution)),
            "df_given_other_factors": c.map(|d| d.df_term),
            "r2_unique_given_other_main_effects": fl.and_then(|d| d.r2),
            "partial_r2_given_other_main_effects": fl.and_then(|d| d.partial_r2),
            "pseudo_f_given_other_main_effects": fl.and_then(|d| d.pseudo_f),
            "pseudo_f_given_other_main_effects_resolution": fl.map(|d| f_resolution(d.f_numerically_unresolved, d.residual_resolution)),
            "df_given_other_main_effects": fl.map(|d| d.df_term),
            "reason_code": marginal[factor].1.as_ref().err().map(|e| e.1.clone()),
        }));
    }
    let joint_value = joint.as_ref().map(|r| match r {
        Ok(d) => json!({"r2_all_factor_cells": d.r2, "pseudo_f": d.pseudo_f,
                        "pseudo_f_resolution": f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                        "df": d.df_term, "n_cells": d.n_levels}),
        Err((_, reason)) => json!({"reason_code": reason}),
    });
    let mut partition = match ss_total {
        None if effective.is_empty() => unavailable_metric(
            "confounding.variance_partition",
            Availability::NotApplicable,
            "SINGLE_FACTOR_LEVEL",
            source_id,
            None,
        ),
        None => {
            let (status, reason) = marginal
                .values()
                .find_map(|(_, r)| r.as_ref().err().cloned())
                .expect("one failed marginal");
            unavailable_metric(
                "confounding.variance_partition",
                status,
                &reason,
                source_id,
                None,
            )
        }
        Some((total, _)) if total <= 0.0 => unavailable_metric(
            "confounding.variance_partition",
            Availability::Undefined,
            "ZERO_TOTAL_VARIANCE",
            source_id,
            None,
        ),
        Some((total, exponent)) => {
            let mut metric = Metric::computed(
                "confounding.variance_partition",
                json!({
                    "ss_total": total,
                    "ss_binary_exponent": exponent,
                    "factors": partition_factors,
                    "joint": joint_value,
                    "shares_are_not_additive": true,
                }),
                Some(source_id),
                None,
            );
            tag(&mut metric, None);
            metric.unit = Some("squared_pca_score_units".into());
            metric
        }
    };
    partition.denominators = denominators.clone();
    partition.parameters.insert(
        "geometry".into(),
        json!("euclidean distances between independence-unit means of canonical PCA scores (structure.pca_scores)"),
    );
    partition.parameters.insert(
        "r2_definitions".into(),
        json!({
            "r2_marginal": "SS(factor) / SS_total, factor alone",
            "r2_unique_given_other_factors": "[SS(other-factor cells + factor) - SS(other-factor cells)] / SS_total",
            "r2_unique_given_other_main_effects": "[SS(other main effects + factor) - SS(other main effects)] / SS_total",
            "r2_all_factor_cells": "SS(all-factor level combinations) / SS_total",
        }),
    );
    partition
        .parameters
        .insert("backend_version".into(), json!(backend));
    report.metrics.push(partition);

    // Descriptive dispersion per factor.
    for &factor in &effective {
        let (request, result) = &dispersion[factor];
        let mut metric = match result {
            Ok(d) => {
                // Codes are dense in sorted level order, as are the means.
                let levels: Vec<Value> = level_sets[factor]
                    .iter()
                    .zip(&d.group_mean_distances)
                    .enumerate()
                    .map(|(code, (level, mean))| {
                        json!({
                            "level": level,
                            "mean_distance_to_centroid": mean,
                            "n_units": request.group_codes.iter().filter(|&&c| c == code as i64).count(),
                        })
                    })
                    .collect();
                Metric::computed(
                    "confounding.dispersion",
                    json!({
                        "levels": levels,
                        "distance_binary_exponent": d.distance_binary_exponent,
                        "anova_f": d.f,
                        "anova_f_resolution": f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                        "df1": d.df1,
                        "df2": d.df2,
                    }),
                    Some(source_id),
                    None,
                )
            }
            Err((status, reason)) => Metric::unavailable(
                "confounding.dispersion",
                status.clone(),
                reason,
                Some(source_id),
                None,
            ),
        };
        tag(&mut metric, Some(factor));
        metric.denominators = denominators.clone();
        metric.parameters.insert(
            "centroid".into(),
            json!("arithmetic mean (vegan betadisper type = \"centroid\")"),
        );
        metric.parameters.insert(
            "interpretation".into(),
            json!(
                "dispersion diagnostic only; it does not validate exchangeability or a PERMANOVA"
            ),
        );
        report.metrics.push(metric);
    }
    for &factor in declared.iter().filter(|f| !effective.contains(f)) {
        for kind in [
            TestKind::Marginal,
            TestKind::Conditional,
            TestKind::FreedmanLane,
            TestKind::Dispersion,
        ] {
            let spec = PlanSpec {
                kind,
                factor,
                others: &[],
                block_sizes: vec![n],
            };
            let p = plan(input, source_id, &spec, Some("SINGLE_FACTOR_LEVEL"));
            report.metrics.push(test_metric(
                kind,
                Availability::NotApplicable,
                Some("SINGLE_FACTOR_LEVEL"),
                source_id,
                factor,
                &p,
                &denominators,
            ));
        }
    }

    // Tests: identifiability, then per-family resolution and Holm.
    let blocked = blocking_reason(input, &units);
    let mut permanova_candidates = Vec::new();
    let mut permdisp_candidates = Vec::new();
    for &factor in &effective {
        let others: Vec<&str> = effective.iter().copied().filter(|f| *f != factor).collect();
        let tests: [(TestKind, Option<Outcome>); 4] = [
            (
                TestKind::Marginal,
                Some(marginal[factor].1.clone().and_then(|d| {
                    saturated(d.df_residual)?;
                    Ok((
                        Request::Permanova(marginal[factor].0.clone()),
                        d.log10_distinct_permutations,
                        d.pseudo_f,
                        f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                        vec![n],
                    ))
                })),
            ),
            (
                TestKind::Conditional,
                conditional.get(factor).map(|(request, result)| {
                    result.clone().and_then(|d| {
                        aliased_term(d.df_term)?;
                        saturated(d.df_residual)?;
                        Ok((
                            Request::Permanova(request.clone()),
                            d.log10_distinct_permutations,
                            d.pseudo_f,
                            f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                            block_sizes(request.strata_codes.as_deref().unwrap_or_default()),
                        ))
                    })
                }),
            ),
            (
                TestKind::FreedmanLane,
                freedman_lane.get(factor).map(|(request, result)| {
                    result.clone().and_then(|d| {
                        if d.rank_reduced >= n {
                            return Err((
                                Availability::NotIdentifiable,
                                "REDUCED_MODEL_SATURATED".to_string(),
                            ));
                        }
                        aliased_term(d.df_term)?;
                        saturated(d.df_residual)?;
                        Ok((
                            Request::FreedmanLane(request.clone()),
                            d.log10_distinct_permutations,
                            d.pseudo_f,
                            f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                            vec![n],
                        ))
                    })
                }),
            ),
            (
                TestKind::Dispersion,
                Some(dispersion[factor].1.clone().map(|d| {
                    (
                        Request::Permdisp(dispersion[factor].0.clone()),
                        d.log10_distinct_permutations,
                        d.f,
                        f_resolution(d.f_numerically_unresolved, d.residual_resolution),
                        vec![n],
                    )
                })),
            ),
        ];
        for (kind, outcome) in tests {
            let mut spec = PlanSpec {
                kind,
                factor,
                others: &others,
                block_sizes: vec![n],
            };
            let reject = |spec: &PlanSpec<'_, '_>, status: Availability, reason: &str| {
                let p = plan(input, source_id, spec, Some(reason));
                test_metric(
                    kind,
                    status,
                    Some(reason),
                    source_id,
                    factor,
                    &p,
                    &denominators,
                )
            };
            let Some(outcome) = outcome else {
                report.metrics.push(reject(
                    &spec,
                    Availability::NotApplicable,
                    "NO_OTHER_VARYING_FACTOR",
                ));
                continue;
            };
            let (request, log10_distinct, effect, effect_resolution, blocks) = match outcome {
                Ok(v) => v,
                Err((status, reason)) => {
                    report.metrics.push(reject(&spec, status, &reason));
                    continue;
                }
            };
            spec.block_sizes = blocks;
            let Some(effect) = effect else {
                let reason = if kind == TestKind::Dispersion {
                    "DISPERSION_F_UNDEFINED"
                } else {
                    "PSEUDO_F_UNDEFINED"
                };
                report
                    .metrics
                    .push(reject(&spec, Availability::Undefined, reason));
                continue;
            };
            if let Some(reason) = blocked {
                report
                    .metrics
                    .push(reject(&spec, Availability::NotIdentifiable, reason));
                continue;
            }
            let mut p = plan(input, source_id, &spec, None);
            p.log10_distinct_admissible_permutations = Some(log10_distinct);
            let candidate = Candidate {
                kind,
                factor,
                request,
                log10_distinct,
                metric: test_metric(
                    kind,
                    Availability::Computed,
                    None,
                    source_id,
                    factor,
                    &p,
                    &denominators,
                ),
                plan: p,
                effect: (
                    if kind == TestKind::Dispersion {
                        "anova_f"
                    } else {
                        "pseudo_f"
                    },
                    effect,
                ),
                effect_resolution,
            };
            if kind == TestKind::Dispersion {
                permdisp_candidates.push(candidate);
            } else {
                permanova_candidates.push(candidate);
            }
        }
    }
    let rejected = finish_family(
        "confounding.permanova_family",
        permanova_candidates,
        source_id,
        provider,
        report,
    );
    let dispersion_rejected = finish_family(
        "confounding.permdisp_family",
        permdisp_candidates,
        source_id,
        provider,
        report,
    );
    findings(source_id, &aliased, &rejected, &dispersion_rejected, report);
}

fn association_unit_label(unit: IndependenceUnit) -> &'static str {
    match unit {
        IndependenceUnit::Sample => "sample",
        IndependenceUnit::ReferenceGroup => "reference_group",
        IndependenceUnit::Group => "group",
        IndependenceUnit::Unknown => "unknown",
    }
}

/// Executes one Holm family; returns the (kind, factor, effect, adjusted p)
/// of tests rejecting at the family level.
fn finish_family<'a>(
    family_id: &str,
    candidates: Vec<Candidate<'a>>,
    source_id: &str,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) -> Vec<(TestKind, &'a str, f64, f64)> {
    let m = candidates.len();
    let members: Vec<Value> = candidates
        .iter()
        .map(|c| json!({"test": c.kind.metric_id(), "factor": c.factor}))
        .collect();
    let mut family = if m == 0 {
        unavailable_metric(
            family_id,
            Availability::NotApplicable,
            "NO_IDENTIFIABLE_TESTS",
            source_id,
            None,
        )
    } else {
        let mut metric = Metric::computed(
            family_id,
            json!({"method": "holm", "family_alpha": FAMILY_ALPHA, "family_size": m,
                   "members": members, "unreported_members_enter_as_p_value_1": true}),
            Some(source_id),
            None,
        );
        tag(&mut metric, None);
        metric
    };
    family.parameters.insert(
        "family_definition".into(),
        json!("every identifiable test of this kind on this source's canonical structure"),
    );
    report.metrics.push(family);
    if m == 0 {
        return Vec::new();
    }
    let threshold = FAMILY_ALPHA / m as f64;
    let mut outcomes = Vec::with_capacity(m);
    for c in &candidates {
        let resolution = (1.0 / (PERMUTATIONS as f64 + 1.0)).max(10f64.powf(-c.log10_distinct));
        if resolution > threshold {
            outcomes.push((resolution, Ok(None)));
            continue;
        }
        let executed = match &c.request {
            Request::Permanova(r) => permanova(provider, r, PERMUTATIONS).map(|d| {
                (
                    d.p_value,
                    d.n_at_least_observed,
                    d.pseudo_f,
                    d.backend_version,
                )
            }),
            Request::FreedmanLane(r) => freedman_lane_call(provider, r, PERMUTATIONS).map(|d| {
                (
                    d.p_value,
                    d.n_at_least_observed,
                    d.pseudo_f,
                    d.backend_version,
                )
            }),
            Request::Permdisp(r) => permdisp(provider, r, PERMUTATIONS)
                .map(|d| (d.p_value, d.n_at_least_observed, d.f, d.backend_version)),
        };
        let outcome = match executed {
            Ok((Some(p), b, Some(effect), backend))
                if (p - (1.0 + b as f64) / (1.0 + PERMUTATIONS as f64)).abs() < 1e-12
                    && (effect - c.effect.1).abs() <= 1e-12 * c.effect.1.abs().max(1.0) =>
            {
                Ok(Some((p, b, backend)))
            }
            Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".to_string())),
            Err(e) => Err(e),
        };
        outcomes.push((resolution, outcome));
    }
    let p_values: Vec<f64> = outcomes
        .iter()
        .map(|(_, o)| match o {
            Ok(Some((p, _, _))) => *p,
            _ => 1.0,
        })
        .collect();
    let holm = match provider.holm_adjust(&HolmRequest {
        p_values: p_values.clone(),
    }) {
        Ok(h)
            if h.adjusted.len() == m
                && h.adjusted
                    .iter()
                    .zip(&p_values)
                    .all(|(a, p)| a.is_finite() && *a >= *p && *a <= 1.0) =>
        {
            Ok(h.adjusted)
        }
        Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".to_string())),
        Err(e) => Err((e.availability(), e.reason)),
    };
    let mut rejected = Vec::new();
    for (i, (c, (resolution, outcome))) in candidates.into_iter().zip(outcomes).enumerate() {
        let mut plan = c.plan;
        plan.resolution = Some(resolution);
        plan.resolution_basis = Some("lower_bound_from_combinatorial_bound".into());
        let mut metric = c.metric;
        metric.parameters.insert(
            "multiplicity".into(),
            json!({"method": "holm", "family": family_id, "family_alpha": FAMILY_ALPHA,
                   "family_size": m, "per_test_resolution_threshold": threshold}),
        );
        let outcome = match (outcome, &holm) {
            (Ok(Some(_)), Err(e)) => Err(e.clone()),
            (outcome, _) => outcome,
        };
        let (p, b, backend) = match outcome {
            Ok(Some(v)) => v,
            Ok(None) => {
                plan.reason_code = Some("PERMUTATION_RESOLUTION_INSUFFICIENT".into());
                metric.status = Availability::InsufficientData;
                metric.reason_code = plan.reason_code.clone();
                metric
                    .parameters
                    .insert("permutation_plan".into(), json!(plan));
                report.metrics.push(metric);
                continue;
            }
            Err((status, reason)) => {
                plan.reason_code = Some(reason.clone());
                metric.status = status;
                metric.reason_code = Some(reason);
                metric
                    .parameters
                    .insert("permutation_plan".into(), json!(plan));
                report.metrics.push(metric);
                continue;
            }
        };
        let adjusted = holm.as_ref().map(|a| a[i]).unwrap_or(1.0);
        let rejects = adjusted <= FAMILY_ALPHA;
        plan.executed = true;
        plan.n_permutations_executed = PERMUTATIONS;
        metric.status = Availability::Computed;
        metric.reason_code = None;
        metric.value = Some(json!({
            "p_value": p,
            "p_value_holm": adjusted,
            "rejects_null_at_family_alpha": rejects,
            "statistic_name": c.effect.0,
            "statistic": c.effect.1,
            "statistic_resolution": c.effect_resolution,
            "n_at_least_observed": b,
        }));
        metric
            .parameters
            .insert("backend_version".into(), json!(backend));
        metric
            .parameters
            .insert("permutation_plan".into(), json!(plan));
        report.metrics.push(metric);
        if rejects {
            rejected.push((c.kind, c.factor, c.effect.1, adjusted));
        }
    }
    rejected
}

fn findings(
    source_id: &str,
    aliased: &[(&str, String, Option<bool>, Option<String>)],
    rejected: &[(TestKind, &str, f64, f64)],
    dispersion: &[(TestKind, &str, f64, f64)],
    report: &mut QualificationReport,
) {
    let has_association = report
        .metrics
        .iter()
        .any(|m| m.metric_id == "association.metadata_target");
    let association_evidence = |evidence: &mut Vec<String>| {
        if has_association {
            evidence.push("association.metadata_target".into());
        }
    };
    for (factor, others, additive, additive_reason) in aliased {
        let mut evidence = vec![
            "confounding.design".to_string(),
            "confounding.permanova_freedman_lane_test".into(),
        ];
        association_evidence(&mut evidence);
        let finding = if additive.is_none() {
            let why = additive_reason.as_deref().unwrap_or("NOT_COMPUTED");
            Finding {
                rule_id: "confounding.aliased_with_other_cells.v1".into(),
                severity: "warning".into(),
                confidence: "unknown".into(),
                evidence,
                message: format!(
                    "In {source_id}, {factor} is aliased with the cells of {others} (interactions included): every level combination of {others} holds a single {factor} level. Whether the additive main-effects model separates it is unknown, because that computation is unavailable ({why})"
                ),
                action: format!(
                    "Do not attribute structure to {factor} or {others} alone until the additive identifiability is computed or the crossings within the cells of {others} are completed"
                ),
            }
        } else if *additive == Some(true) {
            Finding {
                rule_id: "confounding.aliased_with_other_cells.v1".into(),
                severity: "info".into(),
                confidence: "unknown".into(),
                evidence,
                message: format!(
                    "In {source_id}, {factor} is aliased with the cells of {others} (interactions included): every level combination of {others} holds a single {factor} level, so no within-cell comparison exists; under the additive main-effects model (no interaction) {factor} remains identifiable, and only the Freedman-Lane test can separate it, if interactions are assumed absent"
                ),
                action: format!(
                    "Treat any separation of {factor} from {others} as conditional on the absence of interactions; complete the crossings within the cells of {others} before relying on it, and check Y coverage of each crossing and the metadata-Y associations before choosing a validation split"
                ),
            }
        } else {
            Finding {
                rule_id: "confounding.aliased_factors.v1".into(),
                severity: "warning".into(),
                confidence: "unknown".into(),
                evidence,
                message: format!(
                    "In {source_id}, the effect of {factor} on the spectral structure cannot be separated from {others}, neither within the cells of {others} (interactions included) nor under the additive main-effects model: their separate effects are not identifiable"
                ),
                action: format!(
                    "Do not attribute structure to {factor} or {others} alone; complete the crossings (independence units measured under several {factor} levels within the same {others} levels) and check Y coverage of each crossing and the metadata-Y associations before choosing a validation split"
                ),
            }
        };
        report.findings.push(finding);
    }
    for (kind, factor, effect, adjusted) in rejected {
        let mut evidence = vec![
            kind.metric_id().to_string(),
            "confounding.variance_partition".into(),
            "confounding.permanova_family".into(),
            "confounding.dispersion".into(),
        ];
        association_evidence(&mut evidence);
        let (rule, what) = match kind {
            TestKind::Marginal => ("confounding.marginal_structure.v1", "differs across"),
            TestKind::FreedmanLane => (
                "confounding.main_effect_structure.v1",
                "differs, given the main effects of the other declared factors, across",
            ),
            _ => (
                "confounding.conditional_structure.v1",
                "differs, within the cells of the other declared factors, across",
            ),
        };
        report.findings.push(Finding {
            rule_id: rule.into(),
            severity: "warning".into(),
            confidence: "unknown".into(),
            evidence,
            message: format!(
                "In {source_id}, the canonical spectral structure {what} {factor} levels (pseudo-F={effect:.3}, Holm-adjusted permutation p={adjusted:.3}); exploratory, not evidence that {factor} causes the spectral differences, and dispersion differences can contribute"
            ),
            action: format!(
                "Compare with the {factor}-Y association and Y coverage per {factor} level; if the intended use includes new {factor} levels, hold {factor} levels out in validation rather than relying on a random split"
            ),
        });
    }
    for (_, factor, effect, adjusted) in dispersion {
        report.findings.push(Finding {
            rule_id: "confounding.dispersion_heterogeneity.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence: vec![
                "confounding.permdisp_test".into(),
                "confounding.dispersion".into(),
                "confounding.permdisp_family".into(),
            ],
            message: format!(
                "In {source_id}, multivariate dispersion differs across {factor} levels (PERMDISP F={effect:.3}, Holm-adjusted permutation p={adjusted:.3}); a PERMANOVA difference for {factor} may reflect spread as well as location"
            ),
            action: format!(
                "Inspect the spread of each {factor} level in the PCA scores; PERMDISP neither validates nor rules out unit exchangeability"
            ),
        });
    }
}
