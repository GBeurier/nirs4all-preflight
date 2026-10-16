//! Domain-shift protocol. Numerical cases run the real Methods library
//! (N4M_LIBRARY_PATH) and compare against goldens computed independently with
//! NumPy 2.2.6 / SciPy 1.15.3 (scipy.spatial.distance.cdist energy distances,
//! numpy.linalg.svd PCA with out-of-fold limits from numpy.quantile, the seed
//! derivation re-implemented in Python, numpy.random.default_rng(seed)
//! permutation counts and a hand-written Holm step-down). The generator is
//! recorded in the comments of each constant.
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use serde_json::Value;
use std::cell::RefCell;

/// 14 development spectra (8 bands): s00-s07 instrument A, s08-s13 instrument
/// B (B carries a band shift); campaigns crossed with instruments. Generated
/// with numpy.random.default_rng(20261013), rounded to 4 decimals.
const X: [[f64; 8]; 14] = [
    [
        0.1013, 0.3798, 0.9195, 1.0954, 0.6984, 0.2348, 0.0169, 0.0261,
    ],
    [
        0.0773, 0.3917, 0.9632, 1.1229, 0.7265, 0.2569, 0.066, -0.0056,
    ],
    [
        0.0624, 0.2294, 0.5618, 0.6738, 0.396, 0.1429, 0.0196, 0.0019,
    ],
    [
        0.0463, 0.2583, 0.5777, 0.7412, 0.4484, 0.1665, 0.0186, 0.024,
    ],
    [
        0.1036, 0.4032, 0.9938, 1.1816, 0.7431, 0.2349, 0.0645, 0.0043,
    ],
    [
        0.0985, 0.3735, 0.8765, 1.0147, 0.6377, 0.2112, 0.0698, -0.025,
    ],
    [
        0.0468, 0.2071, 0.439, 0.5658, 0.3511, 0.1205, 0.0286, -0.0033,
    ],
    [0.0438, 0.2814, 0.5898, 0.6877, 0.419, 0.1576, 0.0458, 0.026],
    [
        0.0758, 0.312, 0.7419, 0.9422, 0.8405, 0.7524, 0.2299, -0.0179,
    ],
    [0.0324, 0.28, 0.5586, 0.7165, 0.6898, 0.7729, 0.2772, 0.0131],
    [
        0.0709, 0.2953, 0.7258, 0.8697, 0.8798, 0.7823, 0.2101, 0.029,
    ],
    [
        0.063, 0.3496, 0.8153, 1.0344, 0.9006, 0.8017, 0.2621, 0.0189,
    ],
    [
        0.0857, 0.1598, 0.3686, 0.4482, 0.6093, 0.7131, 0.2215, -0.0194,
    ],
    [0.1009, 0.357, 0.889, 1.0802, 0.9565, 0.7797, 0.2248, 0.0038],
];
const Y: [f64; 14] = [
    7.038, 9.472, 11.53, 10.963, 9.333, 9.266, 9.028, 10.518, 9.932, 11.513, 11.658, 11.179,
    12.247, 11.77,
];
const CAMPAIGN: [usize; 14] = [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1];

fn sample(i: usize, partition: Partition) -> Sample {
    Sample {
        sample_id: format!("s{i:02}"),
        physical_sample_id: Some(format!("p{i:02}")),
        partition,
        independence_group: None,
        instrument: Some(if i < 8 { "A" } else { "B" }.into()),
        campaign: Some(format!("c{}", CAMPAIGN[i % 14] + 1)),
        individual_id: None,
        augmentation_parent_id: None,
    }
}

/// The 14 development samples plus `extra` retained-test rows (copies of
/// development spectra under new IDs) whose Y is a sentinel 999.
fn dataset(extra: usize) -> QualificationInput {
    let n = 14 + extra;
    let ids: Vec<String> = (0..n).map(|i| format!("s{i:02}")).collect();
    let samples = (0..n)
        .map(|i| {
            sample(
                i,
                if i < 14 {
                    Partition::Development
                } else {
                    Partition::RetainedTest
                },
            )
        })
        .collect();
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "x".into(),
            observation_ids: ids.iter().map(|i| format!("o_{i}")).collect(),
            sample_ids: ids.clone(),
            x: (0..n)
                .map(|i| {
                    X[i % 14]
                        .iter()
                        .map(|v| Some(*v + 0.5 * (i / 14) as f64))
                        .collect()
                })
                .collect(),
            valid_mask: None,
            axis: (0..8).map(|j| 1000.0 + 10.0 * j as f64).collect(),
            axis_unit: "nm".into(),
            signal_unit: "abs".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples,
        metadata: MetadataTable::default(),
        targets: vec![Target {
            target_id: "moisture".into(),
            kind: TargetKind::Continuous,
            values: (0..n)
                .map(|i| TargetValue {
                    sample_id: ids[i].clone(),
                    value: Some(if i < 14 { Y[i] } else { 999.0 }),
                    category: None,
                    status: ReferenceStatus::Exact,
                    reference_id: None,
                    reference_group_id: None,
                })
                .collect(),
            unit: Some("%".into()),
        }],
        options: Options {
            independence_unit: IndependenceUnit::Sample,
            exchangeable_units: true,
            seed: 42,
            snv_sensitivity: false,
            ..Options::default()
        },
    }
}

