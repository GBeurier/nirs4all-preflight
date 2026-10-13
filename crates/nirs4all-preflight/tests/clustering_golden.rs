//! Full-chain clustering golden (PCA -> score grid -> HDBSCAN -> PCG64 plans
//! -> stability, matching, Gaussian null) against the independent NumPy 2.4.6 /
//! SciPy 1.18.1 / scikit-learn 1.9.1 implementation of
//! `scripts/generate_clustering_golden.py`. The WASM bridge test checks the same
//! fixture, so CPU and WASM partitions are pinned to one reference.
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use serde_json::Value;
use std::collections::BTreeMap;

fn near(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() <= 1e-12 * y.abs().max(1.0),
        _ => a.is_null() && b.is_null(),
    }
}

/// Bijective label map from engine labels to golden labels, identical noise.
fn label_map(got: &[i64], want: &[i64]) -> BTreeMap<i64, i64> {
    assert_eq!(got.len(), want.len());
    let (mut forward, mut backward) = (BTreeMap::new(), BTreeMap::new());
    for (&g, &w) in got.iter().zip(want) {
        assert_eq!(g < 0, w < 0, "noise sets differ");
        if g >= 0 {
            assert_eq!(*forward.entry(g).or_insert(w), w);
            assert_eq!(*backward.entry(w).or_insert(g), g);
        }
    }
    forward
}

fn labels(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_i64().unwrap())
        .collect()
}

