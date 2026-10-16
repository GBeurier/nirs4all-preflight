//! Metadata–target associations over independence units (protocol v1).
//! The engine selects populations, builds units and permutation plans, and
//! owns statuses and multiplicity rules; Methods computes every statistic.
//! Categorical metadata use eta²/F or Cramér V/χ²; continuous metadata use
//! eta²/F across target classes or Spearman's rho against a continuous target.
use crate::*;
use serde_json::json;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROTOCOL: &str = "metadata_association.v1";
/// Monte Carlo budget per global test (specification section 6).
pub(crate) const PERMUTATIONS: usize = 999;
/// Holm family-wise error rate for the metadata × target family.
pub(crate) const FAMILY_ALPHA: f64 = 0.05;
/// sqrt(f64::EPSILON), applied by Methods on the eta² / Cramér V² / |rho| scale.
const TIE_TOLERANCE: f64 = 1.490_116_119_384_765_6e-8;
const DESCRIPTIVE_ID: &str = "association.metadata_target";
const TEST_ID: &str = "association.metadata_target_test";
const FAMILY_ID: &str = "association.metadata_target_family";

/// Seed-derivation domain of one association test (shared `derive_seed`).
fn seed_domain(target_id: &str, metadata: &str) -> String {
    format!("nirs4all-preflight\0methods\0{PROTOCOL}\0{target_id}\0{metadata}")
}

/// One independence unit: linked samples sharing physical, declared unit,
/// reference-group or individual identity.
struct Unit<'a> {
    samples: Vec<&'a Sample>,
    target: Option<TargetLabel>,
}

#[derive(Clone, PartialEq)]
enum TargetLabel {
    Value(f64),
    Class(String),
}

struct Units<'a> {
    units: Vec<Unit<'a>>,
    n_eligible_samples: usize,
    n_target_varies: usize,
    missing_group: bool,
}

/// Units are the identity components of all samples, built from every
/// identity and reference link before any analytic exclusion
/// (`independence_components`); the eligible exact references are then
/// grouped by component. Unit order (smallest eligible sample ID) fixes which
/// unit receives which permuted label, independently of input order.
fn build_units<'a>(
    target: &'a Target,
    input: &'a QualificationInput,
    samples: &HashMap<&str, &'a Sample>,
) -> Units<'a> {
    let eligible = exact_development_references(target, samples).eligible;
    let component = independence_components(input, &[target]);
    let index: HashMap<&str, usize> = input
        .samples
        .iter()
        .enumerate()
        .map(|(i, s)| (s.sample_id.as_str(), i))
        .collect();
    let missing_group = input.options.independence_unit == IndependenceUnit::Group
        && eligible
            .iter()
            .any(|v| samples[v.sample_id.as_str()].independence_group.is_none());
    // Eligible references are sorted by sample ID, so the first member of
    // each component is its smallest eligible sample ID.
    let mut members = BTreeMap::<usize, Vec<usize>>::new();
    for (i, v) in eligible.iter().enumerate() {
        members
            .entry(component[index[v.sample_id.as_str()]])
            .or_default()
            .push(i);
    }
    let mut members: Vec<Vec<usize>> = members.into_values().collect();
    members.sort_by_key(|rows| rows[0]);
    let mut n_target_varies = 0;
    let units = members
        .into_iter()
        .map(|rows| {
            let labels: Vec<TargetLabel> = rows
                .iter()
                .map(|&i| match target.kind {
                    TargetKind::Continuous => {
                        TargetLabel::Value(eligible[i].value.unwrap_or_default() + 0.0)
                    }
                    TargetKind::Categorical => {
                        TargetLabel::Class(eligible[i].category.clone().unwrap_or_default())
                    }
                })
                .collect();
            let homogeneous = labels.iter().all(|l| *l == labels[0]);
            if !homogeneous {
                n_target_varies += 1;
            }
            Unit {
                samples: rows
                    .iter()
                    .map(|&i| samples[eligible[i].sample_id.as_str()])
                    .collect(),
                target: homogeneous.then(|| labels[0].clone()),
            }
        })
        .collect();
    Units {
        units,
        n_eligible_samples: eligible.len(),
        n_target_varies,
        missing_group,
    }
}

/// Which Methods kernel and statistic a metadata × target pair uses.
#[derive(Clone, Copy, PartialEq)]
enum Design {
    /// Categorical metadata: eta²/F (continuous target) or Cramér V/χ².
    CategoricalMetadata,
    /// Continuous metadata, categorical target: eta²/F of the metadata
    /// across target classes.
    MetadataByClass,
    /// Continuous metadata and target: Spearman's rho, Pearson's r descriptive.
    Correlation,
}

struct Spec {
    association_type: &'static str,
    effect_name: &'static str,
    statistic_name: &'static str,
    plan_statistic: &'static str,
}

