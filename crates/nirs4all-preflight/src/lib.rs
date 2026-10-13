//! Safe Rust facade for the preflight qualification protocols.

pub use nirs4all_preflight_core::*;
mod association;
mod clustering;
mod confounding;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub fn capabilities(provider: &impl MethodsProvider) -> Vec<Capability> {
    let mut out = vec![
        Capability {
            capability_id: "integrity".into(),
            available: true,
            qualified: false,
            reason: Some("ALPHA_PROTOCOL_UNQUALIFIED".into()),
        },
        Capability {
            capability_id: "target.coverage".into(),
            available: true,
            qualified: false,
            reason: Some("ALPHA_PROTOCOL_UNQUALIFIED".into()),
        },
    ];
    out.extend(provider.capabilities());
    for id in [
        "validation_probe",
        "domain_shift",
        "repeatability_uncertainty",
    ] {
        out.push(Capability {
            capability_id: id.into(),
            available: false,
            qualified: false,
            reason: Some("PROTOCOL_NOT_IMPLEMENTED".into()),
        });
    }
    let association_available = [
        "methods.association",
        "methods.correlation",
        "methods.holm_adjust",
        "methods.bh_adjust",
        "methods.summary",
    ]
    .iter()
    .all(|id| out.iter().any(|c| c.capability_id == *id && c.available));
    out.push(Capability {
        capability_id: "metadata_association_tests".into(),
        available: association_available,
        qualified: false,
        reason: Some(
            if association_available {
                "ALPHA_PROTOCOL_UNQUALIFIED"
            } else {
                "ASSOCIATION_PROVIDER_NOT_CONFIGURED"
            }
            .into(),
        ),
    });
    let provided = |ids: &[&str]| {
        ids.iter()
            .all(|id| out.iter().any(|c| c.capability_id == *id && c.available))
    };
    let protocols = [
        (
            "noise_proxy",
            provided(&["methods.noise_proxy"]),
            "NOISE_PROXY_PROVIDER_NOT_CONFIGURED",
        ),
        (
            "snv_sensitivity",
            provided(&["methods.snv", "methods.pca"]),
            "SNV_PROVIDER_NOT_CONFIGURED",
        ),
        (
            "quasi_duplicates",
            provided(&["methods.tolerance_pairs"]),
            "TOLERANCE_PAIRS_PROVIDER_NOT_CONFIGURED",
        ),
        (
            "confounding",
            provided(&[
                "methods.pca",
                "methods.permanova",
                "methods.permdisp",
                "methods.permanova_freedman_lane",
                "methods.holm_adjust",
            ]),
            "PERMANOVA_PROVIDER_NOT_CONFIGURED",
        ),
    ];
    for (id, available, missing) in protocols {
        out.push(Capability {
            capability_id: id.into(),
            available,
            qualified: false,
            reason: Some(
                if available {
                    "ALPHA_PROTOCOL_UNQUALIFIED"
                } else {
                    missing
                }
                .into(),
            ),
        });
    }
    let clustering_available = [
        "methods.pca",
        "methods.hdbscan",
        "methods.adjusted_rand_index",
        "methods.summary",
    ]
    .iter()
    .all(|id| out.iter().any(|c| c.capability_id == *id && c.available));
    out.push(Capability {
        capability_id: "clustering".into(),
        available: clustering_available,
        qualified: false,
        reason: Some(
            if clustering_available {
                "ALPHA_PROTOCOL_UNQUALIFIED"
            } else {
                "HDBSCAN_PROVIDER_NOT_CONFIGURED"
            }
            .into(),
        ),
    });
    let knn_available = [
        "methods.pca",
        "methods.nearest_neighbors",
        "methods.local_contrast",
    ]
    .iter()
    .all(|id| out.iter().any(|c| c.capability_id == *id && c.available));
    out.push(Capability {
        capability_id: "local.descriptive".into(),
        available: knn_available,
        qualified: false,
        reason: Some(
            if knn_available {
                "ALPHA_PROTOCOL_UNQUALIFIED"
            } else {
                "KNN_PROVIDER_NOT_CONFIGURED"
            }
            .into(),
        ),
    });
    out
}

pub fn analyze(input: &QualificationInput, provider: &impl MethodsProvider) -> QualificationReport {
    let validation = validate_input(input);
    let mut report = QualificationReport {
        schema_version: SCHEMA_VERSION,
        data_origin: input.data_origin,
        engine_version: ENGINE_VERSION.into(),
        protocol_bundle_version: PROTOCOL_BUNDLE_VERSION.into(),
        profile_status: "exploratory".into(),
        status: if validation.valid {
            "partial"
        } else {
            "failed"
        }
        .into(),
        validation,
        capabilities: capabilities(provider),
        metrics: Vec::new(),
        findings: Vec::new(),
        limitations: vec![
            "Alpha protocols have not passed cross-language scientific qualification".into(),
            "No validation probe or calibrated thresholds are available".into(),
        ],
    };
    for capability in &mut report.capabilities {
        let reason = match capability.capability_id.as_str() {
            "quasi_duplicates" if input.options.quasi_duplicates.is_none() => {
                "QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED"
            }
            "snv_sensitivity" if !input.options.snv_sensitivity => "SNV_SENSITIVITY_DISABLED",
            _ => continue,
        };
        capability.available = false;
        capability.reason = Some(reason.into());
    }
    if !report.validation.valid {
        return report;
    }
    let samples: HashMap<_, _> = input
        .samples
        .iter()
        .map(|s| (s.sample_id.as_str(), s))
        .collect();
    let n_dev = input
        .samples
        .iter()
        .filter(|s| s.partition == Partition::Development && s.augmentation_parent_id.is_none())
        .count();
    let n_test = input
        .samples
        .iter()
        .filter(|s| s.partition == Partition::RetainedTest)
        .count();
    let n_aug = input
        .samples
        .iter()
        .filter(|s| s.augmentation_parent_id.is_some())
        .count();
    report.metrics.push(Metric::computed(
        "population.development_real_samples",
        json!(n_dev),
        None,
        None,
    ));
    report.metrics.push(Metric::computed(
        "population.retained_test_samples",
        json!(n_test),
        None,
        None,
    ));
    report.metrics.push(Metric::computed(
        "population.augmented_samples_excluded",
        json!(n_aug),
        None,
        None,
    ));
    if input.options.independence_unit == IndependenceUnit::Unknown {
        report.findings.push(Finding {
            rule_id: "independence.unknown.v1".into(),
            severity: "warning".into(),
            confidence: "unknown".into(),
            evidence: vec![],
            message: "Independent unit is unknown; inferential X-Y checks cannot be identified"
                .into(),
            action: "Declare and verify a physical or grouped independence unit".into(),
        });
    }
    for source in &input.sources {
        analyze_source(source, &samples, input, provider, &mut report);
    }
    for target in &input.targets {
        analyze_target(target, &samples, input, provider, &mut report);
    }
    association::analyze_metadata_associations(input, &samples, provider, &mut report);
    report
}

fn valid_cell(source: &SpectralSource, r: usize, c: usize) -> Option<f64> {
    let value = source.x.get(r)?.get(c).copied().flatten()?;
    if source.valid_mask.as_ref().is_some_and(|m| !m[r][c]) {
        None
    } else {
        Some(value)
    }
}

fn exact_spectrum_key(source: &SpectralSource, row: usize) -> Option<Vec<u64>> {
    let p = source.axis.len();
    if !(0..p).any(|c| valid_cell(source, row, c).is_some()) {
        return None;
    }
    Some(
        (0..p)
            .map(|c| match valid_cell(source, row, c) {
                Some(0.0) => 0,
                Some(v) => v.to_bits(),
                None => u64::MAX,
            })
            .collect(),
    )
}

