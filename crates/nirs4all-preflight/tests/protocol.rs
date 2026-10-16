use nirs4all_preflight::*;
use std::cell::Cell;
use std::cell::RefCell;

struct Spy(Cell<usize>);
impl MethodsProvider for Spy {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, req: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.0.set(self.0.get() + 1);
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; req.n_components],
            scores: vec![vec![1.0; req.n_components]; req.matrix.len()],
            full_moments: [2.0, 2.0],
            resolution: 0.0,
            unresolved: vec![false; req.n_components],
            backend_version: "spy".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        panic!("no technical repeats expected")
    }
}

fn input() -> QualificationInput {
    let mut samples = Vec::new();
    let mut source = SpectralSource {
        source_id: "x".into(),
        observation_ids: vec![],
        sample_ids: vec![],
        x: vec![],
        valid_mask: None,
        axis: vec![1.0, 2.0],
        axis_unit: "nm".into(),
        signal_unit: "abs".into(),
        signal_type: "absorbance".into(),
        repetition_types: None,
    };
    for i in 0..4 {
        let id = format!("s{i}");
        samples.push(Sample {
            sample_id: id.clone(),
            physical_sample_id: Some(id.clone()),
            partition: Partition::Development,
            independence_group: None,
            instrument: None,
            campaign: None,
            individual_id: None,
            augmentation_parent_id: None,
        });
        source.observation_ids.push(format!("o{i}"));
        source.sample_ids.push(id);
        source.x.push(vec![Some(i as f64), Some((i * 2) as f64)]);
    }
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Unknown,
        sources: vec![source],
        samples,
        targets: vec![],
        options: Options::default(),
    }
}

#[test]
fn leakage_blocks_provider_calls() {
    let mut x = input();
    x.samples[3].partition = Partition::RetainedTest;
    x.samples[3].physical_sample_id = x.samples[0].physical_sample_id.clone();
    let spy = Spy(Cell::new(0));
    let report = analyze(&x, &spy);
    assert_eq!(report.status, "failed");
    assert_eq!(spy.0.get(), 0);
}

#[test]
fn provider_moments_produce_effective_dimension() {
    let spy = Spy(Cell::new(0));
    let report = analyze(&input(), &spy);
    assert_eq!(spy.0.get(), 1);
    assert_eq!(report.profile_status, "exploratory");
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.effective_dimension")
        .unwrap();
    assert!(matches!(metric.status, Availability::Computed));
    assert_eq!(metric.value.as_ref().unwrap().as_f64(), Some(2.0));
    let scores = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.pca_scores")
        .unwrap();
    assert_eq!(scores.value.as_ref().unwrap()["sample_ids"][0], "s0");
    assert_eq!(
        scores.value.as_ref().unwrap()["aggregation_keys"][0],
        "s0||"
    );
}

#[test]
fn retained_and_augmented_rows_are_excluded() {
    let mut x = input();
    x.samples[3].partition = Partition::RetainedTest;
    x.samples[2].augmentation_parent_id = Some("s1".into());
    let report = analyze(&x, &Spy(Cell::new(0)));
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "population.development_real_samples"
            && m.value.as_ref().unwrap().as_u64() == Some(2)));
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "structure.pca"
            && matches!(m.status, Availability::InsufficientData)));
}

#[test]
fn physical_sample_in_two_contexts_does_not_receive_two_pca_votes() {
    let mut x = input();
    x.samples[1].physical_sample_id = x.samples[0].physical_sample_id.clone();
    x.samples[0].instrument = Some("i1".into());
    x.samples[1].instrument = Some("i2".into());
    let report = analyze(&x, &Spy(Cell::new(0)));
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.eligible_samples")
        .unwrap();
    assert_eq!(metric.value.as_ref().and_then(|v| v.as_u64()), Some(2));
    assert_eq!(
        metric
            .denominators
            .get("n_excluded_multicontext_observations"),
        Some(&2)
    );
}

#[test]
fn cross_physical_exact_duplicates_are_suspicions_only() {
    let mut x = input();
    x.sources[0].x[1] = x.sources[0].x[0].clone();
    let report = analyze(&x, &UnavailableMethodsProvider);
    assert_eq!(report.status, "partial");
    assert!(report.metrics.iter().any(|m| m.metric_id
        == "integrity.cross_physical_exact_duplicate_pairs"
        && m.value.as_ref().and_then(|v| v.as_u64()) == Some(1)));
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "identity.possible_undocumented_repeats.v1"
            && f.confidence == "unknown"));
}

