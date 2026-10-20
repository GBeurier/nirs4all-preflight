//! Protocol of the grouped validation probe with a recording provider: the
//! population, components, plan and refusals are fixed before any FIT, a
//! provider result that splits an identity component is rejected, and
//! provider errors keep their kind and context.
use nirs4all_preflight::*;
use std::cell::RefCell;

/// Methods stand-in for the four probe kernels (test-only arithmetic).
struct Kernels;
impl MethodsProvider for Kernels {
    fn capabilities(&self) -> Vec<Capability> {
        [
            "methods.pca",
            "methods.group_means",
            "methods.summary",
            "methods.regression_scores",
        ]
        .iter()
        .map(|id| Capability {
            capability_id: (*id).into(),
            available: true,
            qualified: false,
            reason: None,
        })
        .collect()
    }
    /// Full numerical rank: one unit eigenvalue per requested component.
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; r.n_components],
            scores: vec![vec![0.0; r.n_components]; r.matrix.len()],
            full_moments: [r.n_components as f64; 2],
            resolution: 0.0,
            unresolved: vec![false; r.n_components],
            backend_version: "test".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("TEST_NO_REPEATABILITY"))
    }
    fn group_means(&self, r: &GroupMeansRequest) -> Result<GroupMeansDiagnostics, ProviderError> {
        let p = r.matrix[0].len();
        let mut sums = vec![vec![0.0; p]; r.n_groups];
        let mut counts = vec![0usize; r.n_groups];
        for (row, &g) in r.matrix.iter().zip(&r.group_codes) {
            counts[g as usize] += 1;
            for (s, v) in sums[g as usize].iter_mut().zip(row) {
                *s += v;
            }
        }
        Ok(GroupMeansDiagnostics {
            means: sums
                .into_iter()
                .zip(&counts)
                .map(|(s, &c)| s.into_iter().map(|v| v / c as f64).collect())
                .collect(),
            counts,
            backend_version: "test".into(),
        })
    }
}

#[derive(Default)]
struct Spy {
    requests: RefCell<Vec<ProbeRequest>>,
    /// Put the first sample of every outer validation fold in training.
    split_component: bool,
}

impl ValidationProvider for Spy {
    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability {
            capability_id: VALIDATION_CAPABILITY_ID.into(),
            available: true,
            qualified: false,
            reason: None,
        }]
    }
    fn probe(&self, request: &ProbeRequest) -> Result<ProbeResult, ProviderError> {
        self.requests.borrow_mut().push(request.clone());
        if !self.split_component {
            return Err(ProviderError::internal("SPY_NO_FIT")
                .with_detail("outer fold `fold0` candidate `n_components:0001`"));
        }
        // Folds by sample index, ignoring the identity components.
        let ids = &request.sample_ids;
        let fold = |k: usize, i: usize| i % k;
        let assignment =
            |universe: &[usize], k: usize, f: usize, prefix: &str| ProbeFoldAssignment {
                fold_id: format!("{prefix}{f}"),
                train_sample_ids: universe
                    .iter()
                    .filter(|&&i| fold(k, i) != f)
                    .map(|&i| ids[i].clone())
                    .collect(),
                validation_sample_ids: universe
                    .iter()
                    .filter(|&&i| fold(k, i) == f)
                    .map(|&i| ids[i].clone())
                    .collect(),
            };
        let all: Vec<usize> = (0..ids.len()).collect();
        let scores = ProbeScores {
            mse: 1.0,
            rmse: 1.0,
            mae: 1.0,
        };
        Ok(ProbeResult {
            outer_folds: (0..request.outer_splits)
                .map(|f| ProbeOuterFold {
                    fold: assignment(&all, request.outer_splits, f, "fold"),
                    inner_folds: vec![],
                    candidates: vec![],
                    selected_components: 1,
                })
                .collect(),
            oof: vec![],
            model: scores,
            n_fits: 0,
            backend_version: "spy".into(),
        })
    }
}

fn sample(id: &str) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: Some(id.into()),
        partition: Partition::Development,
        independence_group: None,
        instrument: None,
        campaign: None,
        individual_id: None,
        augmentation_parent_id: None,
    }
}