fn native() -> Option<NativeMethodsProvider> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some(NativeMethodsProvider::load(path).expect("compatible Methods ABI"))
}

fn find<'a>(
    report: &'a QualificationReport,
    id: &str,
    factor: &str,
    target: Option<&str>,
) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| {
            m.metric_id == id
                && m.parameters.get("factor").and_then(Value::as_str) == Some(factor)
                && target.is_none_or(|t| {
                    m.parameters.get("target_domain").and_then(Value::as_str) == Some(t)
                })
        })
        .unwrap_or_else(|| panic!("missing {id} {factor} {target:?}"))
}

fn family<'a>(report: &'a QualificationReport, name: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == "domain_shift.test_family" && m.parameters["family"] == name)
        .unwrap_or_else(|| panic!("missing family {name}"))
}

fn value<'a>(m: &'a Metric, key: &str) -> &'a Value {
    &m.value
        .as_ref()
        .unwrap_or_else(|| panic!("{} has no value", m.metric_id))[key]
}

fn close(actual: &Value, expected: f64) {
    let a = actual
        .as_f64()
        .unwrap_or_else(|| panic!("{actual} is not a number"));
    assert!(
        (a - expected).abs() <= 1e-9 * expected.abs().max(1.0),
        "{a} != {expected}"
    );
}

fn status(m: &Metric) -> String {
    serde_json::to_value(&m.status)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

/// Expected comparison values from the NumPy/SciPy golden script.
struct Golden {
    k: u64,
    folds: u64,
    t2_limit: f64,
    q_limit: f64,
    beyond: [u64; 3],
    centroid: [f64; 4],
    variances: [f64; 2],
    energy_squared: f64,
    median_difference: f64,
    outside: u64,
}

fn check_comparison(report: &QualificationReport, factor: &str, level: &str, g: &Golden) {
    let coverage = find(report, "domain_shift.coverage", factor, Some(level));
    assert_eq!(coverage.parameters["n_components_requested"], g.k);
    assert_eq!(coverage.parameters["n_components_effective"], g.k);
    assert_eq!(coverage.parameters["n_folds"], g.folds);
    close(value(coverage, "t2_limit"), g.t2_limit);
    close(value(coverage, "q_limit"), g.q_limit);
    assert_eq!(value(coverage, "n_target_beyond_t2_limit"), g.beyond[0]);
    assert_eq!(value(coverage, "n_target_beyond_q_limit"), g.beyond[1]);
    assert_eq!(value(coverage, "n_target_beyond_either_limit"), g.beyond[2]);
    let center = find(report, "domain_shift.center_shift", factor, Some(level));
    close(value(center, "centroid_distance"), g.centroid[0]);
    close(value(center, "reference_subspace_distance"), g.centroid[1]);
    close(value(center, "residual_distance"), g.centroid[2]);
    close(value(center, "centroid_hotelling_t2"), g.centroid[3]);
    let dispersion = find(report, "domain_shift.dispersion", factor, Some(level));
    close(
        value(dispersion, "reference_total_variance"),
        g.variances[0],
    );
    close(value(dispersion, "target_total_variance"), g.variances[1]);
    let distance = find(
        report,
        "domain_shift.distribution_distance",
        factor,
        Some(level),
    );
    close(value(distance, "energy_e"), g.energy_squared);
    close(
        value(distance, "scipy_energy_distance"),
        g.energy_squared.sqrt(),
    );
    let change = find(report, "domain_shift.target_change", factor, Some(level));
    close(value(change, "median_difference"), g.median_difference);
    assert_eq!(value(change, "n_target_outside_reference_range"), g.outside);
}

#[test]
fn real_methods_comparisons_and_tests_match_numpy_goldens() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(&dataset(0), &provider);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "domain_shift" && c.available && !c.qualified));
    check_comparison(
        &report,
        "instrument",
        "A",
        &Golden {
            k: 4,
            folds: 6,
            t2_limit: 23.820918374509468,
            q_limit: 0.0026974145909210608,
            beyond: [8, 8, 8],
            centroid: [
                0.6660419386794355,
                0.4876655850983305,
                0.45364539145742905,
                909.6105103562509,
            ],
            variances: [0.11664606566666666, 0.14428205660714283],
            energy_squared: 0.8622817622694797,
            median_difference: -2.183,
            outside: 5,
        },
    );
    check_comparison(
        &report,
        "instrument",
        "B",
        &Golden {
            k: 6,
            folds: 8,
            t2_limit: 22.727636233634133,
            q_limit: 0.001594598717644243,
            beyond: [6, 6, 6],
            centroid: [
                0.6660419386794355,
                0.5282052815237168,
                0.40572286680727304,
                1634.2892470789704,
            ],
            variances: [0.14428205660714283, 0.11664606566666666],
            energy_squared: 0.8622817622694796,
            median_difference: 2.183,
            outside: 3,
        },
    );
    check_comparison(
        &report,
        "campaign",
        "c1",
        &Golden {
            k: 5,
            folds: 7,
            t2_limit: 34.46291679481673,
            q_limit: 0.0022159834632020357,
            beyond: [0, 0, 0],
            centroid: [
                0.03395549908876843,
                0.03204298257676482,
                0.011234909254306383,
                1.1503033177076714,
            ],
            variances: [0.31168977, 0.20666427523809525],
            energy_squared: 0.06168426505535718,
            median_difference: 0.4449999999999985,
            outside: 1,
        },
    );
    // K-sample energy tests: seeds from the Python re-implementation of the
    // derivation, b from default_rng(seed).permutation(14) x 999.
    let instrument = find(&report, "domain_shift.energy_test", "instrument", None);
    let plan = &instrument.parameters["permutation_plan"];
    assert_eq!(plan["seed"], "3370720132560741253");
    assert_eq!(plan["executed"], true);
    assert_eq!(plan["restrictions"], "none_single_block");
    close(
        &plan["log10_distinct_admissible_permutations"],
        3003f64.log10(),
    );
    close(value(instrument, "statistic"), 2.9563946134953585);
    assert_eq!(value(instrument, "n_at_least_observed"), 0);
    close(value(instrument, "p_value"), 0.001);
    close(value(instrument, "p_value_holm"), 0.002);
    assert_eq!(value(instrument, "rejects_null_at_family_alpha"), true);
    let campaign = find(&report, "domain_shift.energy_test", "campaign", None);
    assert_eq!(
        campaign.parameters["permutation_plan"]["seed"],
        "6307764696871631775"
    );
    close(value(campaign, "statistic"), 0.21589492769375013);
    assert_eq!(value(campaign, "n_at_least_observed"), 894);
    close(value(campaign, "p_value_holm"), 0.895);
    let family = family(&report, "domain_factors");
    assert_eq!(value(family, "family_size"), 2);
    // Exactly one exploratory finding, for instrument, with unknown confidence.
    let detected: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|f| f.rule_id == "domain_shift.detected.v1")
        .collect();
    assert_eq!(detected.len(), 1);
    assert_eq!(detected[0].confidence, "unknown");
    assert!(detected[0].message.contains("instrument"));
    assert!(detected[0]
        .action
        .contains("Declare whether calibrations must serve new instrument levels"));
    assert!(!report
        .findings
        .iter()
        .any(|f| f.rule_id == "domain_shift.aliased_domains.v1"));
    // Crossed design: no comparison is aliased.
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(
        coverage.parameters["crossing"]["campaign"]["aliased"],
        false
    );
}

