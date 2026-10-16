//! Portable contracts and conservative protocols for NIRS dataset qualification.
//! Numerical methods are supplied by the host's Methods provider.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const SCHEMA_VERSION: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_BUNDLE_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationInput {
    pub schema_version: u32,
    #[serde(default)]
    pub data_origin: DataOrigin,
    pub sources: Vec<SpectralSource>,
    pub samples: Vec<Sample>,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub options: Options,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DataOrigin {
    #[default]
    Unknown,
    Synthetic,
    UserProvided,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpectralSource {
    pub source_id: String,
    pub observation_ids: Vec<String>,
    pub sample_ids: Vec<String>,
    pub x: Vec<Vec<Option<f64>>>,
    #[serde(default)]
    pub valid_mask: Option<Vec<Vec<bool>>>,
    pub axis: Vec<f64>,
    #[serde(default)]
    pub axis_unit: String,
    #[serde(default)]
    pub signal_unit: String,
    #[serde(default)]
    pub signal_type: String,
    #[serde(default)]
    pub repetition_types: Option<Vec<RepetitionType>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RepetitionType {
    Rescan,
    Repositioning,
    Repreparation,
    Biological,
    #[default]
    Unknown,
}

impl RepetitionType {
    pub fn is_technical(self) -> bool {
        matches!(
            self,
            Self::Rescan | Self::Repositioning | Self::Repreparation
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub sample_id: String,
    #[serde(default)]
    pub physical_sample_id: Option<String>,
    #[serde(default)]
    pub partition: Partition,
    #[serde(default)]
    pub independence_group: Option<String>,
    #[serde(default)]
    pub instrument: Option<String>,
    #[serde(default)]
    pub campaign: Option<String>,
    #[serde(default)]
    pub individual_id: Option<String>,
    #[serde(default)]
    pub augmentation_parent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Partition {
    #[default]
    Development,
    RetainedTest,
    Prediction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub target_id: String,
    pub kind: TargetKind,
    pub values: Vec<TargetValue>,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Continuous,
    Categorical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetValue {
    pub sample_id: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub category: Option<String>,
    pub status: ReferenceStatus,
    #[serde(default)]
    pub reference_id: Option<String>,
    #[serde(default)]
    pub reference_group_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceStatus {
    Exact,
    Censored,
    Composite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub independence_unit: IndependenceUnit,
    #[serde(default)]
    pub assume_one_observation_per_sample: bool,
    /// Declares that independence units are exchangeable under the null of
    /// no metadata-target association. Required for permutation tests.
    #[serde(default)]
    pub exchangeable_units: bool,
    #[serde(default)]
    pub seed: u64,
    #[serde(default = "default_max_cells")]
    pub max_cells: usize,
    #[serde(default = "default_max_samples")]
    pub max_samples: usize,
    #[serde(default)]
    pub noise_proxy: NoiseProxyOptions,
    /// Labelled unsupervised SNV sensitivity of the canonical PCA structure.
    #[serde(default = "default_true")]
    pub snv_sensitivity: bool,
    /// Quasi-identity runs only with a declared tolerance; none is invented.
    #[serde(default)]
    pub quasi_duplicates: Option<QuasiDuplicateOptions>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            independence_unit: IndependenceUnit::Unknown,
            assume_one_observation_per_sample: false,
            exchangeable_units: false,
            seed: 0,
            max_cells: default_max_cells(),
            max_samples: default_max_samples(),
            noise_proxy: NoiseProxyOptions::default(),
            snv_sensitivity: true,
            quasi_duplicates: None,
        }
    }
}
fn default_true() -> bool {
    true
}

/// Savitzky-Golay smoothing-residual noise proxy profile (window in bands).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoiseProxyOptions {
    #[serde(default = "default_noise_window")]
    pub window_bands: usize,
    #[serde(default = "default_noise_polyorder")]
    pub polyorder: usize,
}

impl Default for NoiseProxyOptions {
    fn default() -> Self {
        Self {
            window_bands: default_noise_window(),
            polyorder: default_noise_polyorder(),
        }
    }
}
fn default_noise_window() -> usize {
    11
}
fn default_noise_polyorder() -> usize {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuasiDuplicateOptions {
    /// Maximum root-mean-square band difference, in the units of the view.
    pub tolerance: f64,
    #[serde(default)]
    pub view: QuasiDuplicateView,
    #[serde(default)]
    pub context: ComparisonContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuasiDuplicateView {
    #[default]
    Native,
    Snv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonContext {
    /// Compare observations only within one instrument and campaign.
    #[default]
    InstrumentCampaign,
    /// Compare every observation of a source.
    Source,
}
fn default_max_cells() -> usize {
    10_000_000
}
fn default_max_samples() -> usize {
    100_000
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum IndependenceUnit {
    Sample,
    ReferenceGroup,
    Group,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub code: String,
    pub path: String,
    pub message: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

impl ValidationResult {
    fn add(
        &mut self,
        code: &str,
        path: impl Into<String>,
        message: impl Into<String>,
        blocking: bool,
    ) {
        self.issues.push(ValidationIssue {
            code: code.into(),
            path: path.into(),
            message: message.into(),
            blocking,
        });
        if blocking {
            self.valid = false;
        }
    }
}

pub fn validate_input(input: &QualificationInput) -> ValidationResult {
    let mut out = ValidationResult {
        valid: true,
        issues: Vec::new(),
    };
    if input.schema_version != SCHEMA_VERSION {
        out.add(
            "UNSUPPORTED_SCHEMA",
            "schema_version",
            "Unsupported input schema version",
            true,
        );
    }
    if input.sources.is_empty() {
        out.add(
            "NO_SOURCES",
            "sources",
            "At least one source is required",
            true,
        );
    }
    if input.samples.len() > input.options.max_samples {
        out.add(
            "SAMPLE_BUDGET_EXCEEDED",
            "samples",
            "Sample budget exceeded",
            true,
        );
    }
    let mut sample_ids = BTreeSet::new();
    for (i, s) in input.samples.iter().enumerate() {
        if s.sample_id.is_empty() || !sample_ids.insert(s.sample_id.as_str()) {
            out.add(
                "INVALID_SAMPLE_ID",
                format!("samples[{i}].sample_id"),
                "Sample IDs must be nonempty and unique",
                true,
            );
        }
    }
    let by_id: HashMap<_, _> = input
        .samples
        .iter()
        .map(|s| (s.sample_id.as_str(), s))
        .collect();
    for (i, sample) in input.samples.iter().enumerate() {
        if let Some(parent) = &sample.augmentation_parent_id {
            if !by_id.contains_key(parent.as_str()) {
                out.add(
                    "UNKNOWN_AUGMENTATION_PARENT",
                    format!("samples[{i}].augmentation_parent_id"),
                    "Augmentation parent must name a declared sample",
                    true,
                );
            }
        }
        if [
            sample.physical_sample_id.as_ref(),
            sample.individual_id.as_ref(),
            sample.augmentation_parent_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|v| v.trim().is_empty())
        {
            out.add(
                "EMPTY_IDENTITY",
                format!("samples[{i}]"),
                "Optional identity keys must be nonempty when present",
                true,
            );
        }
    }
    let noise = input.options.noise_proxy;
    if noise.window_bands < 3
        || noise.window_bands.is_multiple_of(2)
        || noise.window_bands > 1001
        || noise.polyorder + 2 > noise.window_bands
    {
        out.add(
            "INVALID_NOISE_PROXY_PARAMETERS",
            "options.noise_proxy",
            "Noise proxy window must be odd, between 3 and 1001 bands, with polyorder <= window - 2",
            true,
        );
    }
    if input
        .options
        .quasi_duplicates
        .as_ref()
        .is_some_and(|q| !(q.tolerance.is_finite() && q.tolerance > 0.0))
    {
        out.add(
            "INVALID_QUASI_DUPLICATE_TOLERANCE",
            "options.quasi_duplicates.tolerance",
            "Quasi-duplicate tolerance must be finite and positive",
            true,
        );
    }
    let mut source_ids = BTreeSet::new();
    let mut total_cells = 0usize;
    let mut observation_sample = BTreeMap::<&str, &str>::new();
    for (si, source) in input.sources.iter().enumerate() {
        let path = format!("sources[{si}]");
        if source.source_id.is_empty() || !source_ids.insert(source.source_id.as_str()) {
            out.add(
                "INVALID_SOURCE_ID",
                format!("{path}.source_id"),
                "Source IDs must be nonempty and unique",
                true,
            );
        }
        let n = source.x.len();
        let p = source.axis.len();
        if n == 0 || p == 0 || source.observation_ids.len() != n || source.sample_ids.len() != n {
            out.add(
                "DIMENSION_MISMATCH",
                path.clone(),
                "Rows, observation IDs, sample IDs and nonempty axis must align",
                true,
            );
        }
        let cells = n.checked_mul(p);
        total_cells = cells
            .and_then(|v| total_cells.checked_add(v))
            .unwrap_or(usize::MAX);
        if cells.is_none() || total_cells > input.options.max_cells {
            out.add(
                "CELL_BUDGET_EXCEEDED",
                path.clone(),
                "Cumulative spectral cell budget exceeded",
                true,
            );
        }
        if source
            .valid_mask
            .as_ref()
            .is_some_and(|m| m.len() != n || m.iter().any(|r| r.len() != p))
        {
            out.add(
                "MASK_DIMENSION_MISMATCH",
                format!("{path}.valid_mask"),
                "Mask must match X",
                true,
            );
        }
        if source
            .repetition_types
            .as_ref()
            .is_some_and(|r| r.len() != n)
        {
            out.add(
                "REPETITION_DIMENSION_MISMATCH",
                format!("{path}.repetition_types"),
                "Repetition types must match X rows",
                true,
            );
        }
        let mut within_ids = BTreeSet::new();
        for (ri, row) in source.x.iter().enumerate() {
            if row.len() != p {
                out.add(
                    "DIMENSION_MISMATCH",
                    format!("{path}.x[{ri}]"),
                    "Row width must equal axis width",
                    true,
                );
            }
            if let Some(id) = source.observation_ids.get(ri) {
                if id.is_empty() || !within_ids.insert(id.as_str()) {
                    out.add(
                        "INVALID_OBSERVATION_ID",
                        format!("{path}.observation_ids[{ri}]"),
                        "Observation IDs must be unique within the source",
                        true,
                    );
                }
            }
            if let Some(id) = source.sample_ids.get(ri) {
                if !by_id.contains_key(id.as_str()) {
                    out.add(
                        "UNKNOWN_SAMPLE",
                        format!("{path}.sample_ids[{ri}]"),
                        "Observation sample ID is not declared",
                        true,
                    );
                }
                if let Some(observation_id) = source.observation_ids.get(ri) {
                    if let Some(previous) = observation_sample.insert(observation_id, id) {
                        if previous != id {
                            out.add(
                                "OBSERVATION_SAMPLE_CONFLICT",
                                format!("{path}.sample_ids[{ri}]"),
                                "The same observation ID maps to different samples across sources",
                                true,
                            );
                        }
                    }
                }
            }
            for (ci, val) in row.iter().enumerate() {
                if val.is_some_and(|v| !v.is_finite()) {
                    out.add(
                        "NONFINITE_X",
                        format!("{path}.x[{ri}][{ci}]"),
                        "Nonfinite X value",
                        true,
                    );
                }
                if let Some(mask) = &source.valid_mask {
                    if mask.get(ri).and_then(|m| m.get(ci)).copied() == Some(true) && val.is_none()
                    {
                        out.add(
                            "MASK_VALUE_CONFLICT",
                            format!("{path}.x[{ri}][{ci}]"),
                            "Valid cell has no value",
                            true,
                        );
                    }
                }
            }
        }
        if source.axis.iter().any(|a| !a.is_finite())
            || source.axis.windows(2).any(|a| a[0] == a[1])
            || !(source.axis.windows(2).all(|a| a[0] < a[1])
                || source.axis.windows(2).all(|a| a[0] > a[1]))
        {
            out.add(
                "INVALID_AXIS",
                format!("{path}.axis"),
                "Axis must be finite and strictly monotonic",
                true,
            );
        }
        if source.axis_unit.trim().is_empty() || source.signal_unit.trim().is_empty() {
            out.add(
                "UNKNOWN_UNIT",
                path,
                "Axis or signal unit is unknown; physical band interpretations are unavailable",
                false,
            );
        }
    }
    let mut target_ids = BTreeSet::new();
    for (ti, target) in input.targets.iter().enumerate() {
        let path = format!("targets[{ti}]");
        if target.target_id.is_empty() || !target_ids.insert(target.target_id.as_str()) {
            out.add(
                "INVALID_TARGET_ID",
                format!("{path}.target_id"),
                "Target IDs must be nonempty and unique",
                true,
            );
        }
        for (vi, value) in target.values.iter().enumerate() {
            if !by_id.contains_key(value.sample_id.as_str()) {
                out.add(
                    "UNKNOWN_SAMPLE",
                    format!("{path}.values[{vi}].sample_id"),
                    "Target sample ID is not declared",
                    true,
                );
            }
            if value.value.is_some_and(|v| !v.is_finite()) {
                out.add(
                    "NONFINITE_Y",
                    format!("{path}.values[{vi}].value"),
                    "Nonfinite target value",
                    true,
                );
            }
            if value.status == ReferenceStatus::Exact
                && match target.kind {
                    TargetKind::Continuous => value.value.is_none() || value.category.is_some(),
                    TargetKind::Categorical => {
                        value.category.as_deref().is_none_or(str::is_empty) || value.value.is_some()
                    }
                }
            {
                out.add(
                    "INVALID_EXACT_TARGET",
                    format!("{path}.values[{vi}]"),
                    "Exact reference must carry exactly its target type",
                    true,
                );
            }
        }
    }
    // Build transitive identity components on the *original* partitions before aggregation.
    // An augmentation parent names a sample ID; that ID is joined to its physical alias here.
    let mut parent: HashMap<String, String> = HashMap::new();
    fn find(parent: &mut HashMap<String, String>, key: &str) -> String {
        let mut root = key.to_owned();
        let mut path = Vec::new();
        loop {
            let next = parent
                .entry(root.clone())
                .or_insert_with(|| root.clone())
                .clone();
            if next == root {
                break;
            }
            path.push(root);
            root = next;
        }
        for node in path {
            parent.insert(node, root.clone());
        }
        root
    }
    fn union(parent: &mut HashMap<String, String>, a: &str, b: &str) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    for sample in &input.samples {
        let own = format!("sample:{}", sample.sample_id);
        if let Some(v) = &sample.physical_sample_id {
            union(&mut parent, &own, &format!("physical:{v}"));
        }
        if let Some(v) = &sample.individual_id {
            union(&mut parent, &own, &format!("individual:{v}"));
        }
        if let Some(v) = &sample.augmentation_parent_id {
            union(&mut parent, &own, &format!("sample:{v}"));
        }
    }
    let mut components: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    for sample in &input.samples {
        if sample.partition == Partition::Prediction {
            continue;
        }
        let role = if sample.partition == Partition::RetainedTest {
            "eval"
        } else {
            "fit"
        };
        let root = find(&mut parent, &format!("sample:{}", sample.sample_id));
        components.entry(root).or_default().insert(role);
    }
    for (key, roles) in components {
        if roles.len() > 1 {
            out.add(
                "IDENTITY_LEAKAGE",
                "samples",
                format!("Linked identity component {key} spans development and retained test"),
                true,
            );
        }
    }
    for target in &input.targets {
        let mut groups: BTreeMap<&str, BTreeSet<&'static str>> = BTreeMap::new();
        for value in &target.values {
            if let (Some(group), Some(sample)) = (
                &value.reference_group_id,
                by_id.get(value.sample_id.as_str()),
            ) {
                if sample.partition == Partition::Prediction {
                    continue;
                }
                groups.entry(group).or_default().insert(
                    if sample.partition == Partition::RetainedTest {
                        "eval"
                    } else {
                        "fit"
                    },
                );
            }
        }
        for (group, roles) in groups {
            if roles.len() > 1 {
                out.add(
                    "REFERENCE_LEAKAGE",
                    format!("targets.{}", target.target_id),
                    format!("Reference group {group} spans development and retained test"),
                    true,
                );
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Computed,
    NotApplicable,
    InsufficientData,
    Unsupported,
    NotIdentifiable,
    Undefined,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metric {
    pub metric_id: String,
    pub protocol_version: String,
    pub status: Availability,
    pub reason_code: Option<String>,
    pub scope: String,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub view_id: String,
    pub population_id: String,
    pub value: Option<Value>,
    pub unit: Option<String>,
    pub denominators: BTreeMap<String, usize>,
    pub parameters: BTreeMap<String, Value>,
}

impl Metric {
    pub fn unavailable(
        id: &str,
        status: Availability,
        reason: &str,
        source: Option<&str>,
        target: Option<&str>,
    ) -> Self {
        Self {
            metric_id: id.into(),
            protocol_version: PROTOCOL_BUNDLE_VERSION.into(),
            status,
            reason_code: Some(reason.into()),
            scope: "source_target".into(),
            source_id: source.map(str::to_owned),
            target_id: target.map(str::to_owned),
            view_id: "native".into(),
            population_id: "development_real".into(),
            value: None,
            unit: None,
            denominators: BTreeMap::new(),
            parameters: BTreeMap::new(),
        }
    }
    pub fn computed(id: &str, value: Value, source: Option<&str>, target: Option<&str>) -> Self {
        let mut m = Self::unavailable(id, Availability::Computed, "", source, target);
        m.reason_code = None;
        m.value = Some(value);
        m
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub rule_id: String,
    pub severity: String,
    pub confidence: String,
    pub evidence: Vec<String>,
    pub message: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub capability_id: String,
    pub available: bool,
    pub qualified: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualificationReport {
    pub schema_version: u32,
    #[serde(default)]
    pub data_origin: DataOrigin,
    pub engine_version: String,
    pub protocol_bundle_version: String,
    pub profile_status: String,
    pub status: String,
    pub validation: ValidationResult,
    pub capabilities: Vec<Capability>,
    pub metrics: Vec<Metric>,
    pub findings: Vec<Finding>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcaRequest {
    pub source_id: String,
    pub sample_ids: Vec<String>,
    pub matrix: Vec<Vec<f64>>,
    pub n_components: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcaDiagnostics {
    /// Variances; 0 for an unresolved component.
    pub eigenvalues: Vec<f64>,
    pub scores: Vec<Vec<f64>>,
    pub full_moments: [f64; 2],
    /// Absolute accuracy bound of every eigenvalue (Methods ABI 2.20:
    /// 16 * max(n,p) * eps * lambda_max).
    pub resolution: f64,
    /// Per component: variance not above `resolution`. Published as 0 with
    /// zero scores; never counted as numerical rank.
    pub unresolved: Vec<bool>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatabilityRequest {
    pub source_id: String,
    pub matrix: Vec<Vec<f64>>,
    pub group_ids: Vec<i64>,
    pub valid_mask: Vec<Vec<bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatabilityDiagnostics {
    pub pooled_sd: Vec<Option<f64>>,
    pub icc: Vec<Option<f64>>,
    pub n_complete_groups: Vec<usize>,
    /// 0 computed, 1 insufficient, 2 unbalanced, 3 zero total variance.
    pub band_status: Vec<i32>,
    pub backend_version: String,
}

#[derive(Debug, Clone)]
pub struct ProviderError(pub String);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryRequest {
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryDiagnostics {
    pub count: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub sample_sd: Option<f64>,
    pub q25: f64,
    pub median: f64,
    pub q75: f64,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearestNeighborsRequest {
    pub query: Vec<Vec<f64>>,
    pub reference: Vec<Vec<f64>>,
    pub query_group_ids: Vec<i64>,
    pub reference_group_ids: Vec<i64>,
    pub k: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearestNeighborsDiagnostics {
    /// Each index points into reference; -1 means no admissible neighbor.
    pub indices: Vec<Vec<i64>>,
    pub distances: Vec<Vec<Option<f64>>>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalContrastRequest {
    /// Exact continuous targets, or nonnegative integer category codes as f64.
    pub targets: Vec<f64>,
    pub neighbor_indices: Vec<Vec<i64>>,
    pub group_ids: Vec<i64>,
    pub categorical: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalContrastDiagnostics {
    /// 1 minus observed neighbor disagreement divided by its declared baseline.
    pub contrast: Option<f64>,
    pub fraction_rows_with_neighbors: f64,
    pub observed_same_class_fraction: Option<f64>,
    pub expected_same_class_fraction: Option<f64>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClusterSelection {
    Eom,
    Leaf,
}

/// Euclidean HDBSCAN* with scikit-learn 1.9.1 semantics (Methods ABI 2.19).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HdbscanRequest {
    pub matrix: Vec<Vec<f64>>,
    pub min_cluster_size: usize,
    /// Neighbors defining the core distance, the row itself included.
    pub min_samples: usize,
    pub selection: ClusterSelection,
    pub allow_single_cluster: bool,
}

/// One condensed-tree cluster node; node 0 is the root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HdbscanTreeNode {
    pub parent: Option<usize>,
    /// Points when the node is born.
    pub size: usize,
    pub label: Option<usize>,
    /// Mutual-reachability distance at birth; None for the root.
    pub birth_distance: Option<f64>,
    /// Smallest distance at which a point or child leaves the node.
    pub death_distance: f64,
    /// Excess of mass before selection; None when infinite (zero distances).
    pub stability: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HdbscanDiagnostics {
    /// -1 is noise; clusters are 0..n_clusters-1.
    pub labels: Vec<i64>,
    /// Relative membership strength in [0, 1]; not a probability.
    pub membership: Vec<f64>,
    /// GLOSH scores; None where undefined.
    pub outlier_scores: Vec<Option<f64>>,
    /// One value per cluster label.
    pub persistence: Vec<f64>,
    pub tree: Vec<HdbscanTreeNode>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdjustedRandRequest {
    pub labels_a: Vec<i64>,
    pub labels_b: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdjustedRandDiagnostics {
    /// None for fewer than two rows or identical trivial partitions.
    pub ari: Option<f64>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnvRequest {
    pub matrix: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnvDiagnostics {
    pub matrix: Vec<Vec<f64>>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseProxyRequest {
    pub matrix: Vec<Vec<f64>>,
    pub valid_mask: Vec<Vec<bool>>,
    pub window_length: usize,
    pub polyorder: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseProxyDiagnostics {
    /// RMS smoothing residual over rows divided by the white-noise residual gain.
    pub band_noise: Vec<Option<f64>>,
    pub band_counts: Vec<usize>,
    pub pooled: Option<f64>,
    pub residual_gain: f64,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TolerancePairsRequest {
    pub query: Vec<Vec<f64>>,
    /// None compares query rows with each other (i < h).
    pub reference: Option<Vec<Vec<f64>>>,
    pub query_group_ids: Vec<i64>,
    pub reference_group_ids: Vec<i64>,
    pub tolerance: f64,
    pub max_pairs: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TolerancePairsDiagnostics {
    /// Listed [query, reference] pairs in ascending order, at most max_pairs.
    pub pairs: Vec<[usize; 2]>,
    pub distances: Vec<f64>,
    pub query_flags: Vec<bool>,
    pub reference_flags: Vec<bool>,
    pub total_pairs: usize,
    pub candidate_pairs: usize,
    pub backend_version: String,
}

/// Decimal-string transport for u64 seeds, so JSON hosts never round them.
pub mod u64_decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

pub const PERMUTATION_PLAN_VERSION: &str = "permutation_plan.v1";

/// Versioned description of one permutation test, carried with its metric so
/// later protocols (for example confounding) reuse the same contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermutationPlan {
    pub plan_version: String,
    pub null_hypothesis: String,
    pub tested_effect: String,
    pub statistic: String,
    /// Independence unit whose labels are permuted (never acquisitions).
    pub exchangeable_unit: IndependenceUnit,
    pub exchangeability_declared: bool,
    /// `none_single_block` is the only executable MVP plan.
    pub restrictions: String,
    pub block_sizes: Vec<usize>,
    pub reduced_model: Option<String>,
    pub draw_method: String,
    pub rng_algorithm: String,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
    pub seed_derivation: String,
    /// log10 upper bound on distinct permutation outcomes of the statistic.
    pub log10_distinct_admissible_permutations: Option<f64>,
    pub n_permutations_requested: usize,
    pub n_permutations_executed: usize,
    /// max(1/(B+1), 1/distinct): smallest p-value the plan can support.
    pub resolution: Option<f64>,
    pub p_value_convention: String,
    pub tie_tolerance: f64,
    pub executed: bool,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssociationRequest {
    /// One row per exchangeable unit.
    pub factor_codes: Vec<i64>,
    /// Exact continuous targets, or nonnegative integer class codes as f64.
    pub targets: Vec<f64>,
    pub categorical: bool,
    pub n_permutations: usize,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssociationDiagnostics {
    /// eta^2 (continuous) or Cramer's V (categorical).
    pub effect_size: Option<f64>,
    /// One-way ANOVA F or Pearson chi-square.
    pub statistic: Option<f64>,
    pub df1: Option<f64>,
    pub df2: Option<f64>,
    pub n_levels: usize,
    pub n_target_values: usize,
    pub log10_distinct_permutations: f64,
    pub p_value: Option<f64>,
    pub n_at_least_observed: usize,
    pub n_permutations_executed: usize,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HolmRequest {
    pub p_values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HolmDiagnostics {
    pub adjusted: Vec<f64>,
    pub backend_version: String,
}

pub trait MethodsProvider {
    fn capabilities(&self) -> Vec<Capability>;
    fn pca(&self, request: &PcaRequest) -> Result<PcaDiagnostics, ProviderError>;
    fn repeatability(
        &self,
        request: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError>;
    fn summary(&self, _request: &SummaryRequest) -> Result<SummaryDiagnostics, ProviderError> {
        Err(ProviderError("SUMMARY_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn nearest_neighbors(
        &self,
        _request: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        Err(ProviderError("KNN_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn local_contrast(
        &self,
        _request: &LocalContrastRequest,
    ) -> Result<LocalContrastDiagnostics, ProviderError> {
        Err(ProviderError(
            "LOCAL_CONTRAST_PROVIDER_NOT_CONFIGURED".into(),
        ))
    }
    fn hdbscan(&self, _request: &HdbscanRequest) -> Result<HdbscanDiagnostics, ProviderError> {
        Err(ProviderError("HDBSCAN_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn adjusted_rand_index(
        &self,
        _request: &AdjustedRandRequest,
    ) -> Result<AdjustedRandDiagnostics, ProviderError> {
        Err(ProviderError("ARI_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn snv(&self, _request: &SnvRequest) -> Result<SnvDiagnostics, ProviderError> {
        Err(ProviderError("SNV_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn noise_proxy(
        &self,
        _request: &NoiseProxyRequest,
    ) -> Result<NoiseProxyDiagnostics, ProviderError> {
        Err(ProviderError("NOISE_PROXY_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn tolerance_pairs(
        &self,
        _request: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        Err(ProviderError(
            "TOLERANCE_PAIRS_PROVIDER_NOT_CONFIGURED".into(),
        ))
    }
    fn association(
        &self,
        _request: &AssociationRequest,
    ) -> Result<AssociationDiagnostics, ProviderError> {
        Err(ProviderError("ASSOCIATION_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn holm_adjust(&self, _request: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        Err(ProviderError("HOLM_PROVIDER_NOT_CONFIGURED".into()))
    }
}

/// Methods operations a complete provider exposes, in report order.
pub const METHODS_CAPABILITY_IDS: [&str; 12] = [
    "methods.pca",
    "methods.repeatability",
    "methods.summary",
    "methods.nearest_neighbors",
    "methods.local_contrast",
    "methods.hdbscan",
    "methods.adjusted_rand_index",
    "methods.snv",
    "methods.noise_proxy",
    "methods.tolerance_pairs",
    "methods.association",
    "methods.holm_adjust",
];

pub struct UnavailableMethodsProvider;
impl MethodsProvider for UnavailableMethodsProvider {
    fn capabilities(&self) -> Vec<Capability> {
        METHODS_CAPABILITY_IDS
            .iter()
            .map(|id| Capability {
                capability_id: (*id).into(),
                available: false,
                qualified: false,
                reason: Some("METHODS_PROVIDER_NOT_CONFIGURED".into()),
            })
            .collect()
    }
    fn pca(&self, _: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Err(ProviderError("METHODS_PROVIDER_NOT_CONFIGURED".into()))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError("METHODS_PROVIDER_NOT_CONFIGURED".into()))
    }
}