/// `n` development samples with distinct spectra and target `y_i = i`.
fn input(n: usize) -> QualificationInput {
    let ids: Vec<String> = (0..n).map(|i| format!("s{i:02}")).collect();
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "nir".into(),
            observation_ids: ids.iter().map(|s| format!("o-{s}")).collect(),
            sample_ids: ids.clone(),
            x: (0..n)
                .map(|i| {
                    let i = i as f64;
                    vec![Some(i), Some(i * i), Some(1.0 / (i + 1.0)), Some(i.sqrt())]
                })
                .collect(),
            valid_mask: None,
            axis: vec![1.0, 2.0, 3.0, 4.0],
            axis_unit: "nm".into(),
            signal_unit: "abs".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples: ids.iter().map(|s| sample(s)).collect(),
        targets: vec![Target {
            target_id: "y".into(),
            kind: TargetKind::Continuous,
            values: ids
                .iter()
                .enumerate()
                .map(|(i, s)| TargetValue {
                    sample_id: s.clone(),
                    value: Some(i as f64),
                    category: None,
                    status: ReferenceStatus::Exact,
                    reference_id: None,
                    reference_group_id: None,
                })
                .collect(),
            unit: Some("%".into()),
        }],
        metadata: MetadataTable::default(),
        options: Options {
            independence_unit: IndependenceUnit::Sample,
            snv_sensitivity: false,
            validation_probe: ValidationProbeOptions {
                estimators: vec![ProbeEstimator::Pls],
                ..Default::default()
            },
            ..Default::default()
        },
    }
}

fn probe_metric<'a>(report: &'a QualificationReport, id: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn reason(report: &QualificationReport) -> Option<&str> {
    probe_metric(report, "probe.rmse").reason_code.as_deref()
}

#[test]
fn same_object_under_another_acquisition_id_in_retained_test_is_refused_before_any_fit() {
    let mut x = input(12);
    // Same physical object, distinct sample and observation IDs, in test.
    x.samples.push(Sample {
        partition: Partition::RetainedTest,
        physical_sample_id: Some("s03".into()),
        ..sample("t03")
    });
    x.sources[0].observation_ids.push("o-t03".into());
    x.sources[0].sample_ids.push("t03".into());
    x.sources[0].x.push(vec![Some(9.5); 4]);
    let spy = Spy::default();
    let report = analyze_with_validation(&x, &Kernels, &spy);
    assert_eq!(report.status, "failed");
    assert!(report
        .validation
        .issues
        .iter()
        .any(|i| i.code == "IDENTITY_LEAKAGE"));
    assert!(spy.requests.borrow().is_empty());
    assert!(!report
        .metrics
        .iter()
        .any(|m| m.metric_id.starts_with("probe.")));
}

#[test]
fn linked_identities_form_one_indivisible_group_and_test_rows_never_enter() {
    let mut x = input(12);
    x.samples[1].individual_id = Some("animal".into());
    x.samples[7].individual_id = Some("animal".into());
    x.targets[0].values[2].reference_group_id = Some("pool".into());
    x.targets[0].values[9].reference_group_id = Some("pool".into());
    // s04 and s05 are linked only through s10, whose reference is censored.
    x.samples[4].individual_id = Some("bridge".into());
    x.samples[10].individual_id = Some("bridge".into());
    x.targets[0].values[10].status = ReferenceStatus::Censored;
    x.targets[0].values[10].reference_group_id = Some("composite".into());
    x.targets[0].values[5].reference_group_id = Some("composite".into());
    // Retained-test and augmented rows carry Y but are never requested.
    for (id, partition, parent) in [
        ("t00", Partition::RetainedTest, None),
        ("a00", Partition::Development, Some("s00".to_string())),
    ] {
        x.samples.push(Sample {
            partition,
            augmentation_parent_id: parent,
            physical_sample_id: Some(format!("p-{id}")),
            ..sample(id)
        });
        x.sources[0].observation_ids.push(format!("o-{id}"));
        x.sources[0].sample_ids.push(id.into());
        x.sources[0]
            .x
            .push(vec![Some(-7.0), Some(3.0), Some(1.0), Some(2.0)]);
        x.targets[0].values.push(TargetValue {
            sample_id: id.into(),
            value: Some(1e6),
            category: None,
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        });
    }
    let spy = Spy::default();
    let report = analyze_with_validation(&x, &Kernels, &spy);
    assert_eq!(report.status, "partial");
    let requests = spy.requests.borrow();
    let request = &requests[0];
    assert_eq!(request.sample_ids.len(), 11);
    assert!(!request.targets.contains(&1e6));
    let group =
        |id: &str| &request.group_ids[request.sample_ids.iter().position(|s| s == id).unwrap()];
    assert_eq!(group("s01"), group("s07"));
    assert_eq!(group("s04"), group("s05"));
    assert!(!request.sample_ids.contains(&"s10".to_string()));
    assert_eq!(group("s02"), group("s09"));
    assert_ne!(group("s01"), group("s02"));
    assert_eq!(
        request
            .group_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8
    );
    assert_eq!((request.outer_splits, request.inner_splits), (5, 3));
    // An execution failure is an error with its fold/candidate context, not
    // an unsupported capability.
    assert_eq!(reason(&report), Some("SPY_NO_FIT"));
    let failed = probe_metric(&report, "probe.rmse");
    assert_eq!(
        serde_json::to_value(&failed.status).unwrap(),
        serde_json::json!("error")
    );
    assert_eq!(
        failed.parameters["provider_error_detail"],
        serde_json::json!("outer fold `fold0` candidate `n_components:0001`")
    );
}

