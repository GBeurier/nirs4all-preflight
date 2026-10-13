//! Real DAG-ML + Methods probe against an independent scikit-learn golden
//! and an adversarial batch-confounded dataset. Skipped without
//! `N4M_LIBRARY_PATH` (an absolute libn4m path, Methods ABI >= 2.19).
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use nirs4all_preflight_dagml::DagMlValidationProvider;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const GOLDEN: &str = include_str!("fixtures/probe_sklearn_v1.json");

fn providers() -> Option<(NativeMethodsProvider, DagMlValidationProvider)> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some((
        NativeMethodsProvider::load(&path).expect("Methods ABI"),
        DagMlValidationProvider::load(&path).expect("DAG-ML Methods runtime"),
    ))
}

fn close(actual: f64, expected: f64, tol: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= tol * (1.0 + expected.abs()),
        "{label}: {actual} vs {expected}"
    );
}

fn metric<'a>(report: &'a QualificationReport, id: &str, estimator: &str) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| m.metric_id == id && m.parameters.get("estimator") == Some(&json!(estimator)))
        .unwrap_or_else(|| panic!("missing {id} for {estimator}"))
}

fn input_from(
    ids: &[String],
    x: &[Vec<f64>],
    y: &[f64],
    campaigns: &[String],
    link: &dyn Fn(usize) -> (Option<String>, Option<String>),
    unit: IndependenceUnit,
) -> QualificationInput {
    let p = x[0].len();
    serde_json::from_value(json!({
        "schema_version": 1,
        "data_origin": "synthetic",
        "sources": [{
            "source_id": "nir",
            "observation_ids": ids.iter().map(|s| format!("obs-{s}")).collect::<Vec<_>>(),
            "sample_ids": ids,
            "x": x,
            "axis": (0..p).map(|i| 1000.0 + 10.0 * i as f64).collect::<Vec<_>>(),
            "axis_unit": "nm",
            "signal_unit": "absorbance"
        }],
        "samples": ids.iter().enumerate().map(|(i, s)| {
            let (individual, group) = link(i);
            json!({"sample_id": s, "instrument": "A", "campaign": campaigns[i],
                   "individual_id": individual, "independence_group": group})
        }).collect::<Vec<_>>(),
        "targets": [{
            "target_id": "y", "kind": "continuous", "unit": "%",
            "values": ids.iter().zip(y).map(|(s, v)| json!({"sample_id": s, "value": v, "status": "exact"})).collect::<Vec<_>>()
        }],
        "options": {"independence_unit": unit, "seed": 7, "snv_sensitivity": false}
    }))
    .unwrap()
}

#[test]
fn dag_ml_probe_matches_independent_scikit_learn_reference() {
    let Some((methods, validation)) = providers() else {
        return;
    };
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let strings =
        |key: &str| -> Vec<String> { serde_json::from_value(golden[key].clone()).unwrap() };
    let ids = strings("sample_ids");
    let individuals = strings("individual_ids");
    let x: Vec<Vec<f64>> = serde_json::from_value(golden["x"].clone()).unwrap();
    let y: Vec<f64> = serde_json::from_value(golden["y"].clone()).unwrap();
    let input = input_from(
        &ids,
        &x,
        &y,
        &strings("campaigns"),
        &|i| (Some(individuals[i].clone()), None),
        IndependenceUnit::Sample,
    );
    let report = analyze_with_validation(&input, &methods, &validation);
    assert!(report
        .capabilities
        .iter()
        .any(|c| c.capability_id == "validation_probe" && c.available && !c.qualified));
    for estimator in ["pls", "pcr"] {
        let expected = &golden[estimator];
        let plan = metric(&report, "probe.plan", estimator);
        assert_eq!(plan.status_wire(), "computed", "{estimator} plan");
        let plan = plan.value.as_ref().unwrap();
        assert_eq!(plan["outer_splits"], golden["outer_splits"]);
        assert_eq!(plan["inner_splits"], golden["inner_splits"]);
        assert_eq!(plan["component_grid"], golden["component_grid"]);
        let folds = metric(&report, "probe.folds", estimator)
            .value
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap();
        let exp_folds = expected["folds"].as_array().unwrap();
        assert_eq!(folds.len(), exp_folds.len());
        for (f, e) in folds.iter().zip(exp_folds) {
            assert_eq!(f["eval_sample_ids"], e["validation_sample_ids"]);
            let inner: Vec<&Value> = f["inner_folds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| &i["eval_sample_ids"])
                .collect();
            let expected_inner: Vec<&Value> = e["inner_validation_sample_ids"]
                .as_array()
                .unwrap()
                .iter()
                .collect();
            assert_eq!(inner, expected_inner);
            assert_eq!(f["selected_components"], e["selected_components"]);
            close(
                f["train_mean"].as_f64().unwrap(),
                e["train_mean"].as_f64().unwrap(),
                1e-12,
                "train mean",
            );
            for (pair, rmse) in f["inner_rmse_by_components"]
                .as_array()
                .unwrap()
                .iter()
                .zip(e["inner_rmse"].as_array().unwrap())
            {
                close(
                    pair[1].as_f64().unwrap(),
                    rmse.as_f64().unwrap(),
                    1e-7,
                    "inner rmse",
                );
            }
        }
        let oof = metric(&report, "probe.oof_predictions", estimator)
            .value
            .clone()
            .unwrap();
        let oof_ids: Vec<String> = serde_json::from_value(oof["sample_ids"].clone()).unwrap();
        assert_eq!(oof_ids, ids);
        for (i, (a, e)) in oof["prediction"]
            .as_array()
            .unwrap()
            .iter()
            .zip(expected["prediction"].as_array().unwrap())
            .enumerate()
        {
            close(
                a.as_f64().unwrap(),
                e.as_f64().unwrap(),
                1e-7,
                &format!("oof {i}"),
            );
        }
        for (id, key) in [
            ("probe.rmse", "rmse"),
            ("probe.mae", "mae"),
            ("probe.r2_oof", "r2_oof"),
            ("probe.skill_vs_train_mean", "skill_vs_train_mean"),
            ("probe.train_mean_rmse", "train_mean_rmse"),
        ] {
            close(
                metric(&report, id, estimator)
                    .value
                    .as_ref()
                    .unwrap()
                    .as_f64()
                    .unwrap(),
                expected[key].as_f64().unwrap(),
                1e-7,
                id,
            );
        }
        let domains = metric(&report, "probe.domain_scores", estimator)
            .value
            .clone()
            .unwrap();
        for d in domains.as_array().unwrap() {
            let e = &expected["domains"][d["campaign"].as_str().unwrap()];
            assert_eq!(d["n_samples"], e["n_samples"]);
            close(
                d["rmse"].as_f64().unwrap(),
                e["rmse"].as_f64().unwrap(),
                1e-7,
                "domain",
            );
            close(
                d["train_mean_rmse"].as_f64().unwrap(),
                e["train_mean_rmse"].as_f64().unwrap(),
                1e-10,
                "domain baseline",
            );
        }
    }
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
            .into()
    }
}