#[test]
fn analysis_is_invariant_to_input_order() {
    let Some(provider) = native() else {
        return;
    };
    let input = dataset(0);
    let mut shuffled = input.clone();
    shuffled.samples.reverse();
    let source = &mut shuffled.sources[0];
    let order: Vec<usize> = (0..14).rev().collect();
    source.observation_ids = order
        .iter()
        .map(|&i| input.sources[0].observation_ids[i].clone())
        .collect();
    source.sample_ids = order
        .iter()
        .map(|&i| input.sources[0].sample_ids[i].clone())
        .collect();
    source.x = order
        .iter()
        .map(|&i| input.sources[0].x[i].clone())
        .collect();
    shuffled.targets[0].values.reverse();
    let a = analyze(&input, &provider);
    let b = analyze(&shuffled, &provider);
    let pick = |r: &QualificationReport| -> Vec<String> {
        r.metrics
            .iter()
            .filter(|m| m.metric_id.starts_with("domain_shift."))
            .map(|m| serde_json::to_string(m).unwrap())
            .collect()
    };
    assert_eq!(pick(&a), pick(&b));
}

#[test]
fn intended_use_and_y_association_shape_the_recommendation() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = dataset(0);
    input.options.domain_shift.intended_use = Some(IntendedUse {
        new_levels: vec!["instrument".into()],
        seen_levels: vec!["campaign".into()],
    });
    let report = analyze(&input, &provider);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "domain_shift.detected.v1")
        .unwrap();
    assert!(finding.action.contains("whole instrument levels held out"));
    let associated = report.metrics.iter().any(|m| {
        m.metric_id == "association.metadata_target_test"
            && m.parameters["metadata"] == "instrument"
            && m.value
                .as_ref()
                .is_some_and(|v| v["rejects_null_at_family_alpha"] == true)
    });
    assert_eq!(finding.action.contains("overlapping Y ranges"), associated);
    input.options.domain_shift.intended_use = Some(IntendedUse {
        new_levels: vec![],
        seen_levels: vec!["instrument".into()],
    });
    let report = analyze(&input, &provider);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "domain_shift.detected.v1")
        .unwrap();
    assert!(finding
        .action
        .contains("keep every instrument level represented"));
}