#[test]
fn provider_folds_that_split_an_identity_component_are_rejected() {
    let mut x = input(12);
    x.samples[0].individual_id = Some("animal".into());
    x.samples[1].individual_id = Some("animal".into());
    let spy = Spy {
        split_component: true,
        ..Default::default()
    };
    let report = analyze_with_validation(&x, &Kernels, &spy);
    let metric = probe_metric(&report, "probe.rmse");
    assert_eq!(
        serde_json::to_value(&metric.status).unwrap(),
        serde_json::json!("error")
    );
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("PROVIDER_FOLD_SPLITS_IDENTITY_COMPONENT")
    );
    assert!(metric.value.is_none());
}

#[test]
fn refusals_precede_any_fit() {
    type Mutation = Box<dyn Fn(&mut QualificationInput)>;
    let cases: Vec<(Mutation, &str)> = vec![
        (
            Box::new(|x| x.options.independence_unit = IndependenceUnit::Unknown),
            "INDEPENDENCE_UNIT_UNKNOWN",
        ),
        (
            Box::new(|x| x.options.independence_unit = IndependenceUnit::Group),
            "MISSING_INDEPENDENCE_GROUP",
        ),
        (
            // An undeclared repeat: identical spectra under two physical IDs.
            Box::new(|x| x.sources[0].x[4] = x.sources[0].x[5].clone()),
            "EXACT_DUPLICATE_SPECTRUM_ACROSS_COMPONENTS",
        ),
        (
            Box::new(|x| {
                for s in &mut x.samples {
                    s.individual_id = Some(format!("i{}", &s.sample_id[2..] < "06"));
                }
            }),
            "FEWER_THAN_THREE_INDEPENDENT_GROUPS",
        ),
        (
            Box::new(|x| {
                for v in &mut x.targets[0].values {
                    v.value = Some(1.0);
                }
            }),
            "CONSTANT_TARGET",
        ),
        (
            Box::new(|x| x.options.validation_probe.max_fits = 10),
            "FIT_BUDGET_EXCEEDED",
        ),
        (
            Box::new(|x| {
                x.targets[0].kind = TargetKind::Categorical;
                for v in &mut x.targets[0].values {
                    v.category = Some(if v.value.unwrap() < 6.0 { "a" } else { "b" }.into());
                    v.value = None;
                }
            }),
            "CLASSIFICATION_PROBE_NOT_QUALIFIED",
        ),
        (
            Box::new(|x| x.options.validation_probe.enabled = false),
            "VALIDATION_PROBE_DISABLED",
        ),
    ];
    for (mutate, expected) in cases {
        let mut x = input(12);
        mutate(&mut x);
        let spy = Spy::default();
        let report = analyze_with_validation(&x, &Kernels, &spy);
        assert!(spy.requests.borrow().is_empty(), "{expected}");
        assert_eq!(reason(&report), Some(expected));
        assert!(report
            .metrics
            .iter()
            .filter(|m| m.metric_id.starts_with("probe."))
            .all(|m| m.value.is_none()));
    }
}

