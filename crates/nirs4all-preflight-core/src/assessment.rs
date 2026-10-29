//! Optional cross-consumer scalar assessment, preserving the original report.
//!
//! This adapter never computes scientific metrics or reads test targets. Native
//! metric identities are retained; consumers must explicitly qualify any mapping
//! to their historical metric names.

use crate::{Availability, QualificationReport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssessmentContext {
    pub dataset_id: String,
    /// SHA-256 of the canonical source bytes, supplied by the dataset owner.
    pub content_hash: String,
    pub producer: String,
    pub source_id: String,
    pub population_id: String,
    pub context_id: String,
    pub scope: String,
    pub target_id: Option<String>,
    pub split_id: Option<String>,
    pub fit_population_id: Option<String>,
    pub evaluation_population_id: Option<String>,
    #[serde(default)]
    pub semantics: BTreeMap<String, MetricSemantics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricSemantics {
    /// measured_observation, heuristic_signature or possible_cause.
    pub kind: String,
    /// unknown/unvalidated are distinct from validated predictive coverage.
    pub confidence_status: String,
    pub evidence_coverage: Option<f64>,
    pub signal_strength: Option<f64>,
}

impl Default for MetricSemantics {
    fn default() -> Self {
        Self {
            kind: "measured_observation".into(),
            confidence_status: "unknown".into(),
            evidence_coverage: None,
            signal_strength: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssessmentMetric {
    pub metric_id: String,
    pub protocol_version: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub availability: String,
    pub reason_code: Option<String>,
    pub kind: String,
    pub confidence_status: String,
    pub view_id: String,
    pub evidence_coverage: Option<f64>,
    pub signal_strength: Option<f64>,
    pub native_status: String,
    /// Exact native metric, including denominators, parameters and non-scalars.
    pub native_metric: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assessment {
    pub schema_version: String,
    pub dataset_id: String,
    pub content_hash: String,
    pub producer: String,
    pub engine_version: String,
    pub protocol_version: String,
    pub source_id: String,
    pub population_id: String,
    pub context_id: String,
    pub scope: String,
    pub target_id: Option<String>,
    pub split_id: Option<String>,
    pub fit_population_id: Option<String>,
    pub evaluation_population_id: Option<String>,
    pub metrics: Vec<AssessmentMetric>,
    /// Lossless original JSON, including findings, capability refusals and
    /// extension fields unknown to this adapter. Not a public/anonymized card.
    pub report: Value,
}

/// A source/view/population-qualified reference to one native metric.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricIdentity {
    pub metric_id: String,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub view_id: String,
    pub population_id: String,
    pub context_id: String,
    pub protocol_version: String,
}

/// Optional findings projection. A qualitative legacy confidence label is
/// retained only in `original_finding`, never promoted to validated confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssessmentFinding {
    pub rule_id: String,
    pub context_id: String,
    pub kind: String,
    pub severity: String,
    pub confidence_status: String,
    pub signal_strength: Option<f64>,
    pub evidence_coverage: Option<f64>,
    pub evidence: Vec<MetricIdentity>,
    pub unresolved_evidence: Vec<String>,
    pub message: String,
    pub recommended_action: String,
    pub original_finding: Value,
}

/// Resolve finding evidence against the declared context without dropping
/// multiple views or treating absent evidence as negative evidence.
pub fn extract_findings(
    report: &Value,
    context: &AssessmentContext,
) -> Result<Vec<AssessmentFinding>, String> {
    // Reuse all report-version, content-hash and context validation.
    extract_assessment(report, context)?;
    let native: QualificationReport =
        serde_json::from_value(report.clone()).map_err(|e| e.to_string())?;
    let original = report["findings"]
        .as_array()
        .ok_or("INVALID_REPORT_FINDINGS")?;
    let mut findings = Vec::new();
    for (finding, raw) in native.findings.iter().zip(original) {
        let semantics =
            context
                .semantics
                .get(&finding.rule_id)
                .cloned()
                .unwrap_or(MetricSemantics {
                    kind: "heuristic_signature".into(),
                    ..MetricSemantics::default()
                });
        let mut evidence = Vec::new();
        let mut unresolved_evidence = Vec::new();
        for id in &finding.evidence {
            let matching: Vec<_> = native
                .metrics
                .iter()
                .filter(|m| {
                    m.metric_id == *id
                        && m.source_id
                            .as_deref()
                            .is_none_or(|source| source == context.source_id)
                        && m.target_id == context.target_id
                        && m.population_id == context.population_id
                })
                .collect();
            if matching.is_empty() {
                unresolved_evidence.push(id.clone());
            }
            for metric in matching {
                let identity = MetricIdentity {
                    metric_id: metric.metric_id.clone(),
                    source_id: metric.source_id.clone(),
                    target_id: metric.target_id.clone(),
                    view_id: metric.view_id.clone(),
                    population_id: metric.population_id.clone(),
                    context_id: context.context_id.clone(),
                    protocol_version: metric.protocol_version.clone(),
                };
                if !evidence.contains(&identity) {
                    evidence.push(identity);
                }
            }
        }
        findings.push(AssessmentFinding {
            rule_id: finding.rule_id.clone(),
            context_id: context.context_id.clone(),
            kind: semantics.kind,
            severity: finding.severity.clone(),
            confidence_status: semantics.confidence_status,
            signal_strength: semantics.signal_strength,
            evidence_coverage: semantics.evidence_coverage,
            evidence,
            unresolved_evidence,
            message: finding.message.clone(),
            recommended_action: finding.action.clone(),
            original_finding: raw.clone(),
        });
    }
    Ok(findings)
}

/// Adapt a schema-1 report without recomputation or missing-evidence coercion.
///
/// Non-scalar native values remain available in `native_metric` and `report`;
/// the scalar assessment marks them unavailable instead of inventing a scalar.
/// Unknown semantic calibration stays unknown. Report findings remain intact,
/// including their independent severity, action and evidence references.
pub fn extract_assessment(
    report: &Value,
    context: &AssessmentContext,
) -> Result<Assessment, String> {
    validate_context(context)?;
    let native: QualificationReport =
        serde_json::from_value(report.clone()).map_err(|e| format!("INVALID_REPORT: {e}"))?;
    if native.schema_version != crate::SCHEMA_VERSION {
        return Err("UNSUPPORTED_REPORT_SCHEMA".into());
    }
    let raw_metrics = report["metrics"]
        .as_array()
        .ok_or("INVALID_REPORT_METRICS")?;
    let mut metrics = Vec::new();
    for (metric, raw) in native.metrics.iter().zip(raw_metrics) {
        if metric.source_id.as_deref() != Some(context.source_id.as_str())
            || metric.population_id != context.population_id
            || metric.target_id != context.target_id
        {
            continue;
        }
        let semantics = context
            .semantics
            .get(&metric.metric_id)
            .cloned()
            .unwrap_or_default();
        validate_semantics(&semantics)?;
        let native_status = serde_json::to_value(&metric.status)
            .map_err(|e| e.to_string())?
            .as_str()
            .ok_or("INVALID_NATIVE_STATUS")?
            .to_owned();
        let computed = matches!(metric.status, Availability::Computed);
        let value = if computed {
            metric.value.as_ref().and_then(Value::as_f64)
        } else {
            None
        };
        if value.is_some_and(|value| !value.is_finite()) {
            return Err("NONFINITE_ASSESSMENT_VALUE".into());
        }
        let availability = match (&metric.status, value) {
            (Availability::Computed, Some(_)) => "available",
            (Availability::NotApplicable, _) => "not_applicable",
            _ => "unavailable",
        };
        let reason_code = if computed && value.is_none() {
            Some("NON_SCALAR_OR_MISSING_NATIVE_VALUE".into())
        } else {
            metric.reason_code.clone()
        };
        metrics.push(AssessmentMetric {
            metric_id: metric.metric_id.clone(),
            protocol_version: metric.protocol_version.clone(),
            value,
            unit: metric.unit.clone(),
            availability: availability.into(),
            reason_code,
            kind: semantics.kind,
            confidence_status: semantics.confidence_status,
            view_id: metric.view_id.clone(),
            evidence_coverage: semantics.evidence_coverage,
            signal_strength: semantics.signal_strength,
            native_status,
            native_metric: raw.clone(),
        });
    }
    Ok(Assessment {
        schema_version: "1".into(),
        dataset_id: context.dataset_id.clone(),
        content_hash: context.content_hash.clone(),
        producer: context.producer.clone(),
        engine_version: native.engine_version,
        protocol_version: native.protocol_bundle_version,
        source_id: context.source_id.clone(),
        population_id: context.population_id.clone(),
        context_id: context.context_id.clone(),
        scope: context.scope.clone(),
        target_id: context.target_id.clone(),
        split_id: context.split_id.clone(),
        fit_population_id: context.fit_population_id.clone(),
        evaluation_population_id: context.evaluation_population_id.clone(),
        metrics,
        report: report.clone(),
    })
}

fn validate_context(context: &AssessmentContext) -> Result<(), String> {
    if [
        &context.dataset_id,
        &context.source_id,
        &context.population_id,
        &context.context_id,
    ]
    .iter()
    .any(|id| id.trim().is_empty())
    {
        return Err("EMPTY_ASSESSMENT_IDENTITY".into());
    }
    let digest = context
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&context.content_hash);
    if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("INVALID_CONTENT_HASH".into());
    }
    if !["nirs4all-preflight", "nirs4all-domains", "nirs4all-methods"]
        .contains(&context.producer.as_str())
    {
        return Err("UNSUPPORTED_ASSESSMENT_PRODUCER".into());
    }
    match context.scope.as_str() {
        "intrinsic" => {
            if context.fit_population_id.is_some()
                || context.evaluation_population_id.is_some()
                || context.split_id.is_some()
            {
                return Err("TASK_CONTEXT_IN_INTRINSIC_ASSESSMENT".into());
            }
        }
        "task" => {
            if context.producer == "nirs4all-preflight" {
                return Err("TASK_ASSESSMENT_BELONGS_TO_DOMAINS".into());
            }
            if context
                .fit_population_id
                .as_deref()
                .is_none_or(str::is_empty)
                || context
                    .evaluation_population_id
                    .as_deref()
                    .is_none_or(str::is_empty)
                || context.split_id.as_deref().is_none_or(str::is_empty)
                || context.fit_population_id == context.evaluation_population_id
            {
                return Err("MISSING_OR_IDENTICAL_FIT_EVALUATION_POPULATIONS".into());
            }
        }
        _ => return Err("UNSUPPORTED_ASSESSMENT_SCOPE".into()),
    }
    for semantics in context.semantics.values() {
        validate_semantics(semantics)?;
    }
    Ok(())
}

fn validate_semantics(semantics: &MetricSemantics) -> Result<(), String> {
    if ![
        "measured_observation",
        "heuristic_signature",
        "possible_cause",
    ]
    .contains(&semantics.kind.as_str())
        || !["unknown", "unvalidated", "validated"].contains(&semantics.confidence_status.as_str())
        || [semantics.evidence_coverage, semantics.signal_strength]
            .into_iter()
            .flatten()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err("INVALID_ASSESSMENT_SEMANTICS".into());
    }
    // A physical cause is a hypothesis until separately calibrated evidence is
    // supplied; this scalar adapter never establishes that calibration.
    if semantics.kind == "possible_cause" && semantics.confidence_status == "validated" {
        return Err("CAUSE_CONFIDENCE_REQUIRES_EXTERNAL_VALIDATION".into());
    }
    Ok(())
}
