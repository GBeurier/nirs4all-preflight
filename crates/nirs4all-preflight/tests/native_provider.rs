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
    // Groups {1,2,3},{7,8,9}: eta^2 = 54/58, F = 54; b from NumPy 2.2.6
    // default_rng(17).permutation(6) x 999 with SciPy f_oneway.
    let association = provider
        .association(&AssociationRequest {
            factor_codes: vec![4, 4, 4, -9, -9, -9],
            targets: vec![1., 2., 3., 7., 8., 9.],
            categorical: false,
            n_permutations: 999,
            seed: 17,
        })
        .unwrap();
    assert!((association.effect_size.unwrap() - 27. / 29.).abs() < 1e-12);
    assert!((association.statistic.unwrap() - 54.).abs() < 1e-10);
    assert!((association.log10_distinct_permutations - 20f64.log10()).abs() < 1e-12);
    assert_eq!(association.n_at_least_observed, 93);
    assert_eq!(association.n_permutations_executed, 999);
    // Seeds above 2^63 keep their exact u64 value across the C ABI.
    let wide = provider
        .association(&AssociationRequest {
            factor_codes: vec![4, 4, 4, -9, -9, -9],
            targets: vec![1., 2., 3., 7., 8., 9.],
            categorical: false,
            n_permutations: 999,
            seed: 18_446_744_073_709_551_557,
        })
        .unwrap();
    assert_eq!(wide.n_at_least_observed, 88);
    // R p.adjust(c(0.01, 0.04, 0.03, 0.005), "holm") = 0.03 0.06 0.06 0.02.
    let holm = provider
        .holm_adjust(&HolmRequest {
            p_values: vec![0.01, 0.04, 0.03, 0.005],
        })
        .unwrap();
    for (a, e) in holm.adjusted.iter().zip([0.03, 0.06, 0.06, 0.02]) {
        assert!((a - e).abs() < 1e-15);
    }
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
    // Rule 13: Methods refuses inputs outside its numerical domain; the
    // adapter reports the reason instead of a status number.
    for matrix in [
        vec![vec![0.0], vec![1e155], vec![2e155], vec![3e155]],
        vec![vec![1.0], vec![2.0], vec![2f64.powi(65)], vec![3.0]],
    ] {
        let refused = provider.hdbscan(&HdbscanRequest {
            matrix,
            min_cluster_size: 2,
            min_samples: 2,
            selection: ClusterSelection::Eom,
            allow_single_cluster: false,
        });
        assert_eq!(refused.unwrap_err().0, NUMERICAL_DOMAIN_EXCEEDED);
    }
    let refused = provider.linear_sum_assignment(&LinearAssignmentRequest {
        cost: vec![vec![-1e20, 1e20], vec![1.0, 0.0]],
        maximize: false,
    });
    assert_eq!(refused.unwrap_err().0, NUMERICAL_DOMAIN_EXCEEDED);
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
    assert_eq!(value["intersection_fraction_of_eligible"]["min"], 0.8);
    assert!(value["cluster_count"]["min"].as_f64().unwrap() >= 2.0);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "clustering" && c.available && !c.qualified));
}

