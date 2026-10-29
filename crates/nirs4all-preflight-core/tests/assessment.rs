use nirs4all_preflight_core::{
    assessment::{extract_assessment, extract_findings, AssessmentContext, MetricSemantics},
    Availability, Metric,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn context() -> AssessmentContext {
    AssessmentContext {
        dataset_id: "dataset".into(),
        content_hash: "a".repeat(64),
        producer: "nirs4all-preflight".into(),
        source_id: "nir".into(),
        population_id: "development_real".into(),
        context_id: "intrinsic/native".into(),
        scope: "intrinsic".into(),
        target_id: None,
        split_id: None,
        fit_population_id: None,
        evaluation_population_id: None,
        semantics: BTreeMap::new(),
    }
}

fn report() -> Value {
    let measured = Metric::computed(
        "structure.effective_dimension",
        json!(2.5),
        Some("nir"),
        None,
    );
    let missing = Metric::unavailable(
        "repeatability.pooled_sd",
        Availability::InsufficientData,
        "NO_REPEAT_GROUPS",
        Some("nir"),
        None,
    );
    let vector = Metric::computed(
        "structure.pca_eigenvalues",
        json!([2.0, 1.0]),
        Some("nir"),
        None,
    );
    json!({
        "schema_version": 1, "engine_version": "0.1.0", "protocol_bundle_version": "0.1.0",
        "profile_status": "alpha", "status": "partial",
        "validation": {"valid": true, "issues": []},
        "capabilities": [{"capability_id": "repeatability", "available": false,
                          "qualified": false, "reason": "NO_REPEAT_GROUPS"}],
        "metrics": [measured, missing, vector],
        "findings": [{"rule_id": "PCA_REFERENCE", "severity": "info", "confidence": "qualitative",
                      "evidence": ["structure.effective_dimension"], "message": "Geometry only",
                      "action": "Inspect the reference population"}],
        "limitations": ["No validation of physical root causes"],
        "future_extension": {"must_survive": ["original", "report"]}
    })
}

#[test]
fn legacy_report_and_unknown_extensions_survive_losslessly() {
    let original = report();
    let adapted = extract_assessment(&original, &context()).unwrap();
    assert_eq!(adapted.report, original);
    assert_eq!(adapted.schema_version, "1");
    assert_eq!(adapted.metrics[0].value, Some(2.5));
    assert_eq!(adapted.metrics[0].confidence_status, "unknown");
    assert_eq!(adapted.metrics[0].evidence_coverage, None);
    assert_eq!(adapted.metrics[1].value, None);
    assert_eq!(adapted.metrics[1].availability, "unavailable");
    assert_eq!(adapted.metrics[1].native_status, "insufficient_data");
    assert_eq!(
        adapted.metrics[1].reason_code.as_deref(),
        Some("NO_REPEAT_GROUPS")
    );
    assert_eq!(adapted.metrics[2].value, None);
    assert_eq!(adapted.metrics[2].native_metric["value"], json!([2.0, 1.0]));
    let roundtrip = serde_json::to_value(&adapted).unwrap();
    assert!(roundtrip["metrics"][1]["value"].is_null());
    assert_eq!(roundtrip["report"], original);
}

#[test]
fn unavailable_evidence_is_never_replaced_by_a_clean_zero() {
    let mut input = report();
    input["metrics"][1]["value"] = json!(0.0); // distrust contradictory legacy payload
    let adapted = extract_assessment(&input, &context()).unwrap();
    assert_eq!(adapted.metrics[1].value, None);
    assert_eq!(adapted.metrics[1].native_metric["value"], json!(0.0));
    input["schema_version"] = json!(2);
    assert!(extract_assessment(&input, &context()).is_err());
}

#[test]
fn identity_and_task_populations_are_explicit_and_separate() {
    let mut cx = context();
    cx.source_id = "another-source".into();
    assert!(extract_assessment(&report(), &cx)
        .unwrap()
        .metrics
        .is_empty());
    let mut source_less = report();
    source_less["metrics"][0]["source_id"] = Value::Null;
    assert!(extract_assessment(&source_less, &context())
        .unwrap()
        .metrics
        .iter()
        .all(|m| m.metric_id != "structure.effective_dimension"));
    cx = context();
    cx.scope = "task".into();
    assert!(extract_assessment(&report(), &cx).is_err());
    cx.producer = "nirs4all-domains".into();
    cx.split_id = Some("split-v1".into());
    cx.fit_population_id = Some("calibration".into());
    cx.evaluation_population_id = Some("retained-test".into());
    assert!(extract_assessment(&report(), &cx).is_ok());
    cx.evaluation_population_id = cx.fit_population_id.clone();
    assert!(extract_assessment(&report(), &cx).is_err());
    cx = context();
    cx.split_id = Some("test-leak".into());
    assert!(extract_assessment(&report(), &cx).is_err());
}

#[test]
fn signature_strength_is_not_validated_causal_confidence() {
    let mut cx = context();
    cx.semantics.insert(
        "structure.effective_dimension".into(),
        MetricSemantics {
            kind: "heuristic_signature".into(),
            confidence_status: "unvalidated".into(),
            evidence_coverage: Some(0.5),
            signal_strength: Some(0.8),
        },
    );
    let adapted = extract_assessment(&report(), &cx).unwrap();
    assert_eq!(adapted.metrics[0].signal_strength, Some(0.8));
    assert_eq!(adapted.metrics[0].confidence_status, "unvalidated");
    cx.semantics
        .get_mut("structure.effective_dimension")
        .unwrap()
        .evidence_coverage = Some(f64::NAN);
    assert!(extract_assessment(&report(), &cx).is_err());
    cx.semantics
        .get_mut("structure.effective_dimension")
        .unwrap()
        .evidence_coverage = Some(1.1);
    assert!(extract_assessment(&report(), &cx).is_err());
    cx.semantics
        .get_mut("structure.effective_dimension")
        .unwrap()
        .evidence_coverage = Some(0.5);
    cx.semantics
        .get_mut("structure.effective_dimension")
        .unwrap()
        .kind = "possible_cause".into();
    cx.semantics
        .get_mut("structure.effective_dimension")
        .unwrap()
        .confidence_status = "validated".into();
    assert!(extract_assessment(&report(), &cx).is_err());
}

#[test]
fn findings_keep_severity_action_and_structured_evidence_separate() {
    let mut original = report();
    let mut snv = original["metrics"][0].clone();
    snv["view_id"] = json!("snv");
    original["metrics"].as_array_mut().unwrap().push(snv);
    original["findings"][0]["confidence"] = json!("high");
    original["findings"][0]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!("absent.proof"));
    let projected = extract_findings(&original, &context()).unwrap();
    assert_eq!(projected[0].confidence_status, "unknown");
    assert_eq!(projected[0].signal_strength, None);
    assert_eq!(projected[0].evidence_coverage, None);
    assert_eq!(projected[0].severity, "info");
    assert_eq!(
        projected[0].recommended_action,
        "Inspect the reference population"
    );
    assert_eq!(projected[0].unresolved_evidence, vec!["absent.proof"]);
    assert_eq!(projected[0].evidence.len(), 2);
    assert_eq!(projected[0].evidence[0].view_id, "native");
    assert_eq!(projected[0].evidence[1].view_id, "snv");
    assert_eq!(projected[0].original_finding, original["findings"][0]);
}
