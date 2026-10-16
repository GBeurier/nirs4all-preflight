use nirs4all_preflight::*;
use std::cell::Cell;

/// Deterministic stand-in: PCA keeps the leading columns, HDBSCAN splits on the
/// sign of the first score, ARI is 1 for identical label sets, permutation b
/// rotates the units by b, assignment pairs equal labels and Gaussian draws
/// alternate the sign of the first column.
struct Mock {
    hdbscan_calls: Cell<usize>,
    permutation_seeds: std::cell::RefCell<Vec<u64>>,
    /// Refuse HDBSCAN as Methods does outside its numerical domain.
    outside_domain: bool,
}
fn mock() -> Mock {
    Mock {
        hdbscan_calls: Cell::new(0),
        permutation_seeds: Default::default(),
        outside_domain: false,
    }
}
impl MethodsProvider for Mock {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; r.n_components],
            scores: r
                .matrix
                .iter()
                .map(|row| row[..r.n_components].to_vec())
                .collect(),
            full_moments: [r.n_components as f64, r.n_components as f64],
            backend_version: "mock".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        panic!("no technical repeats expected")
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        let mut v = r.values.clone();
        v.sort_by(f64::total_cmp);
        let mid = v[v.len() / 2];
        Ok(SummaryDiagnostics {
            count: v.len(),
            min: v[0],
            max: v[v.len() - 1],
            mean: v.iter().sum::<f64>() / v.len() as f64,
            sample_sd: None,
            q25: mid,
            median: mid,
            q75: mid,
            backend_version: "mock".into(),
        })
    }
    fn hdbscan(&self, r: &HdbscanRequest) -> Result<HdbscanDiagnostics, ProviderError> {
        self.hdbscan_calls.set(self.hdbscan_calls.get() + 1);
        if self.outside_domain {
            return Err(ProviderError(NUMERICAL_DOMAIN_EXCEEDED.into()));
        }
        let labels: Vec<i64> = r.matrix.iter().map(|s| i64::from(s[0] > 0.0)).collect();
        let n = labels.len();
        let node = |label: usize| HdbscanTreeNode {
            parent: Some(0),
            size: labels.iter().filter(|&&l| l == label as i64).count(),
            label: Some(label),
            birth_distance: Some(2.0),
            death_distance: 0.5,
            stability: Some(1.0),
        };
        Ok(HdbscanDiagnostics {
            membership: vec![1.0; n],
            outlier_scores: vec![Some(0.0); n],
            persistence: vec![0.5, 0.5],
            tree: vec![
                HdbscanTreeNode {
                    parent: None,
                    size: n,
                    label: None,
                    birth_distance: None,
                    death_distance: 2.0,
                    stability: Some(0.0),
                },
                node(0),
                node(1),
            ],
            labels,
            backend_version: "mock".into(),
        })
    }
    fn adjusted_rand_index(
        &self,
        r: &AdjustedRandRequest,
    ) -> Result<AdjustedRandDiagnostics, ProviderError> {
        Ok(AdjustedRandDiagnostics {
            ari: Some(if r.labels_a == r.labels_b { 1.0 } else { 0.0 }),
            backend_version: "mock".into(),
        })
    }
    fn random_permutations(
        &self,
        r: &RandomPermutationsRequest,
    ) -> Result<RandomPermutationsDiagnostics, ProviderError> {
        self.permutation_seeds.borrow_mut().push(r.seed);
        Ok(RandomPermutationsDiagnostics {
            permutations: (0..r.n_permutations)
                .map(|b| (0..r.n).map(|j| (j + b) % r.n).collect())
                .collect(),
            backend_version: "mock".into(),
        })
    }
    fn cluster_jaccard(
        &self,
        r: &ClusterJaccardRequest,
    ) -> Result<ClusterJaccardDiagnostics, ProviderError> {
        let size = |labels: &[i64], c: usize| labels.iter().filter(|&&l| l == c as i64).count();
        let sizes_a: Vec<usize> = (0..r.n_clusters_a).map(|c| size(&r.labels_a, c)).collect();
        let sizes_b: Vec<usize> = (0..r.n_clusters_b).map(|c| size(&r.labels_b, c)).collect();
        let inter = |i: usize, j: usize| {
            r.labels_a
                .iter()
                .zip(&r.labels_b)
                .filter(|(a, b)| **a == i as i64 && **b == j as i64)
                .count()
        };
        Ok(ClusterJaccardDiagnostics {
            jaccard: (0..r.n_clusters_a)
                .map(|i| {
                    (0..r.n_clusters_b)
                        .map(|j| {
                            let both = inter(i, j);
                            Some(both as f64 / (sizes_a[i] + sizes_b[j] - both) as f64)
                        })
                        .collect()
                })
                .collect(),
            intersections: (0..r.n_clusters_a)
                .map(|i| (0..r.n_clusters_b).map(|j| inter(i, j)).collect())
                .collect(),
            sizes_a,
            sizes_b,
            backend_version: "mock".into(),
        })
    }
    fn linear_sum_assignment(
        &self,
        r: &LinearAssignmentRequest,
    ) -> Result<LinearAssignmentDiagnostics, ProviderError> {
        let k = r.cost.len().min(r.cost[0].len());
        Ok(LinearAssignmentDiagnostics {
            row_indices: (0..k).collect(),
            column_indices: (0..k).collect(),
            backend_version: "mock".into(),
        })
    }
    fn multivariate_normal(
        &self,
        r: &MultivariateNormalRequest,
    ) -> Result<MultivariateNormalDiagnostics, ProviderError> {
        Ok(MultivariateNormalDiagnostics {
            samples: (0..r.n_samples)
                .map(|i| {
                    let sign = if i % 2 == 0 { -1.0 } else { 1.0 };
                    (0..r.mean.len())
                        .map(|j| sign * (1.0 + (i + j) as f64))
                        .collect()
                })
                .collect(),
            backend_version: "mock".into(),
        })
    }
}

