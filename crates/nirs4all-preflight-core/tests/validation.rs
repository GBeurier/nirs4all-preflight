use nirs4all_preflight_core::*;

fn fixture() -> QualificationInput {
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Unknown,
        sources: vec![SpectralSource {
            source_id: "s".into(),
            observation_ids: vec!["o1".into(), "o2".into()],
            sample_ids: vec!["a".into(), "b".into()],
            x: vec![vec![Some(1.0), Some(2.0)], vec![Some(3.0), Some(4.0)]],
            valid_mask: None,
            axis: vec![1000.0, 1001.0],
            axis_unit: "nm".into(),
            signal_unit: "absorbance".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples: vec![
            Sample {
                sample_id: "a".into(),
                physical_sample_id: Some("P".into()),
                partition: Partition::Development,
                independence_group: None,
                instrument: None,
                campaign: None,
                individual_id: None,
                augmentation_parent_id: None,
            },
            Sample {
                sample_id: "b".into(),
                physical_sample_id: Some("Q".into()),
                partition: Partition::RetainedTest,
                independence_group: None,
                instrument: None,
                campaign: None,
                individual_id: None,
                augmentation_parent_id: None,
            },
        ],
        targets: vec![],
        metadata: MetadataTable::default(),
        options: Options::default(),
    }
}

#[test]
fn validates_fixture_and_source_scoped_observation_ids() {
    let mut x = fixture();
    let mut second = x.sources[0].clone();
    second.source_id = "other".into();
    x.sources.push(second);
    assert!(validate_input(&x).valid);
}

#[test]
fn catches_transitive_identity_leakage_before_aggregation() {
    let mut x = fixture();
    x.samples[1].physical_sample_id = Some("P".into());
    let result = validate_input(&x);
    assert!(!result.valid);
    assert!(result.issues.iter().any(|i| i.code == "IDENTITY_LEAKAGE"));
}

#[test]
fn augmentation_parent_sample_id_links_to_physical_alias() {
    let mut x = fixture();
    x.samples[1].augmentation_parent_id = Some("a".into());
    assert!(validate_input(&x)
        .issues
        .iter()
        .any(|i| i.code == "IDENTITY_LEAKAGE"));
}

#[test]
fn reference_group_cannot_cross_test_boundary() {
    let mut x = fixture();
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        unit: Some("g".into()),
        values: vec![
            TargetValue {
                sample_id: "a".into(),
                value: Some(1.0),
                category: None,
                status: ReferenceStatus::Composite,
                reference_id: None,
                reference_group_id: Some("R".into()),
            },
            TargetValue {
                sample_id: "b".into(),
                value: Some(1.0),
                category: None,
                status: ReferenceStatus::Composite,
                reference_id: None,
                reference_group_id: Some("R".into()),
            },
        ],
    });
    assert!(validate_input(&x)
        .issues
        .iter()
        .any(|i| i.code == "REFERENCE_LEAKAGE"));
}

#[test]
fn rejects_masked_value_conflicts_and_nonfinite_axis() {
    let mut x = fixture();
    x.sources[0].x[0][0] = None;
    x.sources[0].valid_mask = Some(vec![vec![true, true], vec![true, true]]);
    x.sources[0].axis[0] = f64::NAN;
    let result = validate_input(&x);
    assert!(result
        .issues
        .iter()
        .any(|i| i.code == "MASK_VALUE_CONFLICT"));
    assert!(result.issues.iter().any(|i| i.code == "INVALID_AXIS"));
}

#[test]
fn missing_units_limit_physical_claims_without_blocking_matrix_checks() {
    let mut x = fixture();
    x.sources[0].axis_unit.clear();
    x.sources[0].signal_unit.clear();
    let result = validate_input(&x);
    assert!(result.valid);
    assert!(result
        .issues
        .iter()
        .any(|i| i.code == "UNKNOWN_UNIT" && !i.blocking));
}

