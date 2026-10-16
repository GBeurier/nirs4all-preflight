use nirs4all_preflight::*;
use std::cell::Cell;

/// Deterministic stand-in: PCA keeps the leading columns, HDBSCAN splits on the
/// sign of the first score, ARI is 1 for identical label sets.
struct Mock {
    hdbscan_calls: Cell<usize>,
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
            resolution: 0.0,
            unresolved: vec![false; r.n_components],
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
    let mock = Mock {
        hdbscan_calls: Cell::new(0),
    };
    let report = analyze(&input(9), &mock);
    let partition = metric(&report, "clustering.partition");
    assert!(matches!(partition.status, Availability::InsufficientData));
    assert_eq!(
        partition.reason_code.as_deref(),
        Some("FEWER_THAN_TWO_MIN_CLUSTER_SIZES")
    );
    assert_eq!(mock.hdbscan_calls.get(), 0);
}

#[test]
fn candidate_partition_is_uncertain_and_subsampled_fifty_times() {
    let mock = Mock {
        hdbscan_calls: Cell::new(0),
    };
    let report = analyze(&input(40), &mock);
    assert_eq!(mock.hdbscan_calls.get(), 1 + 2 * 50);
    let partition = metric(&report, "clustering.partition");
    assert!(matches!(partition.status, Availability::Computed));
    assert_eq!(partition.view_id, "canonical:centered");
    let value = partition.value.as_ref().unwrap();
    assert_eq!(value["sample_ids"][0], "s000");
    assert_eq!(value["labels"].as_array().unwrap().len(), 40);
    assert_eq!(partition.parameters["min_cluster_size"], 5);
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
    let value = stability.value.as_ref().unwrap();
    assert_eq!(value["ari_assigned_in_both"]["min"], 1.0);
    assert_eq!(value["compared_fraction"]["max"], 0.8);
    let constant = metric(
        &report,
        "clustering.subsample_stability_constant_parameters",
    );
    assert_eq!(constant.parameters["min_cluster_size"], 5);
    for id in [
        "clustering.cluster_appearance_frequency",
        "clustering.gaussian_null_model",
    ] {
        assert!(matches!(
            metric(&report, id).status,
            Availability::Unsupported
        ));
    }
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "structure.clustering.uncertain_partition.v1")
        .unwrap();
    assert_eq!(finding.confidence, "unknown");
    assert!(finding.message.contains("candidate groups"));
    assert!(finding.message.contains("uncertain"));
}

#[test]
fn subsampling_is_seeded_and_respects_independence_groups() {
    let mock = Mock {
        hdbscan_calls: Cell::new(0),
    };
    let mut x = input(40);
    x.options.independence_unit = IndependenceUnit::Group;
    x.options.seed = 7;
    let first = analyze(&x, &mock);
    let again = analyze(&x, &mock);
    let a = metric(&first, "clustering.subsample_stability");
    let b = metric(&again, "clustering.subsample_stability");
    assert_eq!(a.value, b.value);
    assert_eq!(a.denominators["n_independent_units"], 20);
    assert_eq!(a.denominators["n_units_per_subsample"], 16);
    assert_eq!(a.value.as_ref().unwrap()["intersection_size"]["max"], 32.0);
    assert!(!a.parameters.contains_key("independence_assumption"));
    x.samples[0].independence_group = None;
    let missing = analyze(&x, &mock);
    let metric = metric(&missing, "clustering.subsample_stability");
    assert!(matches!(metric.status, Availability::NotIdentifiable));
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("MISSING_INDEPENDENCE_GROUP")
    );
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