#[test]
fn exact_development_retained_duplicate_is_reported_without_test_fit() {
    let mut x = input();
    x.samples[3].partition = Partition::RetainedTest;
    x.sources[0].x[3] = x.sources[0].x[0].clone();
    let report = analyze(&x, &UnavailableMethodsProvider);
    assert_eq!(report.status, "partial");
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.cross_partition_exact_duplicate_pairs")
        .unwrap();
    assert_eq!(metric.value.as_ref().and_then(|v| v.as_u64()), Some(1));
    assert_eq!(
        metric
            .denominators
            .get("n_affected_development_observations"),
        Some(&1)
    );
    assert_eq!(
        metric
            .denominators
            .get("n_affected_retained_test_observations"),
        Some(&1)
    );
    assert_eq!(
        metric
            .parameters
            .get("test_access")
            .and_then(|v| v.as_str()),
        Some("X_only_integrity_no_fit_no_Y")
    );
    assert!(report.findings.iter().any(|f| f.rule_id
        == "identity.possible_cross_partition_duplicate.v1"
        && f.confidence == "unknown"));
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "population.development_real_samples"
            && m.value.as_ref().and_then(|v| v.as_u64()) == Some(3)));
}

#[test]
fn html_escapes_untrusted_content() {
    let mut report = analyze(&input(), &UnavailableMethodsProvider);
    report.findings.push(Finding {
        rule_id: "<script>".into(),
        severity: "info".into(),
        confidence: "unknown".into(),
        evidence: vec![],
        message: "<img onerror=alert(1)>".into(),
        action: "check".into(),
    });
    let html = report_html(&report);
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<img onerror"));
    assert!(html.contains("<caption>Scientific metrics and availability</caption>"));
    assert!(html.contains("<th scope=\"col\">Metric / protocol</th>"));
    assert!(html.contains("insufficient_data") || html.contains("unsupported"));
    assert!(html.contains("Protocol bundle:"));
    assert!(html.contains("confidence") || html.contains("unknown"));
}

#[test]
fn html_and_report_label_synthetic_origin() {
    let mut x = input();
    x.data_origin = DataOrigin::Synthetic;
    let report = analyze(&x, &UnavailableMethodsProvider);
    assert_eq!(report.data_origin, DataOrigin::Synthetic);
    assert!(report_html(&report).contains("Demonstration: synthetic data"));
}

#[test]
fn report_deserialization_defaults_legacy_data_origin() {
    let report = analyze(&input(), &UnavailableMethodsProvider);
    let mut json = serde_json::to_value(report).unwrap();
    json.as_object_mut().unwrap().remove("data_origin");
    let restored: QualificationReport = serde_json::from_value(json).unwrap();
    assert_eq!(restored.data_origin, DataOrigin::Unknown);
}

#[test]
fn target_exclusion_count_names_prediction_partition() {
    let mut x = input();
    x.samples[3].partition = Partition::Prediction;
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        unit: None,
        values: vec![TargetValue {
            sample_id: "s3".into(),
            value: Some(4.0),
            category: None,
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        }],
    });
    let report = analyze(&x, &UnavailableMethodsProvider);
    let m = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "target.exact_eligible_samples")
        .unwrap();
    assert_eq!(
        m.denominators
            .get("n_excluded_retained_prediction_or_augmented"),
        Some(&1)
    );
    assert!(!m
        .denominators
        .contains_key("n_excluded_retained_or_augmented"));
}

struct RepeatsSpy(RefCell<Vec<RepeatabilityRequest>>);
impl MethodsProvider for RepeatsSpy {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        panic!("two physical samples cannot run PCA")
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        self.0.borrow_mut().push(r.clone());
        Ok(RepeatabilityDiagnostics {
            pooled_sd: vec![Some(0.1), Some(0.2)],
            icc: vec![None, None],
            n_complete_groups: vec![2, 1],
            band_status: vec![2, 1],
            backend_version: "spy".into(),
        })
    }
}

#[test]
fn unequal_repeats_and_mask_are_preserved_without_claiming_icc() {
    let mut x = input();
    x.samples.truncate(2);
    let source = &mut x.sources[0];
    source.sample_ids = vec![
        "s0".into(),
        "s0".into(),
        "s0".into(),
        "s1".into(),
        "s1".into(),
    ];
    source.observation_ids = (0..5).map(|i| format!("o{i}")).collect();
    source.x = vec![
        vec![Some(1.0), Some(2.0)],
        vec![Some(1.1), None],
        vec![Some(1.2), Some(2.2)],
        vec![Some(3.0), Some(4.0)],
        vec![Some(3.1), Some(4.1)],
    ];
    source.repetition_types = Some(vec![RepetitionType::Rescan; 5]);
    let spy = RepeatsSpy(RefCell::new(Vec::new()));
    let report = analyze(&x, &spy);
    let requests = spy.0.borrow();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].group_ids, vec![0, 0, 0, 1, 1]);
    assert!(!requests[0].valid_mask[1][1]);
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "measurement.icc_1_1"
            && matches!(m.status, Availability::Unsupported)
            && m.value.is_none()));
}

