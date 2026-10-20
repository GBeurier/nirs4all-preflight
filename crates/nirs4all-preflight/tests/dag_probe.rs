//! Real DAG-ML + Methods probe against an independent scikit-learn golden,
//! re-verification of tampered provider results, and an adversarial
//! batch-confounded dataset. Requires `N4M_LIBRARY_PATH` (absolute libn4m,
//! Methods ABI 2.20 with `n4m_stats_group_means`); under CI a missing library
//! fails instead of skipping.
use nirs4all_preflight::dagml::DagMlValidationProvider;
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const GOLDEN: &str = include_str!("fixtures/probe_sklearn_v1.json");

fn providers() -> Option<(NativeMethodsProvider, DagMlValidationProvider)> {
    let Ok(path) = std::env::var("N4M_LIBRARY_PATH") else {
        assert!(
            std::env::var_os("CI").is_none(),
            "N4M_LIBRARY_PATH is required in CI for the DAG-ML probe golden"
        );
        return None;
    };
    Some((
        NativeMethodsProvider::load(&path).expect("Methods ABI"),
        DagMlValidationProvider::load(&path).expect("DAG-ML Methods runtime"),
    ))
}

fn parse(value: Value) -> QualificationInput {
    serde_json::from_str(&value.to_string()).unwrap()
}

