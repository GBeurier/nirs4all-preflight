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
        metadata: MetadataTable::default(),
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
        Err(ProviderError::unsupported("captured"))
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
        Err(ProviderError::unsupported("NOT_UNDER_TEST"))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("NOT_UNDER_TEST"))
    }
    fn noise_proxy(&self, _: &NoiseProxyRequest) -> Result<NoiseProxyDiagnostics, ProviderError> {
        self.noise.set(self.noise.get() + 1);
        Err(ProviderError::unsupported("NOT_UNDER_TEST"))
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

/// Test-only brute-force reference for pairs within an RMS tolerance:
/// every pair under different groups is a candidate, listed in ascending order.
struct PairOracle {
    calls: Cell<usize>,
    inflate: Option<usize>,
}
impl MethodsProvider for PairOracle {
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
    fn tolerance_pairs(
        &self,
        r: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        self.calls.set(self.calls.get() + 1);
        let reference = r.reference.as_ref().unwrap_or(&r.query);
        let groups = if r.reference.is_some() {
            &r.reference_group_ids
        } else {
            &r.query_group_ids
        };
        let mut all = Vec::new();
        let mut candidates = 0;
        for (i, a) in r.query.iter().enumerate() {
            let start = if r.reference.is_some() { 0 } else { i + 1 };
            for (j, b) in reference.iter().enumerate().skip(start) {
                if r.query_group_ids[i] == groups[j] {
                    continue;
                }
                candidates += 1;
                let rms = (a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>()
                    / a.len() as f64)
                    .sqrt();
                if rms <= r.tolerance {
                    all.push(([i, j], rms));
                }
            }
        }
        let mut query_flags = vec![false; r.query.len()];
        let mut reference_flags = vec![false; r.reference.as_ref().map_or(0, Vec::len)];
        for ([i, j], _) in &all {
            query_flags[*i] = true;
            if r.reference.is_some() {
                reference_flags[*j] = true;
            } else {
                query_flags[*j] = true;
            }
        }
        let total = self.inflate.unwrap_or(all.len());
        let listed = total.min(r.max_pairs);
        let filler = all.first().copied().unwrap_or(([0, 1], 0.0));
        let listed: Vec<_> = (0..listed)
            .map(|k| all.get(k).copied().unwrap_or(filler))
            .collect();
        Ok(TolerancePairsDiagnostics {
            pairs: listed.iter().map(|(p, _)| *p).collect(),
            distances: listed.iter().map(|(_, d)| *d).collect(),
            query_flags,
            reference_flags,
            total_pairs: total,
            candidate_pairs: self.inflate.unwrap_or(candidates),
            backend_version: "oracle".into(),
        })
    }
}

fn oracle() -> PairOracle {
    PairOracle {
        calls: Cell::new(0),
        inflate: None,
    }
}

fn duplicate_fixture() -> QualificationInput {
    serde_json::from_str(include_str!("../../../examples/quasi_duplicates.json")).unwrap()
}

fn target_metric<'a>(report: &'a QualificationReport, id: &str, target: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id && m.target_id.as_deref() == Some(target))
        .unwrap_or_else(|| panic!("missing {id} for {target}"))
}

fn close(a: &serde_json::Value, b: f64) -> bool {
    (a.as_f64().unwrap() - b).abs() < 1e-12
}

