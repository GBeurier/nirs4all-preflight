use nirs4all_preflight::*;
use serde_json::json;

fn input() -> QualificationInput {
    serde_json::from_value(json!({
        "schema_version": 1,
        "samples": [
            {"sample_id":"a", "physical_sample_id":"physical-a", "instrument":"first", "campaign":"spring"},
            {"sample_id":"b", "instrument":"second", "campaign":"summer"},
            {"sample_id":"c", "instrument":"first", "campaign":"spring"}
        ],
        "sources": [{"source_id":"nir", "observation_ids":["a1","b1","c1"], "sample_ids":["a","b","c"], "axis":[1000,1100], "x":[[1,2],[2,4],[3,5]]}],
        "metadata": {"columns":[{"name":"id_scan","kind":"categorical"},{"name":"site","kind":"categorical"}], "values":{"a":{"id_scan":"x1","site":"north"},"b":{"id_scan":"x2","site":"south"},"c":{"id_scan":"x3","site":"north"}}},
        "options": {"metadata_roles":{"id_scan":"identifier","instrument":"excluded"}}
    })).unwrap()
}

#[test]
fn metadata_roles_filter_all_shared_factors_without_changing_identities() {
    let input = input();
    assert!(validate_input(&input).valid);
    let factors: Vec<_> = input
        .metadata_factors()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(factors, ["campaign", "site"]);
    assert_eq!(
        input.samples[0].physical_sample_id.as_deref(),
        Some("physical-a")
    );
    assert_eq!(input.samples[0].instrument.as_deref(), Some("first"));
    assert_eq!(input.metadata.columns.len(), 2);
    let roundtrip: QualificationInput =
        serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
    assert_eq!(
        roundtrip.options.metadata_roles["id_scan"],
        MetadataRole::Identifier
    );
}

#[test]
fn disabled_families_are_absent_even_if_canonical_geometry_is_unavailable() {
    let mut input = input();
    input.options.analysis_families = serde_json::from_value(json!({
        "spectral_quality":false,"sensitivity":false,"repeatability":false,
        "clustering":false,"association":false,"confounding":false,"domain_shift":false,"probe":false
    })).unwrap();
    let report = analyze(&input, &UnavailableMethodsProvider);
    assert!(report.validation.valid);
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "analysis.selection"));
    assert!(report
        .metrics
        .iter()
        .any(|m| m.metric_id == "integrity.missing_cells"));
    assert!(!report.metrics.iter().any(|m| [
        "clustering.",
        "confounding.",
        "association.",
        "domain_shift.",
        "probe.",
        "measurement.",
        "intrinsic.",
        "structure.snv_",
        "structure.detrend_"
    ]
    .iter()
    .any(|prefix| m.metric_id.starts_with(prefix))));
    assert!(report
        .capabilities
        .iter()
        .filter(|c| c.capability_id == "clustering")
        .all(|c| !c.available && c.reason.as_deref() == Some("FAMILY_DISABLED")));
}

