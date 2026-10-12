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
