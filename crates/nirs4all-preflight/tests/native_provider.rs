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
    // ABI 2.20 accuracy contract: resolution = 16 max(n,p) eps lambda_max.
    assert_eq!(
        result.resolution,
        16. * 4. * f64::EPSILON * result.eigenvalues[0]
    );
    assert_eq!(result.unresolved, vec![false]);
    // [A; -A], A = [[-1,1,-1],[-1,-1,-1],[1,-1,1],[-t,t,t]] (spread 1/t,
    // inside the 2^32 domain). The third variance 4t^2/7 (1 + O(t^2)) is
    // resolved for t = 2^-20 (~3e-13 lambda_1) and unresolved for t = 2^-30
    // (~2^-61 lambda_1): flagged and published as 0, not a rank-3 claim.
    let weak = |t: f64| {
        let a = [[-1., 1., -1.], [-1., -1., -1.], [1., -1., 1.], [-t, t, t]];
        let matrix: Vec<Vec<f64>> = a
            .iter()
            .map(|r| r.to_vec())
            .chain(a.iter().map(|r| r.iter().map(|v| -v).collect()))
            .collect();
        provider
            .pca(&PcaRequest {
                source_id: "analytic".into(),
                sample_ids: vec![],
                matrix,
                n_components: 3,
            })
            .unwrap()
    };
    let s17 = 17f64.sqrt();
    let resolved = weak(2f64.powi(-20));
    assert_eq!(resolved.unresolved, vec![false, false, false]);
    assert!(
        (resolved.eigenvalues[0] - 2. * (s17 + 1.) * (s17 + 1.) / 28.).abs() <= resolved.resolution
    );
    assert!((resolved.eigenvalues[2] - 4. * 2f64.powi(-40) / 7.).abs() <= resolved.resolution);
    let unresolved = weak(2f64.powi(-30));
    assert_eq!(unresolved.unresolved, vec![false, false, true]);
    assert_eq!(unresolved.eigenvalues[2], 0.);
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
    // Rules 13/15: Methods refuses inputs outside its numerical domain; the
    // adapter reports the reason instead of a status number. Spread edge:
    // max/min nonzero |x| = 2^32 is accepted, one ulp more is refused.
    let spread = 2f64.powi(32);
    let column = |values: &[f64]| HdbscanRequest {
        matrix: values.iter().map(|&v| vec![v]).collect(),
        min_cluster_size: 2,
        min_samples: 2,
        selection: ClusterSelection::Eom,
        allow_single_cluster: false,
    };
    assert!(provider.hdbscan(&column(&[1.0, 2.0, spread, 3.0])).is_ok());
    for values in [
        vec![0.0, 1e155, 2e155, 3e155],
        vec![1.0, 2.0, spread * (1.0 + f64::EPSILON), 3.0],
    ] {
        let refused = provider.hdbscan(&column(&values));
        assert_eq!(refused.unwrap_err().reason, NUMERICAL_DOMAIN_EXCEEDED);
    }
    let refused = provider.linear_sum_assignment(&LinearAssignmentRequest {
        cost: vec![vec![-1e20, 1e20], vec![1.0, 0.0]],
        maximize: false,
    });
    assert_eq!(refused.unwrap_err().reason, NUMERICAL_DOMAIN_EXCEEDED);
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
        metadata: MetadataTable::default(),
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
            group_ids: None,
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
        metadata: MetadataTable::default(),
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

