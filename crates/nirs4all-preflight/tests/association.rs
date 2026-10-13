//! Metadata–target association protocol. Status routing uses a scripted
//! provider; numerical end-to-end cases use the real Methods library and
//! compare against hand values and NumPy 2.2.6 / SciPy 1.15.3 goldens.
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use serde_json::Value;
use std::cell::RefCell;

/// Scripted provider: fixed effect, caller-chosen distinct-outcome bound.
struct Scripted {
    log10_distinct: f64,
    requests: RefCell<Vec<AssociationRequest>>,
}
impl Scripted {
    fn new(log10_distinct: f64) -> Self {
        Self {
            log10_distinct,
            requests: RefCell::new(Vec::new()),
        }
    }
}
impl MethodsProvider for Scripted {
    fn capabilities(&self) -> Vec<Capability> {
        [
            "methods.association",
            "methods.holm_adjust",
            "methods.summary",
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
    fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Err(ProviderError("NOT_SCRIPTED".into()))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError("NOT_SCRIPTED".into()))
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        Ok(SummaryDiagnostics {
            count: r.values.len(),
            min: 0.,
            max: 0.,
            mean: 0.,
            sample_sd: None,
            q25: 0.,
            median: 0.,
            q75: 0.,
            backend_version: "scripted".into(),
        })
    }
    fn association(&self, r: &AssociationRequest) -> Result<AssociationDiagnostics, ProviderError> {
        self.requests.borrow_mut().push(r.clone());
        let constant = r.targets.iter().all(|v| *v == r.targets[0]);
        let levels: std::collections::BTreeSet<_> = r.factor_codes.iter().collect();
        let b = 9;
        Ok(AssociationDiagnostics {
            effect_size: (!constant).then_some(0.4),
            statistic: (!constant).then_some(1.0),
            df1: Some(1.0),
            df2: None,
            n_levels: levels.len(),
            n_target_values: 2,
            log10_distinct_permutations: self.log10_distinct,
            p_value: (r.n_permutations > 0)
                .then(|| (1.0 + b as f64) / (1.0 + r.n_permutations as f64)),
            n_at_least_observed: if r.n_permutations > 0 { b } else { 0 },
            n_permutations_executed: r.n_permutations,
            backend_version: "scripted".into(),
        })
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        // Valid only for the single-hypothesis families scripted here.
        assert_eq!(r.p_values.len(), 1);
        Ok(HolmDiagnostics {
            adjusted: r.p_values.clone(),
            backend_version: "scripted".into(),
        })
    }
}

fn sample(id: &str, instrument: Option<&str>) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: Some(format!("p_{id}")),
        partition: Partition::Development,
        independence_group: None,
        instrument: instrument.map(str::to_owned),
        campaign: Some("c1".into()),
        individual_id: None,
        augmentation_parent_id: None,
    }
}

/// Units s00..s{n-1} with one instrument code and one exact Y each.
fn dataset(codes: &[usize], values: &[f64], kind: TargetKind) -> QualificationInput {
    let ids: Vec<String> = (0..codes.len()).map(|i| format!("s{i:02}")).collect();
    let samples = ids
        .iter()
        .zip(codes)
        .map(|(id, c)| sample(id, Some(&format!("i{c}"))))
        .collect();
    let target_values = ids
        .iter()
        .zip(values)
        .map(|(id, v)| TargetValue {
            sample_id: id.clone(),
            value: (kind == TargetKind::Continuous).then_some(*v),
            category: (kind == TargetKind::Categorical).then(|| format!("class{v}")),
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        })
        .collect();
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "x".into(),
            observation_ids: ids.iter().map(|i| format!("o_{i}")).collect(),
            sample_ids: ids.clone(),
            x: ids.iter().map(|_| vec![Some(1.0)]).collect(),
            valid_mask: None,
            axis: vec![1000.0],
            axis_unit: "nm".into(),
            signal_unit: "abs".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples,
        targets: vec![Target {
            target_id: if kind == TargetKind::Categorical {
                "grade".into()
            } else {
                "moisture".into()
            },
            kind,
            values: target_values,
            unit: None,
        }],
        options: Options {
            independence_unit: IndependenceUnit::Sample,
            exchangeable_units: true,
            seed: 17,
            ..Options::default()
        },
    }
}