#[test]
fn unknown_unit_or_undeclared_exchangeability_keeps_descriptions_without_test() {
    let Some(provider) = native() else {
        return;
    };
    for (unit, exchangeable, reason) in [
        (IndependenceUnit::Unknown, true, "INDEPENDENCE_UNIT_UNKNOWN"),
        (
            IndependenceUnit::Sample,
            false,
            "EXCHANGEABILITY_NOT_DECLARED",
        ),
    ] {
        let mut input = dataset(0);
        input.options.independence_unit = unit;
        input.options.exchangeable_units = exchangeable;
        let report = analyze(&input, &provider);
        let test = find(&report, "domain_shift.energy_test", "instrument", None);
        assert_eq!(status(test), "not_identifiable");
        assert_eq!(test.reason_code.as_deref(), Some(reason));
        assert!(test.value.is_none());
        assert_eq!(test.parameters["permutation_plan"]["executed"], false);
        assert_eq!(
            status(find(
                &report,
                "domain_shift.coverage",
                "instrument",
                Some("A")
            )),
            "computed"
        );
        assert!(!report
            .findings
            .iter()
            .any(|f| f.rule_id == "domain_shift.detected.v1"));
    }
}

#[test]
fn group_unit_spanning_levels_blocks_the_test() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = dataset(0);
    input.options.independence_unit = IndependenceUnit::Group;
    for (i, s) in input.samples.iter_mut().enumerate() {
        // Group g0 spans instruments A and B; the others stay within one.
        s.independence_group = Some(if i == 0 || i == 8 {
            "g0".into()
        } else {
            format!("g{i}")
        });
    }
    let report = analyze(&input, &provider);
    let test = find(&report, "domain_shift.energy_test", "instrument", None);
    assert_eq!(
        test.reason_code.as_deref(),
        Some("FACTOR_VARIES_WITHIN_INDEPENDENCE_UNIT")
    );
    assert_eq!(test.denominators["n_units_level_varies"], 1);
    assert_eq!(test.denominators["n_units_analyzed"], 12);
}

#[test]
fn aliased_factors_are_reported_and_tiny_designs_lack_resolution() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = dataset(0);
    for (i, s) in input.samples.iter_mut().enumerate() {
        s.campaign = Some(if i < 8 { "c1" } else { "c2" }.into());
    }
    let report = analyze(&input, &provider);
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(coverage.parameters["crossing"]["campaign"]["aliased"], true);
    assert!(report.findings.iter().any(
        |f| f.rule_id == "domain_shift.aliased_domains.v1" && f.message.contains("instrument")
    ));
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "domain_shift.detected.v1")
        .unwrap();
    assert!(finding.action.contains("aliased with campaign"));

    // Five units: C(5,2) = 10 distinct splits, resolution 1/10 > 0.05.
    let mut tiny = dataset(0);
    let keep = [0usize, 1, 2, 8, 9];
    tiny.samples = keep.iter().map(|&i| tiny.samples[i].clone()).collect();
    let source = &mut tiny.sources[0];
    source.observation_ids = keep
        .iter()
        .map(|&i| source.observation_ids[i].clone())
        .collect();
    source.sample_ids = keep.iter().map(|&i| source.sample_ids[i].clone()).collect();
    source.x = keep.iter().map(|&i| source.x[i].clone()).collect();
    tiny.targets[0].values = keep
        .iter()
        .map(|&i| tiny.targets[0].values[i].clone())
        .collect();
    let report = analyze(&tiny, &provider);
    let test = find(&report, "domain_shift.energy_test", "instrument", None);
    assert_eq!(status(test), "insufficient_data");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("PERMUTATION_RESOLUTION_INSUFFICIENT")
    );
    close(&test.parameters["permutation_plan"]["resolution"], 0.1);
    // Instrument B has two units: its reference (A) has three, A's has two.
    assert_eq!(
        status(find(
            &report,
            "domain_shift.coverage",
            "instrument",
            Some("B")
        )),
        "computed"
    );
    let small = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(status(small), "insufficient_data");
    assert_eq!(
        small.reason_code.as_deref(),
        Some("FEWER_THAN_THREE_REFERENCE_UNITS")
    );
}