#[test]
fn cell_budget_is_cumulative_across_sources() {
    let mut x = fixture();
    let mut second = x.sources[0].clone();
    second.source_id = "other".into();
    x.sources.push(second);
    x.options.max_cells = 6;
    assert!(validate_input(&x)
        .issues
        .iter()
        .any(|i| i.code == "CELL_BUDGET_EXCEEDED"));
}

#[test]
fn shared_observation_id_cannot_change_sample_across_sources() {
    let mut x = fixture();
    let mut second = x.sources[0].clone();
    second.source_id = "other".into();
    second.sample_ids.swap(0, 1);
    x.sources.push(second);
    assert!(validate_input(&x)
        .issues
        .iter()
        .any(|i| i.code == "OBSERVATION_SAMPLE_CONFLICT"));
}

#[test]
fn unknown_augmentation_parent_is_rejected() {
    let mut x = fixture();
    x.samples[0].augmentation_parent_id = Some("missing".into());
    assert!(validate_input(&x)
        .issues
        .iter()
        .any(|i| i.code == "UNKNOWN_AUGMENTATION_PARENT"));
}

fn with_metadata(metadata: serde_json::Value) -> QualificationInput {
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["metadata"] = metadata;
    serde_json::from_value(value).unwrap()
}

fn codes(input: &QualificationInput) -> Vec<(String, String, bool)> {
    validate_input(input)
        .issues
        .into_iter()
        .map(|i| (i.code, i.path, i.blocking))
        .collect()
}

#[test]
fn typed_metadata_is_validated_at_the_input_boundary() {
    let ok = with_metadata(serde_json::json!({
        "columns": [{"name": "site", "kind": "categorical"},
                    {"name": "temperature", "kind": "continuous", "unit": "degC"}],
        "values": {"a": {"site": "north", "temperature": 21.5}, "b": {"site": null}}
    }));
    assert!(validate_input(&ok).valid);
    let bad = with_metadata(serde_json::json!({
        "columns": [{"name": "site", "kind": "categorical", "unit": "m"},
                    {"name": "site", "kind": "categorical"},
                    {"name": "instrument", "kind": "categorical"},
                    {"name": " ", "kind": "categorical"},
                    {"name": "temperature", "kind": "continuous"}],
        "values": {"a": {"site": 3, "temperature": "21.5", "lot": "x"},
                   "b": {"site": ""}, "ghost": {}}
    }));
    let issues = codes(&bad);
    let has = |code: &str, path: &str| issues.iter().any(|(c, p, b)| c == code && p == path && *b);
    assert!(has("INVALID_METADATA_COLUMN", "metadata.columns[0].unit"));
    assert!(has("INVALID_METADATA_COLUMN", "metadata.columns[1].name"));
    assert!(has("INVALID_METADATA_COLUMN", "metadata.columns[2].name"));
    assert!(has("INVALID_METADATA_COLUMN", "metadata.columns[3].name"));
    assert!(has("METADATA_TYPE_MISMATCH", "metadata.values.a.site"));
    assert!(has(
        "METADATA_TYPE_MISMATCH",
        "metadata.values.a.temperature"
    ));
    assert!(has("UNKNOWN_METADATA_COLUMN", "metadata.values.a.lot"));
    assert!(has("INVALID_METADATA_VALUE", "metadata.values.b.site"));
    assert!(has("UNKNOWN_SAMPLE", "metadata.values.ghost"));
    assert!(issues
        .iter()
        .any(|(c, p, b)| c == "UNKNOWN_METADATA_UNIT" && p == "metadata.columns[4].unit" && !*b));
    // JSON booleans are neither levels nor values: rejected by the parser.
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["metadata"] = serde_json::json!({"columns": [], "values": {"a": {"site": true}}});
    assert!(serde_json::from_value::<QualificationInput>(value).is_err());
}