fn analyze_source(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let n = source.x.len();
    let p = source.axis.len();
    let mut missing = 0usize;
    for r in 0..n {
        for c in 0..p {
            if valid_cell(source, r, c).is_none() {
                missing += 1;
            }
        }
    }
    let mut m = Metric::computed(
        "integrity.missing_cells",
        json!(missing),
        Some(&source.source_id),
        None,
    );
    m.denominators.insert("n_cells".into(), n * p);
    report.metrics.push(m);
    let mut axis_order = Metric::computed(
        "integrity.axis_order",
        json!(if source.axis.windows(2).all(|v| v[0] < v[1]) {
            "ascending"
        } else {
            "descending"
        }),
        Some(&source.source_id),
        None,
    );
    axis_order.unit = (!source.axis_unit.trim().is_empty()).then(|| source.axis_unit.clone());
    axis_order.parameters.insert(
        "axis_transform".into(),
        json!("none; source column order retained"),
    );
    report.metrics.push(axis_order);
    let dev_rows: Vec<usize> = source
        .sample_ids
        .iter()
        .enumerate()
        .filter_map(|(i, id)| {
            let sample = samples.get(id.as_str())?;
            (sample.partition == Partition::Development && sample.augmentation_parent_id.is_none())
                .then_some(i)
        })
        .collect();
    let mut m = Metric::computed(
        "integrity.development_observations",
        json!(dev_rows.len()),
        Some(&source.source_id),
        None,
    );
    m.denominators.insert("n_observations_source".into(), n);
    report.metrics.push(m);
    let mut duplicate_rows: BTreeMap<Vec<u64>, BTreeMap<String, usize>> = BTreeMap::new();
    for &r in &dev_rows {
        let Some(key) = exact_spectrum_key(source, r) else {
            continue;
        };
        let sample = samples[source.sample_ids[r].as_str()];
        let physical = sample
            .physical_sample_id
            .clone()
            .unwrap_or_else(|| sample.sample_id.clone());
        *duplicate_rows
            .entry(key)
            .or_default()
            .entry(physical)
            .or_default() += 1;
    }
    let duplicate_pairs: usize = duplicate_rows
        .values()
        .map(|by_physical| {
            let mut earlier = 0usize;
            let mut pairs = 0usize;
            for count in by_physical.values() {
                pairs = pairs.saturating_add(earlier.saturating_mul(*count));
                earlier = earlier.saturating_add(*count);
            }
            pairs
        })
        .fold(0usize, usize::saturating_add);
    let mut duplicates = Metric::computed(
        "integrity.cross_physical_exact_duplicate_pairs",
        json!(duplicate_pairs),
        Some(&source.source_id),
        None,
    );
    duplicates
        .denominators
        .insert("n_development_observations".into(), dev_rows.len());
    duplicates.parameters.insert(
        "normalization".into(),
        json!("f64_bits_with_negative_zero_normalized_and_masked_cell_sentinel"),
    );
    report.metrics.push(duplicates);
    if duplicate_pairs > 0 {
        report.findings.push(Finding { rule_id: "identity.possible_undocumented_repeats.v1".into(), severity: "warning".into(), confidence: "unknown".into(), evidence: vec!["integrity.cross_physical_exact_duplicate_pairs".into()], message: format!("{duplicate_pairs} exact spectral pairs span declared physical samples in {}", source.source_id), action: "Review acquisition provenance and physical IDs before treating these as independent".into() });
    }
    let test_rows: Vec<usize> = source
        .sample_ids
        .iter()
        .enumerate()
        .filter_map(|(i, id)| {
            let sample = samples.get(id.as_str())?;
            (sample.partition == Partition::RetainedTest && sample.augmentation_parent_id.is_none())
                .then_some(i)
        })
        .collect();
    let mut retained_rows: BTreeMap<Vec<u64>, BTreeMap<String, usize>> = BTreeMap::new();
    for &r in &test_rows {
        let Some(key) = exact_spectrum_key(source, r) else {
            continue;
        };
        let sample = samples[source.sample_ids[r].as_str()];
        let physical = sample
            .physical_sample_id
            .clone()
            .unwrap_or_else(|| sample.sample_id.clone());
        *retained_rows
            .entry(key)
            .or_default()
            .entry(physical)
            .or_default() += 1;
    }
    let mut cross_partition_pairs = 0usize;
    let mut affected_development = 0usize;
    let mut affected_retained = 0usize;
    for (key, dev_physical) in &duplicate_rows {
        let Some(test_physical) = retained_rows.get(key) else {
            continue;
        };
        let dev_total: usize = dev_physical.values().copied().sum();
        for (physical, count) in test_physical {
            let matches = dev_total.saturating_sub(*dev_physical.get(physical).unwrap_or(&0));
            cross_partition_pairs =
                cross_partition_pairs.saturating_add(matches.saturating_mul(*count));
            if matches > 0 {
                affected_retained = affected_retained.saturating_add(*count);
            }
        }
        for (physical, count) in dev_physical {
            if test_physical.keys().any(|other| other != physical) {
                affected_development = affected_development.saturating_add(*count);
            }
        }
    }
    let mut cross = Metric::computed(
        "integrity.cross_partition_exact_duplicate_pairs",
        json!(cross_partition_pairs),
        Some(&source.source_id),
        None,
    );
    cross.population_id = "development_real_vs_retained_test_real".into();
    cross
        .denominators
        .insert("n_development_observations".into(), dev_rows.len());
    cross
        .denominators
        .insert("n_retained_test_observations".into(), test_rows.len());
    cross.denominators.insert(
        "n_affected_development_observations".into(),
        affected_development,
    );
    cross.denominators.insert(
        "n_affected_retained_test_observations".into(),
        affected_retained,
    );
    cross.parameters.insert(
        "normalization".into(),
        json!("f64_bits_with_negative_zero_normalized_and_masked_cell_sentinel"),
    );
    cross
        .parameters
        .insert("test_access".into(), json!("X_only_integrity_no_fit_no_Y"));
    report.metrics.push(cross);
    if cross_partition_pairs > 0 {
        report.findings.push(Finding { rule_id: "identity.possible_cross_partition_duplicate.v1".into(), severity: "high".into(), confidence: "unknown".into(), evidence: vec!["integrity.cross_partition_exact_duplicate_pairs".into()], message: format!("{cross_partition_pairs} exact spectral pairs span development and retained test in {}", source.source_id), action: "Review physical identities and partition assignment before fitting".into() });
    }
    analyze_quasi_duplicates(
        source,
        samples,
        (&dev_rows, &test_rows),
        input,
        provider,
        report,
    );

    // Numeric source structure is one vote per physical sample and homogeneous instrument/campaign.
    // Unknown or biological repeat types cannot be silently averaged as technical replicates.
    let mut groups: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for &r in &dev_rows {
        let sample = samples[source.sample_ids[r].as_str()];
        groups
            .entry((
                sample
                    .physical_sample_id
                    .clone()
                    .unwrap_or_else(|| sample.sample_id.clone()),
                sample.instrument.clone().unwrap_or_default(),
                sample.campaign.clone().unwrap_or_default(),
            ))
            .or_default()
            .push(r);
    }
    let mut matrix = Vec::new();
    let mut group_rows = Vec::new();
    let mut ids = Vec::new();
    let mut representative_sample_ids = Vec::new();
    let mut excluded_incomplete = 0usize;
    let mut excluded_ambiguous = 0usize;
    let mut excluded_multicontext = 0usize;
    let mut contexts_per_physical = BTreeMap::<&str, usize>::new();
    for (physical, _, _) in groups.keys() {
        *contexts_per_physical.entry(physical).or_default() += 1;
    }
    for ((physical, instrument, campaign), rows) in &groups {
        if contexts_per_physical[physical.as_str()] > 1 {
            excluded_multicontext += rows.len();
            continue;
        }
        if rows
            .iter()
            .map(|&r| source.sample_ids[r].as_str())
            .collect::<BTreeSet<_>>()
            .len()
            > 1
        {
            excluded_ambiguous += rows.len();
            continue;
        }
        if rows.len() > 1
            && !rows.iter().all(|&r| {
                source
                    .repetition_types
                    .as_ref()
                    .is_some_and(|types| types[r].is_technical())
            })
        {
            excluded_ambiguous += rows.len();
            continue;
        }
        let mut means = Vec::with_capacity(p);
        for c in 0..p {
            let values: Vec<f64> = rows
                .iter()
                .filter_map(|&r| valid_cell(source, r, c))
                .collect();
            if values.len() != rows.len() {
                break;
            }
            means.push(values.iter().sum::<f64>() / values.len() as f64);
        }
        if means.len() != p {
            excluded_incomplete += rows.len();
            continue;
        }
        matrix.push(means);
        group_rows.push(rows.clone());
        ids.push(format!("{physical}|{instrument}|{campaign}"));
        representative_sample_ids.push(source.sample_ids[rows[0]].clone());
    }
    let mut agg = Metric::computed(
        "structure.eligible_samples",
        json!(matrix.len()),
        Some(&source.source_id),
        None,
    );
    agg.denominators
        .insert("n_development_observations".into(), dev_rows.len());
    agg.denominators.insert(
        "n_excluded_incomplete_observations".into(),
        excluded_incomplete,
    );
    agg.denominators.insert(
        "n_excluded_ambiguous_repeat_observations".into(),
        excluded_ambiguous,
    );
    agg.denominators.insert(
        "n_excluded_multicontext_observations".into(),
        excluded_multicontext,
    );
    agg.parameters.insert(
        "aggregation".into(),
        json!("equal_sample_mean_within_physical_instrument_campaign"),
    );
    report.metrics.push(agg);
    if matrix.len() < 3 || p == 0 {
        report.metrics.push(Metric::unavailable(
            "structure.pca",
            Availability::InsufficientData,
            "FEWER_THAN_THREE_COMPLETE_SAMPLES",
            Some(&source.source_id),
            None,
        ));
        let canonical = Err((
            Availability::InsufficientData,
            "FEWER_THAN_THREE_COMPLETE_SAMPLES",
        ));
        analyze_snv(source, &group_rows, 0, canonical, input, provider, report);
        clustering::unavailable(
            report,
            &source.source_id,
            Availability::InsufficientData,
            "FEWER_THAN_THREE_COMPLETE_SAMPLES",
        );
        confounding::unavailable(
            report,
            &source.source_id,
            Availability::InsufficientData,
            "FEWER_THAN_THREE_COMPLETE_SAMPLES",
        );
    } else {
        let k = 10.min(matrix.len() - 2).min(p);
        let req = PcaRequest {
            source_id: source.source_id.clone(),
            sample_ids: representative_sample_ids.clone(),
            matrix,
            n_components: k,
        };
        match provider.pca(&req) {
            Ok(result) if pca_result_valid(&result, k, req.matrix.len()) => {
                let mut metric = Metric::computed(
                    "structure.pca_eigenvalues",
                    json!(result.eigenvalues),
                    Some(&source.source_id),
                    None,
                );
                metric.view_id = "canonical:centered".into();
                metric
                    .denominators
                    .insert("n_aggregated_samples".into(), req.matrix.len());
                metric.parameters.insert("n_components".into(), json!(k));
                metric
                    .parameters
                    .insert("backend_version".into(), json!(result.backend_version));
                report.metrics.push(metric);
                let [sum, sum2] = result.full_moments;
                let mut moments = Metric::computed(
                    "structure.full_variance_moments",
                    json!({"sum_eigenvalues":sum,"sum_squared_eigenvalues":sum2}),
                    Some(&source.source_id),
                    None,
                );
                moments.view_id = "canonical:centered".into();
                moments.parameters.insert(
                    "provenance".into(),
                    json!("methods_full_centered_covariance_ddof_1"),
                );
                report.metrics.push(moments);
                if sum > 0.0 {
                    let retained: f64 = result.eigenvalues.iter().sum();
                    let mut ratio = Metric::computed(
                        "structure.explained_variance_retained",
                        json!(retained / sum),
                        Some(&source.source_id),
                        None,
                    );
                    ratio.view_id = "canonical:centered".into();
                    ratio.denominators.insert("n_components_retained".into(), k);
                    report.metrics.push(ratio);
                    if req.matrix.len().saturating_mul(k) <= 100_000 {
                        let mut scores = Metric::computed(
                            "structure.pca_scores",
                            json!({"sample_ids":&req.sample_ids,"aggregation_keys":&ids,"scores":&result.scores}),
                            Some(&source.source_id),
                            None,
                        );
                        scores.view_id = "canonical:centered".into();
                        scores
                            .denominators
                            .insert("n_aggregated_samples".into(), req.matrix.len());
                        scores.parameters.insert("score_columns".into(), json!(k));
                        report.metrics.push(scores);
                    } else {
                        report.metrics.push(Metric::unavailable(
                            "structure.pca_scores",
                            Availability::Unsupported,
                            "INLINE_SCORE_BUDGET_EXCEEDED",
                            Some(&source.source_id),
                            None,
                        ));
                    }
                    for target in &input.targets {
                        analyze_local(
                            source,
                            target,
                            input,
                            samples,
                            (&representative_sample_ids, &result.scores),
                            provider,
                            report,
                        );
                    }
                    let geometry = clustering::Geometry {
                        matrix: &req.matrix,
                        sample_ids: &representative_sample_ids,
                        aggregation_keys: &ids,
                        scores: &result.scores,
                    };
                    clustering::analyze(source, input, samples, &geometry, provider, report);
                    confounding::analyze(source, input, samples, &geometry, provider, report);
                } else {
                    clustering::unavailable(
                        report,
                        &source.source_id,
                        Availability::Undefined,
                        "ZERO_NUMERICAL_RANK",
                    );
                    confounding::unavailable(
                        report,
                        &source.source_id,
                        Availability::Undefined,
                        "ZERO_NUMERICAL_RANK",
                    );
                    report.metrics.push(Metric::unavailable(
                        "structure.pca_scores",
                        Availability::Undefined,
                        "ZERO_NUMERICAL_RANK",
                        Some(&source.source_id),
                        None,
                    ));
                    for target in &input.targets {
                        report.metrics.push(Metric::unavailable(
                            "local.global_contrast",
                            Availability::Undefined,
                            "ZERO_NUMERICAL_RANK",
                            Some(&source.source_id),
                            Some(&target.target_id),
                        ));
                    }
                }
                let deff = if sum2 > 0.0 {
                    Some(sum * sum / sum2)
                } else {
                    None
                };
                let mut dm = if let Some(v) = deff.filter(|v| v.is_finite()) {
                    Metric::computed(
                        "structure.effective_dimension",
                        json!(v),
                        Some(&source.source_id),
                        None,
                    )
                } else {
                    Metric::unavailable(
                        "structure.effective_dimension",
                        Availability::Undefined,
                        "ZERO_TOTAL_VARIANCE",
                        Some(&source.source_id),
                        None,
                    )
                };
                dm.view_id = "canonical:centered".into();
                dm.parameters.insert(
                    "moments_provenance".into(),
                    json!("methods_full_covariance_moments"),
                );
                report.metrics.push(dm);
                analyze_snv(source, &group_rows, k, Ok(&result), input, provider, report);
            }
            Ok(_) => {
                report.metrics.push(Metric::unavailable(
                    "structure.pca",
                    Availability::Error,
                    "INVALID_PROVIDER_RESULT",
                    Some(&source.source_id),
                    None,
                ));
                clustering::unavailable(
                    report,
                    &source.source_id,
                    Availability::Error,
                    "INVALID_PROVIDER_RESULT",
                );
                confounding::unavailable(
                    report,
                    &source.source_id,
                    Availability::Error,
                    "INVALID_PROVIDER_RESULT",
                );
                let canonical = Err((Availability::Error, "CANONICAL_PCA_UNAVAILABLE"));
                analyze_snv(source, &group_rows, k, canonical, input, provider, report);
            }
            Err(e) => {
                report.metrics.push(Metric::unavailable(
                    "structure.pca",
                    e.availability(),
                    &e.reason,
                    Some(&source.source_id),
                    None,
                ));
                clustering::unavailable(report, &source.source_id, e.availability(), &e.reason);
                confounding::unavailable(report, &source.source_id, e.availability(), &e.reason);
                let canonical = Err((e.availability(), "CANONICAL_PCA_UNAVAILABLE"));
                analyze_snv(source, &group_rows, k, canonical, input, provider, report);
            }
        }
    }
    analyze_repeats(source, samples, &dev_rows, provider, report);
    analyze_noise_proxy(source, samples, &dev_rows, input, provider, report);
}

