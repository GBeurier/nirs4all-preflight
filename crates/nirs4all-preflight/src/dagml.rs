//! DAG-ML validation provider of the grouped probe.
//!
//! The whole nested loop runs in `dag_ml_core::execute_nested_selection`:
//! grouped outer and inner folds, inner FIT_CV of every candidate, selection
//! from inner OOF, selected FIT_CV on each outer training pool and the outer
//! OOF. Methods PLS/PCR execute through DAG-ML controllers: the native role
//! controllers on CPU, the JavaScript `N4mWasmRegressionController` in the
//! browser. This module only translates rows, identities and results; the
//! request translation is shared by both hosts.
use crate::*;
pub use dag_ml_core::NestedSelectionOutcome;
use dag_ml_core::{
    CampaignSpec, ExternalDataPlanEnvelope, GraphSpec, GroupId, GroupKFoldSpec,
    NestedSelectionCandidate, NestedSelectionRequest, NodeId, RegressionMetricKind, SampleId,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const TARGET_NODE: &str = "model:probe";
const BACKEND: &str = "dag-ml-core nested_selection";

/// Which DAG-ML controller family fits the Methods recipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerKind {
    /// `MethodsEstimatorController` over the native libn4m (CPU).
    NativeMethods,
    /// `N4mWasmRegressionController` over Methods JS/WASM (browser).
    JavaScript,
}