#[test]
fn metadata_varying_inside_an_identity_component_is_a_warning() {
    let mut input = with_metadata(serde_json::json!({
        "columns": [{"name": "lot", "kind": "categorical"}],
        "values": {"a": {"lot": "L1"}, "b": {"lot": "L2"}}
    }));
    input.samples[1].partition = Partition::Development;
    assert!(!codes(&input)
        .iter()
        .any(|(c, _, _)| c == "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT"));
    input.samples[1].individual_id = Some("I".into());
    input.samples[0].individual_id = Some("I".into());
    let issues = codes(&input);
    assert!(issues
        .iter()
        .any(|(c, p, b)| c == "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT"
            && p == "metadata.columns[0]"
            && !*b));
    assert!(validate_input(&input).valid);
}

#[test]
fn independence_components_use_every_identity_and_reference_link() {
    let mut input = fixture();
    input.samples[1].partition = Partition::Development;
    let mut c = input.samples[0].clone();
    c.sample_id = "c".into();
    c.physical_sample_id = None;
    input.samples.push(c);
    assert_eq!(independence_components(&input, &[]), vec![0, 1, 2]);
    let target = Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        values: vec![
            TargetValue {
                sample_id: "b".into(),
                value: None,
                category: None,
                status: ReferenceStatus::Censored,
                reference_id: None,
                reference_group_id: Some("R".into()),
            },
            TargetValue {
                sample_id: "c".into(),
                value: Some(1.0),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: Some("R".into()),
            },
        ],
        unit: None,
    };
    assert_eq!(independence_components(&input, &[&target]), vec![0, 1, 1]);
    input.samples[2].augmentation_parent_id = Some("a".into());
    assert_eq!(independence_components(&input, &[&target]), vec![0, 0, 0]);
}

#[test]
fn retained_test_y_content_is_never_inspected() {
    let mut x = fixture();
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        values: vec![TargetValue {
            sample_id: "b".into(),
            value: None,
            category: Some("garbage".into()),
            status: ReferenceStatus::Exact,
            reference_id: None,
            reference_group_id: None,
        }],
        unit: None,
    });
    assert!(validate_input(&x).valid);
    x.samples[1].partition = Partition::Development;
    assert!(codes(&x)
        .iter()
        .any(|(c, _, _)| c == "INVALID_EXACT_TARGET"));
}

fn sample(id: &str, partition: Partition) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: None,
        partition,
        independence_group: None,
        instrument: None,
        campaign: None,
        individual_id: None,
        augmentation_parent_id: None,
    }
}

fn reference(sample_id: &str, group: &str) -> TargetValue {
    TargetValue {
        sample_id: sample_id.into(),
        value: None,
        category: None,
        status: ReferenceStatus::Censored,
        reference_id: None,
        reference_group_id: Some(group.into()),
    }
}

#[test]
fn leakage_is_checked_on_whole_components_through_prediction_bridges() {
    // Review P0: A (development) shares a physical sample with B
    // (prediction); B shares a reference group with C (retained test).
    let mut x = fixture();
    x.samples = vec![
        sample("a", Partition::Development),
        sample("b", Partition::Prediction),
        sample("c", Partition::RetainedTest),
    ];
    x.sources[0].sample_ids = vec!["a".into(), "c".into()];
    x.samples[0].physical_sample_id = Some("P".into());
    x.samples[1].physical_sample_id = Some("P".into());
    assert!(validate_input(&x).valid);
    x.targets.push(Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        values: vec![reference("b", "R"), reference("c", "R")],
        unit: None,
    });
    let result = validate_input(&x);
    assert!(!result.valid);
    assert!(result.issues.iter().any(|i| i.code == "REFERENCE_LEAKAGE"));
    // Identity-only bridge: A -physical- B -individual- C.
    x.targets.clear();
    x.samples[1].individual_id = Some("I".into());
    x.samples[2].individual_id = Some("I".into());
    let result = validate_input(&x);
    assert!(!result.valid);
    assert_eq!(
        result
            .issues
            .iter()
            .filter(|i| i.code.ends_with("_LEAKAGE"))
            .count(),
        1
    );
    assert!(result.issues.iter().any(|i| i.code == "IDENTITY_LEAKAGE"));
}