#[test]
fn spectral_duplicates_with_incompatible_references_ask_to_verify_pairing() {
    let x = duplicate_fixture();
    assert!(validate_input(&x).valid);
    let report = analyze(&x, &oracle());
    // Instrument context: A = {s0, s1, s2} across campaigns, B = {s3, s4, s5, s6};
    // s3 and s5 share physical p3. Hand count: 3 + 2 suspect pairs of 3 + 5 candidates.
    let within = metric(&report, "integrity.quasi_duplicate_pairs");
    let v = within.value.as_ref().unwrap();
    assert_eq!(
        (v["suspect_pairs"].as_u64(), v["candidate_pairs"].as_u64()),
        (Some(5), Some(8))
    );
    assert!(close(&v["affected_development_fraction"], 6. / 7.));
    assert_eq!(within.parameters["context"], "same_instrument_any_campaign");
    // Concordant indices of the listed pair (s0, s1) and (s0, s2).
    let first = &v["listed_pairs"][0];
    assert_eq!(
        (
            first["observation_a"].as_str(),
            first["observation_b"].as_str()
        ),
        (Some("o-s0"), Some("o-s1"))
    );
    let c = &first["concordant_indices"];
    assert_eq!(
        (c["instrument"].as_bool(), c["campaign"].as_bool()),
        (Some(true), Some(false))
    );
    assert!(c["individual_id"].is_null() && c["independence_group"].is_null());
    assert_eq!(c["references"]["moisture"]["identical_exact_value"], false);
    assert_eq!(c["references"]["moisture"]["shared_reference_id"], false);
    assert_eq!(c["references"]["grade"]["identical_exact_value"], true);
    assert!(c["references"]["grade"]["shared_reference_id"].is_null());
    let second = &v["listed_pairs"][1]["concordant_indices"];
    assert_eq!(second["campaign"], true);
    assert_eq!(
        second["references"]["moisture"]["shared_reference_id"],
        true
    );
    // Development x retained test: X only, no reference comparison.
    let cross = metric(&report, "integrity.cross_partition_quasi_duplicate_pairs");
    let v = cross.value.as_ref().unwrap();
    assert_eq!(v["suspect_pairs"], 3);
    assert!(v["listed_pairs"][0]["concordant_indices"]
        .get("references")
        .is_none());
    assert_eq!(
        cross.parameters["reference_comparison"],
        "not_performed_retained_test_Y_never_read"
    );

    // moisture, absolute 0.5: sample pairs (s0,s1) |10-12| = 2 and (s1,s2) 1.9
    // conflict; (s0,s2) 0.1 agrees; s3 is censored and s5 has no reference.
    let quasi = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture");
    let v = quasi.value.as_ref().unwrap();
    assert_eq!(
        [
            &v["suspect_sample_pairs"],
            &v["compared_sample_pairs"],
            &v["incompatible_sample_pairs"],
            &v["affected_samples"],
            &v["affected_development_observations"]
        ]
        .map(|x| x.as_u64().unwrap()),
        [5, 3, 2, 3, 3]
    );
    assert!(close(&v["incompatible_pair_rate"], 2. / 3.));
    assert!(close(&v["affected_sample_fraction"], 3. / 5.));
    assert!(close(&v["affected_development_fraction"], 3. / 7.));
    assert_eq!(
        quasi.denominators["n_sample_pairs_without_two_exact_references"],
        2
    );
    assert_eq!(quasi.denominators["n_suspect_observation_pairs"], 5);
    let listed = &v["listed_pairs"][0];
    assert_eq!(
        (listed["sample_a"].as_str(), listed["sample_b"].as_str()),
        (Some("s0"), Some("s1"))
    );
    assert!(close(&listed["absolute_difference"], 2.0));
    assert!(close(&listed["min_rms_difference"], 0.0));
    assert_eq!(
        quasi.parameters["contradiction_rule"],
        "absolute_difference_greater_than_tolerance"
    );
    assert_eq!(quasi.parameters["contradiction_tolerance"], 0.5);
    assert_eq!(quasi.unit.as_deref(), Some("%"));
    assert_eq!(quasi.parameters["spectral_tolerance"], 0.1);
    assert!(!quasi.parameters.contains_key("tolerance"));
    // grade, different class: (s0,s2) and (s1,s2) differ; (s0,s1) agree.
    let v = target_metric(&report, "reference.quasi_duplicate_conflicts", "grade")
        .value
        .clone()
        .unwrap();
    assert_eq!(
        (
            v["compared_sample_pairs"].as_u64(),
            v["incompatible_sample_pairs"].as_u64()
        ),
        (Some(3), Some(2))
    );
    assert!(close(&v["affected_sample_fraction"], 3. / 4.));
    // Exact pass, whole source: only (s0, s1); s3/s5 share a physical sample.
    let exact = target_metric(&report, "reference.exact_duplicate_conflicts", "moisture");
    let v = exact.value.as_ref().unwrap();
    assert_eq!(
        (
            v["suspect_sample_pairs"].as_u64(),
            v["incompatible_sample_pairs"].as_u64()
        ),
        (Some(1), Some(1))
    );
    assert!(close(&v["affected_sample_fraction"], 2. / 5.));
    assert!(v["listed_pairs"][0]["min_rms_difference"].is_null());
    let v = target_metric(&report, "reference.exact_duplicate_conflicts", "grade")
        .value
        .clone()
        .unwrap();
    assert_eq!(v["incompatible_sample_pairs"], 0);
    assert!(close(&v["incompatible_pair_rate"], 0.0));
    for id in [
        "reference.exact_duplicate_conflicts",
        "reference.quasi_duplicate_conflicts",
    ] {
        let m = target_metric(&report, id, "protein");
        assert!(matches!(m.status, Availability::NotApplicable) && m.value.is_none());
        assert_eq!(
            m.reason_code.as_deref(),
            Some("REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED")
        );
    }
    let findings: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.rule_id == "reference.verify_reference_or_pairing.v1")
        .collect();
    assert_eq!(findings.len(), 3);
    assert!(findings
        .iter()
        .all(|f| f.confidence == "unknown" && f.severity == "warning"));
    // Retained-test references are never read into the report.
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains("987.654") && !json.contains("zz-test-only"));
}

