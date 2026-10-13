//! Metadata–target associations over independence units (protocol v1).
//! The engine selects populations, builds units and permutation plans, and
//! owns statuses and multiplicity rules; Methods computes every statistic.
use crate::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(crate) const PROTOCOL: &str = "metadata_association.v1";
/// Monte Carlo budget per global test (specification section 6).
pub(crate) const PERMUTATIONS: usize = 999;
/// Holm family-wise error rate for the metadata × target family.
pub(crate) const FAMILY_ALPHA: f64 = 0.05;
/// sqrt(f64::EPSILON), applied by Methods on the eta² / Cramér V² scale.
const TIE_TOLERANCE: f64 = 1.490_116_119_384_765_6e-8;
const DESCRIPTIVE_ID: &str = "association.metadata_target";
const TEST_ID: &str = "association.metadata_target_test";
const FAMILY_ID: &str = "association.metadata_target_family";

type MetadataAccessor = fn(&Sample) -> Option<&String>;
const METADATA: [(&str, MetadataAccessor); 2] = [
    ("instrument", |s| s.instrument.as_ref()),
    ("campaign", |s| s.campaign.as_ref()),
];

/// Stable per-test seed: SplitMix64 finalizer of the root seed XOR the
/// FNV-1a 64 hash of a provider-specific derivation domain.
pub(crate) fn derive_seed(root: u64, target_id: &str, metadata: &str) -> u64 {
    derive_domain_seed(root, &seed_domain(target_id, metadata))
}

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

fn build_units<'a>(
    target: &'a Target,
    input: &QualificationInput,
    samples: &HashMap<&str, &'a Sample>,
) -> Units<'a> {
    let eligible = exact_development_references(target, samples).eligible;
    let mut parent: Vec<usize> = (0..eligible.len()).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut first = BTreeMap::<String, usize>::new();
    let mut missing_group = false;
    for (i, v) in eligible.iter().enumerate() {
        let sample = samples[v.sample_id.as_str()];
        let physical = sample
            .physical_sample_id
            .clone()
            .unwrap_or_else(|| sample.sample_id.clone());
        let mut keys = vec![format!("physical:{physical}")];
        if input.options.independence_unit == IndependenceUnit::Group {
            match &sample.independence_group {
                Some(group) => keys.push(format!("group:{group}")),
                None => missing_group = true,
            }
        }
        if let Some(reference) = &v.reference_group_id {
            keys.push(format!("reference:{reference}"));
        }
        if let Some(individual) = &sample.individual_id {
            keys.push(format!("individual:{individual}"));
        }
        for key in keys {
            if let Some(&j) = first.get(&key) {
                let a = root(&mut parent, i);
                let b = root(&mut parent, j);
                parent[a] = b;
            } else {
                first.insert(key, i);
            }
        }
    }
    let mut members = BTreeMap::<usize, Vec<usize>>::new();
    for i in 0..eligible.len() {
        members.entry(root(&mut parent, i)).or_default().push(i);
    }
    // Canonical unit order (smallest member sample_id) fixes which unit
    // receives which permuted label, independently of union-find roots.
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

