//! Synchronous Methods callback in the same worker. All protocols stay Rust.
use js_sys::Function;
use nirs4all_preflight::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use wasm_bindgen::prelude::*;

struct CallbackProvider<'a>(&'a Function);
impl CallbackProvider<'_> {
    fn invoke<T: DeserializeOwned>(
        &self,
        operation: &str,
        request: &impl Serialize,
    ) -> Result<T, ProviderError> {
        let request = serde_json::to_string(request)
            .map_err(|_| ProviderError::internal("METHODS_REQUEST_SERIALIZATION_FAILED"))?;
        let result = self
            .0
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(operation),
                &JsValue::from_str(&request),
            )
            .map_err(|_| ProviderError::internal("METHODS_CALLBACK_FAILED"))?;
        let text = result
            .as_string()
            .ok_or_else(|| ProviderError::internal("METHODS_CALLBACK_MUST_RETURN_JSON_STRING"))?;
        match serde_json::from_str(&text) {
            Ok(Reply::Ok(value)) => Ok(value),
            Ok(Reply::ProviderError(WireError::Methods {
                methods_status,
                message,
            })) => Err(ProviderError::from_methods_error(methods_status, &message)),
            Ok(Reply::ProviderError(WireError::Adapter(error))) => Err(error),
            Err(_) => Err(ProviderError::internal("METHODS_CALLBACK_INVALID_RESPONSE")),
        }
    }
}
/// Callback reply: a result, or a structured provider error. Methods
/// exceptions carry their n4m status and message, mapped exactly as the
/// native adapter.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Reply<T> {
    Ok(T),
    ProviderError(WireError),
}
#[derive(Deserialize)]
#[serde(untagged)]
enum WireError {
    Methods {
        methods_status: i32,
        message: String,
    },
    Adapter(ProviderError),
}
impl MethodsProvider for CallbackProvider<'_> {
    fn capabilities(&self) -> Vec<Capability> {
        self.invoke("capabilities", &serde_json::json!({}))
            .unwrap_or_else(|e| {
                vec![Capability {
                    capability_id: "methods".into(),
                    available: false,
                    qualified: false,
                    reason: Some(e.reason),
                }]
            })
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        self.invoke("pca", r)
    }
    fn repeatability(
        &self,
        r: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        self.invoke("repeatability", r)
    }
    fn summary(&self, r: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        self.invoke("summary", r)
    }
    fn nearest_neighbors(
        &self,
        r: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        self.invoke("nearest_neighbors", r)
    }
    fn local_contrast(
        &self,
        r: &LocalContrastRequest,
    ) -> Result<LocalContrastDiagnostics, ProviderError> {
        self.invoke("local_contrast", r)
    }
    fn hdbscan(&self, r: &HdbscanRequest) -> Result<HdbscanDiagnostics, ProviderError> {
        self.invoke("hdbscan", r)
    }
    fn adjusted_rand_index(
        &self,
        r: &AdjustedRandRequest,
    ) -> Result<AdjustedRandDiagnostics, ProviderError> {
        self.invoke("adjusted_rand_index", r)
    }
    fn snv(&self, r: &SnvRequest) -> Result<SnvDiagnostics, ProviderError> {
        self.invoke("snv", r)
    }
    fn noise_proxy(&self, r: &NoiseProxyRequest) -> Result<NoiseProxyDiagnostics, ProviderError> {
        self.invoke("noise_proxy", r)
    }
    fn tolerance_pairs(
        &self,
        r: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        self.invoke("tolerance_pairs", r)
    }
    fn association(&self, r: &AssociationRequest) -> Result<AssociationDiagnostics, ProviderError> {
        self.invoke("association", r)
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        self.invoke("holm_adjust", r)
    }
    fn correlation(&self, r: &CorrelationRequest) -> Result<CorrelationDiagnostics, ProviderError> {
        self.invoke("correlation", r)
    }
    fn bh_adjust(&self, r: &BhRequest) -> Result<BhDiagnostics, ProviderError> {
        self.invoke("bh_adjust", r)
    }
    fn association_exact(
        &self,
        r: &AssociationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        self.invoke("association_exact", r)
    }
    fn correlation_exact(
        &self,
        r: &CorrelationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        self.invoke("correlation_exact", r)
    }
    fn permanova(&self, r: &PermanovaRequest) -> Result<PermanovaDiagnostics, ProviderError> {
        self.invoke("permanova", r)
    }
    fn permdisp(&self, r: &PermdispRequest) -> Result<PermdispDiagnostics, ProviderError> {
        self.invoke("permdisp", r)
    }
    fn permanova_freedman_lane(
        &self,
        r: &FreedmanLaneRequest,
    ) -> Result<FreedmanLaneDiagnostics, ProviderError> {
        self.invoke("permanova_freedman_lane", r)
    }
    fn energy_distance(
        &self,
        r: &EnergyDistanceRequest,
    ) -> Result<EnergyDistanceDiagnostics, ProviderError> {
        self.invoke("energy_distance", r)
    }
    fn pca_monitor(&self, r: &PcaMonitorRequest) -> Result<PcaMonitorDiagnostics, ProviderError> {
        self.invoke("pca_monitor", r)
    }
    fn variance_components(
        &self,
        r: &VarianceComponentsRequest,
    ) -> Result<VarianceComponentsDiagnostics, ProviderError> {
        self.invoke("variance_components", r)
    }
    fn group_means(&self, r: &GroupMeansRequest) -> Result<GroupMeansDiagnostics, ProviderError> {
        self.invoke("group_means", r)
    }
    fn regression_scores(
        &self,
        r: &RegressionScoresRequest,
    ) -> Result<RegressionScores, ProviderError> {
        self.invoke("regression_scores", r)
    }
}
/// Browser validation: the Rust engine translates the probe once
/// (`dagml::nested_probe`); the worker runs dag-ml-wasm
/// `execute_nested_selection_json` with the Methods JS controller and
/// returns the outcome, which Rust maps back and re-verifies.
impl ValidationProvider for CallbackProvider<'_> {
    fn capabilities(&self) -> Vec<Capability> {
        self.invoke("validation_capabilities", &serde_json::json!({}))
            .unwrap_or_else(|e| {
                vec![Capability {
                    capability_id: VALIDATION_CAPABILITY_ID.into(),
                    available: false,
                    qualified: false,
                    reason: Some(e.reason),
                }]
            })
    }
    fn probe(&self, request: &ProbeRequest) -> Result<ProbeResult, ProviderError> {
        let probe = dagml::nested_probe(request, dagml::ControllerKind::JavaScript)?;
        let rows = serde_json::json!({
            "sample_ids": probe.rows.keys().collect::<Vec<_>>(),
            "x": probe.rows.values().map(|(x, _)| x).collect::<Vec<_>>(),
            "y": probe.rows.values().map(|(_, y)| y).collect::<Vec<_>>(),
        });
        let outcome: dagml::NestedSelectionOutcome = self.invoke(
            "nested_selection",
            &serde_json::json!({"request": probe.request, "envelope": probe.envelope, "rows": rows}),
        )?;
        dagml::probe_result(
            &probe,
            &outcome,
            "dag-ml-wasm with the Methods JS RolePipeline controller",
        )
    }
}
fn parse<T: DeserializeOwned>(input: &str) -> Result<T, JsValue> {
    if input.len() > 64 * 1024 * 1024 {
        return Err(JsValue::from_str("JSON_MEMORY_BUDGET_EXCEEDED"));
    }
    serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn validate_json(input: &str) -> Result<String, JsValue> {
    let input: QualificationInput = parse(input)?;
    serde_json::to_string(&validate_input(&input)).map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn analyze_json(input: &str, methods_callback: &Function) -> Result<String, JsValue> {
    let input: QualificationInput = parse(input)?;
    serde_json::to_string(&analyze_with_validation(
        &input,
        &CallbackProvider(methods_callback),
        &CallbackProvider(methods_callback),
    ))
    .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn capabilities_json(methods_callback: &Function) -> Result<String, JsValue> {
    serde_json::to_string(&capabilities_with_validation(
        &CallbackProvider(methods_callback),
        &CallbackProvider(methods_callback),
    ))
    .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn report_html_json(input: &str) -> Result<String, JsValue> {
    let report: QualificationReport = parse(input)?;
    Ok(report_html(&report))
}