#[test]
fn relative_contradiction_tolerance_uses_the_larger_absolute_reference() {
    let mut x = duplicate_fixture();
    // bound = 0.16 * max(|a|, |b|): (s0,s1) 2 > 1.92 conflicts, (s1,s2) 1.9 <= 1.92 does not.
    // A mean or min denominator would also flag (s1,s2).
    x.options.reference_contradiction_tolerances.insert(
        "moisture".into(),
        ReferenceContradictionTolerance::Relative { value: 0.16 },
    );
    let report = analyze(&x, &oracle());
    let m = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture");
    assert_eq!(m.value.as_ref().unwrap()["incompatible_sample_pairs"], 1);
    assert_eq!(
        m.parameters["contradiction_tolerance_unit"],
        "fraction_of_max_absolute_reference"
    );
}

#[test]
fn instrument_campaign_context_separates_campaigns_and_pair_budget_is_explicit() {
    let mut x = duplicate_fixture();
    x.options.quasi_duplicates.as_mut().unwrap().context = ComparisonContext::InstrumentCampaign;
    let report = analyze(&x, &oracle());
    // (s0,s2) in A/c1 and (s3,s4), (s4,s5) in B/c1; s1 alone in A/c2.
    let v = metric(&report, "integrity.quasi_duplicate_pairs")
        .value
        .clone()
        .unwrap();
    assert_eq!(
        (v["suspect_pairs"].as_u64(), v["candidate_pairs"].as_u64()),
        (Some(3), Some(6))
    );
    let v = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture")
        .value
        .clone()
        .unwrap();
    assert_eq!(
        (
            v["compared_sample_pairs"].as_u64(),
            v["incompatible_sample_pairs"].as_u64()
        ),
        (Some(1), Some(0))
    );

    // More suspect pairs than the retained-pair budget: X counts stay, Y comparison is unsupported.
    let inflated = PairOracle {
        calls: Cell::new(0),
        inflate: Some(2_000_000),
    };
    let report = analyze(&duplicate_fixture(), &inflated);
    let m = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture");
    assert!(matches!(m.status, Availability::Unsupported) && m.value.is_none());
    assert_eq!(
        m.reason_code.as_deref(),
        Some("SUSPECT_PAIR_BUDGET_EXCEEDED")
    );
    assert_eq!(
        metric(&report, "integrity.quasi_duplicate_pairs")
            .value
            .as_ref()
            .unwrap()["suspect_pairs"],
        4_000_000
    );

    // Without quasi options, quasi conflicts inherit the undeclared spectral tolerance.
    let mut x = duplicate_fixture();
    x.options.quasi_duplicates = None;
    let report = analyze(&x, &oracle());
    let m = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture");
    assert_eq!(
        m.reason_code.as_deref(),
        Some("QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED")
    );
    assert_eq!(
        target_metric(&report, "reference.exact_duplicate_conflicts", "moisture")
            .value
            .as_ref()
            .unwrap()["incompatible_sample_pairs"],
        1
    );
}