#[test]
fn native_quasi_duplicates_flag_incompatible_references_on_development_pairs() {
    let Some(provider) = native() else {
        return;
    };
    let input: QualificationInput =
        serde_json::from_str(include_str!("../../../examples/quasi_duplicates.json")).unwrap();
    let report = analyze(&input, &provider);
    let within = metric(&report, "integrity.quasi_duplicate_pairs");
    let v = within.value.as_ref().unwrap();
    assert_eq!(
        (v["suspect_pairs"].as_u64(), v["candidate_pairs"].as_u64()),
        (Some(5), Some(8))
    );
    // (s0, s2): RMS of (0.05, 0) = 0.05 / sqrt(2).
    assert!(near(
        v["listed_pairs"][1]["rms_difference"].as_f64().unwrap(),
        0.05 / 2f64.sqrt()
    ));
    let by_target = |id: &str, target: &str| {
        report
            .metrics
            .iter()
            .find(|m| m.metric_id == id && m.target_id.as_deref() == Some(target))
            .unwrap()
            .value
            .clone()
            .unwrap()
    };
    let quasi = by_target("reference.quasi_duplicate_conflicts", "moisture");
    assert_eq!(
        (
            quasi["compared_sample_pairs"].as_u64(),
            quasi["incompatible_sample_pairs"].as_u64()
        ),
        (Some(3), Some(2))
    );
    assert!(near(
        quasi["listed_pairs"][1]["min_rms_difference"]
            .as_f64()
            .unwrap(),
        0.05 / 2f64.sqrt()
    ));
    assert_eq!(
        by_target("reference.quasi_duplicate_conflicts", "grade")["incompatible_sample_pairs"],
        2
    );
    assert_eq!(
        by_target("reference.exact_duplicate_conflicts", "moisture")["incompatible_sample_pairs"],
        1
    );
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains("987.654") && !json.contains("zz-test-only"));
}

#[test]
fn native_snv_keeps_constant_spectra_flat_and_extreme_rows_standardized() {
    let Some(provider) = native() else {
        return;
    };
    // Review b1 #1: three constant spectra have no SNV shape; the naive mean
    // residue used to become eleven ones (SNV dimension 1, no quasi-identity).
    let mut constant = input_with(
        [0.1, 0.5, 0.7]
            .iter()
            .enumerate()
            .map(|(i, v)| (["a", "b", "c"][i], Partition::Development, vec![*v; 11]))
            .collect(),
        (0..11).map(|j| 1000. + 10. * j as f64).collect(),
    );
    constant.options.quasi_duplicates = Some(QuasiDuplicateOptions {
        tolerance: 0.01,
        view: QuasiDuplicateView::Snv,
        context: ComparisonContext::Source,
    });
    let report = analyze(&constant, &provider);
    let pairs = metric(&report, "integrity.quasi_duplicate_pairs");
    assert_eq!(pairs.value.as_ref().unwrap()["suspect_pairs"], 3);
    let m = metric(&report, "structure.snv_sensitivity");
    assert_eq!(m.status_wire(), "undefined");
    assert_eq!(m.reason_code.as_deref(), Some("ZERO_SNV_TOTAL_VARIANCE"));
    // Domain edges 2^256 and 2^-256: [a, 0, -a] standardizes to
    // sqrt(3/2) [1, 0, -1] instead of zeros.
    let (hi, lo) = (2f64.powi(256), 2f64.powi(-256));
    let snv = provider
        .snv(&SnvRequest {
            group_ids: None,
            matrix: vec![vec![hi, 0., -hi], vec![0.1; 3], vec![lo, 0., -lo]],
        })
        .unwrap();
    for i in [0, 2] {
        assert!(near(snv.matrix[i][0], 1.5f64.sqrt()) && near(snv.matrix[i][2], -(1.5f64.sqrt())));
    }
    assert!(snv.matrix[1].iter().all(|v| *v == 0.0) && snv.error_bounds[1] == 0.0);
    // Just outside the supported domain: explicit refusal, never a value.
    for row in [
        vec![1e200, 0., -1e200],
        vec![f64::from_bits(1), 0., 0.],
        vec![1.0, 2f64.powi(65)],
    ] {
        let err = provider
            .snv(&SnvRequest {
                group_ids: None,
                matrix: vec![row],
            })
            .unwrap_err();
        assert_eq!(err.reason, NUMERICAL_DOMAIN_EXCEEDED);
    }
}

