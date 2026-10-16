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
    holm_fails: bool,
    requests: RefCell<Vec<AssociationRequest>>,
}
impl Scripted {
    fn new(log10_distinct: f64) -> Self {
        Self {
            log10_distinct,
            holm_fails: false,
            requests: RefCell::new(Vec::new()),
        }
    }
}
impl MethodsProvider for Scripted {
    fn capabilities(&self) -> Vec<Capability> {
        [
            "methods.association",
            "methods.correlation",
            "methods.holm_adjust",
            "methods.bh_adjust",
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
        Err(ProviderError::unsupported("NOT_SCRIPTED"))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("NOT_SCRIPTED"))
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
        // Identity adjustment: exact only for single-hypothesis families,
        // which are the only families whose adjusted values are asserted.
        if self.holm_fails {
            return Err(ProviderError::unsupported("HOLM_SCRIPTED_FAILURE"));
        }
        Ok(HolmDiagnostics {
            adjusted: r.p_values.clone(),
            backend_version: "scripted".into(),
        })
    }
    fn bh_adjust(&self, r: &BhRequest) -> Result<BhDiagnostics, ProviderError> {
        Ok(BhDiagnostics {
            adjusted: r.p_values.clone(),
            backend_version: "scripted".into(),
        })
    }
    fn association_exact(
        &self,
        _: &AssociationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        // One arrangement attains the maximum: minimum p = 1/N.
        let n = 10f64.powf(self.log10_distinct).round();
        Ok(ExactPermutationDiagnostics {
            n_arrangements: n as usize,
            p_value: Some(1.0),
            minimum_p_value: Some(1.0 / n),
            maximum_statistic: Some(1.0),
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
        metadata: MetadataTable::default(),
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

const TEMPERATURE: [f64; 12] = [
    18.0, 19.5, 17.2, 21.0, 22.4, 20.1, 19.9, 21.7, 23.0, 22.2, 24.5, 23.8,
];
const SITE: [&str; 12] = [
    "north", "north", "south", "south", "north", "south", "north", "south", "north", "south",
    "north", "south",
];

/// Declares `site` (categorical) and `temperature` (continuous, degC) for
/// samples s00.. in order.
fn with_typed_metadata(
    mut input: QualificationInput,
    site: &[&str],
    temperature: &[f64],
) -> QualificationInput {
    input.metadata.columns = vec![
        MetadataColumn {
            name: "site".into(),
            kind: MetadataKind::Categorical,
            unit: None,
        },
        MetadataColumn {
            name: "temperature".into(),
            kind: MetadataKind::Continuous,
            unit: Some("degC".into()),
        },
    ];
    for (i, sample) in input.samples.iter().enumerate() {
        let mut row = std::collections::BTreeMap::new();
        if let Some(s) = site.get(i) {
            row.insert("site".to_string(), Some(MetadataValue::Text((*s).into())));
        }
        if let Some(t) = temperature.get(i) {
            row.insert("temperature".to_string(), Some(MetadataValue::Number(*t)));
        }
        input.metadata.values.insert(sample.sample_id.clone(), row);
    }
    input
}

#[test]
fn metadata_accessor_lists_builtin_then_declared_factors() {
    let input = with_typed_metadata(
        dataset(&D_CODES, &D_Y, TargetKind::Continuous),
        &SITE,
        &TEMPERATURE,
    );
    let factors = input.metadata_factors();
    let names: Vec<_> = factors.iter().map(|f| (f.name, f.kind, f.origin)).collect();
    assert_eq!(
        names,
        vec![
            (
                "instrument",
                MetadataKind::Categorical,
                MetadataOrigin::SampleField
            ),
            (
                "campaign",
                MetadataKind::Categorical,
                MetadataOrigin::SampleField
            ),
            ("site", MetadataKind::Categorical, MetadataOrigin::Declared),
            (
                "temperature",
                MetadataKind::Continuous,
                MetadataOrigin::Declared
            ),
        ]
    );
    assert_eq!(factors[3].unit, Some("degC"));
    let s = &input.samples[2];
    assert_eq!(
        input.metadata_value(&factors[0], s),
        Some(MetadataLevel::Category("i0"))
    );
    assert_eq!(
        input.metadata_value(&factors[2], s),
        Some(MetadataLevel::Category("south"))
    );
    assert_eq!(
        input.metadata_value(&factors[3], s),
        Some(MetadataLevel::Value(17.2))
    );
}

#[test]
fn real_methods_typed_metadata_family_matches_scipy_statsmodels_and_numpy() {
    let Some(provider) = native() else {
        return;
    };
    let input = with_typed_metadata(
        dataset(&D_CODES, &D_Y, TargetKind::Continuous),
        &SITE,
        &TEMPERATURE,
    );
    assert!(validate_input(&input).valid);
    let report = analyze(&input, &provider);
    // Spearman rho and Pearson r: scipy.stats 1.15.3.
    let d = metric(&report, "association.metadata_target", "temperature");
    let v = d.value.as_ref().unwrap();
    assert_eq!(v["effect_size_name"], "spearman_rho");
    assert!((v["effect_size"].as_f64().unwrap() - 0.930_069_930_069_930_2).abs() < 1e-12);
    assert!((v["pearson_r"].as_f64().unwrap() - 0.955_405_091_575_308_8).abs() < 1e-12);
    assert_eq!(v["metadata_summary"]["count"], 12);
    assert_eq!(d.parameters["metadata_unit"], "degC");
    assert_eq!(
        d.parameters["association_type"],
        "continuous_metadata_continuous_target"
    );
    let site = metric(&report, "association.metadata_target", "site");
    // scipy.stats.f_oneway F = 0.010218968855369917.
    assert!(
        (site.value.as_ref().unwrap()["statistic"].as_f64().unwrap() - 0.010_218_968_855_369_917)
            .abs()
            < 1e-9
    );
    // NumPy 2.2.6 default_rng(derived seed).permutation(12) x 999 counts:
    // instrument b=19, site b=902, temperature (|rho|) b=0.
    let expect = [
        ("instrument", 19, 0.04, 0.03),
        ("site", 902, 0.903, 0.903),
        ("temperature", 0, 0.003, 0.003),
    ];
    for (name, b, holm, bh) in expect {
        let t = metric(&report, "association.metadata_target_test", name);
        let value = t.value.as_ref().unwrap();
        assert_eq!(value["n_at_least_observed"], b, "{name}");
        // statsmodels multipletests: holm and fdr_bh on [0.02, 0.903, 0.001].
        assert!(
            (value["p_value_holm"].as_f64().unwrap() - holm).abs() < 1e-12,
            "{name}"
        );
        assert!(
            (value["p_value_bh_exploratory"].as_f64().unwrap() - bh).abs() < 1e-12,
            "{name}"
        );
        assert_eq!(value["multiplicity_available"], true);
    }
    let temperature = metric(&report, "association.metadata_target_test", "temperature");
    assert_eq!(plan(temperature)["seed"], "6736674062961124003");
    assert_eq!(plan(temperature)["statistic"], "abs_spearman_rho_two_sided");
    // 12 distinct values on both sides: 12! arrangements, not enumerated.
    assert_eq!(
        plan(temperature)["resolution_basis"],
        "lower_bound_from_combinatorial_bound"
    );
    // Site: 12!/(6!6!) = 924 arrangements; brute force minimal p = 2/924.
    let site_test = metric(&report, "association.metadata_target_test", "site");
    assert_eq!(plan(site_test)["resolution_basis"], "exact_enumeration");
    assert_eq!(plan(site_test)["n_enumerated_arrangements"], 924);
    assert!(
        (plan(site_test)["exact_minimum_p_value"].as_f64().unwrap() - 2.0 / 924.0).abs() < 1e-15
    );
    let family = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "association.metadata_target_family")
        .unwrap();
    let fv = family.value.as_ref().unwrap();
    assert_eq!(fv["family_size"], 3);
    assert_eq!(fv["exploratory_secondary"]["method"], "benjamini_hochberg");
    assert_eq!(fv["exploratory_secondary"]["used_for_findings"], false);
    // Holm rejects instrument and temperature only; BH never adds findings.
    let rejected: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.rule_id == "association.metadata_target.v1")
        .collect();
    assert_eq!(rejected.len(), 2);
}

#[test]
fn real_methods_continuous_metadata_by_target_class_matches_scipy_and_numpy() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = dataset(
        &[0, 0, 0, 0, 0, 0, 0],
        &[0., 0., 1., 1., 1., 1., 0.],
        TargetKind::Categorical,
    );
    input = with_typed_metadata(input, &[], &[18.0, 18.5, 21.0, 22.5, 21.9, 22.8, 18.9]);
    let report = analyze(&input, &provider);
    let d = metric(&report, "association.metadata_target", "temperature");
    let v = d.value.as_ref().unwrap();
    // eta^2 of temperature by class; scipy f_oneway F = 47.92141820443715.
    assert!((v["effect_size"].as_f64().unwrap() - 0.905_520_294_624_668_2).abs() < 1e-12);
    assert!((v["statistic"].as_f64().unwrap() - 47.921_418_204_437_15).abs() < 1e-9);
    assert_eq!(v["classes"][0]["metadata_summary"]["count"], 3);
    let t = metric(&report, "association.metadata_target_test", "temperature");
    // NumPy default_rng(10572913842984848446): b = 20 over permuted temperature.
    assert_eq!(t.value.as_ref().unwrap()["n_at_least_observed"], 20);
    assert_eq!(
        plan(t)["statistic"],
        "eta_squared_of_metadata_by_target_class"
    );
    // 7!/(3!4!) = 35 arrangements; brute force minimal p = 1/35.
    assert!((plan(t)["exact_minimum_p_value"].as_f64().unwrap() - 1.0 / 35.0).abs() < 1e-15);
    // The single-instrument factor is not applicable; site is not declared.
    assert_eq!(
        metric(&report, "association.metadata_target_test", "instrument")
            .reason_code
            .as_deref(),
        Some("SINGLE_METADATA_LEVEL")
    );
    assert_eq!(
        metric(&report, "association.metadata_target", "site")
            .reason_code
            .as_deref(),
        Some("METADATA_NOT_DECLARED")
    );
}

#[test]
fn real_methods_exact_resolution_blocks_tests_a_bound_would_allow() {
    // Review P1-1: perfect 2x2 table, two identical factors (m = 2,
    // threshold 0.025). 70 arrangements but minimal exact p = 1/35.
    let Some(provider) = native() else {
        return;
    };
    let codes = [0, 0, 0, 0, 1, 1, 1, 1];
    let mut input = dataset(
        &codes,
        &[0., 0., 0., 0., 1., 1., 1., 1.],
        TargetKind::Categorical,
    );
    input.options.seed = 1;
    let site: Vec<&str> = codes
        .iter()
        .map(|c| if *c == 0 { "a" } else { "b" })
        .collect();
    input = with_typed_metadata(input, &site, &[]);
    let report = analyze(&input, &provider);
    for name in ["instrument", "site"] {
        let t = metric(&report, "association.metadata_target_test", name);
        assert_eq!(
            t.reason_code.as_deref(),
            Some("PERMUTATION_RESOLUTION_INSUFFICIENT"),
            "{name}"
        );
        let p = plan(t);
        assert_eq!(p["resolution_basis"], "exact_enumeration");
        assert_eq!(p["n_enumerated_arrangements"], 70);
        assert!((p["exact_minimum_p_value"].as_f64().unwrap() - 1.0 / 35.0).abs() < 1e-15);
        assert!((p["monte_carlo_step"].as_f64().unwrap() - 0.001).abs() < 1e-15);
        assert_eq!(p["executed"], false);
    }
    assert!(report
        .findings
        .iter()
        .all(|f| f.rule_id != "association.metadata_target.v1"));
}

#[test]
fn continuous_metadata_without_variation_is_not_applicable() {
    let input = with_typed_metadata(
        dataset(&D_CODES, &D_Y, TargetKind::Continuous),
        &SITE,
        &[20.0; 12],
    );
    let report = analyze(&input, &Scripted::new(4.0));
    let d = metric(&report, "association.metadata_target", "temperature");
    assert!(matches!(d.status, Availability::NotApplicable));
    assert_eq!(d.reason_code.as_deref(), Some("CONSTANT_METADATA_VALUE"));
}

#[test]
fn missing_typed_metadata_units_are_excluded_and_counted() {
    let mut input = with_typed_metadata(
        dataset(&D_CODES, &D_Y, TargetKind::Continuous),
        &SITE,
        &TEMPERATURE,
    );
    input
        .metadata
        .values
        .get_mut("s03")
        .unwrap()
        .insert("temperature".into(), None);
    input
        .metadata
        .values
        .get_mut("s04")
        .unwrap()
        .remove("temperature");
    let report = analyze(&input, &Scripted::new(4.0));
    let d = metric(&report, "association.metadata_target", "temperature");
    assert_eq!(d.denominators["n_units_missing_metadata"], 2);
    assert_eq!(d.denominators["n_units_analyzed"], 10);
}

#[test]
fn heterogeneous_units_report_the_structural_cause_first() {
    // Review P1-2: four groups each crossing two instruments are all
    // excluded; the cause is structural, not a single remaining level.
    let mut input = dataset(
        &[0, 1, 0, 1, 0, 1, 0, 1],
        &[1., 2., 3., 4., 5., 6., 7., 8.],
        TargetKind::Continuous,
    );
    input.options.independence_unit = IndependenceUnit::Group;
    for (i, s) in input.samples.iter_mut().enumerate() {
        s.independence_group = Some(format!("g{}", i / 2));
    }
    for (i, v) in input.targets[0].values.iter_mut().enumerate() {
        v.value = Some((i / 2) as f64);
    }
    let report = analyze(&input, &Scripted::new(4.0));
    for id in [
        "association.metadata_target",
        "association.metadata_target_test",
    ] {
        let m = metric(&report, id, "instrument");
        assert!(matches!(m.status, Availability::NotIdentifiable), "{id}");
        assert_eq!(
            m.reason_code.as_deref(),
            Some("METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT"),
            "{id}"
        );
        assert_eq!(m.denominators["n_units_metadata_varies_within_unit"], 4);
    }
}

#[test]
fn saturated_design_is_not_identifiable_but_stays_described() {
    // Review P1-2: one instrument per unit gives eta^2 = 1 under every
    // permutation.
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(
        &dataset(
            &[0, 1, 2, 3, 4],
            &[1., 2., 4., 8., 9.],
            TargetKind::Continuous,
        ),
        &provider,
    );
    let d = metric(&report, "association.metadata_target", "instrument");
    let v = d.value.as_ref().unwrap();
    assert!((v["effect_size"].as_f64().unwrap() - 1.0).abs() < 1e-12);
    assert_eq!(v["df2"], 0.0);
    let t = metric(&report, "association.metadata_target_test", "instrument");
    assert!(matches!(t.status, Availability::NotIdentifiable));
    assert_eq!(t.reason_code.as_deref(), Some("SATURATED_DESIGN"));
}

#[test]
fn holm_failure_keeps_the_executed_permutations_without_conclusion() {
    // Review P1-3.
    let mut provider = Scripted::new(4.0);
    provider.holm_fails = true;
    let report = analyze(&dataset(&D_CODES, &D_Y, TargetKind::Continuous), &provider);
    let t = metric(&report, "association.metadata_target_test", "instrument");
    assert!(matches!(t.status, Availability::Computed));
    let value = t.value.as_ref().unwrap();
    assert_eq!(value["p_value"], 0.01);
    assert!(value["p_value_holm"].is_null());
    assert!(value["rejects_null_at_family_alpha"].is_null());
    assert_eq!(value["multiplicity_available"], false);
    assert_eq!(value["multiplicity_reason_code"], "HOLM_SCRIPTED_FAILURE");
    assert_eq!(plan(t)["executed"], true);
    assert_eq!(plan(t)["n_permutations_executed"], 999);
    let family = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "association.metadata_target_family")
        .unwrap();
    assert_eq!(family.value.as_ref().unwrap()["holm_available"], false);
    assert!(report
        .findings
        .iter()
        .all(|f| f.rule_id != "association.metadata_target.v1"));
}