#[test]
fn listing_beyond_the_limit_refetches_all_development_pairs_once() {
    let mut x = duplicate_fixture();
    // 1,200 identical development spectra under distinct physical samples in one context.
    let source = &mut x.sources[0];
    for i in 0..1200 {
        let id = format!("bulk{i}");
        source.observation_ids.push(format!("o-{id}"));
        source.sample_ids.push(id.clone());
        source.x.push(vec![Some(9.0), Some(9.0)]);
        x.samples.push(Sample {
            sample_id: id.clone(),
            physical_sample_id: None,
            partition: Partition::Development,
            independence_group: None,
            instrument: Some("C".into()),
            campaign: None,
            individual_id: None,
            augmentation_parent_id: None,
        });
        x.targets[0].values.push(TargetValue {
            sample_id: id,
            value: Some(if i == 0 { 50.0 } else { 40.0 }),
            category: None,
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        });
    }
    let provider = oracle();
    let report = analyze(&x, &provider);
    let v = metric(&report, "integrity.quasi_duplicate_pairs")
        .value
        .clone()
        .unwrap();
    // One call per context and partition, plus one full refetch for context C
    // whose 719,400 pairs exceed the listing room.
    assert_eq!(provider.calls.get(), 5);
    let bulk_pairs = 1200 * 1199 / 2;
    assert_eq!(v["suspect_pairs"], 5 + bulk_pairs);
    assert_eq!(v["listed_pairs"].as_array().unwrap().len(), 1000);
    assert_eq!(v["listing_truncated"], true);
    // bulk0 conflicts with each of the 1,199 others; listing capped at 1,000.
    for id in [
        "reference.quasi_duplicate_conflicts",
        "reference.exact_duplicate_conflicts",
    ] {
        let v = target_metric(&report, id, "moisture")
            .value
            .clone()
            .unwrap();
        let expected = if id.contains("quasi") {
            2 + 1199
        } else {
            1 + 1199
        };
        assert_eq!(v["incompatible_sample_pairs"], expected, "{id}");
        assert_eq!(v["listed_pairs"].as_array().unwrap().len(), 1000);
        assert_eq!(v["listing_truncated"], true);
    }
}

#[test]
fn contradiction_tolerances_are_validated_against_declared_targets() {
    let mut x = duplicate_fixture();
    let tolerances = &mut x.options.reference_contradiction_tolerances;
    tolerances.insert(
        "unknown".into(),
        ReferenceContradictionTolerance::DifferentClass,
    );
    tolerances.insert(
        "grade".into(),
        ReferenceContradictionTolerance::Absolute { value: 1.0 },
    );
    tolerances.insert(
        "moisture".into(),
        ReferenceContradictionTolerance::DifferentClass,
    );
    tolerances.insert(
        "protein".into(),
        ReferenceContradictionTolerance::Relative { value: 0.0 },
    );
    let codes: Vec<_> = validate_input(&x)
        .issues
        .into_iter()
        .map(|i| (i.code, i.blocking))
        .collect();
    for code in [
        "UNKNOWN_CONTRADICTION_TARGET",
        "CONTRADICTION_TOLERANCE_KIND_MISMATCH",
        "INVALID_CONTRADICTION_TOLERANCE",
    ] {
        assert!(codes.contains(&(code.to_string(), true)), "{code}");
    }
    assert_eq!(
        codes
            .iter()
            .filter(|(c, _)| c == "CONTRADICTION_TOLERANCE_KIND_MISMATCH")
            .count(),
        2
    );
    let parsed: Result<Options, _> = serde_json::from_str(
        r#"{"reference_contradiction_tolerances":{"y":{"kind":"absolute","value":1,"extra":2}}}"#,
    );
    assert!(parsed.is_err());
    let mut x = duplicate_fixture();
    x.options.reference_contradiction_tolerances.clear();
    let report = analyze(&x, &oracle());
    let capability = report
        .capabilities
        .iter()
        .find(|c| c.capability_id == "duplicate_reference_conflicts")
        .unwrap();
    assert!(!capability.available);
    assert_eq!(
        capability.reason.as_deref(),
        Some("REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED")
    );
}

