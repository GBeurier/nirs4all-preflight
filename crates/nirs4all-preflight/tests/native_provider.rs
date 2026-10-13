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
