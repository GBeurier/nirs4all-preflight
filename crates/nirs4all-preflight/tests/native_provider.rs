use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;

#[test]
fn actual_public_methods_abi_matches_analytic_covariance_and_repeatability() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = NativeMethodsProvider::load(path).expect("compatible Methods ABI");
    let result = provider
        .pca(&PcaRequest {
            source_id: "analytic".into(),
            sample_ids: vec![],
            matrix: vec![vec![1., 1.], vec![2., 1.], vec![1., 3.], vec![2., 3.]],
            n_components: 1,
        })
        .unwrap();
    assert!((result.eigenvalues[0] - 4. / 3.).abs() < 1e-10);
    assert!((result.full_moments[0] - 5. / 3.).abs() < 1e-10);
    assert!((result.full_moments[1] - 17. / 9.).abs() < 1e-10);
    let repeats = provider
        .repeatability(&RepeatabilityRequest {
            source_id: "analytic".into(),
            matrix: vec![vec![1.], vec![3.], vec![5.], vec![7.]],
            group_ids: vec![0, 0, 1, 1],
            valid_mask: vec![vec![true]; 4],
        })
        .unwrap();
    assert!((repeats.pooled_sd[0].unwrap() - 2f64.sqrt()).abs() < 1e-10);
    assert!((repeats.icc[0].unwrap() - 7. / 9.).abs() < 1e-10);
    let contrast = provider
        .local_contrast(&LocalContrastRequest {
            targets: vec![0., 1., 10., 11.],
            neighbor_indices: vec![vec![1], vec![0], vec![3], vec![2]],
            group_ids: vec![0, 1, 2, 3],
            categorical: false,
        })
        .unwrap();
    assert!((contrast.contrast.unwrap() - (1. - 3. / 202.)).abs() < 1e-10);
}

#[test]
fn actual_methods_hdbscan_separates_blobs_and_reports_stability() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = NativeMethodsProvider::load(path).expect("compatible Methods ABI");
    let matrix: Vec<Vec<f64>> = (0..40)
        .map(|i| {
            let jitter = (i as f64 * 0.37).sin();
            vec![if i % 2 == 0 { -10.0 } else { 10.0 } + jitter, jitter]
        })
        .collect();
    let result = provider
        .hdbscan(&HdbscanRequest {
            matrix,
            min_cluster_size: 5,
            min_samples: 5,
            selection: ClusterSelection::Eom,
            allow_single_cluster: false,
        })
        .unwrap();
    assert_eq!(result.persistence.len(), 2);
    assert!(result.labels.iter().all(|&l| l >= 0));
    assert!(result
        .labels
        .iter()
        .enumerate()
        .all(|(i, &l)| l == result.labels[i % 2]));
    assert!(result.tree[0].parent.is_none() && result.tree[0].birth_distance.is_none());
    let ari = provider
        .adjusted_rand_index(&AdjustedRandRequest {
            labels_a: vec![0, 0, 1, 2],
            labels_b: vec![0, 0, 1, 1],
        })
        .unwrap();
    assert!((ari.ari.unwrap() - 0.5714285714285714).abs() < 1e-12);

    let input = QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "blobs".into(),
            observation_ids: (0..40).map(|i| format!("o{i}")).collect(),
            sample_ids: (0..40).map(|i| format!("s{i:02}")).collect(),
            x: (0..40)
                .map(|i| {
                    let jitter = (i as f64 * 0.37).sin();
                    let side = if i % 2 == 0 { -10.0 } else { 10.0 };
                    vec![Some(side + jitter), Some(jitter), Some(side - jitter)]
                })
                .collect(),
            valid_mask: None,
            axis: vec![1.0, 2.0, 3.0],
            axis_unit: "nm".into(),
            signal_unit: "abs".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples: (0..40)
            .map(|i| Sample {
                sample_id: format!("s{i:02}"),
                physical_sample_id: None,
                partition: Partition::Development,
                independence_group: None,
                instrument: None,
                campaign: None,
                individual_id: None,
                augmentation_parent_id: None,
            })
            .collect(),
        targets: vec![],
        options: Options::default(),
    };
    let report = analyze(&input, &provider);
    let get = |id: &str| report.metrics.iter().find(|m| m.metric_id == id).unwrap();
    assert_eq!(
        get("clustering.candidate_cluster_count").value,
        Some(serde_json::json!(2))
    );
    let stability = get("clustering.subsample_stability");
    assert!(matches!(stability.status, Availability::Computed));
    assert_eq!(stability.denominators["n_ari_evaluable_subsamples"], 50);
    // Scaled parameters may split a blob along its internal jitter curve;
    // only properties robust to that are asserted.
    let value = stability.value.as_ref().unwrap();
    assert_eq!(value["ari_assigned_in_both"]["max"], 1.0);
    assert_eq!(value["assigned_noise_agreement"]["median"], 1.0);
    assert_eq!(value["compared_fraction"]["min"], 0.8);
    assert!(value["cluster_count"]["min"].as_f64().unwrap() >= 2.0);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "clustering" && c.available && !c.qualified));
}