#[test]
fn noise_proxy_validation_cannot_wrap_and_matches_the_methods_domain() {
    // Review b1 #4: polyorder + 2 overflowed (panic on 64-bit, wrap to valid on
    // 32-bit WASM). Review b1 #2: orders above 10 leave the verified SG domain.
    let invalid = |window: u64, polyorder: u64| {
        let mut x = input();
        x.options.noise_proxy = NoiseProxyOptions {
            window_bands: window,
            polyorder,
        };
        let issues = validate_input(&x).issues;
        issues
            .iter()
            .any(|i| i.code == "INVALID_NOISE_PROXY_PARAMETERS" && i.blocking)
    };
    for (w, o) in [
        (11, u64::MAX),
        (11, u64::MAX - 1),
        (11, 4_294_967_295),
        (11, 4_294_967_296),
        (u64::MAX, 2),
        (41, 38),
        (21, 11),
        (1003, 2),
        (11, 10),
        (2, 0),
        (12, 2),
    ] {
        assert!(invalid(w, o), "{w}/{o}");
    }
    for (w, o) in [(3, 0), (3, 1), (13, 10), (1001, 10), (11, 2)] {
        assert!(!invalid(w, o), "{w}/{o}");
    }
    // u64 fields parse identically on 32- and 64-bit hosts.
    let parsed: Options = serde_json::from_str(
        r#"{"noise_proxy":{"window_bands":11,"polyorder":18446744073709551615}}"#,
    )
    .unwrap();
    assert_eq!(parsed.noise_proxy.polyorder, u64::MAX);
}

/// SNV is the identity plus a marker offset so the fake PCA can tell the
/// canonical call from the SNV call and return a chosen SNV trace.
struct SnvTrace(f64);
impl MethodsProvider for SnvTrace {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, req: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        let snv = req.matrix.iter().flatten().any(|v| *v >= 1000.0);
        let trace = if snv { self.0 } else { 1.0 };
        Ok(PcaDiagnostics {
            eigenvalues: vec![trace / req.n_components as f64; req.n_components],
            scores: vec![vec![0.0; req.n_components]; req.matrix.len()],
            full_moments: [trace, trace * trace],
            backend_version: "fake".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError("NOT_UNDER_TEST".into()))
    }
    fn snv(&self, req: &SnvRequest) -> Result<SnvDiagnostics, ProviderError> {
        // Each sample of input() is its own group: output rows follow groups.
        let ids = req.group_ids.clone().unwrap();
        assert!(ids.iter().enumerate().all(|(i, g)| *g == i as i64));
        Ok(SnvDiagnostics {
            matrix: req
                .matrix
                .iter()
                .map(|r| r.iter().map(|v| v + 1000.0).collect())
                .collect(),
            error_bounds: vec![0.0, 1e-12, 3e-12, 2e-12],
            backend_version: "fake".into(),
        })
    }
}

