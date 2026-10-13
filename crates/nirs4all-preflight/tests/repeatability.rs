//! Repeatability uncertainty protocol (repeatability_uncertainty.v1) and the
//! balanced repeat-count structure sensitivity.
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use std::cell::RefCell;

/// Records requests; returns shape-valid placeholder results.
#[derive(Default)]
struct Spy {
    variance: RefCell<Vec<VarianceComponentsRequest>>,
    pca: RefCell<Vec<PcaRequest>>,
    /// REML band status to return (0 by default).
    reml_status: Option<i32>,
    /// Provider failure to return instead of a result.
    error: Option<ProviderError>,
}
impl MethodsProvider for Spy {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.pca.borrow_mut().push(r.clone());
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; r.n_components],
            scores: vec![vec![0.0; r.n_components]; r.matrix.len()],
            full_moments: [2.0, 2.0],
            backend_version: "spy".into(),
        })
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        let p = r.matrix[0].len();
        Ok(RepeatabilityDiagnostics {
            pooled_sd: vec![Some(0.1); p],
            icc: vec![None; p],
            n_complete_groups: vec![2; p],
            band_status: vec![2; p],
            backend_version: "spy".into(),
        })
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        Ok(SummaryDiagnostics {
            count: r.values.len(),
            min: 1.0,
            max: 1.0,
            mean: 1.0,
            sample_sd: None,
            q25: 1.0,
            median: 1.0,
            q75: 1.0,
            backend_version: "spy".into(),
        })
    }
    fn variance_components(
        &self,
        r: &VarianceComponentsRequest,
    ) -> Result<VarianceComponentsDiagnostics, ProviderError> {
        self.variance.borrow_mut().push(r.clone());
        if let Some(e) = &self.error {
            return Err(e.clone());
        }
        let p = r.matrix[0].len();
        let status = self.reml_status.unwrap_or(0);
        let usable = matches!(status, 0 | 2 | 4);
        Ok(VarianceComponentsDiagnostics {
            sigma2_between: vec![Some(1.0); p],
            sigma2_within: vec![Some(1.0); p],
            icc: vec![usable.then_some(0.5); p],
            reml_log_likelihood: vec![Some(-1.0); p],
            n_groups: vec![2; p],
            n_observations: vec![4; p],
            reml_candidates: vec![1; p],
            bisection_iterations: vec![50; p],
            status: vec![status; p],
            sd_ci_chi_square: vec![[Some(0.5), Some(2.0)]; p],
            icc_ci_exact_f: vec![[Some(0.1), Some(0.9)]; p],
            sd_ci_bootstrap: vec![[Some(0.6), Some(1.5)]; p],
            icc_ci_bootstrap: vec![[Some(0.2), Some(0.8)]; p],
            n_valid_replicates: vec![r.n_bootstrap; p],
            interval_status: vec![0; p],
            backend_version: "spy".into(),
        })
    }
}

fn sample(id: &str, instrument: &str) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: Some(format!("p-{id}")),
        partition: Partition::Development,
        independence_group: None,
        instrument: Some(instrument.into()),
        campaign: Some("c".into()),
        individual_id: None,
        augmentation_parent_id: None,
    }
}

/// Context "a": 24 samples with 1..=4 rescans each (singletons included).
/// Band 0 = i/10 + a zero-sum repeat pattern; band 1 = 2 + the same pattern,
/// so every sample mean of band 1 equals 2 (between variance exactly 0).
/// Context "b": the balanced 4 x 3 design of the Methods reference case B.
fn design() -> QualificationInput {
    let mut samples = Vec::new();
    let mut source = SpectralSource {
        source_id: "nir".into(),
        observation_ids: vec![],
        sample_ids: vec![],
        x: vec![],
        valid_mask: None,
        axis: vec![1000.0, 1002.0],
        axis_unit: "nm".into(),
        signal_unit: "absorbance".into(),
        signal_type: "absorbance".into(),
        repetition_types: Some(vec![]),
    };
    let mut push = |id: &str, x: Vec<f64>| {
        source.observation_ids.push(format!("o{}", source.x.len()));
        source.sample_ids.push(id.into());
        source.x.push(x.into_iter().map(Some).collect());
        source
            .repetition_types
            .as_mut()
            .unwrap()
            .push(RepetitionType::Rescan);
    };
    let patterns: [&[f64]; 4] = [
        &[0.0],
        &[-0.01, 0.01],
        &[-0.01, 0.0, 0.01],
        &[-0.02, -0.01, 0.01, 0.02],
    ];
    for i in 0..24 {
        let id = format!("a{i}");
        samples.push(sample(&id, "a"));
        for d in patterns[i % 4] {
            push(&id, vec![0.1 * i as f64 + d, 2.0 + d]);
        }
    }
    let b = [
        [1.0, 1.2, 0.9],
        [2.0, 2.3, 2.1],
        [0.2, 0.1, 0.5],
        [1.4, 1.6, 1.3],
    ];
    for (i, values) in b.iter().enumerate() {
        let id = format!("b{i}");
        samples.push(sample(&id, "b"));
        for &v in values {
            push(&id, vec![v, v]);
        }
    }
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![source],
        samples,
        targets: vec![],
        metadata: MetadataTable::default(),
        options: Options::default(),
    }
}