impl Design {
    fn of(metadata: MetadataKind, target: TargetKind) -> Self {
        match (metadata, target) {
            (MetadataKind::Categorical, _) => Self::CategoricalMetadata,
            (MetadataKind::Continuous, TargetKind::Categorical) => Self::MetadataByClass,
            (MetadataKind::Continuous, TargetKind::Continuous) => Self::Correlation,
        }
    }
    fn spec(self, target: TargetKind) -> Spec {
        match (self, target) {
            (Self::CategoricalMetadata, TargetKind::Continuous) => Spec {
                association_type: "categorical_metadata_continuous_target",
                effect_name: "eta_squared",
                statistic_name: "anova_f",
                plan_statistic: "eta_squared",
            },
            (Self::CategoricalMetadata, TargetKind::Categorical) => Spec {
                association_type: "categorical_metadata_categorical_target",
                effect_name: "cramers_v",
                statistic_name: "pearson_chi_squared",
                plan_statistic: "cramers_v_squared",
            },
            (Self::MetadataByClass, _) => Spec {
                association_type: "continuous_metadata_categorical_target",
                effect_name: "eta_squared",
                statistic_name: "anova_f",
                plan_statistic: "eta_squared_of_metadata_by_target_class",
            },
            (Self::Correlation, _) => Spec {
                association_type: "continuous_metadata_continuous_target",
                effect_name: "spearman_rho",
                statistic_name: "spearman_rho",
                plan_statistic: "abs_spearman_rho_two_sided",
            },
        }
    }
}

/// One unit's metadata value once it is known to be constant in the unit.
#[derive(Clone, PartialEq)]
enum UnitValue {
    Level(String),
    Value(f64),
}

/// Permutation request of one candidate test.
#[derive(Clone)]
enum TestRequest {
    Factor(AssociationRequest),
    Correlation(CorrelationRequest),
}

/// Kernel outcome common to both test kinds.
struct Kernel {
    effect: Option<f64>,
    p_value: Option<f64>,
    n_at_least_observed: usize,
    n_permutations_executed: usize,
    backend_version: String,
}

fn run_test(
    provider: &impl MethodsProvider,
    request: &TestRequest,
    n_permutations: usize,
) -> Result<Kernel, ProviderError> {
    match request {
        TestRequest::Factor(r) => provider
            .association(&AssociationRequest {
                n_permutations,
                ..r.clone()
            })
            .map(|d| Kernel {
                effect: d.effect_size,
                p_value: d.p_value,
                n_at_least_observed: d.n_at_least_observed,
                n_permutations_executed: d.n_permutations_executed,
                backend_version: d.backend_version,
            }),
        TestRequest::Correlation(r) => provider
            .correlation(&CorrelationRequest {
                n_permutations,
                ..r.clone()
            })
            .map(|d| Kernel {
                effect: d.coefficient,
                p_value: d.p_value,
                n_at_least_observed: d.n_at_least_observed,
                n_permutations_executed: d.n_permutations_executed,
                backend_version: d.backend_version,
            }),
    }
}

/// A test that passed identifiability checks and enters the Holm family.
struct Candidate {
    target_id: String,
    metadata: String,
    design: Design,
    request: TestRequest,
    log10_distinct: f64,
    effect_size: f64,
    effect_name: &'static str,
    plan: PermutationPlan,
    base: Metric,
}

fn unit_label(unit: IndependenceUnit) -> &'static str {
    match unit {
        IndependenceUnit::Sample => "sample",
        IndependenceUnit::ReferenceGroup => "reference_group",
        IndependenceUnit::Group => "group",
        IndependenceUnit::Unknown => "unknown",
    }
}

/// Numerical domain published with every association metric (rules 13 and 15).
fn numerical_domain() -> Value {
    json!({"supported_domain": {
               "nonzero_abs_min": "2^-256", "nonzero_abs_max": "2^256",
               "max_over_min_nonzero_abs_per_array": "2^32",
               "zeros": "allowed",
               "checked_arrays": "continuous metadata and continuous targets; categorical codes are labels"},
           "outside_domain": "unsupported_NUMERICAL_DOMAIN_EXCEEDED",
           "multiplicity_inputs": "Holm/BH p-values: finite, in [0, 1], nonzero p >= 2^-1022, no spread limit",
           "invariance": "scale_2k_and_translation_inside_domain",
           "accuracy": "eta2, V and r: absolute error about c*n*f64_epsilon; F: relative error about c*n*f64_epsilon unless eta2 is small, then absolute"})
}

/// Shared identity of the two metrics of one metadata × target pair.
struct Pair<'a> {
    input: &'a QualificationInput,
    target: &'a Target,
    factor: MetadataFactor<'a>,
    design: Design,
    spec: Spec,
    denominators: BTreeMap<String, usize>,
}