fn pca_result_valid(result: &PcaDiagnostics, k: usize, n: usize) -> bool {
    result.eigenvalues.len() == k
        && result.scores.len() == n
        && result
            .scores
            .iter()
            .all(|s| s.len() == k && s.iter().all(|v| v.is_finite()))
        && result.full_moments[0].is_finite()
        && result.full_moments[1].is_finite()
        && result.full_moments[0] >= 0.0
        && result.full_moments[1] >= 0.0
        && result
            .eigenvalues
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0)
        && result.eigenvalues.iter().sum::<f64>() <= result.full_moments[0] * (1.0 + 1e-8) + 1e-12
}

/// Eigenvalue shares of the full spectrum and the full-moment effective dimension.
fn pca_structure(result: &PcaDiagnostics) -> serde_json::Value {
    let [sum, sum2] = result.full_moments;
    let shares: Vec<f64> = result.eigenvalues.iter().map(|v| v / sum).collect();
    json!({
        "eigenvalue_shares": shares,
        "first_component_share": shares.first(),
        "retained_share": shares.iter().sum::<f64>(),
        "effective_dimension": (sum2 > 0.0).then(|| sum * sum / sum2).filter(|v| v.is_finite()),
    })
}

fn analyze_local(
    source: &SpectralSource,
    target: &Target,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    geometry: (&[String], &[Vec<f64>]),
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let (representative_ids, scores) = geometry;
    let mut exact = BTreeMap::<&str, Vec<&TargetValue>>::new();
    for v in &target.values {
        if v.status == ReferenceStatus::Exact {
            exact.entry(&v.sample_id).or_default().push(v);
        }
    }
    let mut selected = Vec::new();
    for (i, id) in representative_ids.iter().enumerate() {
        let Some(values) = exact.get(id.as_str()) else {
            continue;
        };
        if values.iter().any(|v| match target.kind {
            TargetKind::Continuous => v.value != values[0].value,
            TargetKind::Categorical => v.category != values[0].category,
        }) {
            continue;
        }
        selected.push((i, values[0]));
    }
    if selected.len() < 4 {
        report.metrics.push(Metric::unavailable(
            "local.global_contrast",
            Availability::InsufficientData,
            "FEWER_THAN_FOUR_REFERENCED_SAMPLES",
            Some(&source.source_id),
            Some(&target.target_id),
        ));
        return;
    }
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            i = parent[i];
        }
        i
    }
    let mut parent: Vec<usize> = (0..selected.len()).collect();
    // Structured keys: a reference group named like a sample ID, or a
    // physical ID equal to another sample's ID, never merges by accident.
    let mut first_for_key = BTreeMap::<IdentityKey, usize>::new();
    for (i, (_, v)) in selected.iter().enumerate() {
        let sample = samples[v.sample_id.as_str()];
        let physical = match &sample.physical_sample_id {
            Some(p) => IdentityKey::Physical(p),
            None => IdentityKey::Sample(&sample.sample_id),
        };
        let base = match input.options.independence_unit {
            IndependenceUnit::Sample | IndependenceUnit::Unknown => physical,
            IndependenceUnit::ReferenceGroup => match &v.reference_group_id {
                Some(g) => IdentityKey::Reference(&target.target_id, g),
                None => IdentityKey::Sample(&sample.sample_id),
            },
            IndependenceUnit::Group => match &sample.independence_group {
                Some(g) => IdentityKey::Group(g),
                None => {
                    report.metrics.push(Metric::unavailable(
                        "local.global_contrast",
                        Availability::NotIdentifiable,
                        "MISSING_INDEPENDENCE_GROUP",
                        Some(&source.source_id),
                        Some(&target.target_id),
                    ));
                    return;
                }
            },
        };
        let mut keys = vec![physical, base];
        if let Some(reference_group) = &v.reference_group_id {
            keys.push(IdentityKey::Reference(&target.target_id, reference_group));
        }
        for key in keys {
            if let Some(&first) = first_for_key.get(&key) {
                let a = root(&mut parent, i);
                let b = root(&mut parent, first);
                parent[a] = b;
            } else {
                first_for_key.insert(key, i);
            }
        }
    }
    let mut group_labels = BTreeMap::<usize, i64>::new();
    let group_ids: Vec<i64> = (0..selected.len())
        .map(|i| {
            let component = root(&mut parent, i);
            let next = group_labels.len() as i64;
            *group_labels.entry(component).or_insert(next)
        })
        .collect();
    let n = selected.len();
    let k = 10.min(3.max((n as f64).sqrt().floor() as usize));
    let request = NearestNeighborsRequest {
        query: selected.iter().map(|(i, _)| scores[*i].clone()).collect(),
        reference: selected.iter().map(|(i, _)| scores[*i].clone()).collect(),
        query_group_ids: group_ids.clone(),
        reference_group_ids: group_ids,
        k,
    };
    let neighbors = match provider.nearest_neighbors(&request) {
        Ok(d)
            if d.indices.len() == n
                && d.distances.len() == n
                && d.indices.iter().all(|r| r.len() == k)
                && d.distances.iter().all(|r| r.len() == k) =>
        {
            d
        }
        Ok(_) => {
            report.metrics.push(Metric::unavailable(
                "local.global_contrast",
                Availability::Error,
                "INVALID_PROVIDER_RESULT",
                Some(&source.source_id),
                Some(&target.target_id),
            ));
            return;
        }
        Err(e) => {
            report.metrics.push(Metric::unavailable(
                "local.global_contrast",
                e.availability(),
                &e.reason,
                Some(&source.source_id),
                Some(&target.target_id),
            ));
            return;
        }
    };
    if neighbors
        .indices
        .iter()
        .any(|row| row.iter().filter(|&&idx| idx >= 0).count() < 3)
    {
        report.metrics.push(Metric::unavailable(
            "local.global_contrast",
            Availability::InsufficientData,
            "FEWER_THAN_THREE_INDEPENDENT_NEIGHBORS",
            Some(&source.source_id),
            Some(&target.target_id),
        ));
        return;
    }
    if neighbors.indices.iter().enumerate().any(|(i, row)| {
        row.iter().any(|&j| {
            j >= 0
                && ((j as usize) >= n
                    || request.query_group_ids[i] == request.reference_group_ids[j as usize])
        })
    }) || neighbors.distances.iter().enumerate().any(|(i, row)| {
        row.iter().enumerate().any(|(slot, d)| {
            let missing = neighbors.indices[i][slot] < 0;
            (missing && d.is_some()) || (!missing && d.is_none_or(|v| !v.is_finite() || v < 0.0))
        })
    }) {
        report.metrics.push(Metric::unavailable(
            "local.global_contrast",
            Availability::Error,
            "PROVIDER_INCLUDED_EXCLUDED_GROUP",
            Some(&source.source_id),
            Some(&target.target_id),
        ));
        return;
    }
    let targets = match target.kind {
        TargetKind::Continuous => selected.iter().filter_map(|(_, v)| v.value).collect(),
        TargetKind::Categorical => {
            let mut codes = BTreeMap::<&str, usize>::new();
            selected
                .iter()
                .map(|(_, v)| {
                    let label = v.category.as_deref().unwrap_or("");
                    let next = codes.len();
                    *codes.entry(label).or_insert(next) as f64
                })
                .collect()
        }
    };
    let contrast_request = LocalContrastRequest {
        targets,
        neighbor_indices: neighbors.indices.clone(),
        group_ids: request.query_group_ids.clone(),
        categorical: matches!(target.kind, TargetKind::Categorical),
    };
    let diagnostics = match provider.local_contrast(&contrast_request) {
        Ok(d)
            if d.fraction_rows_with_neighbors.is_finite()
                && (0.0..=1.0).contains(&d.fraction_rows_with_neighbors)
                && d.contrast.is_none_or(f64::is_finite)
                && d.observed_same_class_fraction
                    .is_none_or(|v| (0.0..=1.0).contains(&v))
                && d.expected_same_class_fraction
                    .is_none_or(|v| (0.0..=1.0).contains(&v)) =>
        {
            d
        }
        Ok(_) => {
            report.metrics.push(Metric::unavailable(
                "local.global_contrast",
                Availability::Error,
                "INVALID_PROVIDER_RESULT",
                Some(&source.source_id),
                Some(&target.target_id),
            ));
            return;
        }
        Err(e) => {
            report.metrics.push(Metric::unavailable(
                "local.global_contrast",
                e.availability(),
                &e.reason,
                Some(&source.source_id),
                Some(&target.target_id),
            ));
            return;
        }
    };
    let mut metric = if let Some(value) = diagnostics.contrast {
        Metric::computed(
            "local.global_contrast",
            json!(value),
            Some(&source.source_id),
            Some(&target.target_id),
        )
    } else {
        Metric::unavailable(
            "local.global_contrast",
            Availability::Undefined,
            "ZERO_REFERENCE_DISPERSION_OR_NO_EVALUABLE_ROWS",
            Some(&source.source_id),
            Some(&target.target_id),
        )
    };
    metric.view_id = "canonical:centered".into();
    metric.denominators.insert("n_eligible_samples".into(), n);
    metric.parameters.insert("k".into(), json!(k));
    if input.options.independence_unit == IndependenceUnit::Unknown {
        metric.parameters.insert(
            "independence_assumption".into(),
            json!("physical_sample_or_sample_id_descriptive_only"),
        );
    }
    metric
        .parameters
        .insert("neighbor_backend".into(), json!(neighbors.backend_version));
    metric.parameters.insert(
        "contrast_backend".into(),
        json!(diagnostics.backend_version),
    );
    metric.parameters.insert(
        "fraction_rows_with_neighbors".into(),
        json!(diagnostics.fraction_rows_with_neighbors),
    );
    metric.parameters.insert(
        "contrast_definition".into(),
        json!(if matches!(target.kind, TargetKind::Categorical) {
            "1_minus_neighbor_disagreement_over_admissible_pair_disagreement"
        } else {
            "1_minus_neighbor_squared_difference_over_2_sample_variance"
        }),
    );
    report.metrics.push(metric);
    if matches!(target.kind, TargetKind::Categorical) {
        for (id, value) in [
            (
                "local.observed_same_class_fraction",
                diagnostics.observed_same_class_fraction,
            ),
            (
                "local.expected_same_class_fraction",
                diagnostics.expected_same_class_fraction,
            ),
        ] {
            let mut m = if let Some(v) = value {
                Metric::computed(
                    id,
                    json!(v),
                    Some(&source.source_id),
                    Some(&target.target_id),
                )
            } else {
                Metric::unavailable(
                    id,
                    Availability::Undefined,
                    "NO_ADMISSIBLE_CATEGORICAL_COMPARISONS",
                    Some(&source.source_id),
                    Some(&target.target_id),
                )
            };
            m.view_id = "canonical:centered".into();
            m.denominators.insert("n_eligible_samples".into(), n);
            report.metrics.push(m);
        }
    }
}