#[test]
fn declared_independence_group_cannot_cross_partitions() {
    // Groups are dependencies whatever the analysis unit.
    let mut x = fixture();
    assert_eq!(x.options.independence_unit, IndependenceUnit::Unknown);
    x.samples[0].independence_group = Some("G".into());
    x.samples[1].independence_group = Some("G".into());
    let result = validate_input(&x);
    assert!(!result.valid);
    assert!(result.issues.iter().any(|i| i.code == "IDENTITY_LEAKAGE"));
}

#[test]
fn reserved_y_content_stays_opaque_at_parse_time() {
    // Review P0: a reserved value of any JSON type is never decoded.
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["targets"] = serde_json::json!([{
    "target_id": "y", "kind": "continuous",
    "values": [
        {"sample_id": "a", "value": 1.5, "status": "exact"},
        {"sample_id": "b", "value": "do-not-read", "category": {"x": 1}, "status": "exact"}
    ]}]);
    let input: QualificationInput = serde_json::from_value(value.clone()).unwrap();
    assert!(validate_input(&input).valid);
    let reserved = &input.targets[0].values[1];
    assert!(reserved.value.is_none() && reserved.category.is_none());
    assert_eq!(input.targets[0].values[0].value, Some(1.5));
    value["targets"][0]["values"][0]["value"] = serde_json::json!("1.5");
    let error = serde_json::from_value::<QualificationInput>(value).unwrap_err();
    assert!(error.to_string().contains("targets[0].values[0].value"));
}

#[test]
fn reserved_y_tokens_are_never_decoded_from_json_text() {
    // Review P0: textual tokens a typed parser rejects (1e400) or would
    // decode (nested objects) stay unread for retained-test references.
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["targets"] = serde_json::json!([{
    "target_id": "y", "kind": "continuous",
    "values": [
        {"sample_id": "a", "value": 1.5, "status": "exact"},
        {"sample_id": "b", "value": "__V__", "category": "__C__", "status": "exact"}
    ]}]);
    let text = serde_json::to_string(&value).unwrap();
    for (v, c) in [
        ("1e400", r#"{"x":1e400}"#),
        (r#"{"x":1e400}"#, "1e400"),
        ("-1e400", "[1e999]"),
    ] {
        let json = text.replace(r#""__V__""#, v).replace(r#""__C__""#, c);
        let input: QualificationInput = serde_json::from_str(&json).unwrap();
        assert!(validate_input(&input).valid);
        assert!(input.targets[0].values[1].value.is_none());
    }
    // A development value out of the f64 range is still rejected.
    let json = text.replace(r#""__V__""#, "1").replace("1.5", "1e400");
    let error = serde_json::from_str::<QualificationInput>(&json).unwrap_err();
    assert!(error.to_string().contains("targets[0].values[0].value"));
}

#[test]
fn identity_keys_are_structured_and_cannot_collide() {
    // Review P0: target "a:b" / group "c" and target "a" / group "b:c" are
    // different references; they must not link development and test.
    let mut x = fixture();
    x.targets = vec![
        Target {
            target_id: "a:b".into(),
            kind: TargetKind::Continuous,
            values: vec![reference("a", "c")],
            unit: None,
        },
        Target {
            target_id: "a".into(),
            kind: TargetKind::Continuous,
            values: vec![reference("b", "b:c")],
            unit: None,
        },
    ];
    assert!(validate_input(&x).valid);
    // A physical ID equal to another sample's ID is a different identity.
    x.samples[1].physical_sample_id = Some("a".into());
    assert!(validate_input(&x).valid);
    // A group genuinely shared inside one target still blocks.
    x.targets[1].values.push(reference("a", "b:c"));
    let result = validate_input(&x);
    assert!(!result.valid);
    assert!(result.issues.iter().any(|i| i.code == "REFERENCE_LEAKAGE"));
}