fn metric<'a>(report: &'a QualificationReport, id: &str, metadata: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id && m.parameters["metadata"] == metadata)
        .unwrap_or_else(|| panic!("missing {id} for {metadata}"))
}

fn plan(m: &Metric) -> &Value {
    &m.parameters["permutation_plan"]
}

const D_CODES: [usize; 12] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
const D_Y: [f64; 12] = [
    -0.79, 0.24, -1.9, 1.4, 1.44, 0.51, 0.49, 1.1, 1.33, 1.37, 2.32, 2.11,
];

#[test]
fn identifiable_test_runs_999_permutations_with_derived_seed_and_holm() {
    let provider = Scripted::new(4.0);
    let report = analyze(&dataset(&D_CODES, &D_Y, TargetKind::Continuous), &provider);
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert!(matches!(test.status, Availability::Computed));
    let value = test.value.as_ref().unwrap();
    assert_eq!(value["p_value"], 0.01);
    assert_eq!(value["p_value_holm"], 0.01);
    assert_eq!(value["rejects_null_at_family_alpha"], true);
    let p = plan(test);
    assert_eq!(p["plan_version"], "permutation_plan.v1");
    assert_eq!(p["exchangeable_unit"], "sample");
    assert_eq!(p["restrictions"], "none_single_block");
    assert_eq!(p["block_sizes"], serde_json::json!([12]));
    assert_eq!(p["n_permutations_executed"], 999);
    assert_eq!(p["executed"], true);
    assert!(p["reduced_model"].is_null());
    // Independent Python FNV-1a/SplitMix64 reference, decimal-string transport.
    assert_eq!(p["seed"], "3688602029845424831");
    let requests = provider.requests.borrow();
    assert_eq!(requests.last().unwrap().seed, 3_688_602_029_845_424_831);
    assert_eq!(requests.last().unwrap().n_permutations, 999);
    // Campaign is constant: not applicable and outside the Holm family.
    let campaign = metric(&report, "association.metadata_target_test", "campaign");
    assert_eq!(
        campaign.reason_code.as_deref(),
        Some("SINGLE_METADATA_LEVEL")
    );
    let family = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "association.metadata_target_family")
        .unwrap();
    assert_eq!(family.value.as_ref().unwrap()["family_size"], 1);
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "association.metadata_target.v1" && f.confidence == "unknown"));
    assert!(capabilities(&provider)
        .iter()
        .any(|c| c.capability_id == "metadata_association_tests" && c.available && !c.qualified));
}

#[test]
fn target_constant_within_the_block_is_not_identifiable() {
    let provider = Scripted::new(4.0);
    let report = analyze(
        &dataset(&D_CODES, &[1.5; 12], TargetKind::Continuous),
        &provider,
    );
    let d = metric(&report, "association.metadata_target", "instrument");
    assert!(matches!(d.status, Availability::Undefined));
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert!(matches!(test.status, Availability::NotIdentifiable));
    assert_eq!(
        test.reason_code.as_deref(),
        Some("TARGET_CONSTANT_WITHIN_PERMUTATION_BLOCK")
    );
    assert!(test.value.is_none());
    assert!(provider
        .requests
        .borrow()
        .iter()
        .all(|r| r.n_permutations == 0));
}

#[test]
fn undeclared_exchangeability_keeps_descriptive_effect_without_test() {
    let provider = Scripted::new(4.0);
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    input.options.exchangeable_units = false;
    let report = analyze(&input, &provider);
    let d = metric(&report, "association.metadata_target", "instrument");
    assert!(matches!(d.status, Availability::Computed));
    assert_eq!(d.value.as_ref().unwrap()["effect_size"], 0.4);
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("EXCHANGEABILITY_NOT_DECLARED")
    );
    assert_eq!(plan(test)["exchangeability_declared"], false);
    assert_eq!(plan(test)["n_permutations_executed"], 0);
    assert!(provider
        .requests
        .borrow()
        .iter()
        .all(|r| r.n_permutations == 0));
}

#[test]
fn unknown_independence_unit_is_descriptive_only() {
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    input.options.independence_unit = IndependenceUnit::Unknown;
    let report = analyze(&input, &Scripted::new(4.0));
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("INDEPENDENCE_UNIT_UNKNOWN")
    );
    let d = metric(&report, "association.metadata_target", "instrument");
    assert_eq!(
        d.parameters["independence_assumption"],
        "physical_sample_or_sample_id_descriptive_only"
    );
}