/// `n` samples in two blobs along the first band, one row per physical sample.
fn input(n: usize) -> QualificationInput {
    let mut samples = Vec::new();
    let mut source = SpectralSource {
        source_id: "x".into(),
        observation_ids: vec![],
        sample_ids: vec![],
        x: vec![],
        valid_mask: None,
        axis: vec![1.0, 2.0, 3.0],
        axis_unit: "nm".into(),
        signal_unit: "abs".into(),
        signal_type: "absorbance".into(),
        repetition_types: None,
    };
    for i in 0..n {
        let id = format!("s{i:03}");
        samples.push(Sample {
            sample_id: id.clone(),
            physical_sample_id: Some(id.clone()),
            partition: Partition::Development,
            independence_group: Some(format!("g{}", i / 2)),
            instrument: None,
            campaign: None,
            individual_id: None,
            augmentation_parent_id: None,
        });
        source.observation_ids.push(format!("o{i}"));
        source.sample_ids.push(id);
        let side = if i % 2 == 0 { -10.0 } else { 10.0 };
        let jitter = (i as f64 * 0.37).sin();
        source
            .x
            .push(vec![Some(side + jitter), Some(jitter), Some(-jitter)]);
    }
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![source],
        samples,
        targets: vec![],
        options: Options::default(),
    }
}

fn metric<'a>(report: &'a QualificationReport, id: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

#[test]
fn clustering_needs_two_minimum_cluster_sizes() {
    let mock = mock();
    let report = analyze(&input(9), &mock);
    for id in [
        "clustering.partition",
        "clustering.subsample_stability",
        "clustering.cluster_appearance_frequency",
        "clustering.gaussian_null_model",
        "clustering.partition_assessment",
    ] {
        let metric = metric(&report, id);
        assert!(matches!(metric.status, Availability::InsufficientData));
        assert_eq!(
            metric.reason_code.as_deref(),
            Some("FEWER_THAN_TWO_MIN_CLUSTER_SIZES")
        );
    }
    assert_eq!(mock.hdbscan_calls.get(), 0);
}

