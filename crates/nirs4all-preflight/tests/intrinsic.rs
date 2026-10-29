use nirs4all_preflight::*;
use serde_json::{json, Value};
use std::cell::RefCell;

#[derive(Default)]
struct RecordingProvider(RefCell<Vec<ProcedureRequest>>);
impl MethodsProvider for RecordingProvider {
    fn capabilities(&self) -> Vec<Capability> {
        vec![]
    }
    fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("TEST_NO_PCA"))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("TEST_NO_REPEATS"))
    }
    fn procedure(&self, request: &ProcedureRequest) -> Result<ProcedureDiagnostics, ProviderError> {
        self.0.borrow_mut().push(request.clone());
        Err(ProviderError::unsupported("METHODS_PROCEDURE_UNAVAILABLE"))
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../examples/first_run.json")).unwrap()
}

#[test]
fn intrinsic_population_preserves_masks_and_excludes_retained_and_augmented_rows() {
    let provider = RecordingProvider::default();
    let mut value = fixture();
    let old: QualificationInput = serde_json::from_value(value.clone()).unwrap();
    analyze(&old, &provider);
    assert!(
        provider.0.borrow().is_empty(),
        "existing profiles remain unchanged"
    );
    value["options"]["intrinsic_qc"] = json!({"axis_basis":"physical", "clip_upper":10.});
    value["samples"][4]["augmentation_parent_id"] = json!("s1");
    value["sources"][0]["x"][0][0] = Value::Null;
    value["sources"][0]["x"][5] = json!([9e50, 8e50, 7e50]);
    let input: QualificationInput = serde_json::from_value(value).unwrap();
    assert!(validate_input(&input).valid);
    let report = analyze(&input, &provider);
    let calls = provider.0.borrow();
    assert_eq!(calls.len(), 3);
    for call in calls.iter() {
        assert_eq!(call.matrix.len(), 4);
        assert_eq!(call.matrix[0][0], 0.);
        assert!(
            matches!(call.parameters.get("valid_mask"), Some(ProcedureParameter::IntArray(mask)) if mask.len()==12 && mask[0]==0 && mask[1]==1)
        );
    }
    assert!(
        matches!(calls[1].parameters.get("axis_values"), Some(ProcedureParameter::DoubleArray(axis)) if axis == &[1100.,1200.,1300.])
    );
    let metric = report
        .metrics
        .iter()
        .find(|m| m.metric_id == "intrinsic.reference.rms_median")
        .unwrap();
    assert!(matches!(metric.status, Availability::Unsupported));
    assert_eq!(metric.value, None);
    assert_eq!(
        metric.reason_code.as_deref(),
        Some("METHODS_PROCEDURE_UNAVAILABLE")
    );
    let serialized = serde_json::to_value(&report).unwrap();
    let restored: QualificationReport = serde_json::from_value(serialized).unwrap();
    let metric = restored
        .metrics
        .iter()
        .find(|m| m.metric_id == metric.metric_id)
        .unwrap();
    assert!(metric.value.is_none());
    assert_eq!(
        metric.protocol_version,
        "spectral-reference-pairwise-valid.v1"
    );
    assert_eq!(metric.population_id, "development_real");
}

#[test]
fn invalid_intrinsic_parameters_refuse_before_any_provider_call() {
    for options in [
        json!({"outlier_threshold":0}),
        json!({"clip_lower":2,"clip_upper":1}),
        json!({"n_neighbors":0}),
        json!({"clip_tolerance":-0.1}),
    ] {
        let mut input = fixture();
        input["options"]["intrinsic_qc"] = options;
        let input: QualificationInput = serde_json::from_value(input).unwrap();
        let provider = RecordingProvider::default();
        let report = analyze(&input, &provider);
        assert!(!report.validation.valid);
        assert!(provider.0.borrow().is_empty());
    }
}

fn legacy_case(name: &str) -> Value {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/intrinsic_legacy_v1.json")).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == name)
        .unwrap()
        .clone()
}

fn native_report(case: &Value) -> Option<QualificationReport> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    let provider = native::NativeMethodsProvider::load(path).unwrap();
    let input: QualificationInput = serde_json::from_value(case["input"].clone()).unwrap();
    assert!(validate_input(&input).valid);
    Some(analyze(&input, &provider))
}

fn native_metric<'a>(report: &'a QualificationReport, id: &str) -> &'a Metric {
    report.metrics.iter().find(|m| m.metric_id == id).unwrap()
}