/// A test that passed identifiability checks and enters the Holm family.
struct Candidate {
    target_id: String,
    metadata: &'static str,
    request: AssociationRequest,
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

fn plan(
    input: &QualificationInput,
    target: &Target,
    metadata: &str,
    n_units: usize,
    effect_name: &str,
    reason: Option<&str>,
) -> PermutationPlan {
    PermutationPlan {
        plan_version: PERMUTATION_PLAN_VERSION.into(),
        null_hypothesis: format!(
            "target {} labels are exchangeable across independence units, independently of metadata {metadata}",
            target.target_id
        ),
        tested_effect: format!("marginal association of metadata {metadata} with target {}", target.target_id),
        statistic: if effect_name == "cramers_v" {
            "cramers_v_squared".into()
        } else {
            "eta_squared".into()
        },
        exchangeable_unit: input.options.independence_unit,
        exchangeability_declared: input.options.exchangeable_units,
        restrictions: "none_single_block".into(),
        block_sizes: vec![n_units],
        reduced_model: None,
        draw_method: "monte_carlo_uniform_unit_label_permutation_with_replacement_between_draws".into(),
        rng_algorithm: "methods_pcg64_numpy_seedsequence_permutation".into(),
        seed: derive_seed(input.options.seed, &target.target_id, metadata),
        seed_derivation: format!(
            "splitmix64_finalizer(options.seed XOR fnv1a64({:?}))",
            seed_domain(&target.target_id, metadata)
        ),
        log10_distinct_admissible_permutations: None,
        n_permutations_requested: PERMUTATIONS,
        n_permutations_executed: 0,
        resolution: None,
        p_value_convention: "(1+b)/(1+B)".into(),
        tie_tolerance: TIE_TOLERANCE,
        executed: false,
        reason_code: reason.map(str::to_owned),
    }
}

fn unavailable_test(
    id: &str,
    status: Availability,
    reason: &str,
    target: &Target,
    metadata: &str,
    plan: PermutationPlan,
    denominators: &BTreeMap<String, usize>,
) -> Metric {
    let mut m = Metric::unavailable(id, status, reason, None, Some(&target.target_id));
    m.scope = "metadata_target".into();
    m.denominators = denominators.clone();
    m.parameters.insert("metadata".into(), json!(metadata));
    m.parameters.insert("protocol".into(), json!(PROTOCOL));
    m.parameters.insert("permutation_plan".into(), json!(plan));
    m
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
    let mut candidates = Vec::new();
    for target in &input.targets {
        let units = build_units(target, input, samples);
        for (metadata, accessor) in METADATA {
            if let Some(candidate) =
                analyze_pair(input, target, &units, metadata, accessor, provider, report)
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
    metadata: &'static str,
    accessor: MetadataAccessor,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) -> Option<Candidate> {
    let categorical = target.kind == TargetKind::Categorical;
    let effect_name = if categorical {
        "cramers_v"
    } else {
        "eta_squared"
    };
    let mut n_missing = 0;
    let mut n_metadata_varies = 0;
    let mut rows: Vec<(String, TargetLabel)> = Vec::new();
    let mut declared = false;
    for unit in &units.units {
        let levels: Vec<Option<&String>> = unit.samples.iter().map(|s| accessor(s)).collect();
        declared |= levels.iter().any(Option::is_some);
        if levels.iter().any(Option::is_none) {
            n_missing += 1;
            continue;
        }
        let distinct: BTreeSet<&String> = levels.into_iter().flatten().collect();
        if distinct.len() > 1 {
            n_metadata_varies += 1;
            continue;
        }
        if let (Some(level), Some(label)) = (distinct.first(), &unit.target) {
            rows.push(((*level).clone(), label.clone()));
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
    let mut level_codes = BTreeMap::<&str, i64>::new();
    for (level, _) in &rows {
        let next = level_codes.len() as i64;
        level_codes.entry(level.as_str()).or_insert(next);
    }
    let mut class_codes = BTreeMap::<&str, i64>::new();
    if categorical {
        let classes: BTreeSet<&str> = rows
            .iter()
            .filter_map(|(_, l)| match l {
                TargetLabel::Class(c) => Some(c.as_str()),
                TargetLabel::Value(_) => None,
            })
            .collect();
        for (i, c) in classes.into_iter().enumerate() {
            class_codes.insert(c, i as i64);
        }
    }
    let request = AssociationRequest {
        factor_codes: rows.iter().map(|(l, _)| level_codes[l.as_str()]).collect(),
        targets: rows
            .iter()
            .map(|(_, label)| match label {
                TargetLabel::Value(v) => *v,
                TargetLabel::Class(c) => class_codes[c.as_str()] as f64,
            })
            .collect(),
        categorical,
        n_permutations: 0,
        seed: derive_seed(input.options.seed, &target.target_id, metadata),
    };
    let pending = |status: Availability, reason: &str| {
        (
            status.clone(),
            reason.to_owned(),
            plan(
                input,
                target,
                metadata,
                rows.len(),
                effect_name,
                Some(reason),
            ),
        )
    };
    let early = if !declared {
        Some(pending(
            Availability::NotApplicable,
            "METADATA_NOT_DECLARED",
        ))
    } else if level_codes.len() < 2 {
        Some(pending(
            Availability::NotApplicable,
            "SINGLE_METADATA_LEVEL",
        ))
    } else if rows.len() < 3 {
        Some(pending(
            Availability::InsufficientData,
            "FEWER_THAN_THREE_INDEPENDENCE_UNITS",
        ))
    } else {
        None
    };
    if let Some((status, reason, p)) = early {
        let mut d = Metric::unavailable(
            DESCRIPTIVE_ID,
            status.clone(),
            &reason,
            None,
            Some(&target.target_id),
        );
        d.scope = "metadata_target".into();
        d.denominators = denominators.clone();
        d.parameters.insert("metadata".into(), json!(metadata));
        d.parameters.insert("protocol".into(), json!(PROTOCOL));
        report.metrics.push(d);
        report.metrics.push(unavailable_test(
            TEST_ID,
            status,
            &reason,
            target,
            metadata,
            p,
            &denominators,
        ));
        return None;
    }
    let diagnostics = match provider.association(&request) {
        Ok(d)
            if d.n_levels == level_codes.len()
                && d.log10_distinct_permutations.is_finite()
                && d.log10_distinct_permutations >= 0.0
                && d.effect_size.is_none_or(|v| (0.0..=1.0).contains(&v))
                && d.statistic.is_none_or(|v| v.is_finite() && v >= 0.0)
                && d.p_value.is_none()
                && d.n_permutations_executed == 0 =>
        {
            d
        }
        result => {
            let (status, reason) = match result {
                Ok(_) => (Availability::Error, "INVALID_PROVIDER_RESULT".to_string()),
                Err(e) => (Availability::Unsupported, e.0),
            };
            let p = plan(
                input,
                target,
                metadata,
                rows.len(),
                effect_name,
                Some(&reason),
            );
            let mut d = Metric::unavailable(
                DESCRIPTIVE_ID,
                status.clone(),
                &reason,
                None,
                Some(&target.target_id),
            );
            d.scope = "metadata_target".into();
            d.denominators = denominators.clone();
            d.parameters.insert("metadata".into(), json!(metadata));
            report.metrics.push(d);
            report.metrics.push(unavailable_test(
                TEST_ID,
                status,
                &reason,
                target,
                metadata,
                p,
                &denominators,
            ));
            return None;
        }
    };
    // Y coverage per metadata level: Methods summaries or class counts.
    let mut levels = Vec::new();
    for (level, code) in &level_codes {
        let values: Vec<&TargetLabel> = rows
            .iter()
            .filter(|(l, _)| l == level)
            .map(|(_, t)| t)
            .collect();
        let coverage = if categorical {
            let mut counts = BTreeMap::<&str, usize>::new();
            for label in &values {
                if let TargetLabel::Class(c) = label {
                    *counts.entry(c.as_str()).or_default() += 1;
                }
            }
            json!({"class_counts": counts})
        } else {
            let request = SummaryRequest {
                values: values
                    .iter()
                    .filter_map(|l| match l {
                        TargetLabel::Value(v) => Some(*v),
                        TargetLabel::Class(_) => None,
                    })
                    .collect(),
            };
            match provider.summary(&request) {
                Ok(s) if s.count == request.values.len() => json!({"target_summary": {
                    "count": s.count, "min": s.min, "max": s.max, "mean": s.mean,
                    "sample_sd": s.sample_sd, "q25": s.q25, "median": s.median, "q75": s.q75}}),
                Ok(_) => json!({"target_summary": null, "reason_code": "INVALID_PROVIDER_RESULT"}),
                Err(e) => json!({"target_summary": null, "reason_code": e.0}),
            }
        };
        let mut entry = json!({"level": level, "code": code, "n_units": values.len()});
        if let (Some(entry), Some(extra)) = (entry.as_object_mut(), coverage.as_object()) {
            entry.extend(extra.clone());
        }
        levels.push(entry);
    }
    let mut descriptive = match diagnostics.effect_size {
        Some(effect) => Metric::computed(
            DESCRIPTIVE_ID,
            json!({
                "effect_size_name": effect_name,
                "effect_size": effect,
                "statistic_name": if categorical { "pearson_chi_squared" } else { "anova_f" },
                "statistic": diagnostics.statistic,
                "df1": diagnostics.df1,
                "df2": diagnostics.df2,
                "n_levels": diagnostics.n_levels,
                "levels": levels,
            }),
            None,
            Some(&target.target_id),
        ),
        None => Metric::unavailable(
            DESCRIPTIVE_ID,
            Availability::Undefined,
            "CONSTANT_TARGET",
            None,
            Some(&target.target_id),
        ),
    };
    descriptive.scope = "metadata_target".into();
    descriptive.denominators = denominators.clone();
    descriptive
        .parameters
        .insert("metadata".into(), json!(metadata));
    descriptive
        .parameters
        .insert("protocol".into(), json!(PROTOCOL));
    descriptive.parameters.insert(
        "analysis_unit".into(),
        json!(format!(
            "{}_identity_components",
            unit_label(input.options.independence_unit)
        )),
    );
    descriptive.parameters.insert(
        "unit_weighting".into(),
        json!("one_vote_per_independence_unit"),
    );
    if input.options.independence_unit == IndependenceUnit::Unknown {
        descriptive.parameters.insert(
            "independence_assumption".into(),
            json!("physical_sample_or_sample_id_descriptive_only"),
        );
    }
    if let Some(unit) = &target.unit {
        descriptive
            .parameters
            .insert("target_unit".into(), json!(unit));
    }
    descriptive
        .parameters
        .insert("backend_version".into(), json!(diagnostics.backend_version));
    report.metrics.push(descriptive);
    let mut p = plan(input, target, metadata, rows.len(), effect_name, None);
    p.log10_distinct_admissible_permutations = Some(diagnostics.log10_distinct_permutations);
    let blocked = if diagnostics.effect_size.is_none() {
        Some((
            Availability::NotIdentifiable,
            "TARGET_CONSTANT_WITHIN_PERMUTATION_BLOCK",
        ))
    } else if input.options.independence_unit == IndependenceUnit::Unknown {
        Some((Availability::NotIdentifiable, "INDEPENDENCE_UNIT_UNKNOWN"))
    } else if units.missing_group {
        Some((Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"))
    } else if !input.options.exchangeable_units {
        Some((
            Availability::NotIdentifiable,
            "EXCHANGEABILITY_NOT_DECLARED",
        ))
    } else if units.n_target_varies > 0 {
        Some((
            Availability::NotIdentifiable,
            "TARGET_VARIES_WITHIN_INDEPENDENCE_UNIT",
        ))
    } else if n_metadata_varies > 0 {
        Some((
            Availability::NotIdentifiable,
            "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT",
        ))
    } else {
        None
    };
    if let Some((status, reason)) = blocked {
        p.reason_code = Some(reason.into());
        report.metrics.push(unavailable_test(
            TEST_ID,
            status,
            reason,
            target,
            metadata,
            p,
            &denominators,
        ));
        return None;
    }
    let mut base = Metric::unavailable(
        TEST_ID,
        Availability::Computed,
        "",
        None,
        Some(&target.target_id),
    );
    base.scope = "metadata_target".into();
    base.denominators = denominators;
    base.parameters.insert("metadata".into(), json!(metadata));
    base.parameters.insert("protocol".into(), json!(PROTOCOL));
    Some(Candidate {
        target_id: target.target_id.clone(),
        metadata,
        request,
        log10_distinct: diagnostics.log10_distinct_permutations,
        effect_size: diagnostics.effect_size.unwrap_or_default(),
        effect_name,
        plan: p,
        base,
    })
}

fn finish_family(
    candidates: Vec<Candidate>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let m = candidates.len();
    let members: Vec<_> = candidates
        .iter()
        .map(|c| json!({"target_id": c.target_id, "metadata": c.metadata}))
        .collect();
    let mut family = if m == 0 {
        Metric::unavailable(
            FAMILY_ID,
            Availability::NotApplicable,
            "NO_IDENTIFIABLE_TESTS",
            None,
            None,
        )
    } else {
        Metric::computed(
            FAMILY_ID,
            json!({"method": "holm", "family_alpha": FAMILY_ALPHA, "family_size": m,
                   "members": members, "unreported_members_enter_as_p_value_1": true}),
            None,
            None,
        )
    };
    family.scope = "dataset".into();
    family.parameters.insert("protocol".into(), json!(PROTOCOL));
    report.metrics.push(family);
    if m == 0 {
        return;
    }
    let threshold = FAMILY_ALPHA / m as f64;
    // Each test: Ok(Some(diagnostics)) executed, Ok(None) resolution too coarse.
    let mut outcomes = Vec::with_capacity(m);
    for c in &candidates {
        let resolution = (1.0 / (PERMUTATIONS as f64 + 1.0)).max(10f64.powf(-c.log10_distinct));
        if resolution > threshold {
            outcomes.push((resolution, Ok(None)));
            continue;
        }
        let request = AssociationRequest {
            n_permutations: PERMUTATIONS,
            ..c.request.clone()
        };
        let outcome = match provider.association(&request) {
            Ok(d)
                if d.n_permutations_executed == PERMUTATIONS
                    && d.n_at_least_observed <= PERMUTATIONS
                    && d.p_value.is_some_and(|p| {
                        (p - (1.0 + d.n_at_least_observed as f64) / (1.0 + PERMUTATIONS as f64))
                            .abs()
                            < 1e-12
                    })
                    && d.effect_size
                        .is_some_and(|e| (e - c.effect_size).abs() < 1e-12) =>
            {
                Ok(Some(d))
            }
            Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".to_string())),
            Err(e) => Err((Availability::Unsupported, e.0)),
        };
        outcomes.push((resolution, outcome));
    }
    let p_values: Vec<f64> = outcomes
        .iter()
        .map(|(_, o)| match o {
            Ok(Some(d)) => d.p_value.unwrap_or(1.0),
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
        Err(e) => Err((Availability::Unsupported, e.0)),
    };
    for (i, (c, (resolution, outcome))) in candidates.into_iter().zip(outcomes).enumerate() {
        let mut plan = c.plan;
        plan.resolution = Some(resolution);
        let mut metric = c.base;
        metric.parameters.insert(
            "multiplicity".into(),
            json!({"method": "holm", "family": FAMILY_ID, "family_alpha": FAMILY_ALPHA,
                   "family_size": m, "per_test_resolution_threshold": threshold}),
        );
        let outcome = match (outcome, &holm) {
            (Ok(Some(_)), Err(e)) => Err(e.clone()),
            (outcome, _) => outcome,
        };
        let diagnostics = match outcome {
            Ok(Some(d)) => d,
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
                metric.status = status.clone();
                metric.reason_code = Some(reason.clone());
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
        plan.n_permutations_executed = diagnostics.n_permutations_executed;
        metric.reason_code = None;
        metric.value = Some(json!({
            "p_value": diagnostics.p_value,
            "p_value_holm": adjusted,
            "rejects_null_at_family_alpha": rejects,
            "effect_size_name": c.effect_name,
            "effect_size": c.effect_size,
            "n_at_least_observed": diagnostics.n_at_least_observed,
        }));
        metric
            .parameters
            .insert("backend_version".into(), json!(diagnostics.backend_version));
        metric
            .parameters
            .insert("permutation_plan".into(), json!(plan));
        report.metrics.push(metric);
        if rejects {
            report.findings.push(Finding {
                rule_id: "association.metadata_target.v1".into(),
                severity: "warning".into(),
                confidence: "unknown".into(),
                evidence: vec![DESCRIPTIVE_ID.into(), TEST_ID.into(), FAMILY_ID.into()],
                message: format!(
                    "Target {} differs across {} levels ({}={:.3}, Holm-adjusted permutation p={:.3}); association is not causal evidence",
                    c.target_id, c.metadata, c.effect_name, c.effect_size, adjusted
                ),
                action: format!(
                    "Check Y coverage per {} level and whether validation holds out {} levels matching the intended use",
                    c.metadata, c.metadata
                ),
            });
        }
    }
}