#[test]
fn native_metrics_report_inputs_outside_the_numerical_domain() {
    let Some(provider) = native() else {
        return;
    };
    // One spectrum with a value 2^300: noise proxy, SNV sensitivity and
    // quasi-duplicates refuse it explicitly and publish the domain.
    let mut input = input_with(
        vec![
            ("a", Partition::Development, vec![1., 2., 3., 4., 5.]),
            ("b", Partition::Development, vec![2., 1., 3., 5., 4.]),
            (
                "c",
                Partition::Development,
                vec![1., 3., 2., 2f64.powi(300), 5.],
            ),
            ("d", Partition::Development, vec![5., 4., 3., 2., 1.]),
        ],
        vec![1., 2., 3., 4., 5.],
    );
    input.options.noise_proxy = NoiseProxyOptions {
        window_bands: 3,
        polyorder: 1,
    };
    input.options.quasi_duplicates = Some(QuasiDuplicateOptions {
        tolerance: 0.5,
        view: QuasiDuplicateView::Native,
        context: ComparisonContext::Source,
    });
    let report = analyze(&input, &provider);
    // Spread boundary (rule 15): 2^32 next to 1 is computed, 2^33 refused.
    for (big, inside) in [(2f64.powi(32), true), (2f64.powi(33), false)] {
        let mut edge = input.clone();
        edge.sources[0].x[2][3] = Some(big);
        let r = analyze(&edge, &provider);
        let m = metric(&r, "measurement.noise_proxy");
        assert_eq!(m.status_wire() == "computed", inside, "{big}");
        if !inside {
            assert_eq!(m.reason_code.as_deref(), Some(NUMERICAL_DOMAIN_EXCEEDED));
        }
    }
    for id in ["measurement.noise_proxy", "integrity.quasi_duplicate_pairs"] {
        let m = metric(&report, id);
        assert_eq!(m.status_wire(), "unsupported", "{id}");
        assert_eq!(
            m.reason_code.as_deref(),
            Some(NUMERICAL_DOMAIN_EXCEEDED),
            "{id}"
        );
        assert_eq!(m.parameters["numerical_domain"], NUMERICAL_DOMAIN, "{id}");
        assert!(m.value.is_none());
    }
}

#[test]
fn native_snv_rounding_residue_is_not_reported_as_structure() {
    let Some(provider) = native() else {
        return;
    };
    // Review b1 #6: x_i = a_i [1..5] + b_i have identical SNV rows analytically;
    // amplitudes that are not powers of two leave only rounding residue.
    let input = input_with(
        [(1.0, 0.0), (1.1, 100.0), (1.2, 10.0), (2.1, -3.0)]
            .iter()
            .enumerate()
            .map(|(i, (a, b))| {
                (
                    ["a", "b", "c", "d"][i],
                    Partition::Development,
                    (1..=5).map(|j| a * j as f64 + b).collect(),
                )
            })
            .collect(),
        vec![1., 2., 3., 4., 5.],
    );
    let report = analyze(&input, &provider);
    // The SNV rows differ only by rounding residue: entries ~1e-17 next to
    // entries ~1.4, outside the PCA domain (spread > 2^32). The rank
    // criterion is decided from the Methods SNV bounds before the PCA, which
    // is skipped: undefined, never a domain refusal or structure.
    let snv = provider
        .snv(&SnvRequest {
            matrix: input.sources[0]
                .x
                .iter()
                .map(|r| r.iter().map(|v| v.unwrap()).collect())
                .collect(),
            group_ids: None,
        })
        .unwrap();
    let entries: Vec<f64> = snv.matrix.iter().flatten().map(|v| v.abs()).collect();
    assert!(entries.iter().any(|v| *v > 1.4));
    assert!(entries.iter().any(|v| *v > 0.0 && *v < 1e-15));
    for id in [
        "structure.snv_sensitivity",
        "structure.snv_effective_dimension",
    ] {
        let m = metric(&report, id);
        assert_eq!(m.status_wire(), "undefined", "{id}");
        assert!(m.value.is_none());
        assert_eq!(
            m.reason_code.as_deref(),
            Some("SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED"),
            "{id}"
        );
        let rms = m.parameters["snv_rms_band_deviation"].as_f64().unwrap();
        let threshold = m.parameters["numerical_resolution_threshold"]
            .as_f64()
            .unwrap();
        assert!(rms <= threshold && threshold < 1e-12);
    }
    assert!(!report
        .metrics
        .iter()
        .any(|m| m.metric_id == "structure.snv_pca_eigenvalues"));
    assert_eq!(
        metric(&report, "structure.effective_dimension").status_wire(),
        "computed"
    );
}

