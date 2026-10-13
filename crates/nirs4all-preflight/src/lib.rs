//! Safe Rust facade for the preflight qualification protocols.

pub use nirs4all_preflight_core::*;
mod clustering;
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
        "confounding",
        "domain_shift",
        "noise_proxy",
        "repeatability_uncertainty",
        "snv_sensitivity",
        "quasi_duplicates",
        "metadata_association_tests",
    ] {
        out.push(Capability {
            capability_id: id.into(),
            available: false,
            qualified: false,
            reason: Some("PROTOCOL_NOT_IMPLEMENTED".into()),
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
        clustering::unavailable(
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
            Ok(result)
                if result.eigenvalues.len() == k
                    && result.scores.len() == req.matrix.len()
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
                    && result.eigenvalues.iter().sum::<f64>()
                        <= result.full_moments[0] * (1.0 + 1e-8) + 1e-12 =>
            {
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
                } else {
                    clustering::unavailable(
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
            }
            Err(e) => {
                report.metrics.push(Metric::unavailable(
                    "structure.pca",
                    Availability::Unsupported,
                    &e.0,
                    Some(&source.source_id),
                    None,
                ));
                clustering::unavailable(report, &source.source_id, Availability::Unsupported, &e.0);
            }
        }
    }
    analyze_repeats(source, samples, &dev_rows, provider, report);
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
    let mut first_for_key = BTreeMap::<String, usize>::new();
    for (i, (_, v)) in selected.iter().enumerate() {
        let sample = samples[v.sample_id.as_str()];
        let physical = sample
            .physical_sample_id
            .clone()
            .unwrap_or_else(|| sample.sample_id.clone());
        let base = match input.options.independence_unit {
            IndependenceUnit::Sample => sample
                .physical_sample_id
                .clone()
                .unwrap_or_else(|| sample.sample_id.clone()),
            IndependenceUnit::ReferenceGroup => v
                .reference_group_id
                .clone()
                .unwrap_or_else(|| sample.sample_id.clone()),
            IndependenceUnit::Group => match &sample.independence_group {
                Some(g) => g.clone(),
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
            IndependenceUnit::Unknown => sample
                .physical_sample_id
                .clone()
                .unwrap_or_else(|| sample.sample_id.clone()),
        };
        let mut keys = vec![format!("physical:{physical}"), format!("base:{base}")];
        if let Some(reference_group) = &v.reference_group_id {
            keys.push(format!("reference:{reference_group}"));
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
                Availability::Unsupported,
                &e.0,
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
                Availability::Unsupported,
                &e.0,
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
                Availability::Unsupported,
                &e.0,
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

fn analyze_target(
    target: &Target,
    samples: &HashMap<&str, &Sample>,
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let mut eligible = Vec::new();
    let mut excluded_censored = 0;
    let mut excluded_composite = 0;
    let mut excluded_retained_prediction_or_augmented = 0;
    let mut referenced_development = BTreeSet::new();
    let mut by_sample: BTreeMap<&str, Vec<&TargetValue>> = BTreeMap::new();
    for v in &target.values {
        let s = samples[v.sample_id.as_str()];
        if s.partition != Partition::Development || s.augmentation_parent_id.is_some() {
            excluded_retained_prediction_or_augmented += 1;
            continue;
        }
        referenced_development.insert(v.sample_id.as_str());
        match v.status {
            ReferenceStatus::Exact => by_sample.entry(&v.sample_id).or_default().push(v),
            ReferenceStatus::Censored => excluded_censored += 1,
            ReferenceStatus::Composite => excluded_composite += 1,
        }
    }
    let mut inconsistent = 0;
    for values in by_sample.values() {
        let unique: BTreeSet<String> = values
            .iter()
            .map(|v| match target.kind {
                TargetKind::Continuous => format!("{:016x}", v.value.unwrap_or_default().to_bits()),
                TargetKind::Categorical => v.category.clone().unwrap_or_default(),
            })
            .collect();
        if unique.len() == 1 {
            eligible.push(values[0]);
        } else {
            inconsistent += 1;
        }
    }
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
                        Availability::Unsupported,
                        &e.0,
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