#[test]
fn smaller_valid_plans_follow_the_number_of_independent_groups() {
    for (n, outer, inner, k_max) in [(3, 3, 2, 0), (4, 4, 3, 0), (7, 5, 3, 1), (40, 5, 3, 4)] {
        let spy = Spy::default();
        let report = analyze_with_validation(&input(n), &Kernels, &spy);
        if k_max == 0 {
            assert_eq!(reason(&report), Some("TOO_FEW_SAMPLES_FOR_COMPONENT_GRID"));
            assert!(spy.requests.borrow().is_empty());
            continue;
        }
        let requests = spy.requests.borrow();
        assert_eq!(
            (requests[0].outer_splits, requests[0].inner_splits),
            (outer, inner)
        );
        assert_eq!(requests[0].components, (1..=k_max).collect::<Vec<_>>());
    }
}

#[test]
fn without_a_validation_provider_the_probe_is_unavailable_with_its_reason() {
    let report = analyze(&input(12), &UnavailableMethodsProvider);
    let capability = report
        .capabilities
        .iter()
        .find(|c| c.capability_id == "validation_probe")
        .unwrap();
    assert!(!capability.available);
    assert_eq!(
        capability.reason.as_deref(),
        Some("VALIDATION_PROVIDER_NOT_CONFIGURED")
    );
    assert_eq!(reason(&report), Some("VALIDATION_PROVIDER_NOT_CONFIGURED"));
    let classification = report
        .capabilities
        .iter()
        .find(|c| c.capability_id == "validation_probe.classification")
        .unwrap();
    assert!(!classification.available);
}

#[test]
fn missing_methods_kernels_make_the_probe_unavailable_before_any_fit() {
    let spy = Spy::default();
    let report = analyze_with_validation(&input(12), &UnavailableMethodsProvider, &spy);
    assert!(spy.requests.borrow().is_empty());
    assert_eq!(
        reason(&report),
        Some("PROBE_METHODS_KERNELS_NOT_CONFIGURED")
    );
    let capability = report
        .capabilities
        .iter()
        .find(|c| c.capability_id == "validation_probe")
        .unwrap();
    assert!(!capability.available);
}

#[test]
fn reference_group_units_require_a_resolved_reference_group_before_any_fit() {
    // No reference group at all: every component would be a singleton.
    let mut x = input(12);
    x.options.independence_unit = IndependenceUnit::ReferenceGroup;
    let spy = Spy::default();
    let report = analyze_with_validation(&x, &Kernels, &spy);
    assert!(spy.requests.borrow().is_empty());
    assert_eq!(reason(&report), Some("REFERENCE_GROUP_UNRESOLVED"));
    // Every sample but s04 carries a group; s04 is resolved only through s10,
    // an excluded (censored) sample of the same individual.
    for (i, v) in x.targets[0].values.iter_mut().enumerate() {
        if i != 4 {
            v.reference_group_id = Some(format!("rg{i}"));
        }
    }
    x.targets[0].values[10].status = ReferenceStatus::Censored;
    x.samples[4].individual_id = Some("bridge".into());
    x.samples[10].individual_id = Some("bridge".into());
    let spy = Spy::default();
    let report = analyze_with_validation(&x, &Kernels, &spy);
    assert_eq!(spy.requests.borrow().len(), 1);
    assert_eq!(reason(&report), Some("SPY_NO_FIT"));
    // Without the bridge, s04 is unresolved again.
    x.samples[10].individual_id = None;
    let spy = Spy::default();
    let report = analyze_with_validation(&x, &Kernels, &spy);
    assert!(spy.requests.borrow().is_empty());
    assert_eq!(reason(&report), Some("REFERENCE_GROUP_UNRESOLVED"));
}