#[test]
fn snv_ratios_require_numerically_resolved_residual_variance() {
    // Threshold 4 (max_i B_i + n u max|z|): fake bounds peak at 3e-12, four
    // aggregated samples, largest fake SNV entry 1006 (row [3, 6] + 1000).
    let threshold = 4.0 * (3e-12 + 4.0 * (f64::EPSILON / 2.0) * 1006.0);
    for (rms, resolved) in [(0.9 * threshold, false), (1.1 * threshold, true)] {
        let report = analyze(&input(), &SnvTrace(2.0 * rms * rms));
        let m = metric(&report, "structure.snv_sensitivity");
        assert_eq!(m.parameters["numerically_resolved"], resolved);
        assert!(
            (m.parameters["numerical_resolution_threshold"]
                .as_f64()
                .unwrap()
                / threshold
                - 1.0)
                .abs()
                <= 1e-12
        );
        assert_eq!(m.parameters["max_snv_entry_error_bound"], 3e-12);
        let d = metric(&report, "structure.snv_effective_dimension");
        if resolved {
            assert!(matches!(m.status, Availability::Computed));
            assert!(matches!(d.status, Availability::Computed));
        } else {
            for metric in [m, d] {
                assert!(matches!(metric.status, Availability::Undefined) && metric.value.is_none());
                assert_eq!(
                    metric.reason_code.as_deref(),
                    Some("SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED")
                );
            }
        }
    }
}

fn dev_sample(id: &str, physical: &str) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: Some(physical.into()),
        partition: Partition::Development,
        independence_group: None,
        instrument: Some("A".into()),
        campaign: None,
        individual_id: None,
        augmentation_parent_id: None,
    }
}

fn exact(sample: &str, value: f64, reference_id: Option<&str>) -> TargetValue {
    TargetValue {
        sample_id: sample.into(),
        value: Some(value),
        category: None,
        status: ReferenceStatus::Exact,
        reference_id: reference_id.map(str::to_owned),
        reference_group_id: None,
    }
}

#[test]
fn aliases_of_one_physical_sample_with_incompatible_references_are_flagged() {
    // Review b4 #1: two sample IDs of one physical object, identical spectra,
    // references 10 and 20, were hidden by the physical-identity exclusion.
    let mut x = duplicate_fixture();
    for (id, value) in [("s7", 20.0), ("s8", 10.2)] {
        x.samples.push(dev_sample(id, "p0"));
        x.sources[0].observation_ids.push(format!("o-{id}"));
        x.sources[0].sample_ids.push(id.into());
        x.sources[0].x.push(vec![Some(1.0), Some(1.0)]);
        x.targets[0].values.push(exact(id, value, None));
    }
    assert!(validate_input(&x).valid);
    let report = analyze(&x, &oracle());
    // p0 = {s0: 10, s7: 20, s8: 10.2}: (s0,s7) and (s7,s8) conflict, (s0,s8) agree.
    let m = target_metric(
        &report,
        "reference.within_physical_sample_conflicts",
        "moisture",
    );
    assert!(m.source_id.is_none());
    let v = m.value.as_ref().unwrap();
    assert_eq!(
        [
            &v["physical_samples_with_aliases"],
            &v["compared_sample_pairs"],
            &v["incompatible_sample_pairs"],
            &v["affected_physical_samples"],
            &v["affected_samples"],
        ]
        .map(|x| x.as_u64().unwrap()),
        [1, 3, 2, 1, 3]
    );
    let first = &v["listed_pairs"][0];
    assert_eq!(first["physical_sample"], "p0");
    assert_eq!(
        (first["sample_a"].as_str(), first["sample_b"].as_str()),
        (Some("s0"), Some("s7"))
    );
    assert!(close(&first["absolute_difference"], 10.0));
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "reference.verify_reference_or_pairing.v1"
            && f.evidence == ["reference.within_physical_sample_conflicts"]));
    // The between-object population still excludes pairs inside p0.
    let exact_pairs = target_metric(&report, "reference.exact_duplicate_conflicts", "moisture");
    let listed = exact_pairs.value.as_ref().unwrap()["listed_pairs"]
        .as_array()
        .unwrap()
        .clone();
    assert!(listed
        .iter()
        .all(|p| p["physical_sample_a"] != p["physical_sample_b"]));
    // Undeclared target and categorical target without aliases.
    assert_eq!(
        target_metric(
            &report,
            "reference.within_physical_sample_conflicts",
            "protein"
        )
        .reason_code
        .as_deref(),
        Some("REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED")
    );
    assert_eq!(
        target_metric(
            &report,
            "reference.within_physical_sample_conflicts",
            "grade"
        )
        .value
        .as_ref()
        .unwrap()["compared_sample_pairs"],
        0
    );
}