/// Delegates to the real Methods provider and records every target value sent
/// to the summary kernel.
struct Recording {
    inner: NativeMethodsProvider,
    summaries: RefCell<Vec<f64>>,
}
impl MethodsProvider for Recording {
    fn capabilities(&self) -> Vec<Capability> {
        self.inner.capabilities()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.inner.pca(r)
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        self.inner.repeatability(r)
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        self.summaries.borrow_mut().extend(&r.values);
        self.inner.summary(r)
    }
    fn association(&self, r: &AssociationRequest) -> Result<AssociationDiagnostics, ProviderError> {
        assert!(
            r.targets.iter().all(|y| *y != 999.0),
            "retained-test Y read"
        );
        self.inner.association(r)
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        self.inner.holm_adjust(r)
    }
    fn energy_distance(
        &self,
        r: &EnergyDistanceRequest,
    ) -> Result<EnergyDistanceDiagnostics, ProviderError> {
        self.inner.energy_distance(r)
    }
    fn pca_monitor(&self, r: &PcaMonitorRequest) -> Result<PcaMonitorDiagnostics, ProviderError> {
        self.inner.pca_monitor(r)
    }
}

#[test]
fn external_audit_reads_retained_test_x_only() {
    let Some(inner) = native() else {
        return;
    };
    let provider = Recording {
        inner,
        summaries: RefCell::new(Vec::new()),
    };
    // Four retained-test rows: copies of s00-s03 offset by 0.5 absorbance.
    let input = dataset(4);
    let report = analyze(&input, &provider);
    let audit = find(&report, "domain_shift.energy_test", "partition", None);
    assert_eq!(status(audit), "not_applicable");
    assert_eq!(
        audit.reason_code.as_deref(),
        Some("EXTERNAL_DOMAIN_AUDIT_NOT_DECLARED")
    );

    let mut input = dataset(4);
    input.options.domain_shift.external_domain_audit = true;
    let report = analyze(&input, &provider);
    let coverage = find(
        &report,
        "domain_shift.coverage",
        "partition",
        Some("retained_test"),
    );
    assert_eq!(
        coverage.population_id,
        "development_real_vs_retained_test_real"
    );
    assert_eq!(coverage.parameters["test_access"], "X_only_no_fit_no_Y");
    assert_eq!(coverage.denominators["n_reference_units"], 14);
    assert_eq!(coverage.denominators["n_target_units"], 4);
    // Offset copies lie outside the development residual range.
    assert_eq!(value(coverage, "n_target_beyond_either_limit"), 4);
    let change = find(
        &report,
        "domain_shift.target_change",
        "partition",
        Some("retained_test"),
    );
    assert_eq!(
        change.reason_code.as_deref(),
        Some("RETAINED_TEST_Y_NEVER_READ")
    );
    let test = find(&report, "domain_shift.energy_test", "partition", None);
    assert_eq!(test.parameters["family"], "external_domain_audit");
    assert!(provider.summaries.borrow().iter().all(|y| *y != 999.0));
    // The audit never shrinks the development family.
    let family = family(&report, "domain_factors");
    assert_eq!(value(family, "family_size"), 2);
    for f in report
        .findings
        .iter()
        .filter(|f| f.rule_id == "domain_shift.external_domain_audit.v1")
    {
        assert_eq!(f.severity, "info");
        assert!(f.action.contains("do not tune"));
    }
}

#[test]
fn unavailable_provider_reports_unsupported_without_values() {
    let report = analyze(&dataset(0), &UnavailableMethodsProvider);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "domain_shift" && !c.available));
    let test = find(&report, "domain_shift.energy_test", "instrument", None);
    assert_eq!(status(test), "unsupported");
    assert!(test.value.is_none());
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(status(coverage), "unsupported");
    assert!(coverage.value.is_none());
}

#[test]
fn intended_use_must_name_known_factors_once() {
    let mut input = dataset(0);
    input.options.domain_shift.intended_use = Some(IntendedUse {
        new_levels: vec!["instrument".into()],
        seen_levels: vec!["instrument".into()],
    });
    let v = validate_input(&input);
    assert!(!v.valid && v.issues.iter().any(|i| i.code == "INVALID_INTENDED_USE"));
    input.options.domain_shift.intended_use = Some(IntendedUse {
        new_levels: vec!["site".into()],
        seen_levels: vec![],
    });
    assert!(!validate_input(&input).valid);
}

#[test]
fn single_level_factor_is_not_applicable() {
    let mut input = dataset(0);
    for s in &mut input.samples {
        s.campaign = Some("c1".into());
    }
    let report = analyze(&input, &UnavailableMethodsProvider);
    let design = find(&report, "domain_shift.design", "campaign", None);
    assert_eq!(status(design), "not_applicable");
    assert_eq!(design.reason_code.as_deref(), Some("SINGLE_DOMAIN_LEVEL"));
}