#[test]
fn native_snv_rounding_bound_covers_wide_offset_spectra() {
    let Some(provider) = native() else {
        return;
    };
    // Review b1fix #3: 99,999 ones then a two under the same (a, b) offsets;
    // every row has the analytic SNV -1/sqrt(99999), ..., sqrt(99999). The
    // former range-based criterion accepted a 2.66e-8 residual as structure.
    let p = 100_000;
    let shape: Vec<f64> = (0..p).map(|j| if j + 1 < p { 1.0 } else { 2.0 }).collect();
    let input = input_with(
        [(1.0, 0.0), (1.1, 100.0), (1.2, 10.0), (2.1, -3.0)]
            .iter()
            .enumerate()
            .map(|(i, (a, b))| {
                (
                    ["a", "b", "c", "d"][i],
                    Partition::Development,
                    shape.iter().map(|v| a * v + b).collect(),
                )
            })
            .collect(),
        (0..p).map(|j| j as f64).collect(),
    );
    let snv = provider
        .snv(&SnvRequest {
            group_ids: None,
            matrix: input.sources[0]
                .x
                .iter()
                .map(|r| r.iter().map(|v| v.unwrap()).collect())
                .collect(),
        })
        .unwrap();
    let (lo, hi) = (-1.0 / 99_999f64.sqrt(), 99_999f64.sqrt());
    for (row, bound) in snv.matrix.iter().zip(&snv.error_bounds) {
        let error = row
            .iter()
            .enumerate()
            .map(|(j, z)| (z - if j + 1 < p { lo } else { hi }).abs())
            .fold(0.0f64, f64::max);
        assert!(error <= *bound && *bound < 1e-9, "{error} > {bound}");
    }
    let report = analyze(&input, &provider);
    for id in [
        "structure.snv_sensitivity",
        "structure.snv_effective_dimension",
    ] {
        let m = metric(&report, id);
        assert_eq!(
            m.reason_code.as_deref(),
            Some("SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED"),
            "{id}"
        );
    }
}

#[test]
fn native_snv_bound_covers_aggregation_of_unbalanced_repeats() {
    let Some(provider) = native() else {
        return;
    };
    // Review b14fix #3: a [1,2,4] with a = 1, 2, 4, 8 and 1, 10000, 1, 1
    // identical technical acquisitions: every analytic SNV row coincides, and
    // a sequential mean of the 10000 repeats used to leave a 7e-14 residual.
    let mut input = input_with(
        ["a", "b", "c", "d"]
            .iter()
            .enumerate()
            .map(|(g, id)| {
                (
                    *id,
                    Partition::Development,
                    [1.0, 2.0, 4.0]
                        .iter()
                        .map(|v| v * (1 << g) as f64)
                        .collect(),
                )
            })
            .collect(),
        vec![1., 2., 3.],
    );
    let source = &mut input.sources[0];
    for i in 1..10_000 {
        source.observation_ids.push(format!("o-b-{i}"));
        source.sample_ids.push("b".into());
        source.x.push(vec![Some(2.0), Some(4.0), Some(8.0)]);
    }
    source.repetition_types = Some(vec![RepetitionType::Rescan; source.x.len()]);
    let report = analyze(&input, &provider);
    assert_eq!(
        metric(&report, "structure.snv_sensitivity").denominators["n_aggregated_samples"],
        4
    );
    // The compensated mean of identical rows is exact here, so the residual
    // is zero; any residual must stay under the threshold, never "structure".
    let m = metric(&report, "structure.snv_sensitivity");
    assert_eq!(m.status_wire(), "undefined");
    assert!(matches!(
        m.reason_code.as_deref(),
        Some("ZERO_SNV_TOTAL_VARIANCE" | "SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED")
    ));
    let rms = m.parameters["snv_rms_band_deviation"].as_f64().unwrap();
    assert!(
        rms <= m.parameters["numerical_resolution_threshold"]
            .as_f64()
            .unwrap()
    );
}