/// Kernels with test-only summary and regression scores; `huge_r2` makes
/// every R² the scaled value -0.5 * 2^1025 (SSE/SST beyond the double range).
struct Scoring {
    huge_r2: bool,
}
impl MethodsProvider for Scoring {
    fn capabilities(&self) -> Vec<Capability> {
        Kernels.capabilities()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Kernels.pca(r)
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Kernels.repeatability(r)
    }
    fn group_means(&self, r: &GroupMeansRequest) -> Result<GroupMeansDiagnostics, ProviderError> {
        Kernels.group_means(r)
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        let n = r.values.len();
        Ok(SummaryDiagnostics {
            count: n,
            min: 0.0,
            max: 0.0,
            mean: r.values.iter().sum::<f64>() / n as f64,
            sample_sd: None,
            q25: 0.0,
            median: 0.0,
            q75: 0.0,
            backend_version: "test".into(),
        })
    }
    fn regression_scores(
        &self,
        r: &RegressionScoresRequest,
    ) -> Result<RegressionScores, ProviderError> {
        let n = r.y_true.len() as f64;
        let e: Vec<f64> = r.y_true.iter().zip(&r.y_pred).map(|(a, b)| a - b).collect();
        let (r2, r2_exponent) = if self.huge_r2 { (-0.5, 1025) } else { (0.5, 0) };
        Ok(RegressionScores {
            rmse: (e.iter().map(|v| v * v).sum::<f64>() / n).sqrt(),
            mae: e.iter().map(|v| v.abs()).sum::<f64>() / n,
            r2: Some(r2),
            r2_exponent,
            backend_version: "test".into(),
        })
    }
}

/// A consistent provider on singleton components: folds by position, every
/// candidate tied (so one component is selected), predictions y + 1.
struct Honest;
impl ValidationProvider for Honest {
    fn capabilities(&self) -> Vec<Capability> {
        Spy::default().capabilities()
    }
    fn probe(&self, request: &ProbeRequest) -> Result<ProbeResult, ProviderError> {
        let ids = &request.sample_ids;
        let split = |universe: &[usize], k: usize, prefix: &str| -> Vec<ProbeFoldAssignment> {
            (0..k)
                .map(|f| ProbeFoldAssignment {
                    fold_id: format!("{prefix}{f}"),
                    train_sample_ids: universe
                        .iter()
                        .enumerate()
                        .filter(|(p, _)| p % k != f)
                        .map(|(_, &i)| ids[i].clone())
                        .collect(),
                    validation_sample_ids: universe
                        .iter()
                        .enumerate()
                        .filter(|(p, _)| p % k == f)
                        .map(|(_, &i)| ids[i].clone())
                        .collect(),
                })
                .collect()
        };
        let all: Vec<usize> = (0..ids.len()).collect();
        let outer = split(&all, request.outer_splits, "fold");
        let outer_folds: Vec<ProbeOuterFold> = outer
            .into_iter()
            .map(|fold| {
                let train: Vec<usize> = all
                    .iter()
                    .copied()
                    .filter(|&i| fold.train_sample_ids.contains(&ids[i]))
                    .collect();
                ProbeOuterFold {
                    inner_folds: split(
                        &train,
                        request.inner_splits,
                        &format!("{}.inner", fold.fold_id),
                    ),
                    candidates: request
                        .components
                        .iter()
                        .map(|&k| ProbeCandidateScore {
                            n_components: k,
                            inner_rmse: 1.0,
                        })
                        .collect(),
                    selected_components: request.components[0],
                    fold,
                }
            })
            .collect();
        let oof: Vec<ProbeOofRow> = all
            .iter()
            .map(|&i| ProbeOofRow {
                sample_id: ids[i].clone(),
                fold_id: format!("fold{}", i % request.outer_splits),
                y_true: request.targets[i],
                prediction: request.targets[i] + 1.0,
            })
            .collect();
        Ok(ProbeResult {
            n_fits: request.outer_splits * (request.components.len() * request.inner_splits + 1),
            outer_folds,
            oof,
            model: ProbeScores {
                mse: 1.0,
                rmse: 1.0,
                mae: 1.0,
            },
            backend_version: "honest".into(),
        })
    }
}