#[test]
fn units_do_not_depend_on_reference_order_or_on_selected_references() {
    // Review P0-2. A concordant second reference of s00 shares a reference
    // group with s01: s00 and s01 form one unit wherever the value appears.
    let base = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    let extra = TargetValue {
        sample_id: "s00".into(),
        value: Some(D_Y[0]),
        category: None,
        status: ReferenceStatus::Exact,
        reference_id: None,
        reference_group_id: Some("shared".into()),
    };
    let mut first = base.clone();
    first.targets[0].values[1].reference_group_id = Some("shared".into());
    first.targets[0].values.insert(0, extra.clone());
    let mut last = base.clone();
    last.targets[0].values[1].reference_group_id = Some("shared".into());
    last.targets[0].values.push(extra);
    let a = analyze(&first, &Scripted::new(4.0));
    let b = analyze(&last, &Scripted::new(4.0));
    for report in [&a, &b] {
        let t = metric(report, "association.metadata_target_test", "instrument");
        assert_eq!(t.denominators["n_independence_units"], 11);
        assert_eq!(
            t.reason_code.as_deref(),
            Some("TARGET_VARIES_WITHIN_INDEPENDENCE_UNIT")
        );
    }
    // A sample without Y still links identities: s12 shares the physical
    // sample of s00 and the individual of s01.
    let mut linked = base.clone();
    let mut bridge = sample("s12", Some("i0"));
    bridge.physical_sample_id = Some("p_s00".into());
    bridge.individual_id = Some("person".into());
    linked.samples[1].individual_id = Some("person".into());
    linked.samples.push(bridge);
    linked.metadata = MetadataTable::default();
    let report = analyze(&linked, &Scripted::new(4.0));
    let t = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(t.denominators["n_independence_units"], 11);
}