/// One physical sample per case with two aliases; one target per tolerance.
fn relative_extremes_input() -> QualificationInput {
    let cases: [(f64, f64); 7] = [
        (1.7e308, -1.7e308),
        (4.0, 3.0),
        (4.0, 2.9999999999999996),
        (0.0, 0.0),
        (0.0, -0.0),
        (0.0, 1e-300),
        (-1e-310, 1e-310),
    ];
    let mut x = input();
    x.samples.clear();
    x.sources[0].observation_ids.clear();
    x.sources[0].sample_ids.clear();
    x.sources[0].x.clear();
    let tolerances = [
        (
            "rel_quarter",
            ReferenceContradictionTolerance::Relative { value: 0.25 },
        ),
        (
            "rel_one_half",
            ReferenceContradictionTolerance::Relative { value: 1.5 },
        ),
        (
            "rel_two",
            ReferenceContradictionTolerance::Relative { value: 2.0 },
        ),
        (
            "abs_huge",
            ReferenceContradictionTolerance::Absolute { value: 1e308 },
        ),
    ];
    x.targets = tolerances
        .iter()
        .map(|(id, _)| Target {
            target_id: (*id).into(),
            kind: TargetKind::Continuous,
            values: vec![],
            unit: None,
        })
        .collect();
    for (i, (a, b)) in cases.iter().enumerate() {
        for (suffix, value) in [("a", a), ("b", b)] {
            let id = format!("c{i}{suffix}");
            x.samples.push(dev_sample(&id, &format!("case{i}")));
            x.sources[0].observation_ids.push(format!("o-{id}"));
            x.sources[0].sample_ids.push(id.clone());
            x.sources[0].x.push(vec![Some(i as f64), Some(1.0)]);
            for t in &mut x.targets {
                t.values.push(exact(&id, *value, None));
            }
        }
    }
    x.options.reference_contradiction_tolerances = tolerances
        .iter()
        .map(|(id, t)| ((*id).to_string(), *t))
        .collect();
    x
}