#[test]
fn native_target_summary_and_local_contrast_refuse_targets_outside_the_domain() {
    let Some(provider) = native() else {
        return;
    };
    // Continuous targets with 2^300: the Methods summary and local contrast
    // refuse them explicitly (rule 13); the summary has no spread bound.
    let build = |big: f64| {
        let mut input = input_with(
            (0..6)
                .map(|i| {
                    (
                        ["a", "b", "c", "d", "e", "f"][i],
                        Partition::Development,
                        vec![i as f64, (i * i) as f64, 1.0],
                    )
                })
                .collect(),
            vec![1., 2., 3.],
        );
        input.options.independence_unit = IndependenceUnit::Sample;
        input.targets = vec![Target {
            target_id: "y".into(),
            kind: TargetKind::Continuous,
            values: ["a", "b", "c", "d", "e", "f"]
                .iter()
                .zip([1.0, 2.0, big, 3.0, 4.0, 5.0])
                .map(|(id, v)| TargetValue {
                    sample_id: (*id).into(),
                    value: Some(v),
                    category: None,
                    status: ReferenceStatus::Exact,
                    reference_id: None,
                    reference_group_id: None,
                })
                .collect(),
            unit: None,
        }];
        analyze(&input, &provider)
    };
    let report = build(2f64.powi(300));
    let m = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "target.continuous_distribution")
        .unwrap();
    assert_eq!(m.status_wire(), "unsupported");
    assert_eq!(m.reason_code.as_deref(), Some(NUMERICAL_DOMAIN_EXCEEDED));
    assert_eq!(m.parameters["numerical_domain"], NUMERICAL_DOMAIN_SUMMARY);
    // The summary has no spread bound: 1e-20 next to 1 is summarized.
    for value in [2f64.powi(64), 1e-20] {
        let report = build(value);
        let m = report
            .metrics
            .iter()
            .find(|m| m.metric_id == "target.continuous_distribution")
            .unwrap();
        assert_eq!(m.status_wire(), "computed", "{value}");
    }
}

#[test]
fn native_metrics_publish_their_operation_specific_numerical_domain() {
    let Some(provider) = native() else {
        return;
    };
    // Review b14fix5: Y = [1, 2, 2^33, 3, 4, 5] is a valid summary input
    // (magnitude bound only) but exceeds the global 2^32 target spread of the
    // continuous local contrast. Both metrics publish their own domain.
    let build = |y3: f64| {
        let ids = ["a", "b", "c", "d", "e", "f"];
        let mut input = input_with(
            // Full-rank spectra, so no PCA score is a rounding residue.
            ids.iter()
                .zip([
                    [1.0, 4.0, 2.0, 7.0],
                    [2.0, 1.0, 5.0, 3.0],
                    [3.0, 6.0, 1.0, 4.0],
                    [5.0, 2.0, 4.0, 1.0],
                    [4.0, 5.0, 3.0, 6.0],
                    [6.0, 3.0, 6.0, 2.0],
                ])
                .map(|(id, x)| (*id, Partition::Development, x.to_vec()))
                .collect(),
            vec![1., 2., 3., 4.],
        );
        input.options.noise_proxy = NoiseProxyOptions {
            window_bands: 3,
            polyorder: 1,
        };
        input.options.independence_unit = IndependenceUnit::Sample;
        input.targets = vec![Target {
            target_id: "y".into(),
            kind: TargetKind::Continuous,
            values: ids
                .iter()
                .zip([1.0, 2.0, y3, 3.0, 4.0, 5.0])
                .map(|(id, v)| TargetValue {
                    sample_id: (*id).into(),
                    value: Some(v),
                    category: None,
                    status: ReferenceStatus::Exact,
                    reference_id: None,
                    reference_group_id: None,
                })
                .collect(),
            unit: None,
        }];
        analyze(&input, &provider)
    };
    let report = build(2f64.powi(33));
    let summary = metric(&report, "target.continuous_distribution");
    assert_eq!(summary.status_wire(), "computed");
    assert_eq!(
        summary.parameters["numerical_domain"],
        NUMERICAL_DOMAIN_SUMMARY
    );
    let contrast = metric(&report, "local.global_contrast");
    assert_eq!(contrast.status_wire(), "unsupported");
    assert_eq!(
        contrast.reason_code.as_deref(),
        Some(NUMERICAL_DOMAIN_EXCEEDED)
    );
    assert_eq!(
        contrast.parameters["numerical_domain"],
        NUMERICAL_DOMAIN_LOCAL_CONTINUOUS
    );
    let report = build(6.0);
    for (id, domain) in [
        ("target.continuous_distribution", NUMERICAL_DOMAIN_SUMMARY),
        ("local.global_contrast", NUMERICAL_DOMAIN_LOCAL_CONTINUOUS),
        ("measurement.noise_proxy_pooled", NUMERICAL_DOMAIN),
        ("structure.snv_pca_eigenvalues", NUMERICAL_DOMAIN),
    ] {
        let m = metric(&report, id);
        eprintln!(
            "{id} {:?} {:?}",
            m.reason_code,
            report
                .metrics
                .iter()
                .find(|x| x.metric_id == "structure.pca_scores")
                .map(|x| x.value.clone())
        );
        assert_eq!(m.status_wire(), "computed", "{id}");
        assert!(
            m.parameters["numerical_domain"]
                .as_str()
                .unwrap()
                .starts_with(domain.split(';').next().unwrap()),
            "{id}"
        );
    }
}