struct LocalSpy;
impl MethodsProvider for LocalSpy {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; r.n_components],
            scores: (0..r.matrix.len())
                .map(|i| vec![i as f64; r.n_components])
                .collect(),
            full_moments: [2.0, 2.0],
            resolution: 0.0,
            unresolved: vec![false; r.n_components],
            backend_version: "spy".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        panic!("no repeats")
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        Ok(SummaryDiagnostics {
            count: r.values.len(),
            min: 0.0,
            max: 3.0,
            mean: 1.5,
            sample_sd: Some(1.0),
            q25: 0.75,
            median: 1.5,
            q75: 2.25,
            backend_version: "spy".into(),
        })
    }
    fn nearest_neighbors(
        &self,
        r: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        let n = r.query.len();
        let indices: Vec<Vec<i64>> = (0..n)
            .map(|i| (0..n).filter(|&j| j != i).map(|j| j as i64).collect())
            .collect();
        Ok(NearestNeighborsDiagnostics {
            distances: indices
                .iter()
                .map(|row| vec![Some(1.0); row.len()])
                .collect(),
            indices,
            backend_version: "spy".into(),
        })
    }
    fn local_contrast(
        &self,
        r: &LocalContrastRequest,
    ) -> Result<LocalContrastDiagnostics, ProviderError> {
        assert_eq!(r.targets.len(), r.neighbor_indices.len());
        Ok(LocalContrastDiagnostics {
            contrast: Some(0.25),
            fraction_rows_with_neighbors: 1.0,
            observed_same_class_fraction: r.categorical.then_some(0.6),
            expected_same_class_fraction: r.categorical.then_some(0.5),
            backend_version: "spy".into(),
        })
    }
}

#[test]
fn unknown_independence_allows_descriptive_local_contrast_only() {
    let mut x = input();
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        unit: None,
        values: (0..4)
            .map(|i| TargetValue {
                sample_id: format!("s{i}"),
                value: Some(i as f64),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: None,
            })
            .collect(),
    });
    let report = analyze(&x, &LocalSpy);
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "local.global_contrast")
        .unwrap();
    assert!(matches!(metric.status, Availability::Computed));
    assert_eq!(
        metric
            .parameters
            .get("independence_assumption")
            .and_then(|v| v.as_str()),
        Some("physical_sample_or_sample_id_descriptive_only")
    );
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "target.local_contradiction_test"
            && matches!(m.status, Availability::NotIdentifiable)));
}

struct GroupCapture(RefCell<Vec<i64>>);
impl MethodsProvider for GroupCapture {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        LocalSpy.pca(r)
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        panic!("no repeats")
    }
    fn nearest_neighbors(
        &self,
        r: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        *self.0.borrow_mut() = r.query_group_ids.clone();
        Err(ProviderError("captured".into()))
    }
}

#[test]
fn shared_reference_group_is_excluded_from_local_neighbors() {
    let mut x = input();
    x.options.independence_unit = IndependenceUnit::Sample;
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        unit: None,
        values: (0..4)
            .map(|i| TargetValue {
                sample_id: format!("s{i}"),
                value: Some(i as f64),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: (i < 2).then(|| "shared".into()),
            })
            .collect(),
    });
    let spy = GroupCapture(RefCell::new(Vec::new()));
    let _ = analyze(&x, &spy);
    let groups = spy.0.borrow();
    assert_eq!(groups.len(), 4);
    assert_eq!(groups[0], groups[1]);
    assert_ne!(groups[0], groups[2]);
}

#[test]
fn categorical_local_report_carries_observed_and_expected_rates() {
    let mut x = input();
    x.options.independence_unit = IndependenceUnit::Sample;
    x.targets.push(Target {
        target_id: "class".into(),
        kind: TargetKind::Categorical,
        unit: None,
        values: (0..4)
            .map(|i| TargetValue {
                sample_id: format!("s{i}"),
                value: None,
                category: Some(if i < 2 { "a" } else { "b" }.into()),
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: None,
            })
            .collect(),
    });
    let report = analyze(&x, &LocalSpy);
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "local.observed_same_class_fraction"
            && m.value.as_ref().and_then(|v| v.as_f64()) == Some(0.6)));
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "local.expected_same_class_fraction"
            && m.value.as_ref().and_then(|v| v.as_f64()) == Some(0.5)));
}