#[test]
fn candidate_partition_reports_stability_matching_null_and_assessment() {
    let mock = mock();
    let mut x = input(40);
    x.options.independence_unit = IndependenceUnit::Sample;
    let report = analyze(&x, &mock);
    // Full partition, 2 x 50 refit subsamples, 50 observed frozen-projection
    // subsamples, 99 null replicates x (1 + 50).
    assert_eq!(mock.hdbscan_calls.get(), 1 + 2 * 50 + 50 + 99 * 51);
    let partition = metric(&report, "clustering.partition");
    assert!(matches!(partition.status, Availability::Computed));
    assert_eq!(partition.view_id, "canonical:centered");
    let value = partition.value.as_ref().unwrap();
    assert_eq!(value["sample_ids"][0], "s000");
    assert_eq!(value["labels"].as_array().unwrap().len(), 40);
    assert_eq!(partition.parameters["min_cluster_size"], 5);
    assert_eq!(partition.parameters["protocol"], "clustering.v3");
    assert_eq!(
        partition.parameters["membership_semantics"],
        "relative_strength_not_probability"
    );
    assert_eq!(
        metric(&report, "clustering.candidate_cluster_count").value,
        Some(serde_json::json!(2))
    );
    let stability = metric(&report, "clustering.subsample_stability");
    assert!(matches!(stability.status, Availability::Computed));
    assert_eq!(stability.denominators["n_subsamples"], 50);
    assert_eq!(stability.denominators["n_ari_evaluable_subsamples"], 50);
    assert_eq!(stability.denominators["n_units_per_subsample"], 32);
    assert_eq!(stability.parameters["min_cluster_size"], 4);
    assert_eq!(stability.parameters["resampling_unit"], "physical_sample");
    assert_eq!(stability.parameters["independent_unit_resampling"], true);
    let value = stability.value.as_ref().unwrap();
    assert_eq!(value["ari_assigned_in_both"]["min"], 1.0);
    assert_eq!(value["intersection_fraction_of_eligible"]["max"], 0.8);
    assert_eq!(value["ari_population_fraction_of_eligible"]["max"], 0.8);
    assert_eq!(value["per_subsample"].as_array().unwrap().len(), 50);
    // Plan b keeps sorted(rotation_b[0:32]) under the mock permutations.
    let first: Vec<u64> = (0..32).collect();
    assert_eq!(value["unit_plans"][0], serde_json::json!(first));
    assert_eq!(value["unit_plans"][39][0], 0);
    let constant = metric(
        &report,
        "clustering.subsample_stability_constant_parameters",
    );
    assert_eq!(constant.parameters["min_cluster_size"], 5);
    let appearance = metric(&report, "clustering.cluster_appearance_frequency");
    assert!(matches!(appearance.status, Availability::Computed));
    let clusters = &appearance.value.as_ref().unwrap()["clusters"];
    assert_eq!(clusters[0]["appearance_frequency"], 1.0);
    assert_eq!(clusters[1]["n_evaluable_subsamples"], 50);
    assert_eq!(appearance.parameters["appearance_threshold"], 0.5);
    let null = metric(&report, "clustering.gaussian_null_model");
    assert!(matches!(null.status, Availability::Computed));
    assert_eq!(null.denominators["n_replicates"], 99);
    let nv = null.value.as_ref().unwrap();
    assert_eq!(nv["null"]["fraction_with_at_least_two_clusters"], 1.0);
    // Every mock replicate equals the observation: p = (1 + 99) / 100.
    assert_eq!(
        nv["fitted_null_tail"]["statistic"],
        "coverage_weighted_stability"
    );
    assert_eq!(nv["observed"]["coverage_weighted_stability"], 1.0);
    assert_eq!(nv["fitted_null_tail"]["tail_fraction"], 1.0);
    assert_eq!(nv["fitted_null_tail"]["decisional"], true);
    assert_eq!(
        nv["description"]["joint_dominance"]["n_null_dominating"],
        99
    );
    assert!(null.parameters["decisional_scope"]
        .as_str()
        .unwrap()
        .contains("descriptive only"));
    let assessment = metric(&report, "clustering.partition_assessment");
    assert_eq!(
        assessment.value.as_ref().unwrap()["assessment"],
        "compatible_with_fitted_gaussian"
    );
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "structure.clustering.continuous_structure.v3")
        .unwrap();
    assert_eq!(finding.confidence, "unknown");
    assert!(finding.message.contains("candidate groups"));
    assert!(finding.message.contains("fitted to the same data"));
    assert!(finding.message.contains("no type-I error guarantee"));
}