/// Six batches: each has its own target level and a spectral offset along a
/// random direction, with no X-Y relation inside a batch. Sample-level folds
/// learn the batch; batch-level folds cannot.
#[test]
fn batch_confounded_dataset_is_only_predictable_when_batches_leak_across_folds() {
    let Some((methods, validation)) = providers() else {
        return;
    };
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut noise = move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((state >> 11) as f64 / (1u64 << 53) as f64) - 0.5
    };
    let p = 8;
    let offsets: Vec<Vec<f64>> = (0..6)
        .map(|_| (0..p).map(|_| 4.0 * noise()).collect())
        .collect();
    let levels = [3.0, -1.0, 7.0, 0.5, 5.0, -4.0];
    let (mut ids, mut x, mut y, mut batches) = (vec![], vec![], vec![], vec![]);
    for b in 0..6 {
        for i in 0..8 {
            ids.push(format!("b{b}s{i}"));
            x.push(
                offsets[b]
                    .iter()
                    .map(|o| o + 0.05 * noise())
                    .collect::<Vec<_>>(),
            );
            y.push(levels[b] + 0.05 * noise());
            batches.push(format!("batch{b}"));
        }
    }
    let skill = |unit: IndependenceUnit| {
        let input = input_from(
            &ids,
            &x,
            &y,
            &batches,
            &|i| (None, Some(batches[i].clone())),
            unit,
        );
        let report = analyze_with_validation(&input, &methods, &validation);
        let folds = metric(&report, "probe.folds", "pls").value.clone().unwrap();
        let split_batches = folds
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                let batch = |key: &str| -> BTreeSet<String> {
                    f[key]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| s.as_str().unwrap()[..2].to_string())
                        .collect()
                };
                !batch("eval_sample_ids").is_disjoint(&batch("fit_sample_ids"))
            })
            .count();
        let value = metric(&report, "probe.skill_vs_train_mean", "pls")
            .value
            .as_ref()
            .unwrap()
            .as_f64()
            .unwrap();
        (value, split_batches, report)
    };
    let (sample_skill, sample_split, _) = skill(IndependenceUnit::Sample);
    let (batch_skill, batch_split, report) = skill(IndependenceUnit::Group);
    assert!(sample_split > 0, "sample folds split batches");
    assert!(
        sample_skill > 0.9,
        "leaky sample-level skill {sample_skill}"
    );
    assert_eq!(batch_split, 0, "batch folds keep each batch whole");
    assert!(batch_skill < 0.2, "batch-held-out skill {batch_skill}");
    if batch_skill <= 0.0 {
        assert!(report
            .findings
            .iter()
            .any(|f| f.rule_id == "probe.no_skill_over_train_mean.v1"));
    }
}