fn analyze_repeats(
    source: &SpectralSource,
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

/// Labelled unsupervised SNV view of the same aggregated samples as the canonical PCA.
fn analyze_snv(
    source: &SpectralSource,
    group_rows: &[Vec<usize>],
    k: usize,
    canonical: Result<&PcaDiagnostics, (Availability, &str)>,
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    const VIEW: &str = "canonical:snv_centered";
    let src = Some(source.source_id.as_str());
    let push_unavailable = |report: &mut QualificationReport, status, reason: &str| {
        let mut m = Metric::unavailable("structure.snv_sensitivity", status, reason, src, None);
        m.view_id = VIEW.into();
        report.metrics.push(m);
    };
    if !input.options.snv_sensitivity {
        push_unavailable(
            report,
            Availability::NotApplicable,
            "SNV_SENSITIVITY_DISABLED",
        );
        return;
    }
    let canonical = match canonical {
        Ok(c) => c,
        Err((status, reason)) => {
            push_unavailable(report, status, reason);
            return;
        }
    };
    let p = source.axis.len();
    if p < 2 {
        push_unavailable(report, Availability::NotApplicable, "FEWER_THAN_TWO_BANDS");
        return;
    }
    if canonical.full_moments[0] <= 0.0 {
        push_unavailable(report, Availability::Undefined, "ZERO_TOTAL_VARIANCE");
        return;
    }
    // SNV is a per-acquisition transform; aggregation follows it, as for the canonical view.
    let request = SnvRequest {
        matrix: group_rows
            .iter()
            .flatten()
            .map(|&r| {
                (0..p)
                    .map(|c| valid_cell(source, r, c).unwrap_or(0.0))
                    .collect()
            })
            .collect(),
    };
    let snv = match provider.snv(&request) {
        Ok(d)
            if d.matrix.len() == request.matrix.len()
                && d.matrix
                    .iter()
                    .all(|row| row.len() == p && row.iter().all(|v| v.is_finite())) =>
        {
            d
        }
        Ok(_) => {
            push_unavailable(report, Availability::Error, "INVALID_PROVIDER_RESULT");
            return;
        }
        Err(e) => {
            push_unavailable(report, e.availability(), &e.reason);
            return;
        }
    };
    let mut offset = 0;
    let matrix: Vec<Vec<f64>> = group_rows
        .iter()
        .map(|rows| {
            let block = &snv.matrix[offset..offset + rows.len()];
            offset += rows.len();
            (0..p)
                .map(|c| block.iter().map(|row| row[c]).sum::<f64>() / rows.len() as f64)
                .collect()
        })
        .collect();
    let n = matrix.len();
    let req = PcaRequest {
        source_id: source.source_id.clone(),
        sample_ids: Vec::new(),
        matrix,
        n_components: k,
    };
    let result = match provider.pca(&req) {
        Ok(r) if pca_result_valid(&r, k, n) => r,
        Ok(_) => {
            push_unavailable(report, Availability::Error, "INVALID_PROVIDER_RESULT");
            return;
        }
        Err(e) => {
            push_unavailable(report, e.availability(), &e.reason);
            return;
        }
    };
    let mut eigen = Metric::computed(
        "structure.snv_pca_eigenvalues",
        json!(result.eigenvalues),
        src,
        None,
    );
    eigen.view_id = VIEW.into();
    eigen.denominators.insert("n_aggregated_samples".into(), n);
    eigen.parameters.insert("n_components".into(), json!(k));
    eigen
        .parameters
        .insert("backend_version".into(), json!(result.backend_version));
    report.metrics.push(eigen);
    let [sum, sum2] = result.full_moments;
    let mut dimension = match (sum2 > 0.0).then(|| sum * sum / sum2) {
        Some(v) if v.is_finite() => {
            Metric::computed("structure.snv_effective_dimension", json!(v), src, None)
        }
        _ => Metric::unavailable(
            "structure.snv_effective_dimension",
            Availability::Undefined,
            "ZERO_TOTAL_VARIANCE",
            src,
            None,
        ),
    };
    dimension.view_id = VIEW.into();
    dimension.parameters.insert(
        "moments_provenance".into(),
        json!("methods_full_covariance_moments"),
    );
    report.metrics.push(dimension);
    if sum <= 0.0 {
        push_unavailable(report, Availability::Undefined, "ZERO_SNV_TOTAL_VARIANCE");
        return;
    }
    let reference = pca_structure(canonical);
    let snv_view = pca_structure(&result);
    let delta = |key: &str| match (reference[key].as_f64(), snv_view[key].as_f64()) {
        (Some(a), Some(b)) => json!(b - a),
        _ => serde_json::Value::Null,
    };
    let mut m = Metric::computed(
        "structure.snv_sensitivity",
        json!({
            "canonical": reference,
            "snv": snv_view,
            "delta_first_component_share": delta("first_component_share"),
            "delta_retained_share": delta("retained_share"),
            "delta_effective_dimension": delta("effective_dimension"),
        }),
        src,
        None,
    );
    m.view_id = VIEW.into();
    m.denominators.insert("n_aggregated_samples".into(), n);
    m.denominators
        .insert("n_observations".into(), request.matrix.len());
    m.parameters
        .insert("reference_view".into(), json!("canonical:centered"));
    m.parameters.insert("n_components".into(), json!(k));
    m.parameters.insert(
        "snv".into(),
        json!("methods_snv_row_mean_and_population_sd_ddof_0_zero_sd_rows_centered_only"),
    );
    m.parameters.insert(
        "aggregation".into(),
        json!("snv_per_observation_then_equal_sample_mean_within_physical_instrument_campaign"),
    );
    m.parameters
        .insert("shares_denominator".into(), json!("full_variance_trace"));
    m.parameters.insert(
        "interpretation".into(),
        json!("descriptive_change_only_no_attribution_to_nuisance_or_chemistry"),
    );
    m.parameters
        .insert("snv_backend_version".into(), json!(snv.backend_version));
    report.metrics.push(m);
}

/// Smoothing-residual noise proxy per instrument/campaign context. Never an SNR.
fn analyze_noise_proxy(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    dev_rows: &[usize],
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let options = input.options.noise_proxy;
    let p = source.axis.len();
    let src = Some(source.source_id.as_str());
    let unavailable = |report: &mut QualificationReport, status, reason: &str| {
        report.metrics.push(Metric::unavailable(
            "measurement.noise_proxy",
            status,
            reason,
            src,
            None,
        ));
    };
    if dev_rows.is_empty() {
        unavailable(
            report,
            Availability::InsufficientData,
            "NO_DEVELOPMENT_OBSERVATIONS",
        );
        return;
    }
    if p < options.window_bands {
        unavailable(
            report,
            Availability::InsufficientData,
            "FEWER_BANDS_THAN_WINDOW",
        );
        return;
    }
    // The Savitzky-Golay residual assumes equal spacing; tolerance covers stored rounding only.
    let spacing = (source.axis[p - 1] - source.axis[0]) / (p - 1) as f64;
    if source
        .axis
        .windows(2)
        .any(|w| ((w[1] - w[0]) - spacing).abs() > 1e-3 * spacing.abs())
    {
        unavailable(report, Availability::Unsupported, "NON_UNIFORM_AXIS");
        return;
    }
    let axis_unit = (!source.axis_unit.trim().is_empty()).then(|| source.axis_unit.clone());
    let mut contexts: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    for &r in dev_rows {
        let s = samples[source.sample_ids[r].as_str()];
        contexts
            .entry((
                s.instrument.clone().unwrap_or_default(),
                s.campaign.clone().unwrap_or_default(),
            ))
            .or_default()
            .push(r);
    }
    for ((instrument, campaign), rows) in contexts {
        let request = NoiseProxyRequest {
            matrix: rows
                .iter()
                .map(|&r| {
                    (0..p)
                        .map(|c| valid_cell(source, r, c).unwrap_or(0.0))
                        .collect()
                })
                .collect(),
            valid_mask: rows
                .iter()
                .map(|&r| (0..p).map(|c| valid_cell(source, r, c).is_some()).collect())
                .collect(),
            window_length: options.window_bands,
            polyorder: options.polyorder,
        };
        let d = match provider.noise_proxy(&request) {
            Ok(d)
                if d.band_noise.len() == p
                    && d.band_counts.len() == p
                    && d.residual_gain.is_finite()
                    && d.residual_gain > 0.0
                    && d.band_noise.iter().zip(&d.band_counts).all(|(v, &count)| {
                        count <= rows.len()
                            && (count == 0) == v.is_none()
                            && v.is_none_or(|v| v.is_finite() && v >= 0.0)
                    })
                    && d.pooled.is_some() == d.band_counts.iter().any(|&c| c > 0)
                    && d.pooled.is_none_or(|v| v.is_finite() && v >= 0.0) =>
            {
                d
            }
            Ok(_) => {
                unavailable(report, Availability::Error, "INVALID_PROVIDER_RESULT");
                continue;
            }
            Err(e) => {
                unavailable(report, e.availability(), &e.reason);
                continue;
            }
        };
        let evaluable = d.band_counts.iter().filter(|&&c| c > 0).count();
        let describe = |m: &mut Metric| {
            m.unit = (!source.signal_unit.trim().is_empty()).then(|| source.signal_unit.clone());
            m.denominators.insert("n_observations".into(), rows.len());
            m.denominators.insert("n_evaluable_bands".into(), evaluable);
            m.denominators.insert("n_bands".into(), p);
            m.parameters.insert("instrument".into(), json!(instrument));
            m.parameters.insert("campaign".into(), json!(campaign));
            m.parameters
                .insert("smoother".into(), json!("methods_savitzky_golay_deriv_0"));
            m.parameters
                .insert("window_bands".into(), json!(options.window_bands));
            m.parameters
                .insert("polyorder".into(), json!(options.polyorder));
            m.parameters.insert(
                "physical_window_width".into(),
                json!(axis_unit
                    .as_ref()
                    .map(|_| (options.window_bands - 1) as f64 * spacing.abs())),
            );
            m.parameters.insert("axis_unit".into(), json!(axis_unit));
            m.parameters
                .insert("axis_spacing".into(), json!(spacing.abs()));
            m.parameters
                .insert("axis_uniformity_relative_tolerance".into(), json!(1e-3));
            m.parameters.insert(
                "edge_behavior".into(),
                json!("interior_bands_only_no_padding"),
            );
            m.parameters.insert(
                "mask_behavior".into(),
                json!("window_containing_any_masked_cell_skipped"),
            );
            m.parameters.insert(
                "normalization".into(),
                json!("rms_residual_divided_by_white_noise_residual_gain"),
            );
            m.parameters
                .insert("residual_gain".into(), json!(d.residual_gain));
            m.parameters.insert(
                "aggregation".into(),
                json!("root_mean_square_over_native_observations_equal_weight"),
            );
            m.parameters.insert(
                "assumption".into(),
                json!("locally_polynomial_signal_and_white_noise; residual_signal_curvature_inflates_proxy"),
            );
            m.parameters
                .insert("label".into(), json!("noise_proxy_not_snr"));
            m.parameters
                .insert("backend_version".into(), json!(d.backend_version));
        };
        let mut band = if evaluable > 0 {
            Metric::computed("measurement.noise_proxy", json!(d.band_noise), src, None)
        } else {
            Metric::unavailable(
                "measurement.noise_proxy",
                Availability::InsufficientData,
                "NO_COMPLETE_WINDOW",
                src,
                None,
            )
        };
        describe(&mut band);
        band.parameters
            .insert("n_observations_per_band".into(), json!(d.band_counts));
        report.metrics.push(band);
        let mut pooled = match d.pooled {
            Some(v) => Metric::computed("measurement.noise_proxy_pooled", json!(v), src, None),
            None => Metric::unavailable(
                "measurement.noise_proxy_pooled",
                Availability::InsufficientData,
                "NO_COMPLETE_WINDOW",
                src,
                None,
            ),
        };
        describe(&mut pooled);
        pooled.denominators.insert(
            "n_residual_cells".into(),
            d.band_counts.iter().sum::<usize>(),
        );
        report.metrics.push(pooled);
    }
}

/// Quasi-identity suspicions within a declared view, context and tolerance. X only.
fn analyze_quasi_duplicates(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    rows: (&[usize], &[usize]),
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    const WITHIN: &str = "integrity.quasi_duplicate_pairs";
    const CROSS: &str = "integrity.cross_partition_quasi_duplicate_pairs";
    const MAX_LISTED: usize = 1000;
    let (dev_rows, test_rows) = rows;
    let src = Some(source.source_id.as_str());
    let p = source.axis.len();
    let push = |report: &mut QualificationReport, id: &str, status, reason: &str| {
        let mut m = Metric::unavailable(id, status, reason, src, None);
        if id == CROSS {
            m.population_id = "development_real_vs_retained_test_real".into();
        }
        report.metrics.push(m);
    };
    let Some(options) = &input.options.quasi_duplicates else {
        for id in [WITHIN, CROSS] {
            push(
                report,
                id,
                Availability::NotApplicable,
                "QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED",
            );
        }
        return;
    };
    let view_id = match options.view {
        QuasiDuplicateView::Native => "native",
        QuasiDuplicateView::Snv => "canonical:snv",
    };
    if options.view == QuasiDuplicateView::Snv && p < 2 {
        for id in [WITHIN, CROSS] {
            push(
                report,
                id,
                Availability::NotApplicable,
                "FEWER_THAN_TWO_BANDS",
            );
        }
        return;
    }
    let complete = |r: &usize| (0..p).all(|c| valid_cell(source, *r, c).is_some());
    let dev: Vec<usize> = dev_rows.iter().copied().filter(complete).collect();
    let test: Vec<usize> = test_rows.iter().copied().filter(complete).collect();
    let all: Vec<usize> = dev.iter().chain(&test).copied().collect();
    let raw: Vec<Vec<f64>> = all
        .iter()
        .map(|&r| {
            (0..p)
                .map(|c| valid_cell(source, r, c).unwrap_or(0.0))
                .collect()
        })
        .collect();
    // SNV is stateless per spectrum: transforming retained-test X fits nothing.
    let (values, snv_backend) = if options.view == QuasiDuplicateView::Snv && !raw.is_empty() {
        match provider.snv(&SnvRequest { matrix: raw }) {
            Ok(d)
                if d.matrix.len() == all.len()
                    && d.matrix
                        .iter()
                        .all(|row| row.len() == p && row.iter().all(|v| v.is_finite())) =>
            {
                (d.matrix, Some(d.backend_version))
            }
            Ok(_) => {
                for id in [WITHIN, CROSS] {
                    push(report, id, Availability::Error, "INVALID_PROVIDER_RESULT");
                }
                return;
            }
            Err(e) => {
                for id in [WITHIN, CROSS] {
                    push(report, id, e.availability(), &e.reason);
                }
                return;
            }
        }
    } else {
        (raw, None)
    };
    let value_of: HashMap<usize, &Vec<f64>> = all.iter().copied().zip(&values).collect();
    let mut physical_codes = BTreeMap::<String, i64>::new();
    let mut physical = |r: usize| {
        let s = samples[source.sample_ids[r].as_str()];
        let key = s
            .physical_sample_id
            .clone()
            .unwrap_or_else(|| s.sample_id.clone());
        let next = physical_codes.len() as i64;
        *physical_codes.entry(key).or_insert(next)
    };
    let context_of = |r: usize| match options.context {
        ComparisonContext::Source => (String::new(), String::new()),
        ComparisonContext::InstrumentCampaign => {
            let s = samples[source.sample_ids[r].as_str()];
            (
                s.instrument.clone().unwrap_or_default(),
                s.campaign.clone().unwrap_or_default(),
            )
        }
    };
    let mut contexts: BTreeMap<(String, String), (Vec<usize>, Vec<usize>)> = BTreeMap::new();
    for &r in &dev {
        contexts.entry(context_of(r)).or_default().0.push(r);
    }
    for &r in &test {
        contexts.entry(context_of(r)).or_default().1.push(r);
    }
    #[derive(Default)]
    struct Tally {
        pairs: usize,
        candidates: usize,
        affected_query: BTreeSet<usize>,
        affected_reference: BTreeSet<usize>,
        listed: Vec<serde_json::Value>,
        backend: Option<String>,
    }
    let mut within = Tally::default();
    let mut cross = Tally::default();
    let mut failures: [Option<(Availability, String)>; 2] = [None, None];
    for (d_rows, t_rows) in contexts.values() {
        let query_rows = d_rows;
        for (slot, reference_rows) in [(0, None), (1, Some(t_rows))] {
            let tally = if slot == 0 { &mut within } else { &mut cross };
            if failures[slot].is_some()
                || query_rows.is_empty()
                || (reference_rows.is_none() && query_rows.len() < 2)
                || reference_rows.is_some_and(|r| r.is_empty())
            {
                continue;
            }
            let request = TolerancePairsRequest {
                query: query_rows.iter().map(|r| value_of[r].clone()).collect(),
                reference: reference_rows
                    .map(|rows| rows.iter().map(|r| value_of[r].clone()).collect()),
                query_group_ids: query_rows.iter().map(|&r| physical(r)).collect(),
                reference_group_ids: reference_rows
                    .map_or_else(Vec::new, |rows| rows.iter().map(|&r| physical(r)).collect()),
                tolerance: options.tolerance,
                max_pairs: MAX_LISTED - tally.listed.len(),
            };
            let n_reference = reference_rows.map_or(0, Vec::len);
            match provider.tolerance_pairs(&request) {
                Ok(d)
                    if d.query_flags.len() == query_rows.len()
                        && d.reference_flags.len() == n_reference
                        && d.pairs.len() == d.total_pairs.min(request.max_pairs)
                        && d.distances.len() == d.pairs.len()
                        && d.total_pairs <= d.candidate_pairs
                        && d.pairs.iter().zip(&d.distances).all(|(&[a, b], &dist)| {
                            a < query_rows.len()
                                && b < reference_rows.map_or(query_rows.len(), Vec::len)
                                && request.query_group_ids[a]
                                    != if reference_rows.is_some() {
                                        request.reference_group_ids[b]
                                    } else {
                                        request.query_group_ids[b]
                                    }
                                && dist.is_finite()
                                && (0.0..=options.tolerance).contains(&dist)
                        }) =>
                {
                    tally.pairs += d.total_pairs;
                    tally.candidates += d.candidate_pairs;
                    let reference = reference_rows.unwrap_or(query_rows);
                    for (i, _) in d.query_flags.iter().enumerate().filter(|(_, f)| **f) {
                        tally.affected_query.insert(query_rows[i]);
                    }
                    for (i, _) in d.reference_flags.iter().enumerate().filter(|(_, f)| **f) {
                        tally.affected_reference.insert(reference[i]);
                    }
                    for (&[a, b], dist) in d.pairs.iter().zip(&d.distances) {
                        tally.listed.push(json!({
                            "observation_a": source.observation_ids[query_rows[a]],
                            "observation_b": source.observation_ids[reference[b]],
                            "rms_difference": dist,
                        }));
                    }
                    tally.backend = Some(d.backend_version);
                }
                Ok(_) => {
                    failures[slot] = Some((Availability::Error, "INVALID_PROVIDER_RESULT".into()));
                }
                Err(e) => failures[slot] = Some((e.availability(), e.reason)),
            }
        }
    }
    let tolerance_unit = match options.view {
        QuasiDuplicateView::Native => {
            (!source.signal_unit.trim().is_empty()).then(|| source.signal_unit.clone())
        }
        QuasiDuplicateView::Snv => Some("snv_standardized_signal".into()),
    };
    let fraction = |a: usize, b: usize| (b > 0).then(|| a as f64 / b as f64);
    for (slot, tally) in [(0, within), (1, cross)] {
        let id = if slot == 0 { WITHIN } else { CROSS };
        if let Some((status, reason)) = failures[slot].take() {
            push(report, id, status, &reason);
            continue;
        }
        if slot == 1 && test.is_empty() {
            push(
                report,
                id,
                Availability::NotApplicable,
                "NO_COMPLETE_RETAINED_TEST_OBSERVATIONS",
            );
            continue;
        }
        if tally.candidates == 0 {
            push(
                report,
                id,
                Availability::InsufficientData,
                "NO_CANDIDATE_PAIRS",
            );
            continue;
        }
        let affected_dev = if slot == 0 {
            tally
                .affected_query
                .union(&tally.affected_reference)
                .count()
        } else {
            tally.affected_query.len()
        };
        let mut value = json!({
            "suspect_pairs": tally.pairs,
            "candidate_pairs": tally.candidates,
            "suspect_pair_rate": fraction(tally.pairs, tally.candidates),
            "affected_development_observations": affected_dev,
            "affected_development_fraction": fraction(affected_dev, dev.len()),
            "listed_pairs": tally.listed,
            "listing_truncated": tally.listed.len() < tally.pairs,
        });
        if slot == 1 {
            value["affected_retained_test_observations"] = json!(tally.affected_reference.len());
            value["affected_retained_test_fraction"] =
                json!(fraction(tally.affected_reference.len(), test.len()));
        }
        let mut m = Metric::computed(id, value, src, None);
        m.view_id = view_id.into();
        m.denominators
            .insert("n_development_observations".into(), dev_rows.len());
        m.denominators
            .insert("n_compared_development_observations".into(), dev.len());
        m.denominators.insert(
            "n_excluded_incomplete_development_observations".into(),
            dev_rows.len() - dev.len(),
        );
        if slot == 1 {
            m.population_id = "development_real_vs_retained_test_real".into();
            m.denominators
                .insert("n_retained_test_observations".into(), test_rows.len());
            m.denominators
                .insert("n_compared_retained_test_observations".into(), test.len());
            m.parameters
                .insert("test_access".into(), json!("X_only_integrity_no_fit_no_Y"));
        }
        m.parameters
            .insert("tolerance".into(), json!(options.tolerance));
        m.parameters
            .insert("tolerance_unit".into(), json!(tolerance_unit));
        m.parameters.insert(
            "tolerance_source".into(),
            json!("declared_in_options_quasi_duplicates"),
        );
        m.parameters
            .insert("distance".into(), json!("root_mean_square_band_difference"));
        m.parameters.insert(
            "context".into(),
            json!(match options.context {
                ComparisonContext::InstrumentCampaign => "same_instrument_and_campaign",
                ComparisonContext::Source => "whole_source",
            }),
        );
        m.parameters.insert(
            "exclusions".into(),
            json!("pairs_within_one_physical_sample; incomplete_rows"),
        );
        m.parameters
            .insert("includes_exact_duplicates".into(), json!(true));
        m.parameters
            .insert("listing_limit".into(), json!(MAX_LISTED));
        m.parameters
            .insert("backend_version".into(), json!(tally.backend));
        if let Some(v) = &snv_backend {
            m.parameters.insert("snv_backend_version".into(), json!(v));
        }
        report.metrics.push(m);
        if tally.pairs > 0 {
            let (rule, severity, scope, action) = if slot == 0 {
                (
                    "identity.possible_quasi_duplicate_repeats.v1",
                    "warning",
                    "declared physical samples",
                    "Review acquisition provenance and physical IDs; identities are not rewritten",
                )
            } else {
                (
                    "identity.possible_cross_partition_quasi_duplicate.v1",
                    "high",
                    "development and retained test",
                    "Review physical identities and partition assignment before fitting",
                )
            };
            report.findings.push(Finding {
                rule_id: rule.into(),
                severity: severity.into(),
                confidence: "unknown".into(),
                evidence: vec![id.into()],
                message: format!(
                    "{} spectral pairs within the declared tolerance {} span {scope} in {} ({view_id} view); suspicion only",
                    tally.pairs, options.tolerance, source.source_id
                ),
                action: action.into(),
            });
        }
    }
}

/// Exact, internally consistent references of real development samples.
/// Retained-test, prediction and augmented rows are counted, never read.
pub(crate) struct ExactReferences<'a> {
    pub eligible: Vec<&'a TargetValue>,
    pub excluded_censored: usize,
    pub excluded_composite: usize,
    pub excluded_retained_prediction_or_augmented: usize,
    pub inconsistent: usize,
    pub referenced_development: BTreeSet<&'a str>,
}