fn find<'a>(report: &'a QualificationReport, id: &str, instrument: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id && m.parameters.get("instrument") == Some(&instrument.into()))
        .unwrap_or_else(|| panic!("missing {id} for {instrument}"))
}

fn status(m: &Metric) -> String {
    serde_json::to_value(&m.status)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn unknown_unit_keeps_chi_square_but_not_identifiable_icc_intervals() {
    let spy = Spy::default();
    let report = analyze(&design(), &spy);
    let requests = spy.variance.borrow();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|r| r.n_bootstrap == 0 && r.cluster_ids.is_none()));
    // Singletons stay in the request: 24 groups, 60 observations.
    assert_eq!(requests[0].group_ids.len(), 60);
    assert_eq!(requests[0].group_ids.iter().max(), Some(&23));
    assert_eq!(
        status(find(&report, "measurement.icc_1_reml", "a")),
        "computed"
    );
    assert_eq!(
        status(find(
            &report,
            "measurement.repeatability_sd_ci_chi_square",
            "a"
        )),
        "computed"
    );
    for id in [
        "measurement.icc_1_1_ci_exact_f",
        "measurement.repeatability_sd_ci_cluster_bootstrap",
        "measurement.icc_1_reml_ci_cluster_bootstrap",
    ] {
        let m = find(&report, id, "a");
        assert_eq!(status(m), "not_identifiable");
        assert_eq!(m.reason_code.as_deref(), Some("INDEPENDENCE_UNIT_UNKNOWN"));
    }
    let counts = find(&report, "measurement.repeat_counts", "a");
    let value = counts.value.as_ref().unwrap();
    assert_eq!(value["n_groups"], 24);
    assert_eq!(value["n_repeated_groups"], 18);
    assert_eq!(
        value["histogram"],
        serde_json::json!([
            {"r": 1, "n_groups": 6}, {"r": 2, "n_groups": 6},
            {"r": 3, "n_groups": 6}, {"r": 4, "n_groups": 6}
        ])
    );
}

#[test]
fn declared_units_link_individuals_and_gate_small_contexts() {
    let mut input = design();
    input.options.independence_unit = IndependenceUnit::Sample;
    input.samples[0].individual_id = Some("same".into());
    input.samples[1].individual_id = Some("same".into());
    let spy = Spy::default();
    let report = analyze(&input, &spy);
    let requests = spy.variance.borrow();
    let a = &requests[0];
    assert_eq!(a.n_bootstrap, 999);
    let clusters = a.cluster_ids.as_ref().unwrap();
    // Rows of a0 (1 row) and a1 (2 rows) share one resampling unit.
    assert_eq!(clusters[0], clusters[1]);
    assert_eq!(clusters[1], clusters[2]);
    assert_ne!(clusters[2], clusters[3]);
    assert_eq!(
        clusters
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        23
    );
    // Context b has 4 units: below the 20-unit minimum, no bootstrap.
    assert_eq!(requests[1].n_bootstrap, 0);
    let boot = find(&report, "measurement.icc_1_reml_ci_cluster_bootstrap", "b");
    assert_eq!(
        boot.reason_code.as_deref(),
        Some("FEWER_THAN_20_RESAMPLING_UNITS")
    );
    let plan = &find(&report, "measurement.icc_1_reml_ci_cluster_bootstrap", "a").parameters
        ["bootstrap_plan"];
    assert_eq!(plan["n_resampling_units"], 23);
    assert_eq!(plan["seed"], a.seed.to_string());
    // The seed is stable and depends on the root seed.
    let again = Spy::default();
    analyze(&input, &again);
    assert_eq!(again.variance.borrow()[0].seed, a.seed);
    input.options.seed = 7;
    let other = Spy::default();
    analyze(&input, &other);
    assert_ne!(other.variance.borrow()[0].seed, a.seed);
}