#[test]
fn tiny_groups_cannot_support_significance_after_multiplicity() {
    // 2 levels x 2 units: 4!/(2!2!) = 6 outcomes, resolution 1/6 > 0.05.
    let provider = Scripted::new(6f64.log10());
    let report = analyze(
        &dataset(&[0, 0, 1, 1], &[1.0, 2.0, 3.0, 4.0], TargetKind::Continuous),
        &provider,
    );
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert!(matches!(test.status, Availability::InsufficientData));
    assert_eq!(
        test.reason_code.as_deref(),
        Some("PERMUTATION_RESOLUTION_INSUFFICIENT")
    );
    assert!(test.value.is_none());
    let p = plan(test);
    assert!((p["resolution"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-12);
    assert_eq!(p["executed"], false);
    assert!(provider
        .requests
        .borrow()
        .iter()
        .all(|r| r.n_permutations == 0));
    assert!(matches!(
        metric(&report, "association.metadata_target", "instrument").status,
        Availability::Computed
    ));
}

#[test]
fn retained_test_and_augmented_references_never_enter_the_population() {
    let provider = Scripted::new(4.0);
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    let mut retained = sample("t1", Some("i9"));
    retained.partition = Partition::RetainedTest;
    let mut augmented = sample("a1", Some("i0"));
    augmented.augmentation_parent_id = Some("s00".into());
    augmented.physical_sample_id = None;
    input.samples.extend([retained, augmented]);
    for (id, value) in [("t1", 1e6), ("a1", -1e6)] {
        input.targets[0].values.push(TargetValue {
            sample_id: id.into(),
            value: Some(value),
            category: None,
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        });
    }
    let report = analyze(&input, &provider);
    assert!(report.validation.valid);
    let d = metric(&report, "association.metadata_target", "instrument");
    assert_eq!(d.denominators["n_eligible_samples"], 12);
    for r in provider.requests.borrow().iter() {
        assert_eq!(r.targets.len(), 12);
        assert!(r.targets.iter().all(|v| v.abs() < 1e3));
    }
}

#[test]
fn metadata_varying_inside_a_declared_group_blocks_the_unit_test() {
    let provider = Scripted::new(4.0);
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    input.options.independence_unit = IndependenceUnit::Group;
    for (i, s) in input.samples.iter_mut().enumerate() {
        s.independence_group = Some(format!("g{i}"));
    }
    // s03 (i0) and s04 (i1) share one group: crossed with the factor.
    input.samples[4].independence_group = Some("g3".into());
    input.targets[0].values[4].value = Some(1.4);
    let report = analyze(&input, &provider);
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT")
    );
    assert_eq!(test.denominators["n_units_metadata_varies_within_unit"], 1);
    assert_eq!(test.denominators["n_independence_units"], 11);
    assert_eq!(plan(test)["exchangeable_unit"], "group");
}

#[test]
fn shared_reference_group_with_different_targets_is_not_identifiable() {
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    input.targets[0].values[0].reference_group_id = Some("composite".into());
    input.targets[0].values[1].reference_group_id = Some("composite".into());
    let report = analyze(&input, &Scripted::new(4.0));
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("TARGET_VARIES_WITHIN_INDEPENDENCE_UNIT")
    );
    assert_eq!(test.denominators["n_units_target_varies_within_unit"], 1);
}

#[test]
fn absent_metadata_is_explicit_not_applicable() {
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    for s in &mut input.samples {
        s.instrument = None;
    }
    let report = analyze(&input, &Scripted::new(4.0));
    let d = metric(&report, "association.metadata_target", "instrument");
    assert!(matches!(d.status, Availability::NotApplicable));
    assert_eq!(d.reason_code.as_deref(), Some("METADATA_NOT_DECLARED"));
    let family = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "association.metadata_target_family")
        .unwrap();
    assert_eq!(family.reason_code.as_deref(), Some("NO_IDENTIFIABLE_TESTS"));
}