#[test]
fn native_clustering_matches_the_independent_python_golden() {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        return;
    };
    let provider = NativeMethodsProvider::load(path).expect("compatible Methods ABI");
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/clustering_v3_golden.json")).unwrap();
    assert_eq!(golden["protocol"], "clustering.v3");
    let mut assessments = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input: QualificationInput = serde_json::from_value(case["input"].clone()).unwrap();
        let expected = &case["expected"];
        let report = analyze(&input, &provider);
        let get = |id: &str| {
            let m = report.metrics.iter().find(|m| m.metric_id == id).unwrap();
            assert!(matches!(m.status, Availability::Computed), "{name} {id}");
            m
        };
        let partition = get("clustering.partition").value.as_ref().unwrap();
        let map = label_map(&labels(&partition["labels"]), &labels(&expected["labels"]));
        assert_eq!(
            map.len() as u64,
            expected["cluster_count"].as_u64().unwrap(),
            "{name}"
        );

        let stability = get("clustering.subsample_stability");
        // Review 2026-10-13 P0: the ARI population is the doubly assigned
        // identities, never all drawn rows; it is bounded by the full
        // partition's assigned share.
        let n = expected["n"].as_f64().unwrap();
        let assigned_share = (n - expected["noise"].as_f64().unwrap()) / n;
        let sv = stability.value.as_ref().unwrap();
        if let Some(max) = sv["ari_population_fraction_of_eligible"]["max"].as_f64() {
            assert!(max <= assigned_share + 1e-15, "{name}");
        }
        if expected["noise"].as_u64().unwrap() > 0 {
            assert!(
                sv["assigned_in_both_fraction_of_eligible"]["median"]
                    .as_f64()
                    .unwrap()
                    < sv["intersection_fraction_of_eligible"]["median"]
                        .as_f64()
                        .unwrap()
            );
        }
        assert_eq!(
            stability.parameters["seed"], expected["plan_seed"],
            "{name}"
        );
        assert_eq!(
            stability.value.as_ref().unwrap()["unit_plans"],
            expected["unit_plans"],
            "{name}: PCG64 plans"
        );
        assert_eq!(
            stability.denominators["n_resampling_units"] as u64,
            expected["n_resampling_units"].as_u64().unwrap()
        );
        for (variant, id) in [
            ("scaled", "clustering.subsample_stability"),
            (
                "constant",
                "clustering.subsample_stability_constant_parameters",
            ),
        ] {
            let got = get(id).value.as_ref().unwrap();
            let want = &expected["variants"][variant];
            for (g, w) in got["per_subsample"]
                .as_array()
                .unwrap()
                .iter()
                .zip(want["per_subsample"].as_array().unwrap())
            {
                for key in [
                    "intersection_size",
                    "assigned_in_both_size",
                    "cluster_count",
                ] {
                    assert_eq!(g[key], w[key], "{name} {variant} {key}");
                }
                assert!(near(&g["ari"], &w["ari"]), "{name} {variant} ari");
                let noise = w["noise"].as_f64().unwrap() / w["intersection_size"].as_f64().unwrap();
                assert!((g["noise_fraction"].as_f64().unwrap() - noise).abs() < 1e-15);
            }
            for key in [
                "ari_assigned_in_both",
                "assigned_in_both_fraction_of_eligible",
            ] {
                for stat in ["count", "min", "q25", "median", "q75", "max", "mean"] {
                    assert!(
                        near(&got[key][stat], &want[key][stat]),
                        "{name} {variant} {key}.{stat}"
                    );
                }
            }
            let appearance_id = id.replace("subsample_stability", "cluster_appearance_frequency");
            if expected["cluster_count"] == 0 {
                let m = report
                    .metrics
                    .iter()
                    .find(|m| m.metric_id == appearance_id)
                    .unwrap();
                assert!(matches!(m.status, Availability::NotApplicable));
                assert_eq!(m.reason_code.as_deref(), Some("NO_REFERENCE_CLUSTERS"));
                continue;
            }
            let appearance = get(&appearance_id).value.as_ref().unwrap();
            for cluster in appearance["clusters"].as_array().unwrap() {
                let golden_label = map[&cluster["label"].as_i64().unwrap()];
                let w = &want["appearance"][golden_label as usize];
                assert_eq!(
                    cluster["n_evaluable_subsamples"],
                    w["n_evaluable_subsamples"]
                );
                assert_eq!(cluster["n_appeared"], w["n_appeared"], "{name} {variant}");
                for stat in ["min", "median", "max", "mean"] {
                    assert!(near(
                        &cluster["matched_jaccard"][stat],
                        &w["matched_jaccard"][stat]
                    ));
                }
            }
        }

        let null = get("clustering.gaussian_null_model")
            .value
            .as_ref()
            .unwrap();
        for (g, w) in null["per_replicate"]
            .as_array()
            .unwrap()
            .iter()
            .zip(expected["null"]["per_replicate"].as_array().unwrap())
        {
            assert_eq!(g["cluster_count"], w["cluster_count"], "{name} null");
            assert!(near(&g["noise_fraction"], &w["noise_fraction"]));
            assert!(near(&g["median_ari"], &w["median_ari"]), "{name} null ari");
            assert!(near(
                &g["coverage_weighted_stability"],
                &w["coverage_weighted_stability"]
            ));
        }
        let golden_null = &expected["null"];
        assert!(near(
            &null["observed"]["coverage_weighted_stability"],
            &golden_null["observed_statistic"]
        ));
        assert!(near(
            &null["observed"]["frozen_projection_median_ari"],
            &golden_null["observed_frozen_median_ari"]
        ));
        assert!(
            near(&null["test"]["p_value"], &golden_null["p_value"]),
            "{name}"
        );
        assert_eq!(
            null["test"]["decisional"], golden_null["decisional"],
            "{name}"
        );
        let assessment = get("clustering.partition_assessment")
            .value
            .as_ref()
            .unwrap();
        assessments.push(assessment["assessment"].as_str().unwrap().to_string());
        assert!(report.findings.iter().all(|f| f.confidence == "unknown"));
    }
    assert_eq!(
        assessments,
        [
            "uncertain_partition",
            "uncertain_partition",
            "stable_candidate_partition",
            "compatible_with_continuous_structure",
            "uncertain_partition",
            "no_density_separated_groups",
            "stable_candidate_partition",
        ]
    );
}
