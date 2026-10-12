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