fn native() -> Option<NativeMethodsProvider> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some(NativeMethodsProvider::load(path).expect("compatible Methods ABI"))
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn native_snv_noise_proxy_and_pairs_match_hand_values() {
    let Some(provider) = native() else {
        return;
    };
    // Population SD (ddof 0): both rows become (-sqrt(3/2), 0, sqrt(3/2)).
    let snv = provider
        .snv(&SnvRequest {
            matrix: vec![vec![1., 2., 3.], vec![2., 4., 6.]],
        })
        .unwrap();
    for row in &snv.matrix {
        assert!(near(row[0], -1.5f64.sqrt()) && near(row[1], 0.) && near(row[2], 1.5f64.sqrt()));
    }
    // Window 5 / quadratic: weights (-3,12,17,12,-3)/35, white-noise gain^2 = 18/35.
    // Row 0 is quadratic; row 1 is linear plus a 35 impulse at band 5.
    let quadratic: Vec<f64> = (0..11).map(|j| (j * j) as f64).collect();
    let impulse: Vec<f64> = (0..11)
        .map(|j| 1. + 2. * j as f64 + if j == 5 { 35. } else { 0. })
        .collect();
    let mut mask = vec![vec![true; 11]; 2];
    mask[1][9] = false;
    let noise = provider
        .noise_proxy(&NoiseProxyRequest {
            matrix: vec![quadratic, impulse],
            valid_mask: mask,
            window_length: 5,
            polyorder: 2,
        })
        .unwrap();
    assert!(near(noise.residual_gain, (18f64 / 35.).sqrt()));
    assert!(near(noise.band_noise[5].unwrap(), 315f64.sqrt()));
    assert!(near(noise.band_noise[3].unwrap(), 8.75f64.sqrt()));
    assert_eq!(noise.band_counts, vec![0, 0, 2, 2, 2, 2, 2, 1, 1, 0, 0]);
    assert!(noise.band_noise[0].is_none() && noise.band_noise[10].is_none());
    // Masked band 9 drops row 1 from bands 7 and 8: pooled 621 over 12 cells.
    assert!(near(
        noise.pooled.unwrap(),
        (621f64 / 12.).sqrt() / (18f64 / 35.).sqrt()
    ));
    // RMS distance sqrt(0.01/2) for (0,1) and (1,4); (0,4) shares a group.
    let points = vec![
        vec![0., 0.],
        vec![0.1, 0.],
        vec![0., 0.3],
        vec![5., 5.],
        vec![0., 0.],
    ];
    let pairs = provider
        .tolerance_pairs(&TolerancePairsRequest {
            query: points,
            reference: None,
            query_group_ids: vec![1, 2, 3, 4, 1],
            reference_group_ids: vec![],
            tolerance: 0.1,
            max_pairs: 10,
        })
        .unwrap();
    assert_eq!((pairs.total_pairs, pairs.candidate_pairs), (2, 9));
    assert_eq!(pairs.pairs, vec![[0, 1], [1, 4]]);
    assert!(near(pairs.distances[0], 0.005f64.sqrt()));
    assert_eq!(pairs.query_flags, vec![true, true, false, false, true]);
    let cross = provider
        .tolerance_pairs(&TolerancePairsRequest {
            query: vec![vec![0., 0.]],
            reference: Some(vec![vec![0., 0.1], vec![1., 1.]]),
            query_group_ids: vec![0],
            reference_group_ids: vec![1, 2],
            tolerance: 0.1,
            max_pairs: 0,
        })
        .unwrap();
    assert_eq!((cross.total_pairs, cross.candidate_pairs), (1, 2));
    assert!(cross.pairs.is_empty());
    assert_eq!(cross.reference_flags, vec![true, false]);
}

fn sample(id: &str, partition: Partition) -> Sample {
    Sample {
        sample_id: id.into(),
        physical_sample_id: Some(format!("p-{id}")),
        partition,
        independence_group: None,
        instrument: Some("a".into()),
        campaign: Some("c".into()),
        individual_id: None,
        augmentation_parent_id: None,
    }
}

fn input_with(rows: Vec<(&str, Partition, Vec<f64>)>, axis: Vec<f64>) -> QualificationInput {
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "nir".into(),
            observation_ids: rows.iter().map(|r| format!("o-{}", r.0)).collect(),
            sample_ids: rows.iter().map(|r| r.0.to_string()).collect(),
            x: rows
                .iter()
                .map(|r| r.2.iter().copied().map(Some).collect())
                .collect(),
            valid_mask: None,
            axis,
            axis_unit: "nm".into(),
            signal_unit: "absorbance".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples: rows.iter().map(|r| sample(r.0, r.1)).collect(),
        targets: vec![],
        options: Options::default(),
    }
}

fn metric<'a>(report: &'a QualificationReport, id: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