#[test]
fn group_unit_without_declared_group_is_not_identifiable() {
    let mut input = design();
    input.options.independence_unit = IndependenceUnit::Group;
    let report = analyze(&input, &Spy::default());
    let m = find(
        &report,
        "measurement.repeatability_sd_ci_cluster_bootstrap",
        "a",
    );
    assert_eq!(m.reason_code.as_deref(), Some("MISSING_INDEPENDENCE_GROUP"));
}

#[test]
fn capability_requires_variance_components_and_summary() {
    let available = |ids: &[&str]| {
        struct Caps(Vec<String>);
        impl MethodsProvider for Caps {
            fn capabilities(&self) -> Vec<Capability> {
                self.0
                    .iter()
                    .map(|id| Capability {
                        capability_id: id.clone(),
                        available: true,
                        qualified: false,
                        reason: None,
                    })
                    .collect()
            }
            fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
                unreachable!()
            }
            fn repeatability(
                &self,
                _: &RepeatabilityRequest,
            ) -> Result<RepeatabilityDiagnostics, ProviderError> {
                unreachable!()
            }
        }
        capabilities(&Caps(ids.iter().map(|s| s.to_string()).collect()))
            .into_iter()
            .find(|c| c.capability_id == "repeatability_uncertainty")
            .unwrap()
    };
    let both = available(&["methods.variance_components", "methods.summary"]);
    assert!(both.available && !both.qualified);
    let missing = available(&["methods.summary"]);
    assert!(!missing.available);
    assert_eq!(
        missing.reason.as_deref(),
        Some("VARIANCE_COMPONENTS_PROVIDER_NOT_CONFIGURED")
    );
}

#[test]
fn balanced_sensitivity_subsamples_to_min_count_without_dropping_samples() {
    let spy = Spy::default();
    let report = analyze(&design(), &spy);
    let m = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.balanced_repeat_sensitivity")
        .unwrap();
    assert_eq!(status(m), "computed");
    assert_eq!(m.parameters["r_star"], 1);
    assert_eq!(m.denominators["n_aggregated_samples"], 28);
    assert_eq!(m.denominators["n_aggregated_samples_subsampled"], 22);
    // Canonical PCA, balanced PCA, SNV PCA: the balanced matrix keeps all 28
    // samples, each from one acquisition of its own sample.
    let pca = spy.pca.borrow();
    let balanced = &pca[1].matrix;
    assert_eq!(balanced.len(), 28);
    let order = &pca[0].sample_ids;
    let x = &design().sources[0];
    for (row, id) in balanced.iter().zip(order) {
        let own: Vec<f64> = x
            .sample_ids
            .iter()
            .zip(&x.x)
            .filter(|(sid, _)| *sid == id)
            .map(|(_, v)| v[1].unwrap())
            .collect();
        assert!(own.contains(&row[1]), "{id}");
    }
}

/// 40 physical objects x 3 rescans, `n_individuals` individuals (round robin).
fn linked_design(n_individuals: usize) -> QualificationInput {
    let mut input = design();
    let source = &mut input.sources[0];
    source.observation_ids.clear();
    source.sample_ids.clear();
    source.x.clear();
    source.repetition_types = Some(vec![]);
    input.samples.clear();
    for i in 0..40 {
        let id = format!("o{i}");
        let mut s = sample(&id, "a");
        if n_individuals > 0 {
            s.individual_id = Some(format!("ind{}", i % n_individuals));
        }
        input.samples.push(s);
        for d in [-0.01, 0.0, 0.01] {
            source.observation_ids.push(format!("x{}", source.x.len()));
            source.sample_ids.push(id.clone());
            source.x.push(vec![Some(0.1 * i as f64 + d), Some(2.0 + d)]);
            source
                .repetition_types
                .as_mut()
                .unwrap()
                .push(RepetitionType::Rescan);
        }
    }
    input.options.independence_unit = IndependenceUnit::Sample;
    input
}

