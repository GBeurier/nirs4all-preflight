//! DAG-ML validation provider for the preflight grouped probe.
//!
//! The whole nested loop runs in `dag_ml_core::execute_nested_selection`:
//! grouped outer and inner folds, inner FIT_CV of every candidate, selection
//! from inner OOF, selected FIT_CV on the outer training pool, outer OOF and
//! the fold-train mean baseline. Methods PLS/PCR execute through DAG-ML's
//! native role controllers. This adapter only translates rows and identities.
use dag_ml_core::{
    derive_host_controller_registry, execute_nested_selection,
    methods_estimator_host_controller_specs, register_methods_estimator_controllers,
    score_regression_prediction_block, CampaignSpec, ControllerId, DataBinding,
    DataMaterializationRequest, DataViewRequest, GraphSpec, GroupId, GroupKFoldSpec, HandleKind,
    HandleRef, MethodsPlsData, MethodsPlsDataRequest, MethodsPlsDataset, MethodsPlsMatrix,
    MethodsRuntime, NestedSelectionCandidate, NestedSelectionRequest, NodeId, PredictionBlock,
    PredictionLevel, PredictionPartition, PredictionUnitId, RegressionMetricKind,
    RegressionTargetBlock, RuntimeControllerRegistry, RuntimeDataProvider, SampleId,
    TrainingDataIdentity,
};
use nirs4all_preflight::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const TARGET_NODE: &str = "model:probe";
const BACKEND: &str = "dag-ml-core nested_selection.v1 + Methods role estimators";