/// Strictly relative tolerance; no reference value used here is zero.
fn close(actual: f64, expected: f64, tol: f64, label: &str) {
    assert!(expected != 0.0, "{label}: zero reference");
    assert!(
        (actual - expected).abs() <= tol * expected.abs(),
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

fn status(m: &Metric) -> String {
    serde_json::to_value(&m.status)
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

fn number(report: &QualificationReport, id: &str, estimator: &str) -> f64 {
    metric(report, id, estimator)
        .value
        .as_ref()
        .unwrap()
        .as_f64()
        .unwrap()
}

#[test]
fn dag_ml_probe_matches_independent_scikit_learn_reference() {
    let Some((methods, validation)) = providers() else {
        return;
    };
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for (case, data) in golden["cases"].as_object().unwrap() {
        let report = analyze_with_validation(&parse(data["input"].clone()), &methods, &validation);
        assert!(report
            .capabilities
            .iter()
            .any(|c| c.capability_id == "validation_probe" && c.available && !c.qualified));
        let ids: Vec<String> = serde_json::from_value(data["sample_ids"].clone()).unwrap();
        for estimator in ["pls", "pcr"] {
            let label = format!("{case}/{estimator}");
            let expected = &data[estimator];
            let plan = metric(&report, "probe.plan", estimator);
            assert_eq!(status(plan), "computed", "{label}: {:?}", plan.reason_code);
            let plan = plan.value.as_ref().unwrap();
            assert_eq!(plan["outer_splits"], data["outer_splits"], "{label}");
            assert_eq!(plan["inner_splits"], data["inner_splits"], "{label}");
            assert_eq!(plan["component_grid"], data["component_grid"], "{label}");
            assert_eq!(plan["numerical_rank"], data["numerical_rank"], "{label}");
            let folds = metric(&report, "probe.folds", estimator)
                .value
                .clone()
                .unwrap();
            let folds = folds.as_array().unwrap();
            let exp_folds = expected["folds"].as_array().unwrap();
            assert_eq!(folds.len(), exp_folds.len(), "{label}");
            for (f, e) in folds.iter().zip(exp_folds) {
                assert_eq!(f["eval_sample_ids"], e["validation_sample_ids"], "{label}");
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
                assert_eq!(inner, expected_inner, "{label}");
                assert_eq!(
                    f["selected_components"], e["selected_components"],
                    "{label}"
                );
                close(
                    f["train_mean"].as_f64().unwrap(),
                    e["train_mean"].as_f64().unwrap(),
                    1e-12,
                    &format!("{label} train mean"),
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
                        &format!("{label} inner rmse"),
                    );
                }
            }
            let oof = metric(&report, "probe.oof_predictions", estimator)
                .value
                .clone()
                .unwrap();
            let oof_ids: Vec<String> = serde_json::from_value(oof["sample_ids"].clone()).unwrap();
            assert_eq!(oof_ids, ids, "{label}");
            for key in ["prediction", "train_mean_prediction"] {
                for (i, (a, e)) in oof[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(expected[key].as_array().unwrap())
                    .enumerate()
                {
                    close(
                        a.as_f64().unwrap(),
                        e.as_f64().unwrap(),
                        1e-7,
                        &format!("{label} {key} {i}"),
                    );
                }
            }
            for (id, key) in [
                ("probe.rmse", "rmse"),
                ("probe.mae", "mae"),
                ("probe.r2_oof", "r2_oof"),
                ("probe.skill_vs_train_mean", "skill_vs_train_mean"),
                ("probe.train_mean_rmse", "train_mean_rmse"),
            ] {
                close(
                    number(&report, id, estimator),
                    expected[key].as_f64().unwrap(),
                    1e-7,
                    &format!("{label} {id}"),
                );
            }
            // Domains stay structured: ("A|B", "C"), ("A", "B|C") and an
            // absent instrument are three distinct domains.
            let domains = metric(&report, "probe.domain_scores", estimator)
                .value
                .clone()
                .unwrap();
            let domains = domains.as_array().unwrap();
            let exp_domains = expected["domains"].as_array().unwrap();
            assert_eq!(domains.len(), exp_domains.len(), "{label}");
            for (d, e) in domains.iter().zip(exp_domains) {
                assert_eq!(d["instrument"], e["instrument"], "{label}");
                assert_eq!(d["campaign"], e["campaign"], "{label}");
                assert_eq!(d["n_samples"], e["n_samples"], "{label}");
                close(
                    d["rmse"].as_f64().unwrap(),
                    e["rmse"].as_f64().unwrap(),
                    1e-7,
                    &format!("{label} domain"),
                );
                close(
                    d["train_mean_rmse"].as_f64().unwrap(),
                    e["train_mean_rmse"].as_f64().unwrap(),
                    1e-10,
                    &format!("{label} domain baseline"),
                );
            }
        }
    }
}

/// The real DAG-ML provider with a deliberate alteration of its result.
struct Tamper<'a, F: Fn(&mut ProbeResult)> {
    inner: &'a DagMlValidationProvider,
    alter: F,
}

impl<F: Fn(&mut ProbeResult)> ValidationProvider for Tamper<'_, F> {
    fn capabilities(&self) -> Vec<Capability> {
        self.inner.capabilities()
    }
    fn probe(&self, request: &ProbeRequest) -> Result<ProbeResult, ProviderError> {
        let mut result = self.inner.probe(request)?;
        (self.alter)(&mut result);
        Ok(result)
    }
}

#[test]
fn contradictory_provider_results_are_rejected_without_a_new_cv() {
    let Some((methods, validation)) = providers() else {
        return;
    };
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut input = parse(golden["cases"]["base"]["input"].clone());
    input.options.validation_probe.estimators = vec![ProbeEstimator::Pls];
    type Alteration = Box<dyn Fn(&mut ProbeResult)>;
    let cases: Vec<(Alteration, Option<&str>)> = vec![
        (
            // Two components chosen although one has a lower inner RMSE.
            Box::new(|r| {
                let f = &mut r.outer_folds[0];
                f.candidates[0].inner_rmse = 0.0;
                f.selected_components = 2;
            }),
            Some("PROVIDER_SELECTION_NOT_MINIMUM"),
        ),
        (
            // Exact ties resolve to the fewest components.
            Box::new(|r| {
                let f = &mut r.outer_folds[0];
                f.candidates.iter_mut().for_each(|c| c.inner_rmse = 1.0);
                f.selected_components = 1;
            }),
            None,
        ),
        (
            Box::new(|r| {
                let f = &mut r.outer_folds[0];
                f.candidates.iter_mut().for_each(|c| c.inner_rmse = 1.0);
                f.selected_components = 2;
            }),
            Some("PROVIDER_SELECTION_NOT_MINIMUM"),
        ),
        (
            Box::new(|r| r.outer_folds[1].fold.fold_id = r.outer_folds[0].fold.fold_id.clone()),
            Some("PROVIDER_FOLD_IDS_NOT_UNIQUE"),
        ),
        (
            Box::new(|r| r.n_fits = 0),
            Some("PROVIDER_FIT_COUNT_MISMATCH"),
        ),
        (
            Box::new(|r| r.model.rmse = -1.0),
            Some("INVALID_PROVIDER_RESULT"),
        ),
        (
            Box::new(|r| r.model.mae = f64::INFINITY),
            Some("INVALID_PROVIDER_RESULT"),
        ),
        (
            Box::new(|r| r.model.rmse *= 1.001),
            Some("PROVIDER_SCORES_DISAGREE_WITH_METHODS"),
        ),
        (
            Box::new(|r| r.oof[0].prediction += 1.0),
            Some("PROVIDER_SCORES_DISAGREE_WITH_METHODS"),
        ),
    ];
    for (alter, expected) in cases {
        let tampered = Tamper {
            inner: &validation,
            alter,
        };
        let report = analyze_with_validation(&input, &methods, &tampered);
        let rmse = metric(&report, "probe.rmse", "pls");
        match expected {
            Some(reason) => {
                assert_eq!(status(rmse), "error", "{reason}");
                assert_eq!(rmse.reason_code.as_deref(), Some(reason));
                assert!(report
                    .metrics
                    .iter()
                    .filter(|m| m.metric_id.starts_with("probe."))
                    .all(|m| m.value.is_none()));
            }
            None => assert_eq!(status(rmse), "computed", "{:?}", rmse.reason_code),
        }
    }
}

fn input_from(
    ids: &[String],
    x: &[Vec<f64>],
    y: &[f64],
    campaigns: &[String],
    groups: Option<&[String]>,
    unit: IndependenceUnit,
) -> QualificationInput {
    let p = x[0].len();
    parse(json!({
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
            json!({"sample_id": s, "instrument": "A", "campaign": campaigns[i],
                   "independence_group": groups.map(|g| g[i].clone())})
        }).collect::<Vec<_>>(),
        "targets": [{
            "target_id": "y", "kind": "continuous", "unit": "%",
            "values": ids.iter().zip(y).map(|(s, v)| json!({"sample_id": s, "value": v, "status": "exact"})).collect::<Vec<_>>()
        }],
        "options": {"independence_unit": unit, "seed": "7", "snv_sensitivity": false,
                    "validation_probe": {"estimators": ["pls"]}}
    }))
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
        let groups = (unit == IndependenceUnit::Group).then_some(batches.as_slice());
        let input = input_from(&ids, &x, &y, &batches, groups, unit);
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
        let value = number(&report, "probe.skill_vs_train_mean", "pls");
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

