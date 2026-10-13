//! Synchronous Methods callback in the same worker. All protocols stay Rust.
use js_sys::Function;
use nirs4all_preflight::*;
use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;

struct CallbackProvider<'a>(&'a Function);
impl CallbackProvider<'_> {
    fn invoke<T: DeserializeOwned>(
        &self,
        operation: &str,
        request: &impl Serialize,
    ) -> Result<T, ProviderError> {
        let request = serde_json::to_string(request)
            .map_err(|_| ProviderError("METHODS_REQUEST_SERIALIZATION_FAILED".into()))?;
        let result = self
            .0
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(operation),
                &JsValue::from_str(&request),
            )
            .map_err(|_| ProviderError("METHODS_CALLBACK_FAILED".into()))?;
        let text = result
            .as_string()
            .ok_or_else(|| ProviderError("METHODS_CALLBACK_MUST_RETURN_JSON_STRING".into()))?;
        serde_json::from_str(&text)
            .map_err(|_| ProviderError("METHODS_CALLBACK_INVALID_RESPONSE".into()))
    }
}
impl MethodsProvider for CallbackProvider<'_> {
    fn capabilities(&self) -> Vec<Capability> {
        self.invoke("capabilities", &serde_json::json!({}))
            .unwrap_or_else(|e| {
                vec![Capability {
                    capability_id: "methods".into(),
                    available: false,
                    qualified: false,
                    reason: Some(e.0),
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
    serde_json::to_string(&analyze(&input, &CallbackProvider(methods_callback)))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn capabilities_json(methods_callback: &Function) -> Result<String, JsValue> {
    serde_json::to_string(&capabilities(&CallbackProvider(methods_callback)))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn report_html_json(input: &str) -> Result<String, JsValue> {
    let report: QualificationReport = parse(input)?;
    Ok(report_html(&report))
}