pub(crate) fn exact_development_references<'a>(
    target: &'a Target,
    samples: &HashMap<&str, &Sample>,
) -> ExactReferences<'a> {
    let mut out = ExactReferences {
        eligible: Vec::new(),
        excluded_censored: 0,
        excluded_composite: 0,
        excluded_retained_prediction_or_augmented: 0,
        inconsistent: 0,
        referenced_development: BTreeSet::new(),
    };
    let mut by_sample: BTreeMap<&str, Vec<&TargetValue>> = BTreeMap::new();
    for v in &target.values {
        let s = samples[v.sample_id.as_str()];
        if s.partition != Partition::Development || s.augmentation_parent_id.is_some() {
            out.excluded_retained_prediction_or_augmented += 1;
            continue;
        }
        out.referenced_development.insert(v.sample_id.as_str());
        match v.status {
            ReferenceStatus::Exact => by_sample.entry(&v.sample_id).or_default().push(v),
            ReferenceStatus::Censored => out.excluded_censored += 1,
            ReferenceStatus::Composite => out.excluded_composite += 1,
        }
    }
    for values in by_sample.values() {
        let unique: BTreeSet<String> = values
            .iter()
            .map(|v| match target.kind {
                TargetKind::Continuous => format!("{:016x}", v.value.unwrap_or_default().to_bits()),
                TargetKind::Categorical => v.category.clone().unwrap_or_default(),
            })
            .collect();
        if unique.len() == 1 {
            out.eligible.push(values[0]);
        } else {
            out.inconsistent += 1;
        }
    }
    out
}