struct ZeroPca;
impl MethodsProvider for ZeroPca {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Ok(PcaDiagnostics {
            eigenvalues: vec![0.0; r.n_components],
            scores: vec![vec![0.0; r.n_components]; r.matrix.len()],
            full_moments: [0.0, 0.0],
            resolution: 0.0,
            unresolved: vec![true; r.n_components],
            backend_version: "spy".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        panic!("no repeats")
    }
}

#[test]
fn zero_rank_does_not_claim_pca_geometry_or_local_contrast() {
    let mut x = input();
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        unit: None,
        values: (0..4)
            .map(|i| TargetValue {
                sample_id: format!("s{i}"),
                value: Some(i as f64),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: None,
            })
            .collect(),
    });
    let report = analyze(&x, &ZeroPca);
    for id in [
        "structure.pca_scores",
        "structure.effective_dimension",
        "local.global_contrast",
    ] {
        assert!(report.metrics.iter().any(|m| m.metric_id == id
            && matches!(m.status, Availability::Undefined)
            && m.value.is_none()));
    }
}

/// Methods' rule-14 contract: the last component is below the published
/// resolution (unresolved, variance and scores 0); the first one is resolved.
struct PartlyResolvedPca(usize);
impl MethodsProvider for PartlyResolvedPca {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        let k = r.n_components;
        let resolved = self.0.min(k);
        Ok(PcaDiagnostics {
            eigenvalues: (0..k)
                .map(|a| if a < resolved { 1.0 } else { 0.0 })
                .collect(),
            scores: (0..r.matrix.len())
                .map(|i| {
                    (0..k)
                        .map(|a| if a < resolved { i as f64 } else { 0.0 })
                        .collect()
                })
                .collect(),
            full_moments: [2.0, 2.0],
            resolution: 1e-12,
            unresolved: (0..k).map(|a| a >= resolved).collect(),
            backend_version: "spy".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError("NOT_UNDER_TEST".into()))
    }
}

#[test]
fn unresolved_components_are_labelled_and_not_counted_as_rank() {
    let report = analyze(&input(), &PartlyResolvedPca(1));
    let eigen = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.pca_eigenvalues")
        .expect("eigenvalue metric");
    let k = eigen.parameters["n_components"].as_u64().unwrap() as usize;
    assert!(k >= 2);
    assert_eq!(eigen.parameters["eigenvalue_resolution"], 1e-12);
    assert_eq!(
        eigen.parameters["unresolved_components"],
        serde_json::json!((1..k).collect::<Vec<_>>())
    );
    let ratio = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.explained_variance_retained")
        .expect("retained ratio");
    assert_eq!(ratio.denominators["n_resolved_components"], 1);
    // Nothing resolved: no PCA geometry is claimed (zero numerical rank).
    let none = analyze(&input(), &PartlyResolvedPca(0));
    assert!(none
        .metrics
        .iter()
        .any(|m| m.metric_id == "structure.pca_scores"
            && matches!(m.status, Availability::Undefined)
            && m.reason_code.as_deref() == Some("ZERO_NUMERICAL_RANK")));
}

#[derive(Default)]
struct Recorder {
    pairs: RefCell<Vec<TolerancePairsRequest>>,
    noise: Cell<usize>,
}
impl MethodsProvider for Recorder {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Err(ProviderError("NOT_UNDER_TEST".into()))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError("NOT_UNDER_TEST".into()))
    }
    fn noise_proxy(&self, _: &NoiseProxyRequest) -> Result<NoiseProxyDiagnostics, ProviderError> {
        self.noise.set(self.noise.get() + 1);
        Err(ProviderError("NOT_UNDER_TEST".into()))
    }
    fn tolerance_pairs(
        &self,
        r: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        self.pairs.borrow_mut().push(r.clone());
        let n_reference = r.reference.as_ref().map_or(0, Vec::len);
        Ok(TolerancePairsDiagnostics {
            pairs: vec![],
            distances: vec![],
            query_flags: vec![false; r.query.len()],
            reference_flags: vec![false; n_reference],
            total_pairs: 0,
            candidate_pairs: 1,
            backend_version: "recorder".into(),
        })
    }
}

fn metric<'a>(report: &'a QualificationReport, id: &str) -> &'a Metric {
    report.metrics.iter().find(|m| m.metric_id == id).unwrap()
}