#[test]
fn native_complete_spectra_conform_to_recorded_legacy_protocols() {
    let case = legacy_case("complete");
    let Some(report) = native_report(&case) else {
        return;
    };
    for (legacy_family, legacy_name, native_id) in [
        (
            "reference",
            "rms_to_mean_spectrum",
            "intrinsic.reference.rms_median",
        ),
        (
            "reference",
            "rms_to_mean_spectrum_p95",
            "intrinsic.reference.rms_p95",
        ),
        (
            "reference",
            "sam_to_mean_spectrum",
            "intrinsic.reference.sam_median",
        ),
        (
            "reference",
            "sam_to_mean_spectrum_p95",
            "intrinsic.reference.sam_p95",
        ),
        (
            "reference",
            "affine_offset_median",
            "intrinsic.reference.affine_offset_median",
        ),
        (
            "reference",
            "affine_offset_p95_abs",
            "intrinsic.reference.affine_abs_offset_p95",
        ),
        (
            "reference",
            "affine_gain_median",
            "intrinsic.reference.affine_gain_median",
        ),
        (
            "reference",
            "affine_gain_p95_abs_delta",
            "intrinsic.reference.affine_abs_gain_delta_p95",
        ),
        (
            "reference",
            "affine_residual_rms_median",
            "intrinsic.reference.affine_residual_rms_median",
        ),
        (
            "reference",
            "affine_residual_rms_p95",
            "intrinsic.reference.affine_residual_rms_p95",
        ),
        ("noise", "noise_rms", "intrinsic.noise.global_noise_sigma"),
        ("noise", "snr", "intrinsic.noise.global_signal_noise_ratio"),
        ("noise", "snr_db", "intrinsic.noise.global_signal_noise_db"),
        ("events", "jump_count", "intrinsic.events.global_jump_count"),
        (
            "events",
            "jump_rate",
            "intrinsic.events.global_jump_fraction",
        ),
        (
            "events",
            "spike_count",
            "intrinsic.events.global_spike_count",
        ),
        (
            "events",
            "spike_rate",
            "intrinsic.events.global_spike_fraction",
        ),
    ] {
        let metric = native_metric(&report, native_id);
        assert!(
            matches!(metric.status, Availability::Computed),
            "{native_id}: {metric:?}"
        );
        let expected = case["legacy"][legacy_family][legacy_name].as_f64().unwrap();
        let actual = metric.value.as_ref().unwrap().as_f64().unwrap();
        let tolerance = if native_id.contains(".sam_") {
            2e-10
        } else {
            2e-12 + 2e-11 * expected.abs()
        };
        assert!(
            (actual - expected).abs() <= tolerance,
            "{native_id}: actual={actual}, expected={expected}"
        );
    }
    let clipping = native_metric(&report, "intrinsic.events.global_declared_clip_fraction");
    assert!(matches!(clipping.status, Availability::NotApplicable));
    assert!(clipping.value.is_none());
    assert_eq!(
        clipping.reason_code.as_deref(),
        Some("PHYSICAL_SENSOR_BOUNDS_NOT_DECLARED")
    );
    // True LOF is a distinct native protocol, never the legacy kNN ratio.
    assert!(matches!(
        native_metric(&report, "intrinsic.local_density.lof_p95").status,
        Availability::Computed
    ));
}

#[test]
fn native_masked_spectra_keep_unavailability_and_observation_identity() {
    let case = legacy_case("masked");
    let Some(report) = native_report(&case) else {
        return;
    };
    let rms = native_metric(&report, "intrinsic.reference.rms");
    let values = rms.value.as_ref().unwrap();
    assert!(values["values"][2].is_null());
    assert_eq!(values["observation_ids"][2], "obs-2");
    assert_eq!(values["physical_sample_ids"][2], "physical-1");
    assert_eq!(rms.denominators["n_observations"], 8);
    assert_eq!(rms.denominators["n_available_observations"], 7);
    assert_ne!(values["status_codes"][2], 0);
    assert_eq!(
        rms.parameters["reference_definition"],
        "development_real_dataset_mean_per_valid_feature"
    );
    let round_trip: QualificationReport =
        serde_json::from_value(serde_json::to_value(&report).unwrap()).unwrap();
    assert!(native_metric(&round_trip, "intrinsic.reference.rms")
        .value
        .as_ref()
        .unwrap()["values"][2]
        .is_null());
}

#[test]
fn native_zero_noise_is_observed_but_zero_norm_and_ratios_are_undefined() {
    let case = legacy_case("zero_norm");
    let Some(report) = native_report(&case) else {
        return;
    };
    let rms = native_metric(&report, "intrinsic.reference.rms_median");
    assert_eq!(rms.value, Some(json!(0.)));
    let noise = native_metric(&report, "intrinsic.noise.global_noise_sigma");
    assert_eq!(noise.value, Some(json!(0.)));
    for (signal, row_code) in [("sam", 2), ("affine_gain", 3)] {
        let metric = native_metric(&report, &format!("intrinsic.reference.{signal}_median"));
        assert!(matches!(metric.status, Availability::InsufficientData));
        assert!(metric.value.is_none());
        let rows = native_metric(&report, &format!("intrinsic.reference.{signal}"));
        assert_eq!(
            rows.parameters["row_status_codes"],
            json!(vec![row_code; 4])
        );
    }
    for id in [
        "intrinsic.noise.global_signal_noise_ratio",
        "intrinsic.noise.global_signal_noise_db",
    ] {
        let metric = native_metric(&report, id);
        assert!(
            matches!(metric.status, Availability::Undefined),
            "{id}: {metric:?}"
        );
        assert!(metric.value.is_none());
        assert!(metric.reason_code.is_some());
    }
}