#[test]
fn relative_tolerance_is_normalised_and_cannot_overflow() {
    // Review b4 #2: 1.7e308 vs -1.7e308 at relative 1.5 compared Inf > Inf.
    let report = analyze(&relative_extremes_input(), &oracle());
    let flagged = |target: &str| -> Vec<String> {
        target_metric(
            &report,
            "reference.within_physical_sample_conflicts",
            target,
        )
        .value
        .as_ref()
        .unwrap()["listed_pairs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["physical_sample"].as_str().unwrap().to_string())
            .collect()
    };
    // |x/m - y/m|: case0 2, case1 0.25 (equal, compatible), case2 just above
    // 0.25, case3/4 zero (m = 0), case5 1, case6 2 (subnormal).
    assert_eq!(flagged("rel_quarter"), ["case0", "case2", "case5", "case6"]);
    assert_eq!(flagged("rel_one_half"), ["case0", "case6"]);
    assert!(flagged("rel_two").is_empty());
    // Absolute rule: an unrepresentable |x - y| exceeds any finite tolerance.
    assert_eq!(flagged("abs_huge"), ["case0"]);
    let listed = &target_metric(
        &report,
        "reference.within_physical_sample_conflicts",
        "rel_one_half",
    )
    .value
    .as_ref()
    .unwrap()["listed_pairs"][0];
    assert!(listed["absolute_difference"].is_null());
    assert!(close(&listed["relative_difference"], 2.0));
}

#[test]
fn shared_reference_ids_do_not_depend_on_measurement_order() {
    // Review b4 #4: s0 has two exact measurements of 10 (r1, r2), s2 has r2.
    for order in [["r1", "r2"], ["r2", "r1"]] {
        let mut x = duplicate_fixture();
        let values = &mut x.targets[0].values;
        values.retain(|v| v.sample_id != "s0");
        values.insert(0, exact("s0", 10.0, Some(order[0])));
        values.push(exact("s0", 10.0, Some(order[1])));
        for v in values.iter_mut().filter(|v| v.sample_id == "s2") {
            v.reference_id = Some("r2".into());
        }
        let report = analyze(&x, &oracle());
        let v = metric(&report, "integrity.quasi_duplicate_pairs")
            .value
            .clone()
            .unwrap();
        // Listed pair 1 is (s0, s2); pair 0 is (s0, s1) with r1 for s1.
        let s0_s2 = &v["listed_pairs"][1]["concordant_indices"]["references"]["moisture"];
        assert_eq!(s0_s2["shared_reference_id"], true, "{order:?}");
        let s0_s1 = &v["listed_pairs"][0]["concordant_indices"]["references"]["moisture"];
        assert_eq!(s0_s1["shared_reference_id"], true, "{order:?}");
        let conflicts = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture");
        assert_eq!(
            conflicts.value.as_ref().unwrap()["listed_pairs"][0]["reference_ids_a"],
            serde_json::json!(["r1", "r2"])
        );
    }
}

#[test]
fn conflict_denominators_name_total_admissible_and_excluded_observations() {
    // Review b4 #5: one incomplete development observation (s6) stays in the
    // exact population but leaves the quasi (complete-case) population.
    let mut x = duplicate_fixture();
    x.sources[0].x[6][1] = None;
    let report = analyze(&x, &oracle());
    for (id, admissible) in [
        ("reference.exact_duplicate_conflicts", 7),
        ("reference.quasi_duplicate_conflicts", 6),
    ] {
        let m = target_metric(&report, id, "moisture");
        assert_eq!(m.denominators["n_development_observations"], 7, "{id}");
        assert_eq!(
            m.denominators["n_admissible_development_observations"], admissible,
            "{id}"
        );
        assert_eq!(
            m.denominators["n_excluded_development_observations"],
            7 - admissible,
            "{id}"
        );
        assert_eq!(
            m.parameters["fraction_denominators"]["affected_development_fraction"],
            "n_admissible_development_observations"
        );
    }
    let v = target_metric(&report, "reference.quasi_duplicate_conflicts", "moisture")
        .value
        .clone()
        .unwrap();
    assert!(close(&v["affected_development_fraction"], 3. / 6.));
}

#[test]
fn relative_tolerance_does_not_lose_precision_on_close_references() {
    // Review b14fix #5: |1e16 - 9999999999999998| / 1e16 = 2e-16 exactly
    // (rational oracle), compatible at 2.1e-16; x/m - y/m gave 2.22e-16.
    for (tolerance, conflict) in [(2.1e-16, false), (1.9e-16, true)] {
        let mut x = input();
        x.samples = vec![dev_sample("a", "p"), dev_sample("b", "p")];
        x.sources[0].observation_ids = vec!["oa".into(), "ob".into()];
        x.sources[0].sample_ids = vec!["a".into(), "b".into()];
        x.sources[0].x = vec![vec![Some(0.0), Some(1.0)], vec![Some(1.0), Some(0.0)]];
        x.targets = vec![Target {
            target_id: "y".into(),
            kind: TargetKind::Continuous,
            values: vec![exact("a", 1e16, None), exact("b", 9999999999999998.0, None)],
            unit: None,
        }];
        x.options.reference_contradiction_tolerances.insert(
            "y".into(),
            ReferenceContradictionTolerance::Relative { value: tolerance },
        );
        let report = analyze(&x, &oracle());
        let v = target_metric(&report, "reference.within_physical_sample_conflicts", "y")
            .value
            .clone()
            .unwrap();
        assert_eq!(
            v["incompatible_sample_pairs"],
            u64::from(conflict),
            "{tolerance}"
        );
    }
}