#[test]
fn native_repeat_tolerance_uses_only_calibration_technical_repeats() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = native::NativeMethodsProvider::load(&path).unwrap();
    let mut input = input();
    let source = &mut input.sources[0];
    source.axis = (0..18).map(|b| 1000.0 + 20.0 * b as f64).collect();
    source.x.clear();
    source.observation_ids.clear();
    source.sample_ids.clear();
    let mut types = Vec::new();
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        for r in 0..3 {
            source.observation_ids.push(format!("{id}-{r}"));
            source.sample_ids.push(id.to_string());
            source.x.push(
                (0..18)
                    .map(|b| {
                        Some(
                            1.0 + (b as f64 / 3.0 + i as f64).sin()
                                + 0.001 * ((b + r * 3) % 7) as f64,
                        )
                    })
                    .collect(),
            );
            types.push(RepetitionType::Rescan);
        }
    }
    source.repetition_types = Some(types);
    input.options.quasi_tolerance_from_repeats = true;
    input.options.analysis_families.probe = false;
    let report = analyze(&input, &provider);
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.quasi_duplicate_pairs")
        .unwrap();
    assert!(
        matches!(metric.status, Availability::Computed),
        "{:?}",
        metric.reason_code
    );
    assert_eq!(metric.parameters["tolerance_repeat_groups"], json!(3));
    assert_eq!(metric.parameters["tolerance_repeat_pairs"], json!(9));
    assert!(metric.parameters["tolerance"].as_f64().unwrap() > 0.0);
    let baseline = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "structure.detrend_sensitivity")
        .unwrap();
    assert!(
        matches!(baseline.status, Availability::Computed),
        "{:?}",
        baseline.reason_code
    );
    // Poison a separate retained-test physical sample with different technical
    // repeats and a test target; the development estimate must stay identical.
    let mut held_out_input = input.clone();
    let mut held_out_sample = input.samples[0].clone();
    held_out_sample.sample_id = "held-out".into();
    held_out_sample.physical_sample_id = Some("held-out-object".into());
    held_out_sample.partition = Partition::RetainedTest;
    held_out_input.samples.push(held_out_sample);
    let source = &mut held_out_input.sources[0];
    for r in 0..3 {
        source.observation_ids.push(format!("held-out-{r}"));
        source.sample_ids.push("held-out".into());
        source.x.push(
            (0..18)
                .map(|b| Some(100.0 + (r * 1000 + b) as f64))
                .collect(),
        );
        source
            .repetition_types
            .as_mut()
            .unwrap()
            .push(RepetitionType::Rescan);
    }
    held_out_input.targets.push(
        serde_json::from_value(json!({
            "target_id": "held-out-y", "kind": "continuous",
            "values": [{"sample_id": "held-out", "value": 9000.0, "status": "exact"}]
        }))
        .unwrap(),
    );
    let held_out_report = analyze(&held_out_input, &provider);
    assert!(held_out_report.validation.valid);
    let held_out_metric = held_out_report
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.quasi_duplicate_pairs")
        .unwrap();
    assert!(matches!(held_out_metric.status, Availability::Computed));
    assert_eq!(
        held_out_metric.parameters["tolerance_repeat_groups"],
        json!(3)
    );
    assert_eq!(
        held_out_metric.parameters["tolerance_repeat_pairs"],
        json!(9)
    );
    assert_eq!(
        held_out_metric.parameters["tolerance"]
            .as_f64()
            .unwrap()
            .to_bits(),
        metric.parameters["tolerance"].as_f64().unwrap().to_bits()
    );
    // Multiple acquisition contexts of one object do not satisfy the
    // minimum number of physical samples for estimating a repeat tolerance.
    for sample in &mut input.samples {
        sample.physical_sample_id = Some("one-object".into());
    }
    let refused = analyze(&input, &provider);
    assert!(refused.validation.valid);
    let tolerance = refused
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.quasi_duplicate_pairs")
        .unwrap();
    assert!(matches!(tolerance.status, Availability::InsufficientData));
    assert_eq!(
        tolerance.reason_code.as_deref(),
        Some("FEWER_THAN_THREE_TECHNICAL_REPEAT_GROUPS")
    );
}

#[test]
fn repeat_tolerance_refusals_precede_methods_calls() {
    let mut input = input();
    input.options.quasi_tolerance_from_repeats = true;
    let missing = analyze(&input, &UnavailableMethodsProvider);
    let metric = missing
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.quasi_duplicate_pairs")
        .unwrap();
    assert!(matches!(metric.status, Availability::NotApplicable));
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("TECHNICAL_REPEATS_REQUIRED_FOR_TOLERANCE")
    );

    // 142 choose 2 + 2 choose 2 + 2 choose 2 = 10,013 exact pairs.
    // An unavailable provider would refuse the first RMS request if called.
    let source = &mut input.sources[0];
    source.x.clear();
    source.observation_ids.clear();
    source.sample_ids.clear();
    source.repetition_types = Some(Vec::new());
    for (id, count) in [("a", 142), ("b", 2), ("c", 2)] {
        for row in 0..count {
            source.observation_ids.push(format!("{id}-{row}"));
            source.sample_ids.push(id.into());
            source.x.push(vec![Some(1.0), Some(2.0)]);
            source
                .repetition_types
                .as_mut()
                .unwrap()
                .push(RepetitionType::Rescan);
        }
    }
    let refused = analyze(&input, &UnavailableMethodsProvider);
    assert!(refused.validation.valid);
    let metric = refused
        .metrics
        .iter()
        .find(|m| m.metric_id == "integrity.quasi_duplicate_pairs")
        .unwrap();
    assert!(matches!(metric.status, Availability::Unsupported));
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("REPEAT_TOLERANCE_PAIR_BUDGET_EXCEEDED")
    );
}