fn analyze_target(
    target: &Target,
    samples: &HashMap<&str, &Sample>,
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let ExactReferences {
        eligible,
        excluded_censored,
        excluded_composite,
        excluded_retained_prediction_or_augmented,
        inconsistent,
        referenced_development,
    } = exact_development_references(target, samples);
    let mut m = Metric::computed(
        "target.exact_eligible_samples",
        json!(eligible.len()),
        None,
        Some(&target.target_id),
    );
    m.denominators
        .insert("n_reference_measurements".into(), target.values.len());
    m.denominators
        .insert("n_excluded_censored".into(), excluded_censored);
    m.denominators
        .insert("n_excluded_composite".into(), excluded_composite);
    m.denominators.insert(
        "n_excluded_retained_prediction_or_augmented".into(),
        excluded_retained_prediction_or_augmented,
    );
    m.denominators
        .insert("n_inconsistent_samples".into(), inconsistent);
    let n_development_real = input
        .samples
        .iter()
        .filter(|s| s.partition == Partition::Development && s.augmentation_parent_id.is_none())
        .count();
    m.denominators
        .insert("n_development_real_samples".into(), n_development_real);
    m.denominators.insert(
        "n_unreferenced_development_samples".into(),
        n_development_real.saturating_sub(referenced_development.len()),
    );
    report.metrics.push(m);
    if inconsistent > 0 {
        report.findings.push(Finding {
            rule_id: "reference.inconsistent.v1".into(),
            severity: "warning".into(),
            confidence: "unknown".into(),
            evidence: vec!["target.exact_eligible_samples".into()],
            message: format!(
                "{inconsistent} samples have conflicting exact references for {}",
                target.target_id
            ),
            action: "Resolve references with a traceable rule before X-Y analysis".into(),
        });
    }
    match target.kind {
        TargetKind::Categorical => {
            let mut counts = BTreeMap::<String, usize>::new();
            for v in eligible {
                *counts
                    .entry(v.category.clone().unwrap_or_default())
                    .or_default() += 1;
            }
            report.metrics.push(Metric::computed(
                "target.class_counts",
                json!(counts),
                None,
                Some(&target.target_id),
            ));
        }
        TargetKind::Continuous => {
            let distinct: BTreeSet<u64> = eligible
                .iter()
                .filter_map(|v| v.value.map(f64::to_bits))
                .collect();
            if distinct.len() < 2 {
                report.metrics.push(Metric::unavailable(
                    "target.continuous_distribution",
                    Availability::Undefined,
                    "CONSTANT_OR_EMPTY_TARGET",
                    None,
                    Some(&target.target_id),
                ));
            } else {
                let request = SummaryRequest {
                    values: eligible.iter().filter_map(|v| v.value).collect(),
                };
                match provider.summary(&request) {
                    Ok(d)
                        if d.count == request.values.len()
                            && [d.min, d.max, d.mean, d.q25, d.median, d.q75]
                                .iter()
                                .all(|v| v.is_finite())
                            && d.sample_sd.is_none_or(|v| v.is_finite() && v >= 0.0) =>
                    {
                        let mut metric = Metric::computed(
                            "target.continuous_distribution",
                            json!({"count":d.count,"min":d.min,"max":d.max,"mean":d.mean,"sample_sd":d.sample_sd,"q25":d.q25,"median":d.median,"q75":d.q75}),
                            None,
                            Some(&target.target_id),
                        );
                        metric
                            .parameters
                            .insert("backend_version".into(), json!(d.backend_version));
                        metric.unit = target.unit.clone();
                        report.metrics.push(metric);
                    }
                    Ok(_) => report.metrics.push(Metric::unavailable(
                        "target.continuous_distribution",
                        Availability::Error,
                        "INVALID_PROVIDER_RESULT",
                        None,
                        Some(&target.target_id),
                    )),
                    Err(e) => report.metrics.push(Metric::unavailable(
                        "target.continuous_distribution",
                        e.availability(),
                        &e.reason,
                        None,
                        Some(&target.target_id),
                    )),
                }
            }
        }
    }
    let status = if input.options.independence_unit == IndependenceUnit::Unknown {
        Availability::NotIdentifiable
    } else {
        Availability::Unsupported
    };
    let reason = if input.options.independence_unit == IndependenceUnit::Unknown {
        "INDEPENDENCE_UNIT_UNKNOWN"
    } else {
        "PERMUTATION_PLAN_NOT_QUALIFIED"
    };
    report.metrics.push(Metric::unavailable(
        "target.local_contradiction_test",
        status,
        reason,
        None,
        Some(&target.target_id),
    ));
}