/// P0-2: physical objects sharing individuals are not independent groups,
/// so the Searle F interval is not exact; it becomes unsupported.
#[test]
fn exact_f_interval_requires_one_independence_unit_per_group() {
    let report = analyze(&linked_design(4), &Spy::default());
    let f = find(&report, "measurement.icc_1_1_ci_exact_f", "a");
    assert_eq!(status(f), "unsupported");
    assert_eq!(
        f.reason_code.as_deref(),
        Some("GROUPS_SHARE_INDEPENDENCE_UNIT")
    );
    assert_eq!(
        f.parameters["groups_share_independence_unit_per_band"],
        serde_json::json!([true, true])
    );
    let boot = find(&report, "measurement.icc_1_reml_ci_cluster_bootstrap", "a");
    assert_eq!(
        boot.reason_code.as_deref(),
        Some("FEWER_THAN_20_RESAMPLING_UNITS")
    );
    // Without links every object is its own unit and the interval is kept.
    let independent = analyze(&linked_design(0), &Spy::default());
    assert_eq!(
        status(find(&independent, "measurement.icc_1_1_ci_exact_f", "a")),
        "computed"
    );
}

/// P0-3: a reference-group unit without reference identities is refused,
/// never replaced by physical objects.
#[test]
fn reference_group_unit_requires_reference_identities() {
    let mut input = design();
    input.options.independence_unit = IndependenceUnit::ReferenceGroup;
    let spy = Spy::default();
    let report = analyze(&input, &spy);
    assert!(spy
        .variance
        .borrow()
        .iter()
        .all(|r| r.n_bootstrap == 0 && r.cluster_ids.is_none()));
    for id in [
        "measurement.icc_1_1_ci_exact_f",
        "measurement.repeatability_sd_ci_cluster_bootstrap",
        "measurement.icc_1_reml_ci_cluster_bootstrap",
    ] {
        let m = find(&report, id, "a");
        assert_eq!(status(m), "not_identifiable", "{id}");
        assert_eq!(m.reason_code.as_deref(), Some("MISSING_REFERENCE_GROUP"));
    }
}

/// P1-4: units are counted per band after the masks; a band where only ten
/// units contribute is not published even though the context has 40.
#[test]
fn bootstrap_threshold_applies_to_units_contributing_per_band() {
    let mut input = linked_design(0);
    let source = &mut input.sources[0];
    let mut mask = vec![vec![true, true]; source.x.len()];
    for (row, id) in source.sample_ids.iter().enumerate() {
        let i: usize = id[1..].parse().unwrap();
        if i >= 10 {
            mask[row][1] = false;
        }
    }
    source.valid_mask = Some(mask);
    let report = analyze(&input, &Spy::default());
    for id in [
        "measurement.repeatability_sd_ci_cluster_bootstrap",
        "measurement.icc_1_reml_ci_cluster_bootstrap",
    ] {
        let m = find(&report, id, "a");
        assert_eq!(status(m), "computed", "{id}");
        assert_eq!(
            m.parameters["band_reason"],
            serde_json::json!([null, "FEWER_THAN_20_RESAMPLING_UNITS"])
        );
        assert!(m.value.as_ref().unwrap()["lower"][1].is_null());
        let plan = &m.parameters["bootstrap_plan"];
        assert_eq!(
            plan["n_units_with_valid_value_per_band"],
            serde_json::json!([40, 10])
        );
        assert_eq!(
            plan["n_units_with_within_df_per_band"],
            serde_json::json!([40, 10])
        );
    }
}

/// P1-7: non-convergence and numerical failures are errors, not data
/// shortages or missing capabilities; per-band reasons are kept.
#[test]
fn convergence_and_numerical_failures_are_reported_as_errors() {
    let input = linked_design(0);
    let spy = Spy {
        reml_status: Some(5),
        ..Spy::default()
    };
    let report = analyze(&input, &spy);
    let reml = find(&report, "measurement.icc_1_reml", "a");
    assert_eq!(status(reml), "error");
    assert_eq!(reml.reason_code.as_deref(), Some("REML_NOT_CONVERGED"));
    assert_eq!(
        reml.parameters["band_reason"],
        serde_json::json!(["REML_NOT_CONVERGED", "REML_NOT_CONVERGED"])
    );
    let spy = Spy {
        reml_status: Some(6),
        ..Spy::default()
    };
    let report = analyze(&input, &spy);
    let reml = find(&report, "measurement.icc_1_reml", "a");
    assert_eq!(
        (status(reml).as_str(), reml.reason_code.as_deref()),
        ("error", Some("VALUE_NOT_REPRESENTABLE"))
    );
    let spy = Spy {
        error: Some(ProviderError::numerical("METHODS_STATUS_NUMERICAL_FAILURE")),
        ..Spy::default()
    };
    let report = analyze(&input, &spy);
    for id in [
        "measurement.icc_1_reml",
        "measurement.repeatability_sd_ci_chi_square",
        "measurement.icc_1_reml_ci_cluster_bootstrap",
    ] {
        assert_eq!(status(find(&report, id, "a")), "error", "{id}");
    }
    let spy = Spy {
        error: Some(ProviderError::unsupported(
            "VARIANCE_COMPONENTS_PROVIDER_NOT_CONFIGURED",
        )),
        ..Spy::default()
    };
    let report = analyze(&input, &spy);
    assert_eq!(
        status(find(&report, "measurement.icc_1_reml", "a")),
        "unsupported"
    );
}