/// A probe translated for DAG-ML. Rows are keyed by positional DAG sample
/// identities; `sample_ids` maps them back to the preflight samples.
pub struct NestedProbe {
    pub request: NestedSelectionRequest,
    pub envelope: ExternalDataPlanEnvelope,
    pub rows: BTreeMap<SampleId, (Vec<f64>, f64)>,
    pub sample_ids: BTreeMap<SampleId, String>,
    /// Data, target and relation content fingerprints.
    pub identity: [String; 3],
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A DAG-ML refusal or execution failure keeps its taxonomy code; the
/// message (outer fold and candidate included) travels as detail.
pub fn dag_error(error: dag_ml_core::DagMlError) -> ProviderError {
    ProviderError::internal(format!(
        "DAG_ML_{}",
        error.code().to_uppercase().replace(['-', '.'], "_")
    ))
    .with_detail(error.to_string())
}

/// A failed nested selection, mapped identically on CPU and in WASM. The
/// first provider error raised by the selection-metrics callback (`cause`)
/// keeps its kind and reason, with the DAG-ML message as detail. Otherwise a
/// Methods numerical-domain refusal reported through a controller (the
/// DAG-ML message contains [`METHODS_DOMAIN_MESSAGE`]) is `unsupported`
/// with reason [`NUMERICAL_DOMAIN_EXCEEDED`]; any other failure stays the
/// host's `ordinary` provider error. `ordinary` carries the DAG-ML message
/// as its detail.
pub fn nested_selection_failure(
    cause: Option<ProviderError>,
    ordinary: ProviderError,
) -> ProviderError {
    let detail = ordinary.detail.clone().unwrap_or_default();
    match cause {
        Some(cause) => cause.with_detail(detail),
        None if detail.contains(METHODS_DOMAIN_MESSAGE) => {
            ProviderError::unsupported(NUMERICAL_DOMAIN_EXCEEDED).with_detail(detail)
        }
        None => ordinary,
    }
}

fn contract(e: impl std::fmt::Display) -> ProviderError {
    ProviderError::internal("DAG_ML_CONTRACT_TRANSLATION_FAILED").with_detail(e.to_string())
}

fn graph(estimator: ProbeEstimator, kind: ControllerKind) -> Result<GraphSpec, ProviderError> {
    let (method, solver) = match estimator {
        ProbeEstimator::Pls => ("models.pls.pls_regression", Some("nipals")),
        ProbeEstimator::Pcr => ("models.pls.pcr", None),
    };
    let mut params =
        json!({"center_x": true, "scale_x": false, "center_y": true, "scale_y": false});
    if let Some(solver) = solver {
        params["solver"] = json!(solver);
    }
    // The native role controller reads `method_id`; the JS controller reads
    // the operator type and passes node parameters to the Methods step.
    let operator = match kind {
        ControllerKind::NativeMethods => {
            params["method_id"] = json!(method);
            json!(format!("n4m:{method}"))
        }
        ControllerKind::JavaScript => json!({"type": format!("n4m:{method}")}),
    };
    serde_json::from_value(json!({
        "id": "graph:preflight.validation_probe", "interface": {"inputs": [], "outputs": []},
        "nodes": [{
            "id": TARGET_NODE, "kind": "model", "operator": operator, "params": params,
            "ports": {
                "inputs": [{"name": "x", "kind": "data", "representation": "tabular_numeric", "cardinality": "one", "description": ""}],
                "outputs": [{"name": "y_hat", "kind": "prediction", "representation": null, "cardinality": "one", "description": ""}]
            },
            "metadata": {}, "seed_label": null
        }],
        "edges": [], "search_space_fingerprint": null, "metadata": {}
    }))
    .map_err(contract)
}

/// Translate a probe request. Group identities keep the sorted order of the
/// component names; candidate IDs are zero-padded so DAG-ML's tie rule
/// (smallest ID) selects the fewest components.
pub fn nested_probe(
    request: &ProbeRequest,
    kind: ControllerKind,
) -> Result<NestedProbe, ProviderError> {
    let n = request.sample_ids.len();
    if request.group_ids.len() != n || request.matrix.len() != n || request.targets.len() != n {
        return Err(ProviderError::internal("PROBE_REQUEST_DIMENSION_MISMATCH"));
    }
    let group_rank: BTreeMap<&str, usize> = request
        .group_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .enumerate()
        .map(|(i, g)| (g, i))
        .collect();
    let mut rows = BTreeMap::new();
    let mut sample_groups = BTreeMap::new();
    let mut sample_ids = BTreeMap::new();
    for i in 0..n {
        let id = SampleId::new(format!("sample:{i:09}")).map_err(contract)?;
        rows.insert(id.clone(), (request.matrix[i].clone(), request.targets[i]));
        sample_groups.insert(
            id.clone(),
            GroupId::new(format!(
                "group:{:09}",
                group_rank[request.group_ids[i].as_str()]
            ))
            .map_err(contract)?,
        );
        sample_ids.insert(id, request.sample_ids[i].clone());
    }
    let content = |value: serde_json::Value| sha256_hex(value.to_string().as_bytes());
    let schema = content(json!({
        "probe": "preflight.validation_probe.v1",
        "cols": request.matrix.first().map_or(0, Vec::len),
    }));
    let plan = content(json!({
        "probe_id": request.probe_id,
        "estimator": request.estimator,
        "components": request.components,
    }));
    let identity = [
        content(json!(request.matrix)),
        content(json!(request.targets)),
        content(json!(sample_groups)),
    ];
    let envelope: ExternalDataPlanEnvelope = serde_json::from_value(json!({
        "schema_version": 1, "schema_fingerprint": schema, "plan_fingerprint": plan,
        "relation_fingerprint": null, "coordinator_relations": null,
    }))
    .map_err(contract)?;
    let campaign: CampaignSpec = serde_json::from_value(json!({
        "id": "campaign:preflight.validation_probe", "root_seed": request.seed,
        "data_bindings": {TARGET_NODE: [{
            "node_id": TARGET_NODE, "input_name": "x", "request_id": "preflight-probe-x",
            "schema_fingerprint": schema, "plan_fingerprint": plan,
            "relation_fingerprint": null,
            "output_representation": "tabular_numeric", "feature_set_id": "x",
            "source_ids": ["preflight"], "require_relations": false
        }]}
    }))
    .map_err(contract)?;
    Ok(NestedProbe {
        request: NestedSelectionRequest {
            id: "preflight.validation_probe".into(),
            graph: graph(request.estimator, kind)?,
            campaign,
            target_node: NodeId::new(TARGET_NODE).map_err(contract)?,
            candidates: request
                .components
                .iter()
                .map(|k| NestedSelectionCandidate {
                    candidate_id: format!("n_components:{k:04}"),
                    params: BTreeMap::from([("n_components".to_string(), json!(k))]),
                })
                .collect(),
            sample_groups,
            outer: GroupKFoldSpec {
                n_splits: request.outer_splits,
            },
            inner: GroupKFoldSpec {
                n_splits: request.inner_splits,
            },
            selection_metric: RegressionMetricKind::Rmse,
        },
        envelope,
        rows,
        sample_ids,
        identity,
    })
}

/// Translate a DAG-ML outcome back to preflight samples. Preflight then
/// re-verifies the whole result (`probe::validate_result`).
pub fn probe_result(
    probe: &NestedProbe,
    outcome: &NestedSelectionOutcome,
    backend: &str,
) -> Result<ProbeResult, ProviderError> {
    let ids = |list: &[SampleId]| -> Result<Vec<String>, ProviderError> {
        list.iter()
            .map(|id| {
                probe
                    .sample_ids
                    .get(id)
                    .cloned()
                    .ok_or_else(|| ProviderError::internal("DAG_ML_UNKNOWN_SAMPLE"))
            })
            .collect()
    };
    let components = |candidate: &str| {
        candidate
            .strip_prefix("n_components:")
            .and_then(|k| k.parse::<usize>().ok())
            .ok_or_else(|| ProviderError::internal("DAG_ML_UNKNOWN_CANDIDATE"))
    };
    if outcome.scopes.len() != outcome.outer_fold_set.folds.len() {
        return Err(ProviderError::internal("DAG_ML_SCOPE_FOLD_MISMATCH"));
    }
    let mut outer_folds = Vec::new();
    for (scope, fold) in outcome.scopes.iter().zip(&outcome.outer_fold_set.folds) {
        if scope.outer_fold_id != fold.fold_id {
            return Err(ProviderError::internal("DAG_ML_SCOPE_FOLD_MISMATCH"));
        }
        outer_folds.push(ProbeOuterFold {
            fold: ProbeFoldAssignment {
                fold_id: fold.fold_id.to_string(),
                train_sample_ids: ids(&fold.train_sample_ids)?,
                validation_sample_ids: ids(&fold.validation_sample_ids)?,
            },
            inner_folds: scope
                .inner_fold_set
                .inner_fold_set
                .folds
                .iter()
                .map(|f| {
                    Ok(ProbeFoldAssignment {
                        fold_id: f.fold_id.to_string(),
                        train_sample_ids: ids(&f.train_sample_ids)?,
                        validation_sample_ids: ids(&f.validation_sample_ids)?,
                    })
                })
                .collect::<Result<_, ProviderError>>()?,
            candidates: scope
                .candidates
                .iter()
                .map(|c| {
                    Ok(ProbeCandidateScore {
                        n_components: components(&c.candidate_id)?,
                        inner_rmse: c.score,
                    })
                })
                .collect::<Result<_, ProviderError>>()?,
            selected_components: components(&scope.decision.selected_candidate_id)?,
        });
    }
    let order: BTreeMap<&SampleId, usize> = probe
        .rows
        .keys()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let mut oof = outcome
        .oof
        .iter()
        .map(|r| {
            Ok((
                order
                    .get(&r.sample_id)
                    .copied()
                    .ok_or_else(|| ProviderError::internal("DAG_ML_UNKNOWN_SAMPLE"))?,
                ProbeOofRow {
                    sample_id: probe.sample_ids[&r.sample_id].clone(),
                    fold_id: r.outer_fold_id.to_string(),
                    y_true: r.y_true,
                    prediction: r.prediction,
                },
            ))
        })
        .collect::<Result<Vec<_>, ProviderError>>()?;
    oof.sort_by_key(|(i, _)| *i);
    let metric = |k: &str| {
        outcome
            .model_metrics
            .get(k)
            .copied()
            .ok_or_else(|| ProviderError::internal("DAG_ML_MISSING_SCORE"))
    };
    Ok(ProbeResult {
        outer_folds,
        oof: oof.into_iter().map(|(_, r)| r).collect(),
        model: ProbeScores {
            mse: metric("mse")?,
            rmse: metric("rmse")?,
            mae: metric("mae")?,
        },
        n_fits: outcome.n_fits,
        backend_version: format!("{BACKEND} schema {}; {backend}", outcome.schema_version),
    })
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
    use dag_ml_core::{
        derive_host_controller_registry, execute_nested_selection_with_metrics,
        methods_estimator_host_controller_specs, register_methods_estimator_controllers,
        ControllerId, DataBinding, DataMaterializationRequest, DataViewRequest, HandleKind,
        HandleRef, MethodsPlsData, MethodsPlsDataRequest, MethodsPlsDataset, MethodsPlsMatrix,
        MethodsRuntime, NestedSelectionMetrics, RegressionMetricKind, RuntimeControllerRegistry,
        RuntimeDataProvider, TrainingDataIdentity,
    };
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// CPU validation provider: DAG-ML with its native Methods role controllers;
    /// selection metrics come from Methods `n4m_stats_regression_scores`.
    pub struct DagMlValidationProvider {
        runtime: MethodsRuntime,
        methods: crate::native::NativeMethodsProvider,
    }

    /// DAG-ML selection metrics through Methods. The first provider error is
    /// kept so its kind and reason (e.g. `NUMERICAL_DOMAIN_EXCEEDED`) survive.
    struct MethodsMetrics<'a> {
        methods: &'a crate::native::NativeMethodsProvider,
        error: RefCell<Option<ProviderError>>,
    }