#[test]
fn subsampling_is_seeded_and_respects_independence_groups() {
    let mock = mock();
    let mut x = input(40);
    x.options.independence_unit = IndependenceUnit::Group;
    x.options.seed = 7;
    let first = analyze(&x, &mock);
    let a = metric(&first, "clustering.subsample_stability");
    assert_eq!(a.denominators["n_resampling_units"], 20);
    assert_eq!(a.denominators["n_independent_units"], 20);
    assert_eq!(a.denominators["n_units_per_subsample"], 16);
    assert_eq!(a.value.as_ref().unwrap()["intersection_size"]["max"], 32.0);
    // Two-row units: independent simulated rows would erase the within-unit
    // dependence, so the null is descriptive and cannot decide (review P1).
    let null = metric(&first, "clustering.gaussian_null_model");
    let test = &null.value.as_ref().unwrap()["fitted_null_tail"];
    assert_eq!(test["decisional"], false);
    assert_eq!(test["decisional_reason"], "MULTI_ROW_RESAMPLING_UNITS");
    let assessment = metric(&first, "clustering.partition_assessment")
        .value
        .as_ref()
        .unwrap();
    assert_eq!(assessment["assessment"], "uncertain_partition");
    assert_eq!(
        assessment["criteria"]["fitted_null_tail_fraction"]["passed"],
        serde_json::Value::Null
    );
    // The plans are drawn once and reused by both variants and the null.
    let seeds = mock.permutation_seeds.borrow().clone();
    assert_eq!(seeds.len(), 1);
    // splitmix64_finalizer(7 XOR fnv1a64(domain)), recomputed independently.
    let domain = "nirs4all-preflight\0methods\0clustering.v3\0subsample_plans\0x";
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in domain.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mut z = 7 ^ hash;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    assert_eq!(seeds[0], z ^ (z >> 31));
    assert_eq!(a.parameters["seed"], (z ^ (z >> 31)).to_string());
    x.samples[0].independence_group = None;
    let missing = analyze(&x, &mock);
    let metric = metric(&missing, "clustering.subsample_stability");
    assert!(matches!(metric.status, Availability::NotIdentifiable));
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("MISSING_INDEPENDENCE_GROUP")
    );
}

fn reference_target(groups: impl Fn(usize) -> Option<String>) -> Target {
    Target {
        target_id: "composite".into(),
        kind: TargetKind::Continuous,
        unit: None,
        values: (0..40)
            .map(|i| TargetValue {
                sample_id: format!("s{i:03}"),
                value: Some(1.0),
                category: None,
                status: ReferenceStatus::Composite,
                reference_id: None,
                reference_group_id: groups(i),
            })
            .collect(),
    }
}