/// Export a small, escaped standalone report view. JSON remains the scientific artifact.
pub fn report_html(report: &QualificationReport) -> String {
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")
    }
    fn wire_status(status: &Availability) -> &'static str {
        match status {
            Availability::Computed => "computed",
            Availability::NotApplicable => "not_applicable",
            Availability::InsufficientData => "insufficient_data",
            Availability::Unsupported => "unsupported",
            Availability::NotIdentifiable => "not_identifiable",
            Availability::Undefined => "undefined",
            Availability::Cancelled => "cancelled",
            Availability::Error => "error",
        }
    }
    fn wire_origin(origin: DataOrigin) -> &'static str {
        match origin {
            DataOrigin::Unknown => "unknown",
            DataOrigin::Synthetic => "synthetic",
            DataOrigin::UserProvided => "user_provided",
        }
    }
    fn concise_value(id: &str, value: &serde_json::Value) -> String {
        if id == "structure.pca_scores" {
            let rows = value.get("scores").and_then(serde_json::Value::as_array);
            let n = rows.map_or(0, Vec::len);
            let p = rows
                .and_then(|r| r.first())
                .and_then(serde_json::Value::as_array)
                .map_or(0, Vec::len);
            return format!("{n} rows × {p} score columns; full values in JSON");
        }
        if let Some(array) = value.as_array() {
            if array.len() > 20 {
                return format!("{} values; full array in JSON", array.len());
            }
        }
        let rendered = value.to_string();
        if rendered.chars().count() > 240 {
            format!(
                "{} characters; full value in JSON",
                rendered.chars().count()
            )
        } else {
            rendered
        }
    }
    let mut html = String::from("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>NIRS preflight report</title><style>body{font:16px system-ui;max-width:90rem;margin:2rem auto;padding:0 1rem;color:#172235}table{border-collapse:collapse;width:100%;margin:1rem 0;display:block;overflow-x:auto}caption{text-align:left;font-weight:600;padding:.3rem 0}td,th{padding:.5rem;border:1px solid #b8c2cf;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f5f9}.warning{color:#8b4a00}dt{font-weight:600}dd{margin:0 0 .5rem 0}</style></head><body><main><h1>NIRS preflight report</h1>");
    html.push_str(&format!("<p><strong>Profile:</strong> {} · <strong>Status:</strong> {} · <strong>Data origin:</strong> {}</p><p><strong>Schema:</strong> {} · <strong>Engine:</strong> {} · <strong>Protocol bundle:</strong> {}</p>", esc(&report.profile_status), esc(&report.status), wire_origin(report.data_origin), report.schema_version, esc(&report.engine_version), esc(&report.protocol_bundle_version)));
    if report.data_origin == DataOrigin::Synthetic {
        html.push_str("<p class=\"warning\"><strong>Demonstration: synthetic data.</strong> Scientific values are for interface testing.</p>");
    }
    html.push_str(
        "<p class=\"warning\">Exploratory alpha. No global score or calibration guarantee.</p>",
    );
    html.push_str(&format!("<h2>Validation</h2><p><strong>Input valid:</strong> {}</p><table><caption>Input validation issues</caption><thead><tr><th scope=\"col\">Code</th><th scope=\"col\">Path</th><th scope=\"col\">Blocking</th><th scope=\"col\">Message</th></tr></thead><tbody>", report.validation.valid));
    for issue in &report.validation.issues {
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&issue.code),
            esc(&issue.path),
            issue.blocking,
            esc(&issue.message)
        ));
    }
    html.push_str("</tbody></table><h2>Metrics</h2><table><caption>Scientific metrics and availability</caption><thead><tr><th scope=\"col\">Metric / protocol</th><th scope=\"col\">Scope / population / view</th><th scope=\"col\">Status / reason</th><th scope=\"col\">Value / unit</th><th scope=\"col\">Denominators</th><th scope=\"col\">Parameters</th></tr></thead><tbody>");
    for m in &report.metrics {
        let denominators = m
            .denominators
            .iter()
            .map(|(k, v)| format!("{}: {}", esc(k), v))
            .collect::<Vec<_>>()
            .join("<br>");
        let params = m
            .parameters
            .iter()
            .map(|(k, v)| format!("{}: {}", esc(k), esc(&concise_value(k, v))))
            .collect::<Vec<_>>()
            .join("<br>");
        let value = m
            .value
            .as_ref()
            .map(|v| concise_value(&m.metric_id, v))
            .unwrap_or_else(|| "null".into());
        html.push_str(&format!("<tr><td>{}<br><small>protocol {}</small></td><td>source: {}<br>target: {}<br>scope: {}<br>population: {}<br>view: {}</td><td>{}<br>{}</td><td>{}<br>unit: {}</td><td>{}</td><td>{}</td></tr>", esc(&m.metric_id),esc(&m.protocol_version),esc(m.source_id.as_deref().unwrap_or("—")),esc(m.target_id.as_deref().unwrap_or("—")),esc(&m.scope),esc(&m.population_id),esc(&m.view_id),wire_status(&m.status),esc(m.reason_code.as_deref().unwrap_or("—")),esc(&value),esc(m.unit.as_deref().unwrap_or("—")),denominators,params));
    }
    html.push_str("</tbody></table><h2>Findings</h2><table><caption>Findings, evidence and actions</caption><thead><tr><th scope=\"col\">Rule</th><th scope=\"col\">Severity / confidence</th><th scope=\"col\">Evidence</th><th scope=\"col\">Observation</th><th scope=\"col\">Action</th></tr></thead><tbody>");
    for f in &report.findings {
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}<br>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&f.rule_id),
            esc(&f.severity),
            esc(&f.confidence),
            f.evidence
                .iter()
                .map(|e| esc(e))
                .collect::<Vec<_>>()
                .join("<br>"),
            esc(&f.message),
            esc(&f.action)
        ));
    }
    html.push_str("</tbody></table><h2>Capabilities</h2><table><caption>Provider and protocol capabilities</caption><thead><tr><th scope=\"col\">Capability</th><th scope=\"col\">Available</th><th scope=\"col\">Qualified</th><th scope=\"col\">Reason</th></tr></thead><tbody>");
    for c in &report.capabilities {
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&c.capability_id),
            c.available,
            c.qualified,
            esc(c.reason.as_deref().unwrap_or("—"))
        ));
    }
    html.push_str("</tbody></table><h2>Limitations</h2><ul>");
    for limit in &report.limitations {
        html.push_str(&format!("<li>{}</li>", esc(limit)));
    }
    html.push_str("</ul></main></body></html>");
    html
}