#[test]
fn report_is_invariant_to_retained_test_y() {
    // Review P0-3: retained-test Y is never read, not even by validation.
    let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
    let mut retained = sample("t1", Some("i2"));
    retained.partition = Partition::RetainedTest;
    input.samples.push(retained);
    input.sources[0].observation_ids.push("o_t1".into());
    input.sources[0].sample_ids.push("t1".into());
    input.sources[0].x.push(vec![Some(1.0)]);
    let reference = |value: Option<f64>, category: Option<&str>| TargetValue {
        sample_id: "t1".into(),
        value,
        category: category.map(str::to_owned),
        status: ReferenceStatus::Exact,
        reference_id: None,
        reference_group_id: None,
    };
    let reports: Vec<String> = [
        reference(Some(1.0), None),
        reference(Some(-1e300), None),
        reference(None, None),
        reference(Some(2.0), Some("not a number")),
    ]
    .into_iter()
    .map(|value| {
        let mut variant = input.clone();
        variant.targets[0].values.push(value);
        let report = analyze(&variant, &Scripted::new(4.0));
        assert!(report.validation.valid);
        serde_json::to_string(&report).unwrap()
    })
    .collect();
    assert!(reports.iter().all(|r| *r == reports[0]));
}

#[test]
fn root_seed_accepts_numbers_and_canonical_decimal_strings() {
    // Review P0-4. Derived seeds: independent Python FNV-1a/SplitMix64.
    let parse = |seed: &str| {
        serde_json::from_str::<Options>(&format!("{{\"seed\": {seed}}}")).map(|o| o.seed)
    };
    assert_eq!(parse("17").unwrap(), 17);
    assert_eq!(parse("\"17\"").unwrap(), 17);
    assert_eq!(parse("\"18446744073709551615\"").unwrap(), u64::MAX);
    assert_eq!(parse("18446744073709551615").unwrap(), u64::MAX);
    for bad in [
        "\"18446744073709551616\"",
        "\"-1\"",
        "\"+1\"",
        "\"017\"",
        "\"\"",
        "\" 1\"",
        "1.5",
        "-1",
    ] {
        assert!(parse(bad).is_err(), "{bad}");
    }
    let options: Options = serde_json::from_str("{\"seed\": \"9007199254740993\"}").unwrap();
    assert_eq!(
        serde_json::to_value(&options).unwrap()["seed"],
        "9007199254740993"
    );
    for (root, derived) in [
        ("18446744073709551615", "7451612999727185815"),
        ("9007199254740993", "16179578612770166967"),
    ] {
        let mut input = dataset(&D_CODES, &D_Y, TargetKind::Continuous);
        input.options.seed = root.parse().unwrap();
        let report = analyze(&input, &Scripted::new(4.0));
        let t = metric(&report, "association.metadata_target_test", "instrument");
        assert_eq!(plan(t)["seed"], derived);
    }
}