/// Review 2026-10-13 P0: `reference_group` fell back to one unit per row, so 40
/// samples sharing one composite reference group were resampled as 40
/// independent units.
#[test]
fn reference_groups_define_units_from_identities() {
    let mock = mock();
    let mut x = input(40);
    x.options.independence_unit = IndependenceUnit::ReferenceGroup;
    x.targets = vec![reference_target(|_| Some("shared".into()))];
    let report = analyze(&x, &mock);
    let stability = metric(&report, "clustering.subsample_stability");
    assert!(matches!(stability.status, Availability::InsufficientData));
    assert_eq!(
        stability.reason_code.as_deref(),
        Some("FEWER_THAN_FIVE_RESAMPLING_UNITS")
    );
    x.targets = vec![reference_target(|i| Some(format!("r{}", i / 4)))];
    let report = analyze(&x, &mock);
    let stability = metric(&report, "clustering.subsample_stability");
    assert!(matches!(stability.status, Availability::Computed));
    assert_eq!(stability.denominators["n_resampling_units"], 10);
    assert_eq!(stability.parameters["resampling_unit"], "reference_group");
    x.targets = vec![reference_target(|i| (i != 3).then(|| format!("r{i}")))];
    let missing = metric(&analyze(&x, &mock), "clustering.subsample_stability").clone();
    assert!(matches!(missing.status, Availability::NotIdentifiable));
    assert_eq!(
        missing.reason_code.as_deref(),
        Some("MISSING_REFERENCE_GROUP")
    );
    let mut other = reference_target(|i| Some(format!("r{i}")));
    other.target_id = "other".into();
    other.values[5].reference_group_id = Some("r6".into());
    x.targets = vec![reference_target(|i| Some(format!("r{i}"))), other];
    let ambiguous = metric(&analyze(&x, &mock), "clustering.subsample_stability").clone();
    assert!(matches!(ambiguous.status, Availability::NotIdentifiable));
    assert_eq!(
        ambiguous.reason_code.as_deref(),
        Some("AMBIGUOUS_REFERENCE_GROUP")
    );
}

#[test]
fn undeclared_independence_is_descriptive_only() {
    let mock = mock();
    let report = analyze(&input(40), &mock);
    let stability = metric(&report, "clustering.subsample_stability");
    assert!(matches!(stability.status, Availability::Computed));
    assert_eq!(
        stability.parameters["resampling_unit"],
        "eligible_sample_undeclared_independence"
    );
    assert_eq!(stability.parameters["independent_unit_resampling"], false);
    assert!(!stability.denominators.contains_key("n_independent_units"));
    let criteria = &metric(&report, "clustering.partition_assessment")
        .value
        .as_ref()
        .unwrap()["criteria"];
    assert_eq!(criteria["independent_units_declared"]["passed"], false);
}

#[test]
fn clustering_capability_follows_methods_provider() {
    let unavailable = capabilities(&UnavailableMethodsProvider);
    let clustering = unavailable
        .iter()
        .find(|c| c.capability_id == "clustering")
        .unwrap();
    assert!(!clustering.available);
    assert_eq!(
        clustering.reason.as_deref(),
        Some("HDBSCAN_PROVIDER_NOT_CONFIGURED")
    );
    let report = analyze(&input(40), &UnavailableMethodsProvider);
    assert!(matches!(
        metric(&report, "clustering.partition").status,
        Availability::Unsupported
    ));
}

/// Rule 13: a Methods refusal outside the numerical domain becomes an
/// unsupported metric with reason NUMERICAL_DOMAIN_EXCEEDED and the domain.
#[test]
fn numerical_domain_refusal_is_reported() {
    let mut refusing = mock();
    refusing.outside_domain = true;
    let report = analyze(&input(40), &refusing);
    let partition = metric(&report, "clustering.partition");
    assert!(matches!(partition.status, Availability::Unsupported));
    assert_eq!(
        partition.reason_code.as_deref(),
        Some(NUMERICAL_DOMAIN_EXCEEDED)
    );
    assert_eq!(partition.parameters["numerical_domain"], NUMERICAL_DOMAIN);
    assert!(partition.value.is_none());
}