#[test]
fn unavailable_provider_reports_unsupported_without_values() {
    let report = analyze(
        &dataset(&D_CODES, &D_Y, TargetKind::Continuous),
        &UnavailableMethodsProvider,
    );
    let d = metric(&report, "association.metadata_target", "instrument");
    assert!(matches!(d.status, Availability::Unsupported));
    assert!(d.value.is_none());
    assert!(capabilities(&UnavailableMethodsProvider)
        .iter()
        .any(|c| c.capability_id == "metadata_association_tests" && !c.available));
}

fn native() -> Option<NativeMethodsProvider> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some(NativeMethodsProvider::load(path).expect("compatible Methods ABI"))
}

#[test]
fn real_methods_continuous_association_matches_scipy_and_numpy_goldens() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(&dataset(&D_CODES, &D_Y, TargetKind::Continuous), &provider);
    let d = metric(&report, "association.metadata_target", "instrument");
    let v = d.value.as_ref().unwrap();
    // scipy.stats.f_oneway on the three groups: F=5.112931786078764.
    assert!((v["effect_size"].as_f64().unwrap() - 0.531_880_585_430_055_7).abs() < 1e-12);
    assert!((v["statistic"].as_f64().unwrap() - 5.112_931_786_078_764).abs() < 1e-9);
    assert_eq!(v["df1"], 2.0);
    assert_eq!(v["df2"], 9.0);
    assert_eq!(v["levels"][0]["target_summary"]["count"], 4);
    // Group i0 = {-0.79, 0.24, -1.9, 1.4}: mean -0.2625.
    assert!((v["levels"][0]["target_summary"]["mean"].as_f64().unwrap() + 0.2625).abs() < 1e-12);
    let test = metric(&report, "association.metadata_target_test", "instrument");
    let t = test.value.as_ref().unwrap();
    // NumPy default_rng(3688602029845424831).permutation(12) x 999: b=19.
    assert_eq!(t["n_at_least_observed"], 19);
    assert!((t["p_value"].as_f64().unwrap() - 0.02).abs() < 1e-15);
    assert_eq!(t["p_value_holm"], t["p_value"]);
    // log10(12!/(4!4!4!)) = log10(34650).
    let log10 = plan(test)["log10_distinct_admissible_permutations"]
        .as_f64()
        .unwrap();
    assert!((log10 - 34650f64.log10()).abs() < 1e-9);
}

#[test]
fn real_methods_categorical_association_matches_hand_and_numpy_goldens() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(
        &dataset(
            &[0, 0, 0, 1, 1, 1, 1],
            &[0., 0., 1., 1., 1., 1., 0.],
            TargetKind::Categorical,
        ),
        &provider,
    );
    let d = metric(&report, "association.metadata_target", "instrument");
    let v = d.value.as_ref().unwrap();
    // Table [[2,1],[1,3]]: chi2 = 175/144, Cramer's V = 5/12.
    assert!((v["effect_size"].as_f64().unwrap() - 5. / 12.).abs() < 1e-12);
    assert!((v["statistic"].as_f64().unwrap() - 175. / 144.).abs() < 1e-12);
    assert_eq!(v["levels"][1]["class_counts"]["class1"], 3);
    let test = metric(&report, "association.metadata_target_test", "instrument");
    // NumPy default_rng(10737358689995417344): b=466, p=467/1000.
    assert_eq!(test.value.as_ref().unwrap()["n_at_least_observed"], 466);
    assert_eq!(plan(test)["seed"], "10737358689995417344");
    assert_eq!(
        test.value.as_ref().unwrap()["rejects_null_at_family_alpha"],
        false
    );
    assert!(report
        .findings
        .iter()
        .all(|f| f.rule_id != "association.metadata_target.v1"));
}

#[test]
fn real_methods_tiny_groups_resolution_is_insufficient() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(
        &dataset(&[0, 0, 1, 1], &[1., 2., 3., 4.], TargetKind::Continuous),
        &provider,
    );
    let test = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("PERMUTATION_RESOLUTION_INSUFFICIENT")
    );
    // Groups {1,2},{3,4}: SST=5, SSB=4, eta^2=0.8 stays descriptive.
    let d = metric(&report, "association.metadata_target", "instrument");
    assert!((d.value.as_ref().unwrap()["effect_size"].as_f64().unwrap() - 0.8).abs() < 1e-12);
}