#[test]
fn native_engine_reports_noise_proxy_and_declared_quasi_duplicates() {
    let Some(provider) = native() else {
        return;
    };
    let quadratic: Vec<f64> = (0..11).map(|j| (j * j) as f64).collect();
    let impulse: Vec<f64> = (0..11)
        .map(|j| 1. + 2. * j as f64 + if j == 5 { 35. } else { 0. })
        .collect();
    let linear: Vec<f64> = (0..11).map(|j| 100. + j as f64).collect();
    let mut input = input_with(
        vec![
            ("s0", Partition::Development, quadratic.clone()),
            ("s1", Partition::Development, impulse),
            (
                "s2",
                Partition::Development,
                quadratic.iter().map(|v| v + 0.01).collect(),
            ),
            ("s3", Partition::Development, linear.clone()),
            (
                "t0",
                Partition::RetainedTest,
                linear.iter().map(|v| v + 0.02).collect(),
            ),
        ],
        (0..11).map(|j| 1000. + 10. * j as f64).collect(),
    );
    input.options.noise_proxy = NoiseProxyOptions {
        window_bands: 5,
        polyorder: 2,
    };
    input.options.quasi_duplicates = Some(QuasiDuplicateOptions {
        tolerance: 0.05,
        view: QuasiDuplicateView::Native,
        context: ComparisonContext::InstrumentCampaign,
    });
    let report = analyze(&input, &provider);
    // Development rows only: residual energy 630 over 4 rows x 7 interior bands.
    let noise = metric(&report, "measurement.noise_proxy");
    let bands = noise.value.as_ref().unwrap().as_array().unwrap();
    assert!(near(bands[5].as_f64().unwrap(), 157.5f64.sqrt()));
    assert!(bands[0].is_null() && bands[10].is_null());
    assert_eq!(noise.parameters["physical_window_width"], 40.0);
    let pooled = metric(&report, "measurement.noise_proxy_pooled");
    assert!(near(
        pooled.value.as_ref().unwrap().as_f64().unwrap(),
        43.75f64.sqrt()
    ));
    let within = metric(&report, "integrity.quasi_duplicate_pairs");
    let v = within.value.as_ref().unwrap();
    assert_eq!(v["suspect_pairs"], 1);
    assert_eq!(v["candidate_pairs"], 6);
    assert!(near(v["suspect_pair_rate"].as_f64().unwrap(), 1. / 6.));
    assert!(near(
        v["affected_development_fraction"].as_f64().unwrap(),
        0.5
    ));
    assert_eq!(v["listed_pairs"][0]["observation_b"], "o-s2");
    assert!(near(
        v["listed_pairs"][0]["rms_difference"].as_f64().unwrap(),
        0.01
    ));
    let cross = metric(&report, "integrity.cross_partition_quasi_duplicate_pairs");
    let v = cross.value.as_ref().unwrap();
    assert_eq!(
        (v["suspect_pairs"].as_u64(), v["candidate_pairs"].as_u64()),
        (Some(1), Some(4))
    );
    assert!(near(
        v["affected_retained_test_fraction"].as_f64().unwrap(),
        1.
    ));
    assert!(report.findings.iter().any(|f| f.rule_id
        == "identity.possible_cross_partition_quasi_duplicate.v1"
        && f.confidence == "unknown"));
    assert_eq!(
        metric(&report, "structure.snv_sensitivity").status_wire(),
        "computed"
    );
}

#[test]
fn native_snv_sensitivity_is_identity_on_standardized_rows_and_removes_pure_scatter() {
    let Some(provider) = native() else {
        return;
    };
    // Rows with zero mean and unit population SD (+-1, four each) are fixed
    // points of SNV, so both views must give identical structure.
    let standardized = input_with(
        [
            [1., 1., -1., -1., 1., -1., 1., -1.],
            [1., -1., 1., 1., -1., -1., 1., -1.],
            [-1., 1., 1., -1., 1., 1., -1., -1.],
            [1., 1., 1., -1., -1., -1., -1., 1.],
            [-1., -1., 1., 1., 1., -1., 1., -1.],
        ]
        .iter()
        .enumerate()
        .map(|(i, row)| {
            (
                ["a", "b", "c", "d", "e"][i],
                Partition::Development,
                row.to_vec(),
            )
        })
        .collect(),
        (1..=8).map(f64::from).collect(),
    );
    let report = analyze(&standardized, &provider);
    let v = metric(&report, "structure.snv_sensitivity")
        .value
        .clone()
        .unwrap();
    for key in [
        "delta_first_component_share",
        "delta_retained_share",
        "delta_effective_dimension",
    ] {
        assert!(v[key].as_f64().unwrap().abs() < 1e-12, "{key}");
    }
    // x_i = a_i f + b_i with mean(f)=0, sd(f)=1 and power-of-two a_i: canonical
    // structure exists, while SNV maps every row exactly to f.
    let f = [-1., 1., -1., 1.];
    let scatter = input_with(
        [(1., 0.), (2., 1.), (0.5, -3.), (4., 2.)]
            .iter()
            .enumerate()
            .map(|(i, (a, b))| {
                (
                    ["a", "b", "c", "d"][i],
                    Partition::Development,
                    f.iter().map(|v| a * v + b).collect(),
                )
            })
            .collect(),
        vec![1., 2., 3., 4.],
    );
    let report = analyze(&scatter, &provider);
    assert_eq!(
        metric(&report, "structure.effective_dimension").status_wire(),
        "computed"
    );
    let m = metric(&report, "structure.snv_sensitivity");
    assert_eq!(m.status_wire(), "undefined");
    assert_eq!(m.reason_code.as_deref(), Some("ZERO_SNV_TOTAL_VARIANCE"));
}

trait Wire {
    fn status_wire(&self) -> String;
}
impl Wire for Metric {
    fn status_wire(&self) -> String {
        serde_json::to_value(&self.status)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }
}