/// Robustness sweep of the balanced-sensitivity means (engine side): every
/// object has three rescans and o0 a fourth, so r* = 3 and each balanced mean
/// averages three values. The matrix sent to PCA scales exactly with 2^k and
/// stays finite next to 1.7e308, where a plain sum would overflow.
#[test]
fn balanced_sensitivity_means_are_scale_and_offset_robust() {
    let balanced = |input: &QualificationInput| {
        let spy = Spy::default();
        analyze(input, &spy);
        let pca = spy.pca.borrow();
        pca[1].matrix.clone()
    };
    let uneven = || {
        let mut input = linked_design(0);
        let source = &mut input.sources[0];
        source.observation_ids.push("extra".into());
        source.sample_ids.push("o0".into());
        source.x.push(vec![Some(0.02), Some(2.02)]);
        source
            .repetition_types
            .as_mut()
            .unwrap()
            .push(RepetitionType::Rescan);
        input
    };
    let reference = balanced(&uneven());
    let pow2 = |k: i32| 2f64.powi(k / 2) * 2f64.powi(k - k / 2);
    for k in [-1000, -500, -100, 100, 500, 1000] {
        let mut scaled = uneven();
        for row in &mut scaled.sources[0].x {
            for v in row.iter_mut().flatten() {
                *v *= pow2(k);
            }
        }
        let got = balanced(&scaled);
        for (a, b) in got.iter().flatten().zip(reference.iter().flatten()) {
            assert!(a.is_finite() && *a == b * pow2(k), "{k}: {a} {b}");
        }
    }
    let mut far = uneven();
    for row in &mut far.sources[0].x {
        for v in row.iter_mut().flatten() {
            *v = 1.7e308 - *v * 1e292;
        }
    }
    assert!(balanced(&far)
        .iter()
        .flatten()
        .all(|v| v.is_finite() && *v > 1.6e308));
}

fn native() -> Option<NativeMethodsProvider> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some(NativeMethodsProvider::load(path).expect("compatible Methods ABI"))
}

fn rel(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * b.abs().max(1.0)
}

/// Same independent references as the Methods native test (dense REML score
/// equations, NumPy 2.5.4 / SciPy 1.18.1; numpy default_rng(12345) draws).
#[test]
fn native_variance_components_match_independent_references() {
    let Some(provider) = native() else {
        return;
    };
    let y = [1.0, 1.4, 2.2, 2.0, 2.9, 0.3, 0.9, 0.4, 0.8, 1.7, 3.1, 2.5];
    let d = provider
        .variance_components(&VarianceComponentsRequest {
            matrix: y.iter().map(|v| vec![*v]).collect(),
            group_ids: vec![0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 4, 4],
            cluster_ids: Some(vec![7, 7, 7, 7, 7, 3, 3, 3, 3, 9, 5, 5]),
            valid_mask: vec![vec![true]; 12],
            confidence: 0.95,
            n_bootstrap: 40,
            seed: 12345,
        })
        .unwrap();
    assert_eq!(d.status, vec![0]);
    assert!(rel(d.sigma2_between[0].unwrap(), 0.7446105326226952, 1e-10));
    assert!(rel(d.sigma2_within[0].unwrap(), 0.13630617544724544, 1e-10));
    assert!(rel(d.icc[0].unwrap(), 0.8452678054592837, 1e-10));
    assert!(rel(
        d.reml_log_likelihood[0].unwrap(),
        -10.963218720046495,
        1e-12
    ));
    assert!(rel(
        d.sd_ci_chi_square[0][0].unwrap(),
        0.24570003389152809,
        1e-10
    ));
    assert!(rel(
        d.sd_ci_chi_square[0][1].unwrap(),
        0.7563308737449301,
        1e-10
    ));
    assert_eq!(d.icc_ci_exact_f[0], [None, None]);
    assert_eq!(d.n_valid_replicates, vec![40]);
    assert!(rel(
        d.sd_ci_bootstrap[0][0].unwrap(),
        0.3094525017261184,
        1e-10
    ));
    assert!(rel(
        d.sd_ci_bootstrap[0][1].unwrap(),
        0.42426406871192857,
        1e-10
    ));
    assert_eq!(d.icc_ci_bootstrap[0][0], Some(0.0));
    assert!(rel(
        d.icc_ci_bootstrap[0][1].unwrap(),
        0.9233717840878614,
        1e-8
    ));
}