impl Pair<'_> {
    fn metric(&self, id: &str, status: Availability, reason: Option<&str>) -> Metric {
        let mut m = Metric::unavailable(id, status, "", None, Some(&self.target.target_id));
        m.reason_code = reason.map(str::to_owned);
        m.scope = "metadata_target".into();
        m.denominators = self.denominators.clone();
        m.parameters
            .insert("metadata".into(), json!(self.factor.name));
        m.parameters
            .insert("metadata_kind".into(), json!(self.factor.kind));
        m.parameters
            .insert("metadata_origin".into(), json!(self.factor.origin));
        if let Some(unit) = self.factor.unit {
            m.parameters.insert("metadata_unit".into(), json!(unit));
        }
        m.parameters
            .insert("association_type".into(), json!(self.spec.association_type));
        m.parameters.insert("protocol".into(), json!(PROTOCOL));
        m.parameters
            .insert("numerical_domain".into(), numerical_domain());
        m
    }

    fn plan(&self, n_units: usize, reason: Option<&str>) -> PermutationPlan {
        let (target_id, metadata) = (&self.target.target_id, self.factor.name);
        let (null_hypothesis, draw_method) = if self.design == Design::MetadataByClass {
            (
                format!("metadata {metadata} values are exchangeable across independence units, independently of target {target_id} classes"),
                "monte_carlo_uniform_unit_metadata_permutation_with_replacement_between_draws",
            )
        } else {
            (
                format!("target {target_id} labels are exchangeable across independence units, independently of metadata {metadata}"),
                "monte_carlo_uniform_unit_label_permutation_with_replacement_between_draws",
            )
        };
        PermutationPlan {
            plan_version: PERMUTATION_PLAN_VERSION.into(),
            null_hypothesis,
            tested_effect: if self.design == Design::Correlation {
                format!("marginal monotone association (Spearman) of metadata {metadata} with target {target_id}")
            } else {
                format!("marginal association of metadata {metadata} with target {target_id}")
            },
            statistic: self.spec.plan_statistic.into(),
            exchangeable_unit: self.input.options.independence_unit,
            exchangeability_declared: self.input.options.exchangeable_units,
            restrictions: "none_single_block".into(),
            block_sizes: vec![n_units],
            reduced_model: None,
            draw_method: draw_method.into(),
            rng_algorithm: "methods_pcg64_numpy_seedsequence_permutation".into(),
            seed: derive_seed(self.input.options.seed, &seed_domain(target_id, metadata)),
            seed_derivation: format!(
                "splitmix64_finalizer(options.seed XOR fnv1a64({:?}))",
                seed_domain(target_id, metadata)
            ),
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

    /// Both metrics of a pair that stops before any test.
    fn unavailable(
        &self,
        report: &mut QualificationReport,
        status: Availability,
        reason: &str,
        n_units: usize,
    ) {
        report
            .metrics
            .push(self.metric(DESCRIPTIVE_ID, status.clone(), Some(reason)));
        let mut test = self.metric(TEST_ID, status, Some(reason));
        test.parameters.insert(
            "permutation_plan".into(),
            json!(self.plan(n_units, Some(reason))),
        );
        report.metrics.push(test);
    }
}

/// Methods summary of a value set, or null with the provider reason.
fn summarize(provider: &impl MethodsProvider, values: Vec<f64>) -> (Value, Option<String>) {
    let request = SummaryRequest { values };
    match provider.summary(&request) {
        Ok(s) if s.count == request.values.len() => (
            json!({"count": s.count, "min": s.min, "max": s.max, "mean": s.mean,
                   "sample_sd": s.sample_sd, "q25": s.q25, "median": s.median, "q75": s.q75}),
            None,
        ),
        Ok(_) => (Value::Null, Some("INVALID_PROVIDER_RESULT".into())),
        Err(e) => (Value::Null, Some(e.reason)),
    }
}

/// Descriptive result of the zero-permutation kernel call(s).
struct Descriptive {
    /// None: the effect is undefined because the target is constant.
    value: Option<Value>,
    effect: Option<f64>,
    log10_distinct: f64,
    request: TestRequest,
    backend_version: String,
}

pub(crate) fn analyze_metadata_associations(
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    if input.targets.is_empty() {
        return;
    }
    let factors = input.metadata_factors();
    let mut candidates = Vec::new();
    for target in &input.targets {
        let units = build_units(target, input, samples);
        for factor in &factors {
            if let Some(candidate) = analyze_pair(input, target, &units, *factor, provider, report)
            {
                candidates.push(candidate);
            }
        }
    }
    finish_family(candidates, provider, report);
}

fn analyze_pair(
    input: &QualificationInput,
    target: &Target,
    units: &Units,
    factor: MetadataFactor<'_>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) -> Option<Candidate> {
    let design = Design::of(factor.kind, target.kind);
    let mut n_missing = 0;
    let mut n_metadata_varies = 0;
    let mut rows: Vec<(UnitValue, TargetLabel)> = Vec::new();
    let mut declared = false;
    for unit in &units.units {
        let values: Vec<Option<UnitValue>> = unit
            .samples
            .iter()
            .map(|s| {
                input.metadata_value(&factor, s).map(|v| match v {
                    MetadataLevel::Category(c) => UnitValue::Level(c.to_owned()),
                    MetadataLevel::Value(x) => UnitValue::Value(x),
                })
            })
            .collect();
        declared |= values.iter().any(Option::is_some);
        let Some(values) = values.into_iter().collect::<Option<Vec<_>>>() else {
            n_missing += 1;
            continue;
        };
        if values.iter().any(|v| *v != values[0]) {
            n_metadata_varies += 1;
            continue;
        }
        if let Some(label) = &unit.target {
            rows.push((values[0].clone(), label.clone()));
        }
    }
    let mut denominators = BTreeMap::new();
    denominators.insert("n_eligible_samples".to_string(), units.n_eligible_samples);
    denominators.insert("n_independence_units".to_string(), units.units.len());
    denominators.insert("n_units_analyzed".to_string(), rows.len());
    denominators.insert("n_units_missing_metadata".to_string(), n_missing);
    denominators.insert(
        "n_units_metadata_varies_within_unit".to_string(),
        n_metadata_varies,
    );
    denominators.insert(
        "n_units_target_varies_within_unit".to_string(),
        units.n_target_varies,
    );
    let pair = Pair {
        input,
        target,
        factor,
        design,
        spec: design.spec(target.kind),
        denominators,
    };
    let n_metadata_values = {
        let mut keys: Vec<String> = rows
            .iter()
            .map(|(v, _)| match v {
                UnitValue::Level(l) => format!("l:{l}"),
                UnitValue::Value(x) => format!("v:{:016x}", x.to_bits()),
            })
            .collect();
        keys.sort();
        keys.dedup();
        keys.len()
    };
    // Structural causes come first when exclusions leave too little data.
    let structural = if n_metadata_varies > 0 {
        Some((
            Availability::NotIdentifiable,
            "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT",
        ))
    } else if units.n_target_varies > 0 {
        Some((
            Availability::NotIdentifiable,
            "TARGET_VARIES_WITHIN_INDEPENDENCE_UNIT",
        ))
    } else {
        None
    };
    let early = if !declared {
        Some((Availability::NotApplicable, "METADATA_NOT_DECLARED"))
    } else if (n_metadata_values < 2 || rows.len() < 3) && structural.is_some() {
        structural.clone()
    } else if n_metadata_values < 2 {
        Some((
            Availability::NotApplicable,
            if factor.kind == MetadataKind::Categorical {
                "SINGLE_METADATA_LEVEL"
            } else {
                "CONSTANT_METADATA_VALUE"
            },
        ))
    } else if rows.len() < 3 {
        Some((
            Availability::InsufficientData,
            "FEWER_THAN_THREE_INDEPENDENCE_UNITS",
        ))
    } else {
        None
    };
    if let Some((status, reason)) = early {
        pair.unavailable(report, status, reason, rows.len());
        return None;
    }
    let seed = derive_seed(
        input.options.seed,
        &seed_domain(&target.target_id, factor.name),
    );
    let descriptive = match design {
        Design::CategoricalMetadata => describe_categorical(&pair, &rows, seed, provider),
        Design::MetadataByClass => describe_by_class(&pair, &rows, seed, provider),
        Design::Correlation => describe_correlation(&pair, &rows, seed, provider),
    };
    let descriptive = match descriptive {
        Ok(d) => d,
        Err((status, reason)) => {
            pair.unavailable(report, status, &reason, rows.len());
            return None;
        }
    };
    let mut metric = match descriptive.value {
        Some(value) => {
            let mut m = pair.metric(DESCRIPTIVE_ID, Availability::Computed, None);
            m.value = Some(value);
            m
        }
        None => pair.metric(
            DESCRIPTIVE_ID,
            Availability::Undefined,
            Some("CONSTANT_TARGET"),
        ),
    };
    metric.parameters.insert(
        "analysis_unit".into(),
        json!(format!(
            "{}_identity_components",
            unit_label(input.options.independence_unit)
        )),
    );
    metric.parameters.insert(
        "unit_weighting".into(),
        json!("one_vote_per_independence_unit"),
    );
    if input.options.independence_unit == IndependenceUnit::Unknown {
        metric.parameters.insert(
            "independence_assumption".into(),
            json!("physical_sample_or_sample_id_descriptive_only"),
        );
    }
    if let Some(unit) = &target.unit {
        metric.parameters.insert("target_unit".into(), json!(unit));
    }
    metric
        .parameters
        .insert("backend_version".into(), json!(descriptive.backend_version));
    report.metrics.push(metric);
    let mut plan = pair.plan(rows.len(), None);
    plan.log10_distinct_admissible_permutations = Some(descriptive.log10_distinct);
    // A design with one unit per level (or per target class) gives a
    // statistic that no permutation can change.
    let n_classes = class_codes(&rows).len();
    let saturated = match design {
        Design::CategoricalMetadata => {
            n_metadata_values == rows.len()
                || (target.kind == TargetKind::Categorical && n_classes == rows.len())
        }
        Design::MetadataByClass => n_classes == rows.len(),
        Design::Correlation => false,
    };
    let blocked = if input.options.independence_unit == IndependenceUnit::Unknown {
        Some((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN"))
    } else if units.missing_group {
        Some((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"))
    } else if let Some(cause) = structural {
        Some(cause)
    } else if saturated {
        Some((Availability::NotIdentifiable, "SATURATED_DESIGN"))
    } else if descriptive.effect.is_none() {
        Some((
            Availability::NotIdentifiable,
            "TARGET_CONSTANT_WITHIN_PERMUTATION_BLOCK",
        ))
    } else if !input.options.exchangeable_units {
        Some((
            Availability::NotIdentifiable,
            "EXCHANGEABILITY_NOT_DECLARED",
        ))
    } else {
        None
    };
    if let Some((status, reason)) = blocked {
        plan.reason_code = Some(reason.into());
        let mut test = pair.metric(TEST_ID, status, Some(reason));
        test.parameters
            .insert("permutation_plan".into(), json!(plan));
        report.metrics.push(test);
        return None;
    }
    Some(Candidate {
        target_id: target.target_id.clone(),
        metadata: factor.name.to_owned(),
        design,
        request: descriptive.request,
        log10_distinct: descriptive.log10_distinct,
        effect_size: descriptive.effect.unwrap_or_default(),
        effect_name: pair.spec.effect_name,
        plan,
        base: pair.metric(TEST_ID, Availability::Computed, None),
    })
}

fn invalid() -> (Availability, String) {
    (Availability::Error, "INVALID_PROVIDER_RESULT".into())
}

fn provider_failure(e: ProviderError) -> (Availability, String) {
    (e.availability(), e.reason)
}

/// A zero-permutation factor-association result consistent with its request.
fn valid_association(d: &AssociationDiagnostics, n_levels: usize) -> bool {
    d.n_levels == n_levels
        && d.log10_distinct_permutations.is_finite()
        && d.log10_distinct_permutations >= 0.0
        && d.effect_size.is_none_or(|v| (0.0..=1.0).contains(&v))
        && d.statistic.is_none_or(|v| v.is_finite() && v >= 0.0)
        && d.p_value.is_none()
        && d.n_permutations_executed == 0
}

fn class_codes(rows: &[(UnitValue, TargetLabel)]) -> BTreeMap<&str, i64> {
    let classes: BTreeSet<&str> = rows
        .iter()
        .filter_map(|(_, l)| match l {
            TargetLabel::Class(c) => Some(c.as_str()),
            TargetLabel::Value(_) => None,
        })
        .collect();
    classes
        .into_iter()
        .enumerate()
        .map(|(i, c)| (c, i as i64))
        .collect()
}

fn target_number(label: &TargetLabel, classes: &BTreeMap<&str, i64>) -> f64 {
    match label {
        TargetLabel::Value(v) => *v,
        TargetLabel::Class(c) => classes[c.as_str()] as f64,
    }
}

fn metadata_number(value: &UnitValue) -> f64 {
    match value {
        UnitValue::Value(v) => *v,
        UnitValue::Level(_) => 0.0,
    }
}

fn describe_categorical(
    pair: &Pair,
    rows: &[(UnitValue, TargetLabel)],
    seed: u64,
    provider: &impl MethodsProvider,
) -> Result<Descriptive, (Availability, String)> {
    let categorical = pair.target.kind == TargetKind::Categorical;
    let level = |v: &UnitValue| match v {
        UnitValue::Level(l) => l.clone(),
        UnitValue::Value(_) => String::new(),
    };
    let mut level_codes = BTreeMap::<String, i64>::new();
    for (v, _) in rows {
        let next = level_codes.len() as i64;
        level_codes.entry(level(v)).or_insert(next);
    }
    let classes = class_codes(rows);
    let request = AssociationRequest {
        factor_codes: rows.iter().map(|(v, _)| level_codes[&level(v)]).collect(),
        targets: rows
            .iter()
            .map(|(_, l)| target_number(l, &classes))
            .collect(),
        categorical,
        n_permutations: 0,
        seed,
    };
    let d = provider.association(&request).map_err(provider_failure)?;
    if !valid_association(&d, level_codes.len()) {
        return Err(invalid());
    }
    // Y coverage per metadata level: Methods summaries or class counts.
    let mut levels = Vec::new();
    for (name, code) in &level_codes {
        let labels: Vec<&TargetLabel> = rows
            .iter()
            .filter(|(v, _)| level(v) == *name)
            .map(|(_, t)| t)
            .collect();
        let mut entry = json!({"level": name, "code": code, "n_units": labels.len()});
        if categorical {
            let mut counts = BTreeMap::<&str, usize>::new();
            for label in &labels {
                if let TargetLabel::Class(c) = label {
                    *counts.entry(c.as_str()).or_default() += 1;
                }
            }
            entry["class_counts"] = json!(counts);
        } else {
            let (summary, reason) = summarize(
                provider,
                labels.iter().map(|l| target_number(l, &classes)).collect(),
            );
            entry["target_summary"] = summary;
            if let Some(reason) = reason {
                entry["reason_code"] = json!(reason);
            }
        }
        levels.push(entry);
    }
    Ok(Descriptive {
        value: d.effect_size.map(|effect| {
            json!({
                "effect_size_name": pair.spec.effect_name,
                "effect_size": effect,
                "statistic_name": pair.spec.statistic_name,
                "statistic": d.statistic,
                "df1": d.df1,
                "df2": d.df2,
                "n_levels": d.n_levels,
                "levels": levels,
            })
        }),
        effect: d.effect_size,
        log10_distinct: d.log10_distinct_permutations,
        request: TestRequest::Factor(request),
        backend_version: d.backend_version,
    })
}

fn describe_by_class(
    pair: &Pair,
    rows: &[(UnitValue, TargetLabel)],
    seed: u64,
    provider: &impl MethodsProvider,
) -> Result<Descriptive, (Availability, String)> {
    let classes = class_codes(rows);
    // Classes are the factor; metadata values are permuted across units.
    let request = AssociationRequest {
        factor_codes: rows
            .iter()
            .map(|(_, l)| target_number(l, &classes) as i64)
            .collect(),
        targets: rows.iter().map(|(v, _)| metadata_number(v)).collect(),
        categorical: false,
        n_permutations: 0,
        seed,
    };
    let d = provider.association(&request).map_err(provider_failure)?;
    if !valid_association(&d, classes.len()) {
        return Err(invalid());
    }
    let mut per_class = Vec::new();
    for (class, code) in &classes {
        let values: Vec<f64> = rows
            .iter()
            .filter(|(_, l)| matches!(l, TargetLabel::Class(c) if c == class))
            .map(|(v, _)| metadata_number(v))
            .collect();
        let mut entry = json!({"class": class, "code": code, "n_units": values.len()});
        let (summary, reason) = summarize(provider, values);
        entry["metadata_summary"] = summary;
        if let Some(reason) = reason {
            entry["reason_code"] = json!(reason);
        }
        per_class.push(entry);
    }
    Ok(Descriptive {
        value: d.effect_size.map(|effect| {
            json!({
                "effect_size_name": pair.spec.effect_name,
                "effect_size": effect,
                "statistic_name": pair.spec.statistic_name,
                "statistic": d.statistic,
                "df1": d.df1,
                "df2": d.df2,
                "n_classes": d.n_levels,
                "classes": per_class,
            })
        }),
        effect: d.effect_size,
        log10_distinct: d.log10_distinct_permutations,
        request: TestRequest::Factor(request),
        backend_version: d.backend_version,
    })
}

fn describe_correlation(
    pair: &Pair,
    rows: &[(UnitValue, TargetLabel)],
    seed: u64,
    provider: &impl MethodsProvider,
) -> Result<Descriptive, (Availability, String)> {
    let x: Vec<f64> = rows.iter().map(|(v, _)| metadata_number(v)).collect();
    let classes = BTreeMap::new();
    let y: Vec<f64> = rows
        .iter()
        .map(|(_, l)| target_number(l, &classes))
        .collect();
    let request = |method| CorrelationRequest {
        x: x.clone(),
        y: y.clone(),
        method,
        n_permutations: 0,
        seed,
    };
    let spearman = request(CorrelationMethod::Spearman);
    let rho = provider.correlation(&spearman).map_err(provider_failure)?;
    let r = provider
        .correlation(&request(CorrelationMethod::Pearson))
        .map_err(provider_failure)?;
    let valid = |d: &CorrelationDiagnostics| {
        d.n_distinct_x == rho.n_distinct_x
            && d.n_distinct_y == rho.n_distinct_y
            && d.n_distinct_x >= 2
            && d.log10_distinct_permutations.is_finite()
            && d.log10_distinct_permutations >= 0.0
            && d.coefficient.is_none_or(|v| (-1.0..=1.0).contains(&v))
            && d.coefficient.is_some() == (d.n_distinct_y >= 2)
            && d.p_value.is_none()
            && d.n_permutations_executed == 0
    };
    if !valid(&rho) || !valid(&r) {
        return Err(invalid());
    }
    let (summary, reason) = summarize(provider, x.clone());
    Ok(Descriptive {
        value: rho.coefficient.map(|effect| {
            json!({
                "effect_size_name": pair.spec.effect_name,
                "effect_size": effect,
                "statistic_name": pair.spec.statistic_name,
                "statistic": effect,
                "pearson_r": r.coefficient,
                "rank_ties": "average",
                "n_distinct_metadata_values": rho.n_distinct_x,
                "n_distinct_target_values": rho.n_distinct_y,
                "metadata_summary": summary,
                "metadata_summary_reason_code": reason,
            })
        }),
        effect: rho.coefficient,
        log10_distinct: rho.log10_distinct_permutations,
        request: TestRequest::Correlation(spearman),
        backend_version: rho.backend_version,
    })
}

/// BH controls the FDR under independence or PRDS; tests of this family share
/// units and targets, so the assumption is declared, not verified.
const BH_DEPENDENCE: &str = "independence_or_positive_regression_dependence_assumed_not_verified";

/// Spaces of at most this many distinct arrangements are enumerated so the
/// exact minimal attainable p-value, not 1/N, drives the resolution guard.
const EXACT_ENUMERATION_LIMIT: usize = 100_000;

fn run_exact(
    provider: &impl MethodsProvider,
    request: &TestRequest,
) -> Result<ExactPermutationDiagnostics, ProviderError> {
    match request {
        TestRequest::Factor(r) => provider.association_exact(&AssociationExactRequest {
            factor_codes: r.factor_codes.clone(),
            targets: r.targets.clone(),
            categorical: r.categorical,
            max_arrangements: EXACT_ENUMERATION_LIMIT,
        }),
        TestRequest::Correlation(r) => provider.correlation_exact(&CorrelationExactRequest {
            x: r.x.clone(),
            y: r.y.clone(),
            method: r.method,
            max_arrangements: EXACT_ENUMERATION_LIMIT,
        }),
    }
}

/// Resolution of one candidate: Monte Carlo step, exact enumeration of small
/// spaces, otherwise the combinatorial lower bound.
struct Resolution {
    value: f64,
    basis: &'static str,
    exact: Option<ExactPermutationDiagnostics>,
    exact_reason: Option<String>,
}

fn resolve(provider: &impl MethodsProvider, c: &Candidate) -> Resolution {
    let step = 1.0 / (PERMUTATIONS as f64 + 1.0);
    let bound = Resolution {
        value: step.max(10f64.powf(-c.log10_distinct)),
        basis: "lower_bound_from_combinatorial_bound",
        exact: None,
        exact_reason: None,
    };
    if c.log10_distinct > (EXACT_ENUMERATION_LIMIT as f64).log10() + 1e-9 {
        return bound;
    }
    match run_exact(provider, &c.request) {
        Ok(e)
            if e.n_arrangements >= 1
                && e.n_arrangements <= EXACT_ENUMERATION_LIMIT
                && (e.n_arrangements as f64).log10() <= c.log10_distinct + 1e-9
                && e.minimum_p_value.is_some_and(|p| p > 0.0 && p <= 1.0) =>
        {
            Resolution {
                value: step.max(e.minimum_p_value.unwrap_or(1.0)),
                basis: "exact_enumeration",
                exact: Some(e),
                exact_reason: None,
            }
        }
        Ok(_) => Resolution {
            exact_reason: Some("INVALID_PROVIDER_RESULT".into()),
            ..bound
        },
        Err(e) => Resolution {
            exact_reason: Some(e.reason),
            ..bound
        },
    }
}

fn finish_family(
    candidates: Vec<Candidate>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let m = candidates.len();
    if m == 0 {
        let mut family = Metric::unavailable(
            FAMILY_ID,
            Availability::NotApplicable,
            "NO_IDENTIFIABLE_TESTS",
            None,
            None,
        );
        family.scope = "dataset".into();
        family.parameters.insert("protocol".into(), json!(PROTOCOL));
        report.metrics.push(family);
        return;
    }
    let threshold = FAMILY_ALPHA / m as f64;
    // Each test: Ok(Some(kernel)) executed, Ok(None) resolution too coarse.
    let mut outcomes = Vec::with_capacity(m);
    for c in &candidates {
        let resolution = resolve(provider, c);
        if resolution.value > threshold {
            outcomes.push((resolution, Ok(None)));
            continue;
        }
        let outcome = match run_test(provider, &c.request, PERMUTATIONS) {
            Ok(k)
                if k.n_permutations_executed == PERMUTATIONS
                    && k.n_at_least_observed <= PERMUTATIONS
                    && k.p_value.is_some_and(|p| {
                        (p - (1.0 + k.n_at_least_observed as f64) / (1.0 + PERMUTATIONS as f64))
                            .abs()
                            < 1e-12
                    })
                    && k.effect.is_some_and(|e| (e - c.effect_size).abs() < 1e-12) =>
            {
                Ok(Some(k))
            }
            Ok(_) => Err(invalid()),
            Err(e) => Err(provider_failure(e)),
        };
        outcomes.push((resolution, outcome));
    }
    let p_values: Vec<f64> = outcomes
        .iter()
        .map(|(_, o)| match o {
            Ok(Some(k)) => k.p_value.unwrap_or(1.0),
            _ => 1.0,
        })
        .collect();
    let adjusted_ok = |adjusted: &[f64]| {
        adjusted.len() == m
            && adjusted
                .iter()
                .zip(&p_values)
                .all(|(a, p)| a.is_finite() && *a >= *p && *a <= 1.0)
    };
    let holm = match provider.holm_adjust(&HolmRequest {
        p_values: p_values.clone(),
    }) {
        Ok(h) if adjusted_ok(&h.adjusted) => Ok(h.adjusted),
        Ok(_) => Err(invalid()),
        Err(e) => Err(provider_failure(e)),
    };
    // Exploratory secondary view; never used for findings.
    let bh = match provider.bh_adjust(&BhRequest {
        p_values: p_values.clone(),
    }) {
        Ok(b) if adjusted_ok(&b.adjusted) => Ok(b.adjusted),
        Ok(_) => Err("INVALID_PROVIDER_RESULT".to_string()),
        Err(e) => Err(e.reason),
    };
    let members: Vec<_> = candidates
        .iter()
        .map(|c| {
            json!({"target_id": c.target_id, "metadata": c.metadata,
                   "association_type": c.base.parameters["association_type"]})
        })
        .collect();
    let mut family = Metric::computed(
        FAMILY_ID,
        json!({"method": "holm", "family_alpha": FAMILY_ALPHA, "family_size": m,
        "members": members, "unreported_members_enter_as_p_value_1": true,
        "holm_available": holm.is_ok(),
        "holm_reason_code": holm.as_ref().err().map(|e| e.1.clone()),
        "exploratory_secondary": {
            "method": "benjamini_hochberg",
            "used_for_findings": false,
            "dependence_assumption": BH_DEPENDENCE,
            "available": bh.is_ok(),
            "reason_code": bh.as_ref().err(),
        }}),
        None,
        None,
    );
    family.scope = "dataset".into();
    family.parameters.insert("protocol".into(), json!(PROTOCOL));
    report.metrics.push(family);
    for (i, (c, (resolution, outcome))) in candidates.into_iter().zip(outcomes).enumerate() {
        let mut plan = c.plan;
        plan.resolution = Some(resolution.value);
        plan.resolution_basis = Some(resolution.basis.into());
        if let Some(e) = &resolution.exact {
            plan.n_enumerated_arrangements = Some(e.n_arrangements);
            plan.exact_minimum_p_value = e.minimum_p_value;
        }
        let mut metric = c.base;
        if let Some(reason) = &resolution.exact_reason {
            metric
                .parameters
                .insert("exact_enumeration_reason_code".into(), json!(reason));
        }
        metric.parameters.insert(
            "multiplicity".into(),
            json!({"method": "holm", "family": FAMILY_ID, "family_alpha": FAMILY_ALPHA,
                   "family_size": m, "per_test_resolution_threshold": threshold,
                   "exploratory_secondary": "benjamini_hochberg_not_used_for_findings"}),
        );
        let kernel = match outcome {
            Ok(Some(k)) => k,
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
        // The permutations ran: record them even if the correction is missing.
        plan.executed = true;
        plan.n_permutations_executed = kernel.n_permutations_executed;
        metric.reason_code = None;
        let adjusted = holm.as_ref().ok().map(|a| a[i]);
        let rejects = adjusted.map(|a| a <= FAMILY_ALPHA);
        metric.value = Some(json!({
            "p_value": kernel.p_value,
            "p_value_holm": adjusted,
            "rejects_null_at_family_alpha": rejects,
            "multiplicity_available": adjusted.is_some(),
            "multiplicity_reason_code": holm.as_ref().err().map(|e| e.1.clone()),
            "p_value_bh_exploratory": bh.as_ref().ok().map(|b| b[i]),
            "effect_size_name": c.effect_name,
            "effect_size": c.effect_size,
            "n_at_least_observed": kernel.n_at_least_observed,
        }));
        metric
            .parameters
            .insert("backend_version".into(), json!(kernel.backend_version));
        metric
            .parameters
            .insert("permutation_plan".into(), json!(plan));
        report.metrics.push(metric);
        let Some(adjusted) = adjusted.filter(|a| *a <= FAMILY_ALPHA) else {
            continue;
        };
        let (message, action) = match c.design {
            Design::CategoricalMetadata => (
                format!(
                    "Target {} differs across {} levels ({}={:.3}, Holm-adjusted permutation p={:.3}); association is not causal evidence",
                    c.target_id, c.metadata, c.effect_name, c.effect_size, adjusted
                ),
                format!(
                    "Check Y coverage per {} level and whether validation holds out {} levels matching the intended use",
                    c.metadata, c.metadata
                ),
            ),
            Design::MetadataByClass => (
                format!(
                    "Metadata {} differs across target {} classes ({}={:.3}, Holm-adjusted permutation p={:.3}); association is not causal evidence",
                    c.metadata, c.target_id, c.effect_name, c.effect_size, adjusted
                ),
                format!(
                    "Check {} coverage per {} class and whether validation spans the {} range of the intended use",
                    c.metadata, c.target_id, c.metadata
                ),
            ),
            Design::Correlation => (
                format!(
                    "Target {} varies monotonically with metadata {} ({}={:.3}, Holm-adjusted permutation p={:.3}); association is not causal evidence",
                    c.target_id, c.metadata, c.effect_name, c.effect_size, adjusted
                ),
                format!(
                    "Check Y coverage along {} and whether validation spans the {} range of the intended use",
                    c.metadata, c.metadata
                ),
            ),
        };
        report.findings.push(Finding {
            rule_id: "association.metadata_target.v1".into(),
            severity: "warning".into(),
            confidence: "unknown".into(),
            evidence: vec![DESCRIPTIVE_ID.into(), TEST_ID.into(), FAMILY_ID.into()],
            message,
            action,
        });
    }
}