#[test]
fn real_methods_example_matches_the_wasm_goldens() {
    // Same independent NumPy/SciPy/statsmodels goldens as the WASM test.
    let Some(provider) = native() else {
        return;
    };
    let input: QualificationInput =
        serde_json::from_str(include_str!("../../../examples/metadata_association.json")).unwrap();
    let report = analyze(&input, &provider);
    for (name, b, holm, bh) in [
        ("instrument", 25, 0.078, 0.052),
        ("campaign", 409, 0.82, 0.546_666_666_666_666_6),
        ("site", 910, 0.911, 0.911),
        ("temperature", 0, 0.004, 0.004),
    ] {
        let value = metric(&report, "association.metadata_target_test", name)
            .value
            .clone()
            .unwrap();
        assert_eq!(value["n_at_least_observed"], b, "{name}");
        assert!((value["p_value_holm"].as_f64().unwrap() - holm).abs() < 1e-12);
        assert!((value["p_value_bh_exploratory"].as_f64().unwrap() - bh).abs() < 1e-12);
    }
    let mut big = input.clone();
    big.options.seed = 9_007_199_254_740_993;
    let report = analyze(&big, &provider);
    let t = metric(&report, "association.metadata_target_test", "instrument");
    assert_eq!(plan(t)["seed"], "11028598969094618448");
}