#[test]
fn native_local_contrast_is_computed_on_rank_deficient_spectra() {
    let Some(provider) = native() else {
        return;
    };
    // Rank 2 (columns affine in i and i^2): the components beyond the rank
    // are below Methods' PCA resolution and are dropped (k_resolved = 2), so
    // the scores carry no rounding-level column and the local contrast is
    // computed.
    let ids = ["a", "b", "c", "d", "e", "f"];
    let mut input = input_with(
        ids.iter()
            .enumerate()
            .map(|(i, id)| {
                let v = i as f64;
                (
                    *id,
                    Partition::Development,
                    vec![v, v * v + 1.0, 2.0 * v + 3.0, 7.0 - v],
                )
            })
            .collect(),
        vec![1., 2., 3., 4.],
    );
    input.options.independence_unit = IndependenceUnit::Sample;
    input.targets = vec![Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        values: ids
            .iter()
            .zip([1.0, 2.0, 6.0, 3.0, 4.0, 5.0])
            .map(|(id, v)| TargetValue {
                sample_id: (*id).into(),
                value: Some(v),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: None,
            })
            .collect(),
        unit: None,
    }];
    let report = analyze(&input, &provider);
    let scores = metric(&report, "structure.pca_scores")
        .value
        .clone()
        .unwrap();
    let rows = scores["scores"].as_array().unwrap();
    assert_eq!(
        metric(&report, "structure.pca_scores").parameters["k_resolved"],
        2
    );
    assert!(rows.iter().all(|r| r.as_array().unwrap().len() == 2));
    let m = metric(&report, "local.global_contrast");
    assert_eq!(m.status_wire(), "computed");
    assert_eq!(
        m.parameters["numerical_domain"],
        NUMERICAL_DOMAIN_LOCAL_CONTINUOUS
    );
}