#[test]
fn native_engine_reports_reml_boundaries_and_balanced_equivalence() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = design();
    input.options.independence_unit = IndependenceUnit::Sample;
    let report = analyze(&input, &provider);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "repeatability_uncertainty" && c.available && !c.qualified));
    // Context a: band 1 has identical sample means -> boundary s2b = 0.
    let reml = find(&report, "measurement.icc_1_reml", "a");
    assert_eq!(status(reml), "computed");
    assert_eq!(reml.parameters["band_status"], serde_json::json!([0, 2]));
    assert_eq!(reml.parameters["n_bands_between_variance_zero"], 1);
    assert_eq!(
        reml.parameters["n_groups_per_band"],
        serde_json::json!([24, 24])
    );
    let icc = reml.value.as_ref().unwrap();
    assert!(icc[0].as_f64().unwrap() > 0.99);
    assert_eq!(icc[1].as_f64(), Some(0.0));
    let chi = find(&report, "measurement.repeatability_sd_ci_chi_square", "a");
    assert_eq!(chi.parameters["df_per_band"], serde_json::json!([36, 36]));
    // 24 units contribute to the ICC; only the 18 repeated objects carry
    // within df, below the 20-unit minimum for the SD bootstrap.
    let icc_boot = find(&report, "measurement.icc_1_reml_ci_cluster_bootstrap", "a");
    assert_eq!(status(icc_boot), "computed");
    let plan = &icc_boot.parameters["bootstrap_plan"];
    assert_eq!(
        plan["n_valid_replicates_per_band"],
        serde_json::json!([999, 999])
    );
    assert_eq!(
        plan["n_units_with_within_df_per_band"],
        serde_json::json!([18, 18])
    );
    let sd_boot = find(
        &report,
        "measurement.repeatability_sd_ci_cluster_bootstrap",
        "a",
    );
    assert_eq!(status(sd_boot), "insufficient_data");
    assert_eq!(
        sd_boot.reason_code.as_deref(),
        Some("FEWER_THAN_20_UNITS_WITH_WITHIN_DF")
    );
    assert_eq!(
        status(find(&report, "measurement.icc_1_1_ci_exact_f", "a")),
        "unsupported"
    );
    // Context b (balanced 4 x 3): REML equals ANOVA ICC(1,1); exact F
    // interval equals the SciPy 1.18.1 values for case B.
    let b = find(&report, "measurement.icc_1_reml", "b")
        .value
        .as_ref()
        .unwrap();
    let anova = 0.9547872340425532;
    assert!(rel(b[0].as_f64().unwrap(), anova, 1e-10));
    let exact = find(&report, "measurement.icc_1_1_ci_exact_f", "b")
        .value
        .as_ref()
        .unwrap();
    assert!(rel(
        exact["lower"][0].as_f64().unwrap(),
        0.7838941809128407,
        1e-10
    ));
    assert!(rel(
        exact["upper"][0].as_f64().unwrap(),
        0.9968006295172774,
        1e-10
    ));
}

/// Robustness through the actual kernel: at 2^1000 the variances overflow a
/// double, which the engine reports as a numerical error per band (never a
/// value), while the ICC-free chi-square SD interval stays representable.
#[test]
fn native_unrepresentable_variances_are_errors() {
    let Some(provider) = native() else {
        return;
    };
    let mut input = linked_design(0);
    for row in &mut input.sources[0].x {
        for v in row.iter_mut().flatten() {
            *v *= 2f64.powi(500) * 2f64.powi(500);
        }
    }
    let report = analyze(&input, &provider);
    let reml = find(&report, "measurement.icc_1_reml", "a");
    assert_eq!(status(reml), "error");
    assert_eq!(reml.reason_code.as_deref(), Some("VALUE_NOT_REPRESENTABLE"));
    assert_eq!(reml.parameters["band_status"], serde_json::json!([6, 6]));
    let chi = find(&report, "measurement.repeatability_sd_ci_chi_square", "a");
    assert_eq!(status(chi), "computed");
    assert!(chi.value.as_ref().unwrap()["lower"][0].as_f64().unwrap() > 1e297);
}