#[test]
fn real_methods_association_follows_the_supported_numerical_domain() {
    // Rules 13/15: inside D (nonzero |x| in [2^-256, 2^256], spread <= 2^32)
    // metadata and targets scaled by 2^k or shifted by 2^200 give the same
    // effects, counts and plans; outside D every metric of the affected pair
    // is unsupported with NUMERICAL_DOMAIN_EXCEEDED.
    let Some(provider) = native() else {
        return;
    };
    let summary = |input: &QualificationInput| {
        let report = analyze(input, &provider);
        ["instrument", "site", "temperature"]
            .iter()
            .map(|name| {
                let d = metric(&report, "association.metadata_target", name);
                let t = metric(&report, "association.metadata_target_test", name);
                assert!(
                    d.value.is_some(),
                    "{name}: {:?} {:?}",
                    d.status,
                    d.reason_code
                );
                assert!(
                    t.value.is_some(),
                    "{name}: {:?} {:?}",
                    t.status,
                    t.reason_code
                );
                (
                    d.value.as_ref().unwrap()["effect_size"].as_f64().unwrap(),
                    t.value.as_ref().unwrap()["n_at_least_observed"].clone(),
                    plan(t)["exact_minimum_p_value"].clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    // Integer-valued data (Y * 100, temperature * 10) are exact at every
    // scale used here.
    let y: Vec<f64> = D_Y.iter().map(|v| (v * 100.0).round()).collect();
    let t: Vec<f64> = TEMPERATURE.iter().map(|v| (v * 10.0).round()).collect();
    let base = with_typed_metadata(dataset(&D_CODES, &y, TargetKind::Continuous), &SITE, &t);
    let reference = summary(&base);
    let scaled = |k: i32| {
        let mut input = base.clone();
        for v in &mut input.targets[0].values {
            v.value = v.value.map(|x| x * 2f64.powi(k));
        }
        for row in input.metadata.values.values_mut() {
            if let Some(Some(MetadataValue::Number(t))) = row.get_mut("temperature") {
                *t *= 2f64.powi(k);
            }
        }
        input
    };
    for k in [-240, -100, 100, 240] {
        let got = summary(&scaled(k));
        for (a, b) in got.iter().zip(&reference) {
            assert!((a.0 - b.0).abs() <= 1e-12 * b.0.abs(), "k={k}");
            assert_eq!(a.1, b.1, "k={k}");
            assert_eq!(a.2, b.2, "k={k}");
        }
    }
    // Translation of the covariate by 2^200 (a multiple of its ulp 2^148).
    let mut input = base.clone();
    for row in input.metadata.values.values_mut() {
        if let Some(Some(MetadataValue::Number(t))) = row.get_mut("temperature") {
            *t = 2f64.powi(200) + *t * 2f64.powi(150);
        }
    }
    let got = summary(&input);
    assert!((got[2].0 - reference[2].0).abs() <= 1e-12);
    assert_eq!(got[2].1, reference[2].1);
    // Outside D: targets at 2^300 refuse the target pairs; a covariate with
    // a spread above 2^32 refuses only its own pair.
    let report = analyze(&scaled(300), &provider);
    for name in ["instrument", "site", "temperature"] {
        for id in [
            "association.metadata_target",
            "association.metadata_target_test",
        ] {
            let m = metric(&report, id, name);
            assert!(matches!(m.status, Availability::Unsupported), "{name} {id}");
            assert_eq!(m.reason_code.as_deref(), Some("NUMERICAL_DOMAIN_EXCEEDED"));
            assert!(m.value.is_none());
            assert_eq!(
                m.parameters["numerical_domain"]["supported_domain"]["nonzero_abs_max"],
                "2^256"
            );
        }
    }
    let mut wide = base.clone();
    wide.metadata
        .values
        .get_mut("s00")
        .unwrap()
        .insert("temperature".into(), Some(MetadataValue::Number(1e-30)));
    let report = analyze(&wide, &provider);
    let d = metric(&report, "association.metadata_target", "temperature");
    assert_eq!(d.reason_code.as_deref(), Some("NUMERICAL_DOMAIN_EXCEEDED"));
    assert!(matches!(
        metric(&report, "association.metadata_target_test", "instrument").status,
        Availability::Computed
    ));
}