#[test]
fn an_r2_beyond_the_double_range_is_published_scaled_not_as_absent() {
    let x = input(40);
    let ordinary = analyze_with_validation(&x, &Scoring { huge_r2: false }, &Honest);
    let r2 = probe_metric(&ordinary, "probe.r2_oof");
    assert_eq!(
        serde_json::to_value(&r2.status).unwrap(),
        serde_json::json!("computed")
    );
    assert_eq!(r2.value, Some(serde_json::json!(0.5)));
    let huge = analyze_with_validation(&x, &Scoring { huge_r2: true }, &Honest);
    let r2 = probe_metric(&huge, "probe.r2_oof");
    assert_eq!(
        serde_json::to_value(&r2.status).unwrap(),
        serde_json::json!("computed")
    );
    assert_eq!(
        r2.value,
        Some(serde_json::json!({"significand": -0.5, "exponent": 1025,
                                "representation": "significand_times_2_pow_exponent"}))
    );
    // A constant target stays a distinct, undefined R² (refused upstream as
    // CONSTANT_TARGET before any fit).
    let mut constant = input(40);
    for v in &mut constant.targets[0].values {
        v.value = Some(3.0);
    }
    let report = analyze_with_validation(&constant, &Scoring { huge_r2: true }, &Honest);
    assert_eq!(reason(&report), Some("CONSTANT_TARGET"));
}

/// The probe kernels plus a nearest-neighbour stand-in recording the
/// canonical PCA sample order and the local-contrast neighbour groups.
#[derive(Default)]
struct LocalSpy {
    pca_sample_ids: RefCell<Option<Vec<String>>>,
    neighbor_groups: RefCell<Option<Vec<i64>>>,
}
impl MethodsProvider for LocalSpy {
    fn capabilities(&self) -> Vec<Capability> {
        Kernels.capabilities()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.pca_sample_ids
            .borrow_mut()
            .get_or_insert_with(|| r.sample_ids.clone());
        Kernels.pca(r)
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Kernels.repeatability(r)
    }
    fn group_means(&self, r: &GroupMeansRequest) -> Result<GroupMeansDiagnostics, ProviderError> {
        Kernels.group_means(r)
    }
    fn nearest_neighbors(
        &self,
        r: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        assert_eq!(r.query_group_ids, r.reference_group_ids);
        *self.neighbor_groups.borrow_mut() = Some(r.query_group_ids.clone());
        Err(ProviderError::unsupported("SPY_NO_NEIGHBORS"))
    }
}

/// Review final1 P0: the local contrast excludes the same indivisible
/// identity components as the validation probe (individuals, reference
/// groups, bridges through a censored reference), on the same population.
#[test]
fn local_contrast_excludes_the_probe_identity_components() {
    let mut x = input(12);
    x.samples[1].individual_id = Some("animal".into());
    x.samples[7].individual_id = Some("animal".into());
    x.targets[0].values[2].reference_group_id = Some("pool".into());
    x.targets[0].values[9].reference_group_id = Some("pool".into());
    x.samples[4].individual_id = Some("bridge".into());
    x.samples[10].individual_id = Some("bridge".into());
    x.targets[0].values[10].status = ReferenceStatus::Censored;
    x.targets[0].values[10].reference_group_id = Some("composite".into());
    x.targets[0].values[5].reference_group_id = Some("composite".into());
    let methods = LocalSpy::default();
    let spy = Spy::default();
    analyze_with_validation(&x, &methods, &spy);
    let requests = spy.requests.borrow();
    let probe = &requests[0];
    // Local-contrast rows: canonical PCA order, censored s10 not eligible.
    let ids: Vec<String> = methods
        .pca_sample_ids
        .borrow()
        .clone()
        .unwrap()
        .into_iter()
        .filter(|id| id != "s10")
        .collect();
    let local = methods.neighbor_groups.borrow().clone().unwrap();
    assert_eq!(local.len(), ids.len());
    let mut probe_ids = probe.sample_ids.clone();
    probe_ids.sort();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(sorted, probe_ids);
    let probe_group =
        |id: &str| &probe.group_ids[probe.sample_ids.iter().position(|s| s == id).unwrap()];
    for (a, ga) in ids.iter().zip(&local) {
        for (b, gb) in ids.iter().zip(&local) {
            assert_eq!(ga == gb, probe_group(a) == probe_group(b), "{a} {b}");
        }
    }
    assert_eq!(
        local
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8
    );
}