#[test]
fn quasi_duplicates_require_a_declared_tolerance() {
    let mut x = input();
    x.options.snv_sensitivity = false;
    let report = analyze(&x, &Recorder::default());
    for id in [
        "integrity.quasi_duplicate_pairs",
        "integrity.cross_partition_quasi_duplicate_pairs",
    ] {
        let m = metric(&report, id);
        assert!(matches!(m.status, Availability::NotApplicable) && m.value.is_none());
        assert_eq!(
            m.reason_code.as_deref(),
            Some("QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED")
        );
    }
    let capability = |id: &str| {
        report
            .capabilities
            .iter()
            .find(|c| c.capability_id == id)
            .unwrap()
    };
    assert_eq!(
        capability("quasi_duplicates").reason.as_deref(),
        Some("QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED")
    );
    assert_eq!(
        capability("snv_sensitivity").reason.as_deref(),
        Some("SNV_SENSITIVITY_DISABLED")
    );
    assert!(!report
        .capabilities
        .iter()
        .any(|c| c.reason.as_deref() == Some("PROTOCOL_NOT_IMPLEMENTED")
            && ["noise_proxy", "snv_sensitivity", "quasi_duplicates"]
                .contains(&c.capability_id.as_str())));
    let mut bad = input();
    bad.options.quasi_duplicates = Some(QuasiDuplicateOptions {
        tolerance: 0.0,
        view: QuasiDuplicateView::Native,
        context: ComparisonContext::Source,
    });
    bad.options.noise_proxy.window_bands = 4;
    let codes: Vec<_> = validate_input(&bad)
        .issues
        .into_iter()
        .map(|i| i.code)
        .collect();
    assert!(codes.contains(&"INVALID_QUASI_DUPLICATE_TOLERANCE".to_string()));
    assert!(codes.contains(&"INVALID_NOISE_PROXY_PARAMETERS".to_string()));
}

#[test]
fn quasi_duplicate_requests_respect_physical_identity_context_and_partitions() {
    let mut x = input();
    // s0 and s1 share one physical sample; s2 is on another instrument; s3 is retained test.
    x.samples[1].physical_sample_id = Some("s0".into());
    x.samples[2].instrument = Some("other".into());
    x.samples[3].partition = Partition::RetainedTest;
    x.options.quasi_duplicates = Some(QuasiDuplicateOptions {
        tolerance: 0.5,
        view: QuasiDuplicateView::Native,
        context: ComparisonContext::InstrumentCampaign,
    });
    let recorder = Recorder::default();
    let report = analyze(&x, &recorder);
    let requests = recorder.pairs.borrow();
    // Context (no instrument): s0,s1 within, then s0,s1 against retained s3.
    // Context "other": a single development row and no test row => no call.
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].query.len(), 2);
    assert!(requests[0].reference.is_none());
    assert_eq!(
        requests[0].query_group_ids[0],
        requests[0].query_group_ids[1]
    );
    let cross = &requests[1];
    assert_eq!(cross.reference.as_ref().unwrap(), &vec![vec![3.0, 6.0]]);
    assert_ne!(cross.query_group_ids[0], cross.reference_group_ids[0]);
    assert!(requests.iter().all(|r| r.tolerance == 0.5));
    let cross_metric = metric(&report, "integrity.cross_partition_quasi_duplicate_pairs");
    assert_eq!(
        cross_metric.population_id,
        "development_real_vs_retained_test_real"
    );
    assert_eq!(
        cross_metric.parameters["test_access"],
        "X_only_integrity_no_fit_no_Y"
    );
    assert_eq!(
        metric(&report, "integrity.quasi_duplicate_pairs")
            .value
            .as_ref()
            .unwrap()["suspect_pairs"],
        0
    );
}

#[test]
fn noise_proxy_declares_axis_and_window_limits_before_calling_methods() {
    let mut x = input();
    x.options.noise_proxy.window_bands = 3;
    x.options.noise_proxy.polyorder = 1;
    x.sources[0].axis = vec![1.0, 2.0, 4.0];
    for row in &mut x.sources[0].x {
        row.push(Some(0.0));
    }
    let recorder = Recorder::default();
    let report = analyze(&x, &recorder);
    assert_eq!(
        metric(&report, "measurement.noise_proxy")
            .reason_code
            .as_deref(),
        Some("NON_UNIFORM_AXIS")
    );
    let report = analyze(&input(), &recorder);
    assert_eq!(
        metric(&report, "measurement.noise_proxy")
            .reason_code
            .as_deref(),
        Some("FEWER_BANDS_THAN_WINDOW")
    );
    assert_eq!(recorder.noise.get(), 0);
}