/// Two-band source: instrument A units on the line (i, 0), instrument B
/// units given by `b`; one sample per unit.
fn line_dataset(a: &[[f64; 2]], b: &[[f64; 2]]) -> QualificationInput {
    let mut input = dataset(0);
    let rows: Vec<[f64; 2]> = a.iter().chain(b).copied().collect();
    let n = rows.len();
    let ids: Vec<String> = (0..n).map(|i| format!("s{i:02}")).collect();
    input.samples = (0..n)
        .map(|i| {
            let mut s = sample(i % 14, Partition::Development);
            s.sample_id = ids[i].clone();
            s.physical_sample_id = Some(format!("p{i:02}"));
            s.instrument = Some(if i < a.len() { "A" } else { "B" }.into());
            s.campaign = Some("c1".into());
            s
        })
        .collect();
    let source = &mut input.sources[0];
    source.observation_ids = ids.iter().map(|i| format!("o_{i}")).collect();
    source.sample_ids = ids.clone();
    source.x = rows
        .iter()
        .map(|r| r.iter().map(|v| Some(*v)).collect())
        .collect();
    source.axis = vec![1000.0, 1010.0];
    input.targets.clear();
    input
}

#[test]
fn residual_outside_a_residual_free_reference_is_counted_and_k_follows_rank() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10 P0-2: the reference A has no residual variance (rank 1 in
    // two bands); B rows (0, 100) and (1, 100) leave the line, (2, 0) does not.
    let a: Vec<[f64; 2]> = (-5..=5).map(|i| [f64::from(i), 0.0]).collect();
    let report = analyze(
        &line_dataset(&a, &[[0.0, 100.0], [1.0, 100.0], [2.0, 0.0]]),
        &provider,
    );
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("B"));
    assert_eq!(status(coverage), "computed");
    assert_eq!(coverage.parameters["n_components_requested"], 2);
    assert_eq!(coverage.parameters["n_components_effective"], 1);
    assert_eq!(value(coverage, "q_limit"), 0.0);
    // (0, 100) and (1, 100) are certainly beyond; (2, 0) lies in the
    // subspace and cannot be certified against a limit of 0: undetermined.
    assert_eq!(value(coverage, "n_target_beyond_q_limit"), 2);
    assert_eq!(value(coverage, "n_target_undetermined_q"), 1);
    assert!(
        value(coverage, "n_target_beyond_either_limit")
            .as_u64()
            .unwrap()
            >= 2
    );
    let center = find(
        &report,
        "domain_shift.center_shift",
        "instrument",
        Some("B"),
    );
    close(value(center, "residual_distance"), 200.0 / 3.0);
    // Rank-zero reference (every A unit identical): T² is unavailable and
    // the combined count is not presented as complete; Q still flags B.
    let a = vec![[1.0, 2.0]; 5];
    let report = analyze(&line_dataset(&a, &[[1.0, 2.0], [1.0, 3.0]]), &provider);
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("B"));
    assert_eq!(coverage.parameters["n_components_effective"], 0);
    assert!(value(coverage, "t2_limit").is_null());
    assert_eq!(
        value(coverage, "t2_reason_code"),
        "REFERENCE_NUMERICAL_RANK_ZERO"
    );
    assert!(value(coverage, "n_target_beyond_either_limit").is_null());
    assert_eq!(
        value(coverage, "either_reason_code"),
        "T2_UNAVAILABLE_COMBINED_COVERAGE_INCOMPLETE"
    );
    // (1, 3) is beyond; (1, 2) equals every reference unit: its residual is
    // exactly 0 with a zero interval, so it is certainly not beyond.
    assert_eq!(value(coverage, "n_target_beyond_q_limit"), 1);
    assert_eq!(value(coverage, "n_target_undetermined_q"), 0);
    let dispersion = find(&report, "domain_shift.dispersion", "instrument", Some("B"));
    assert_eq!(
        dispersion.reason_code.as_deref(),
        Some("ZERO_REFERENCE_VARIANCE")
    );
}

#[test]
fn every_value_carries_its_unit() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(&dataset(0), &provider);
    let distance = find(
        &report,
        "domain_shift.distribution_distance",
        "instrument",
        Some("A"),
    );
    let units = &distance.parameters["value_units"];
    assert_eq!(units["energy_e"], "abs");
    assert_eq!(units["energy_e_error_bound"], "abs");
    let e = value(distance, "energy_e").as_f64().unwrap();
    let interval = value(distance, "energy_e_interval");
    assert!(interval[0].as_f64().unwrap() <= e && e <= interval[1].as_f64().unwrap());
    assert_eq!(units["scipy_energy_distance"], "(abs)^(1/2)");
    assert!(distance.unit.is_none());
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(coverage.parameters["value_units"]["q_limit"], "(abs)^2");
    assert_eq!(
        coverage.parameters["value_units"]["t2_limit"],
        "dimensionless"
    );
    // Scaling X by 100 scales energy_e by 100 and its root by 10.
    let mut scaled = dataset(0);
    for row in &mut scaled.sources[0].x {
        for v in row.iter_mut() {
            *v = v.map(|x| x * 100.0);
        }
    }
    let report = analyze(&scaled, &provider);
    let d2 = find(
        &report,
        "domain_shift.distribution_distance",
        "instrument",
        Some("A"),
    );
    close(value(d2, "energy_e"), 100.0 * 0.8622817622694797);
    close(
        value(d2, "scipy_energy_distance"),
        10.0 * 0.8622817622694797f64.sqrt(),
    );
}