fn err(e: impl std::fmt::Display) -> ProviderError {
    ProviderError(format!("DAG_ML_VALIDATION_FAILED: {e}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub struct DagMlValidationProvider {
    runtime: MethodsRuntime,
}

impl DagMlValidationProvider {
    /// Configure DAG-ML's Methods runtime from an absolute libn4m path.
    pub fn load(library: impl AsRef<Path>) -> Result<Self, ProviderError> {
        MethodsRuntime::configure(library)
            .map(|runtime| Self { runtime })
            .map_err(|e| ProviderError(format!("METHODS_RUNTIME_UNAVAILABLE: {e}")))
    }
}

/// Provider-owned aggregated rows, keyed by the DAG sample identity.
struct Rows {
    rows: BTreeMap<SampleId, (Vec<f64>, f64)>,
    identity: [String; 3],
    next: AtomicU64,
}

impl Rows {
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
                self.rows.get(id).ok_or_else(|| {
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

impl RuntimeDataProvider for Rows {
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
        let [data, target, relation] = self.identity.clone();
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
            dag_ml_core::DagMlError::RuntimeValidation("fit view lacks sample identities".into())
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

fn scores(metrics: &BTreeMap<String, f64>) -> Result<ProbeScores, ProviderError> {
    let get = |k: &str| {
        metrics
            .get(k)
            .copied()
            .ok_or_else(|| err(format!("missing {k}")))
    };
    Ok(ProbeScores {
        mse: get("mse")?,
        rmse: get("rmse")?,
        mae: get("mae")?,
        r2: get("r2")?,
    })
}

fn request_graph(estimator: ProbeEstimator) -> Result<GraphSpec, ProviderError> {
    let (method, solver) = match estimator {
        ProbeEstimator::Pls => ("models.pls.pls_regression", Some("nipals")),
        ProbeEstimator::Pcr => ("models.pls.pcr", None),
    };
    let mut params = json!({"method_id": method, "center_x": true, "scale_x": false,
                            "center_y": true, "scale_y": false});
    if let Some(solver) = solver {
        params["solver"] = json!(solver);
    }
    serde_json::from_value(json!({
        "id": "graph:preflight.validation_probe", "interface": {"inputs": [], "outputs": []},
        "nodes": [{
            "id": TARGET_NODE, "kind": "model", "operator": format!("n4m:{method}"),
            "params": params,
            "ports": {
                "inputs": [{"name": "x", "kind": "data", "representation": "tabular_numeric", "cardinality": "one", "description": ""}],
                "outputs": [{"name": "y_hat", "kind": "prediction", "representation": null, "cardinality": "one", "description": ""}]
            },
            "metadata": {}, "seed_label": null
        }],
        "edges": [], "search_space_fingerprint": null, "metadata": {}
    }))
    .map_err(err)
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
        let n = request.sample_ids.len();
        if request.group_ids.len() != n || request.matrix.len() != n || request.targets.len() != n {
            return Err(ProviderError("PROBE_REQUEST_DIMENSION_MISMATCH".into()));
        }
        // DAG identities are positional aliases; groups keep their sorted order.
        let dag_id = |i: usize| SampleId::new(format!("sample:{i:09}")).map_err(err);
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
        let mut back = BTreeMap::new();
        for i in 0..n {
            let id = dag_id(i)?;
            rows.insert(id.clone(), (request.matrix[i].clone(), request.targets[i]));
            sample_groups.insert(
                id.clone(),
                GroupId::new(format!(
                    "group:{:09}",
                    group_rank[request.group_ids[i].as_str()]
                ))
                .map_err(err)?,
            );
            back.insert(id, request.sample_ids[i].clone());
        }
        let content = |value: serde_json::Value| sha256_hex(value.to_string().as_bytes());
        let schema = content(
            json!({"probe": "preflight.validation_probe.v1", "cols": request.matrix.first().map_or(0, Vec::len)}),
        );
        let plan = content(
            json!({"probe_id": request.probe_id, "estimator": request.estimator, "components": request.components}),
        );
        let provider = Rows {
            identity: [
                content(json!(request.matrix)),
                content(json!(request.targets)),
                content(json!(sample_groups)),
            ],
            rows,
            next: AtomicU64::new(0),
        };
        let campaign: CampaignSpec = serde_json::from_value(json!({
            "id": "campaign:preflight.validation_probe", "root_seed": request.seed,
            "data_bindings": {TARGET_NODE: [{
                "node_id": TARGET_NODE, "input_name": "x", "request_id": "preflight-probe-x",
                "schema_fingerprint": schema, "plan_fingerprint": plan,
                "relation_fingerprint": provider.identity[2],
                "output_representation": "tabular_numeric", "feature_set_id": "x",
                "source_ids": ["preflight"], "require_relations": false
            }]}
        }))
        .map_err(err)?;
        let nested = NestedSelectionRequest {
            id: "preflight.validation_probe".into(),
            graph: request_graph(request.estimator)?,
            campaign,
            target_node: NodeId::new(TARGET_NODE).map_err(err)?,
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
        };
        let registry = derive_host_controller_registry(
            &methods_estimator_host_controller_specs(&self.runtime).map_err(err)?,
        )
        .map_err(err)?;
        let mut controllers = RuntimeControllerRegistry::new();
        register_methods_estimator_controllers(&mut controllers, self.runtime.clone())
            .map_err(err)?;
        let outcome =
            execute_nested_selection(&nested, &registry, &controllers, &provider).map_err(err)?;
        let ids = |list: &[SampleId]| list.iter().map(|id| back[id].clone()).collect::<Vec<_>>();
        let components = |candidate: &str| {
            candidate
                .strip_prefix("n_components:")
                .and_then(|k| k.parse::<usize>().ok())
                .ok_or_else(|| err(format!("unknown candidate {candidate}")))
        };
        let outer_folds = outcome
            .scopes
            .iter()
            .zip(&outcome.outer_fold_set.folds)
            .map(|(scope, fold)| {
                Ok(ProbeOuterFold {
                    fold: ProbeFoldAssignment {
                        fold_id: fold.fold_id.to_string(),
                        train_sample_ids: ids(&fold.train_sample_ids),
                        validation_sample_ids: ids(&fold.validation_sample_ids),
                    },
                    inner_folds: scope
                        .inner_fold_set
                        .inner_fold_set
                        .folds
                        .iter()
                        .map(|f| ProbeFoldAssignment {
                            fold_id: f.fold_id.to_string(),
                            train_sample_ids: ids(&f.train_sample_ids),
                            validation_sample_ids: ids(&f.validation_sample_ids),
                        })
                        .collect(),
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
                    train_mean: scope.train_mean,
                })
            })
            .collect::<Result<Vec<_>, ProviderError>>()?;
        if outcome
            .scopes
            .iter()
            .zip(&outcome.outer_fold_set.folds)
            .any(|(scope, fold)| scope.outer_fold_id != fold.fold_id)
        {
            return Err(err("scope order differs from the outer fold set"));
        }
        let mut oof: Vec<ProbeOofRow> = outcome
            .oof
            .iter()
            .map(|r| ProbeOofRow {
                sample_id: back[&r.sample_id].clone(),
                fold_id: r.outer_fold_id.to_string(),
                y_true: r.y_true,
                prediction: r.prediction,
                train_mean_prediction: r.train_mean_prediction,
            })
            .collect();
        let order: BTreeMap<&str, usize> = request
            .sample_ids
            .iter()
            .enumerate()
            .map(|(i, s)| (s.as_str(), i))
            .collect();
        oof.sort_by_key(|r| order[r.sample_id.as_str()]);
        Ok(ProbeResult {
            outer_folds,
            oof,
            model: scores(&outcome.model_metrics)?,
            train_mean: scores(&outcome.train_mean_metrics)?,
            n_fits: outcome.n_fits,
            backend_version: format!(
                "{BACKEND}; nested_selection schema {}; Methods runtime {}",
                outcome.schema_version,
                self.runtime
                    .library_path()
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
            ),
        })
    }

    fn score(&self, request: &ProbeScoreRequest) -> Result<ProbeScores, ProviderError> {
        if request.y_true.len() != request.predictions.len() || request.y_true.is_empty() {
            return Err(ProviderError("SCORE_REQUEST_DIMENSION_MISMATCH".into()));
        }
        let ids = (0..request.y_true.len())
            .map(|i| SampleId::new(format!("sample:{i:09}")).map_err(err))
            .collect::<Result<Vec<_>, _>>()?;
        let node = NodeId::new(TARGET_NODE).map_err(err)?;
        let report = score_regression_prediction_block(
            &PredictionBlock {
                prediction_id: None,
                producer_node: node,
                producer_port: None,
                partition: PredictionPartition::Validation,
                fold_id: None,
                sample_ids: ids.clone(),
                values: request.predictions.iter().map(|v| vec![*v]).collect(),
                target_names: vec!["y".into()],
            },
            &RegressionTargetBlock {
                level: PredictionLevel::Sample,
                unit_ids: ids.into_iter().map(PredictionUnitId::Sample).collect(),
                values: request.y_true.iter().map(|v| vec![*v]).collect(),
                validity_masks: None,
                target_names: vec!["y".into()],
            },
            &[
                RegressionMetricKind::Mse,
                RegressionMetricKind::Rmse,
                RegressionMetricKind::Mae,
                RegressionMetricKind::R2,
            ],
        )
        .map_err(err)?;
        scores(&report.metrics)
    }
}