/// Declared numerical domain. Inside it, every scaled run is either correct
/// (golden predictions, scaled for y) or an explicit error: the Methods
/// NIPALS PLS estimator uses absolute `DBL_EPSILON` thresholds and refuses
/// strongly scaled data with `NumericalFailure` (known upstream limit,
/// reported with its fold/candidate context), never a wrong value. Outside
/// the domain (X at 2^300) the Methods aggregation kernel refuses before any
/// fit with `NUMERICAL_DOMAIN_EXCEEDED`.
#[test]
fn probe_is_correct_or_explicit_inside_the_domain_and_refuses_outside() {
    let Some((methods, validation)) = providers() else {
        return;
    };
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let base = &golden["cases"]["base"];
    let scaled = |x_scale: f64, y_scale: f64| {
        let mut data = base["input"].clone();
        for row in data["sources"][0]["x"].as_array_mut().unwrap() {
            for v in row.as_array_mut().unwrap() {
                *v = json!(v.as_f64().unwrap() * x_scale);
            }
        }
        for v in data["targets"][0]["values"].as_array_mut().unwrap() {
            v["value"] = json!(v["value"].as_f64().unwrap() * y_scale);
        }
        data["options"]["validation_probe"] = json!({"estimators": ["pls"]});
        analyze_with_validation(&parse(data), &methods, &validation)
    };
    let expected: Vec<f64> = serde_json::from_value(base["pls"]["prediction"].clone()).unwrap();
    let mut computed = 0;
    for (x_scale, y_scale) in [
        (1.0, 1.0),
        (2f64.powi(100), 1.0),
        (2f64.powi(-100), 1.0),
        (1.0, 2f64.powi(30)),
        (1.0, 2f64.powi(100)),
    ] {
        let report = scaled(x_scale, y_scale);
        let oof = metric(&report, "probe.oof_predictions", "pls");
        match &oof.value {
            Some(value) => {
                computed += 1;
                for (i, (a, e)) in value["prediction"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(&expected)
                    .enumerate()
                {
                    close(
                        a.as_f64().unwrap() / y_scale,
                        *e,
                        1e-7,
                        &format!("x*{x_scale} y*{y_scale} oof {i}"),
                    );
                }
                close(
                    number(&report, "probe.rmse", "pls") / y_scale,
                    base["pls"]["rmse"].as_f64().unwrap(),
                    1e-7,
                    "scaled rmse",
                );
            }
            None => {
                assert_eq!(status(oof), "error");
                let detail = oof.parameters["provider_error_detail"].as_str().unwrap();
                assert!(detail.contains("NumericalFailure"), "{detail}");
                assert!(detail.contains("outer fold"), "{detail}");
            }
        }
    }
    assert!(computed >= 2, "the unscaled and y*2^30 runs are computed");
    // Refused during population aggregation, before any estimator runs.
    let report = scaled(2f64.powi(300), 1.0);
    let rmse = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "probe.rmse")
        .unwrap();
    assert_eq!(status(rmse), "unsupported");
    assert_eq!(
        rmse.reason_code.as_deref(),
        Some("NUMERICAL_DOMAIN_EXCEEDED")
    );
}