#[test]
fn unequal_unit_composition_refuses_the_test_and_publishes_sizes() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10 P1-6: some instrument-A units hold two samples, the others one.
    let mut input = dataset(0);
    input.options.independence_unit = IndependenceUnit::Group;
    for (i, s) in input.samples.iter_mut().enumerate() {
        s.independence_group = Some(if i < 4 {
            format!("g{}", i / 2)
        } else {
            format!("u{i}")
        });
    }
    let report = analyze(&input, &provider);
    let test = find(&report, "domain_shift.energy_test", "instrument", None);
    assert_eq!(status(test), "not_identifiable");
    assert_eq!(
        test.reason_code.as_deref(),
        Some("UNEQUAL_UNIT_COMPOSITION")
    );
    assert_eq!(
        test.parameters["estimand"],
        "distribution_of_independence_unit_mean_spectra"
    );
    assert_eq!(test.parameters["composition"]["n_units"], 12);
    assert_eq!(test.parameters["composition"]["max_samples_per_unit"], 2);
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("A"));
    assert_eq!(coverage.parameters["composition"]["target"]["n_units"], 6);
    assert_eq!(
        coverage.parameters["composition"]["target"]["n_aggregated_samples"],
        8
    );
}

#[test]
fn audit_is_invariant_to_reserved_y_content() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10 P0-3: retained-test Y values, categories and absences, sent
    // through the JSON contract, change nothing in the report.
    let mut base = serde_json::to_value(dataset(4)).unwrap();
    base["options"]["domain_shift"]["external_domain_audit"] = serde_json::json!(true);
    let variants = [
        serde_json::json!({"sample_id": "s14", "value": 1.0, "status": "exact"}),
        serde_json::json!({"sample_id": "s14", "status": "exact"}),
        serde_json::json!({"sample_id": "s14", "category": "oops", "status": "exact"}),
        serde_json::json!({"sample_id": "s14", "value": "not a number", "status": "censored"}),
    ];
    let mut reports = Vec::new();
    for v in variants {
        let mut doc = base.clone();
        doc["targets"][0]["values"][14] = v;
        let input: QualificationInput = serde_json::from_value(doc).expect("parsed");
        let report = analyze(&input, &provider);
        assert_ne!(report.status, "failed");
        let shift: Vec<String> = report
            .metrics
            .iter()
            .filter(|m| m.metric_id.starts_with("domain_shift."))
            .map(|m| serde_json::to_string(m).unwrap())
            .collect();
        reports.push(shift);
    }
    assert!(reports.windows(2).all(|w| w[0] == w[1]));
}

/// Native provider whose energies can be forced negative (an invalid result).
struct Negative(NativeMethodsProvider);
impl MethodsProvider for Negative {
    fn capabilities(&self) -> Vec<Capability> {
        self.0.capabilities()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.0.pca(r)
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        self.0.repeatability(r)
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        self.0.summary(r)
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        self.0.holm_adjust(r)
    }
    fn energy_distance(
        &self,
        r: &EnergyDistanceRequest,
    ) -> Result<EnergyDistanceDiagnostics, ProviderError> {
        let mut d = self.0.energy_distance(r)?;
        d.energy[0][1] = -5.55e-17;
        Ok(d)
    }
    fn pca_monitor(&self, r: &PcaMonitorRequest) -> Result<PcaMonitorDiagnostics, ProviderError> {
        self.0.pca_monitor(r)
    }
}

#[test]
fn invalid_energy_is_never_published_as_computed() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10 P0-5: a negative energy (whose square root is NaN) is an
    // error, never a null under `computed`.
    let report = analyze(&dataset(0), &Negative(provider));
    let distance = find(
        &report,
        "domain_shift.distribution_distance",
        "instrument",
        Some("A"),
    );
    assert_eq!(status(distance), "error");
    assert_eq!(
        distance.reason_code.as_deref(),
        Some("INVALID_PROVIDER_RESULT")
    );
    assert!(distance.value.is_none());
}

#[test]
fn provider_budgets_refuse_before_allocation() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10 P0-4: 100 000 one-column rows in 100 000 groups would need
    // two 10^10-element g x g tables; refused before any allocation.
    let n = 100_000;
    let request = EnergyDistanceRequest {
        matrix: vec![vec![0.0]; n],
        group_codes: (0..n as i64).collect(),
        n_groups: n,
        n_permutations: 0,
        seed: 0,
    };
    let error = provider.energy_distance(&request).unwrap_err();
    assert_eq!(error.kind, ProviderErrorKind::Unsupported);
    assert_eq!(error.reason, "ENERGY_DISTANCE_WORK_BUDGET");
}