/// Rank-2 spectra (24 samples x 40 wavelengths around 10, two smooth bases):
/// the canonical PCA asks for 10 components, 8 of which are rounding noise
/// below Methods' resolution. They are dropped before any downstream use, so
/// the scores keep the 2 resolved columns and the structure, local-contrast
/// and clustering metrics are computed on them.
#[test]
fn rank_two_spectra_drop_unresolved_components_before_downstream_metrics() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = NativeMethodsProvider::load(path).expect("compatible Methods ABI");
    let n = 24;
    let coef = |i: usize| ((i as f64) * 0.7).sin() * 0.3;
    let coef2 = |i: usize| ((i as f64) * 1.3 + 0.4).cos() * 0.2;
    let x: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            (0..40)
                .map(|w| {
                    let l = 1100.0 + 10.0 * w as f64;
                    10.0 + coef(i) * (l * 0.01).sin() + coef2(i) * (l * 0.007).cos()
                })
                .collect()
        })
        .collect();
    let ids: Vec<String> = (0..n).map(|i| format!("s{i}")).collect();
    let input: QualificationInput = serde_json::from_value(serde_json::json!({
        "schema_version": 1,
        "data_origin": "synthetic",
        "sources": [{
            "source_id": "rank2",
            "observation_ids": (0..n).map(|i| format!("o{i}")).collect::<Vec<_>>(),
            "sample_ids": ids,
            "x": x,
            "axis": (0..40).map(|w| 1100.0 + 10.0 * w as f64).collect::<Vec<_>>(),
            "axis_unit": "nm",
            "signal_unit": "absorbance",
            "signal_type": "absorbance"
        }],
        "samples": (0..n).map(|i| serde_json::json!({
            "sample_id": format!("s{i}"),
            "physical_sample_id": format!("p{i}"),
            "partition": "development",
            "instrument": "a",
            "campaign": "2026"
        })).collect::<Vec<_>>(),
        "targets": [{
            "target_id": "y",
            "kind": "continuous",
            "unit": "%",
            "values": (0..n).map(|i| serde_json::json!({
                "sample_id": format!("s{i}"),
                "value": coef(i) + 0.5 * coef2(i),
                "status": "exact",
                "reference_id": format!("r{i}")
            })).collect::<Vec<_>>()
        }],
        "options": {}
    }))
    .expect("valid rank-2 input");
    let report = analyze(&input, &provider);
    let metric = |id: &str| {
        report
            .metrics
            .iter()
            .find(|m| m.metric_id == id)
            .unwrap_or_else(|| panic!("{id} missing"))
    };
    let eigen = metric("structure.pca_eigenvalues");
    assert_eq!(eigen.parameters["k_requested"], 10);
    assert_eq!(eigen.parameters["k_resolved"], 2);
    assert_eq!(eigen.value.as_ref().unwrap().as_array().unwrap().len(), 2);
    let scores = metric("structure.pca_scores");
    assert!(matches!(scores.status, Availability::Computed));
    assert_eq!(scores.parameters["score_columns"], 2);
    let rows = scores.value.as_ref().unwrap()["scores"]
        .as_array()
        .unwrap()
        .clone();
    assert!(rows.iter().all(|r| r.as_array().unwrap().len() == 2));
    for id in [
        "structure.effective_dimension",
        "structure.explained_variance_retained",
        "local.global_contrast",
    ] {
        assert!(matches!(metric(id).status, Availability::Computed), "{id}");
    }
    let partition = metric("clustering.partition");
    assert!(
        !matches!(
            partition.status,
            Availability::Unsupported | Availability::Error
        ),
        "clustering: {:?} {:?}",
        partition.status,
        partition.reason_code
    );
}

#[test]
fn regression_scores_publish_an_out_of_range_r2_scaled() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = NativeMethodsProvider::load(path).expect("compatible Methods ABI");
    // Rational oracle: SST = 2^-511, SSE = 2^513, R² = 1 - 2^1024 = -0.5 * 2^1025.
    let s = provider
        .regression_scores(&RegressionScoresRequest {
            y_true: vec![2f64.powi(-255), 2f64.powi(-254)],
            y_pred: vec![2f64.powi(256), 2f64.powi(256)],
        })
        .unwrap();
    assert_eq!(s.rmse, 2f64.powi(256));
    assert_eq!((s.r2, s.r2_exponent), (Some(-0.5), 1025));
    // Constant target: undefined, distinct from the scaled case.
    let c = provider
        .regression_scores(&RegressionScoresRequest {
            y_true: vec![2.0, 2.0],
            y_pred: vec![1.0, 3.0],
        })
        .unwrap();
    assert_eq!((c.r2, c.r2_exponent), (None, 0));
    // Outside the domain: explicit refusal with the shared reason.
    let e = provider
        .regression_scores(&RegressionScoresRequest {
            y_true: vec![1.0, 2f64.powi(33)],
            y_pred: vec![1.0, 1.0],
        })
        .unwrap_err();
    assert_eq!(e.reason, NUMERICAL_DOMAIN_EXCEEDED);
}