    impl NestedSelectionMetrics for MethodsMetrics<'_> {
        fn regression_metric(
            &self,
            metric: RegressionMetricKind,
            y_true: &[f64],
            y_pred: &[f64],
        ) -> dag_ml_core::Result<f64> {
            let scores = self
                .methods
                .regression_scores(&RegressionScoresRequest {
                    y_true: y_true.to_vec(),
                    y_pred: y_pred.to_vec(),
                })
                .map_err(|e| {
                    let reason = e.reason.clone();
                    self.error.borrow_mut().get_or_insert(e);
                    dag_ml_core::DagMlError::RuntimeValidation(format!(
                        "Methods regression scores refused: {reason}"
                    ))
                })?;
            match metric {
                RegressionMetricKind::Rmse => Ok(scores.rmse),
                RegressionMetricKind::Mse => Ok(scores.rmse * scores.rmse),
                RegressionMetricKind::Mae => Ok(scores.mae),
                other => Err(dag_ml_core::DagMlError::RuntimeValidation(format!(
                    "metric `{}` is not a probe selection metric",
                    other.name()
                ))),
            }
        }
    }

    impl DagMlValidationProvider {
        /// Configure DAG-ML's Methods runtime from an absolute libn4m path.
        pub fn load(library: impl AsRef<Path>) -> Result<Self, ProviderError> {
            let library = std::fs::canonicalize(library).map_err(|e| {
                ProviderError::unsupported("METHODS_LIBRARY_LOAD_FAILED").with_detail(e.to_string())
            })?;
            let methods = crate::native::NativeMethodsProvider::load(&library)?;
            MethodsRuntime::configure(library)
                .map(|runtime| Self { runtime, methods })
                .map_err(|e| {
                    ProviderError::unsupported("DAG_ML_METHODS_RUNTIME_UNAVAILABLE")
                        .with_detail(e.to_string())
                })
        }
    }

    /// Provider-owned aggregated rows, keyed by the DAG sample identity.
    struct Rows<'a> {
        probe: &'a NestedProbe,
        next: AtomicU64,
    }

    impl Rows<'_> {
        fn handle(&self, kind: HandleKind) -> dag_ml_core::Result<HandleRef> {
            Ok(HandleRef {
                handle: self.next.fetch_add(1, Ordering::SeqCst) + 1,
                kind,
                owner_controller: ControllerId::new("controller:preflight.rows")?,
            })
        }

        fn dataset(&self, ids: &[SampleId]) -> dag_ml_core::Result<MethodsPlsDataset> {
            let rows = ids
                .iter()
                .map(|id| {
                    self.probe.rows.get(id).ok_or_else(|| {
                        dag_ml_core::DagMlError::RuntimeValidation(format!("unknown sample `{id}`"))
                    })
                })
                .collect::<dag_ml_core::Result<Vec<_>>>()?;
            Ok(MethodsPlsDataset {
                y_validity_masks: None,
                sample_ids: ids.to_vec(),
                x: MethodsPlsMatrix {
                    values: rows.iter().flat_map(|(x, _)| x.iter().copied()).collect(),
                    rows: rows.len(),
                    cols: rows.first().map_or(0, |(x, _)| x.len()),
                },
                y: Some(MethodsPlsMatrix {
                    values: rows.iter().map(|(_, y)| *y).collect(),
                    rows: rows.len(),
                    cols: 1,
                }),
                target_names: vec!["y".into()],
            })
        }
    }

    impl RuntimeDataProvider for Rows<'_> {
        fn materialize(&self, _: &DataMaterializationRequest) -> dag_ml_core::Result<HandleRef> {
            self.handle(HandleKind::Data)
        }

        fn make_view(&self, _: &DataViewRequest) -> dag_ml_core::Result<HandleRef> {
            self.handle(HandleKind::DataView)
        }

        fn training_data_identity(
            &self,
            binding: &DataBinding,
        ) -> dag_ml_core::Result<Option<TrainingDataIdentity>> {
            let [data, target, relation] = self.probe.identity.clone();
            let mut identity = TrainingDataIdentity {
                requirement_key: dag_ml_core::data_binding_requirement_key(
                    &binding.node_id,
                    &binding.input_name,
                ),
                schema_fingerprint: binding.schema_fingerprint.clone(),
                plan_fingerprint: binding.plan_fingerprint.clone(),
                relation_fingerprint: relation,
                data_content_fingerprint: data,
                target_content_fingerprint: target,
                identity_fingerprint: String::new(),
            };
            identity.identity_fingerprint = identity.compute_fingerprint()?;
            Ok(Some(identity))
        }

        fn methods_pls_capability(&self) -> dag_ml_core::Result<()> {
            Ok(())
        }

        fn methods_pls_data(
            &self,
            request: &MethodsPlsDataRequest,
        ) -> dag_ml_core::Result<MethodsPlsData> {
            let fit = request.fit_view.sample_ids.as_deref().ok_or_else(|| {
                dag_ml_core::DagMlError::RuntimeValidation(
                    "fit view lacks sample identities".into(),
                )
            })?;
            Ok(MethodsPlsData {
                fit: self.dataset(fit)?,
                prediction: request
                    .prediction_view
                    .as_ref()
                    .and_then(|v| v.sample_ids.as_deref())
                    .map(|ids| self.dataset(ids))
                    .transpose()?,
            })
        }
    }

    impl ValidationProvider for DagMlValidationProvider {
        fn capabilities(&self) -> Vec<Capability> {
            vec![Capability {
                capability_id: VALIDATION_CAPABILITY_ID.into(),
                available: true,
                qualified: false,
                reason: Some("ALPHA_PROTOCOL_UNQUALIFIED".into()),
            }]
        }

        fn probe(&self, request: &ProbeRequest) -> Result<ProbeResult, ProviderError> {
            let probe = nested_probe(request, ControllerKind::NativeMethods)?;
            let registry = derive_host_controller_registry(
                &methods_estimator_host_controller_specs(&self.runtime).map_err(dag_error)?,
            )
            .map_err(dag_error)?;
            let mut controllers = RuntimeControllerRegistry::new();
            register_methods_estimator_controllers(&mut controllers, self.runtime.clone())
                .map_err(dag_error)?;
            let rows = Rows {
                probe: &probe,
                next: AtomicU64::new(0),
            };
            let metrics = MethodsMetrics {
                methods: &self.methods,
                error: RefCell::new(None),
            };
            let outcome = execute_nested_selection_with_metrics(
                &probe.request,
                &registry,
                &controllers,
                &rows,
                &metrics,
            )
            .map_err(|e| {
                nested_selection_failure(metrics.error.borrow_mut().take(), dag_error(e))
            })?;
            let library = self
                .runtime
                .library_path()
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            probe_result(
                &probe,
                &outcome,
                &format!("native Methods role controllers ({library})"),
            )
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::DagMlValidationProvider;