#[test]
fn magnitude_sweep_is_equivariant_inside_the_domain_and_refused_outside() {
    let Some(provider) = native() else {
        return;
    };
    // Rule 13: nonzero |x| in [2^-256, 2^256], spread <= 2^64. The data
    // span about 2^-4 .. 2^0.2, so shifts beyond about ±250 leave the domain.
    let reference = analyze(&dataset(0), &provider);
    for shift in [-1062, -1022, -500, -100, 100, 500, 1000] {
        let mut input = dataset(0);
        for row in &mut input.sources[0].x {
            for v in row.iter_mut() {
                // Two exact power-of-two factors (2^-1062 alone is subnormal).
                *v = v.map(|x| x * 2f64.powi(shift / 2) * 2f64.powi(shift - shift / 2));
            }
        }
        let report = analyze(&input, &provider);
        for m in report
            .metrics
            .iter()
            .filter(|m| m.metric_id.starts_with("domain_shift."))
        {
            // Never a value-less success.
            assert_eq!(
                m.value.is_some(),
                status(m) == "computed",
                "{}",
                m.metric_id
            );
            assert_eq!(m.parameters["numerical_domain"], NUMERICAL_DOMAIN);
        }
        let test = find(&report, "domain_shift.energy_test", "instrument", None);
        let base = find(&reference, "domain_shift.energy_test", "instrument", None);
        let c = find(&report, "domain_shift.coverage", "instrument", Some("A"));
        let c0 = find(&reference, "domain_shift.coverage", "instrument", Some("A"));
        if shift.abs() > 250 {
            for m in [test, c] {
                assert_eq!(status(m), "unsupported", "shift {shift}");
                assert_eq!(m.reason_code.as_deref(), Some("NUMERICAL_DOMAIN_EXCEEDED"));
            }
            continue;
        }
        assert_eq!(status(test), "computed");
        assert_eq!(
            value(test, "n_at_least_observed"),
            value(base, "n_at_least_observed")
        );
        assert_eq!(value(test, "p_value_holm"), value(base, "p_value_holm"));
        assert_eq!(status(c), "computed");
        for key in [
            "n_target_beyond_t2_limit",
            "n_target_beyond_q_limit",
            "n_target_undetermined_q",
            "t2_limit",
        ] {
            assert_eq!(value(c, key), value(c0, key), "{key} at shift {shift}");
        }
        assert_eq!(
            c.parameters["n_components_effective"],
            c0.parameters["n_components_effective"]
        );
    }
}

#[test]
fn audit_without_development_units_is_refused_before_indexing() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10fix: only retained-test acquisitions in the source.
    let mut input = dataset(4);
    input.options.domain_shift.external_domain_audit = true;
    let source = &mut input.sources[0];
    source.observation_ids.drain(..14);
    source.sample_ids.drain(..14);
    source.x.drain(..14);
    let report = analyze(&input, &provider);
    let audit = find(&report, "domain_shift.energy_test", "partition", None);
    assert_eq!(status(audit), "insufficient_data");
    assert_eq!(audit.reason_code.as_deref(), Some("NO_DEVELOPMENT_UNITS"));
}

#[test]
fn tiny_real_residual_and_huge_level_are_resolved_inside_the_domain() {
    let Some(provider) = native() else {
        return;
    };
    // Astra b10fix (1): (1, 2^-27) leaves the residual-free line by Q = 2^-54.
    let a: Vec<[f64; 2]> = (-5..=5).map(|i| [f64::from(i), 0.0]).collect();
    let report = analyze(
        &line_dataset(&a, &[[1.0, 2f64.powi(-27)], [3.0, 0.0]]),
        &provider,
    );
    let coverage = find(&report, "domain_shift.coverage", "instrument", Some("B"));
    assert_eq!(value(coverage, "n_target_beyond_q_limit"), 1);
    assert_eq!(value(coverage, "n_target_undetermined_q"), 1);
    // Astra b10fix (2, 4): a 2^60 reference level does not erase the unit
    // differences of the targets [0], [1]: dispersion 0.5, energy computed
    // from local differences.
    let huge: Vec<[f64; 2]> = (-5..=5)
        .map(|i| [2f64.powi(60) + 256.0 * f64::from(i), 1.0])
        .collect();
    let report = analyze(&line_dataset(&huge, &[[0.0, 1.0], [1.0, 1.0]]), &provider);
    let dispersion = find(&report, "domain_shift.dispersion", "instrument", Some("B"));
    assert_eq!(value(dispersion, "target_total_variance"), 0.5);
    let distance = find(
        &report,
        "domain_shift.distribution_distance",
        "instrument",
        Some("B"),
    );
    assert_eq!(status(distance), "computed");
    assert!(value(distance, "energy_e").as_f64().unwrap() > 0.0);
}
