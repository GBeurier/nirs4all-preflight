//! Portable contracts and conservative protocols for NIRS dataset qualification.
//! Numerical methods are supplied by the host's Methods provider.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const SCHEMA_VERSION: u32 = 1;
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_BUNDLE_VERSION: &str = "0.1.0-alpha.3";

/// Deserialized through a raw wire form: partitions and identifiers
/// are decoded first and target content stays opaque JSON until the
/// partition of its sample is known. Retained-test references keep their
/// identity fields; their value and category are dropped unread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "RawQualificationInput")]
pub struct QualificationInput {
    pub schema_version: u32,
    #[serde(default)]
    pub data_origin: DataOrigin,
    pub sources: Vec<SpectralSource>,
    pub samples: Vec<Sample>,
    #[serde(default)]
    pub targets: Vec<Target>,
    /// Typed sample-level metadata beyond `instrument` and `campaign`.
    #[serde(default)]
    pub metadata: MetadataTable,
    #[serde(default)]
    pub options: Options,
}

/// Wire form of [`QualificationInput`]: identical fields, with target
/// values and categories kept as unparsed JSON text (`RawValue`): the
/// tokenizer only skips them, so no number, string or nested content of a
/// retained-test reference is ever decoded.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawQualificationInput {
    schema_version: u32,
    #[serde(default)]
    data_origin: DataOrigin,
    sources: Vec<SpectralSource>,
    samples: Vec<Sample>,
    #[serde(default)]
    targets: Vec<RawTarget>,
    #[serde(default)]
    metadata: MetadataTable,
    #[serde(default)]
    options: Options,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTarget {
    target_id: String,
    kind: TargetKind,
    values: Vec<RawTargetValue>,
    #[serde(default)]
    unit: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTargetValue {
    sample_id: String,
    #[serde(default)]
    value: Option<Box<serde_json::value::RawValue>>,
    #[serde(default)]
    category: Option<Box<serde_json::value::RawValue>>,
    status: ReferenceStatus,
    #[serde(default)]
    reference_id: Option<String>,
    #[serde(default)]
    reference_group_id: Option<String>,
}

impl TryFrom<RawQualificationInput> for QualificationInput {
    type Error = String;
    fn try_from(raw: RawQualificationInput) -> Result<Self, String> {
        let retained: BTreeSet<&str> = raw
            .samples
            .iter()
            .filter(|s| s.partition == Partition::RetainedTest)
            .map(|s| s.sample_id.as_str())
            .collect();
        let mut targets = Vec::with_capacity(raw.targets.len());
        for (ti, target) in raw.targets.into_iter().enumerate() {
            let mut values = Vec::with_capacity(target.values.len());
            for (vi, v) in target.values.into_iter().enumerate() {
                let (value, category) = if retained.contains(v.sample_id.as_str()) {
                    (None, None)
                } else {
                    let path = format!("targets[{ti}].values[{vi}]");
                    let value = match &v.value {
                        None => None,
                        Some(raw) => serde_json::from_str::<Option<f64>>(raw.get())
                            .map_err(|e| format!("{path}.value: {e}"))?,
                    };
                    let category = match &v.category {
                        None => None,
                        Some(raw) => serde_json::from_str::<Option<String>>(raw.get())
                            .map_err(|e| format!("{path}.category: {e}"))?,
                    };
                    (value, category)
                };
                values.push(TargetValue {
                    sample_id: v.sample_id,
                    value,
                    category,
                    status: v.status,
                    reference_id: v.reference_id,
                    reference_group_id: v.reference_group_id,
                });
            }
            targets.push(Target {
                target_id: target.target_id,
                kind: target.kind,
                values,
                unit: target.unit,
            });
        }
        Ok(Self {
            schema_version: raw.schema_version,
            data_origin: raw.data_origin,
            sources: raw.sources,
            samples: raw.samples,
            targets,
            metadata: raw.metadata,
            options: raw.options,
        })
    }
}

/// Declared metadata columns and their per-sample values. Values are keyed by
/// `sample_id`: a value describes every acquisition of that sample, so an
/// acquisition-level covariate is declared only when it is constant per sample.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetadataTable {
    #[serde(default)]
    pub columns: Vec<MetadataColumn>,
    /// sample_id -> column name -> value; absent or null means missing.
    #[serde(default)]
    pub values: BTreeMap<String, BTreeMap<String, Option<MetadataValue>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetadataColumn {
    pub name: String,
    pub kind: MetadataKind,
    /// Physical unit of a continuous column; not allowed for categorical ones.
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataKind {
    Categorical,
    Continuous,
}

/// JSON strings are categorical levels and JSON numbers continuous values;
/// neither is ever converted into the other.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MetadataValue {
    Number(f64),
    Text(String),
}

/// Built-in sample fields that are categorical metadata factors.
pub const SAMPLE_METADATA_FIELDS: [&str; 2] = ["instrument", "campaign"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataOrigin {
    /// `Sample::instrument` or `Sample::campaign`.
    SampleField,
    /// A column of `QualificationInput::metadata`.
    Declared,
}

/// One analysable metadata factor (categorical) or covariate (continuous).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MetadataFactor<'a> {
    pub name: &'a str,
    pub kind: MetadataKind,
    pub unit: Option<&'a str>,
    pub origin: MetadataOrigin,
}

/// Value of one factor for one sample.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MetadataLevel<'a> {
    Category(&'a str),
    Value(f64),
}

impl QualificationInput {
    /// Analysable metadata in report order: `instrument`, `campaign`, then the
    /// declared columns in declaration order. Call on validated input.
    pub fn metadata_factors(&self) -> Vec<MetadataFactor<'_>> {
        SAMPLE_METADATA_FIELDS
            .iter()
            .map(|name| MetadataFactor {
                name,
                kind: MetadataKind::Categorical,
                unit: None,
                origin: MetadataOrigin::SampleField,
            })
            .chain(self.metadata.columns.iter().map(|c| MetadataFactor {
                name: &c.name,
                kind: c.kind,
                unit: c.unit.as_deref(),
                origin: MetadataOrigin::Declared,
            }))
            .collect()
    }

    /// Value of `factor` for `sample`; `None` when missing. A value of the
    /// wrong JSON type (rejected by `validate_input`) is also `None`.
    pub fn metadata_value<'a>(
        &'a self,
        factor: &MetadataFactor<'_>,
        sample: &'a Sample,
    ) -> Option<MetadataLevel<'a>> {
        match factor.origin {
            MetadataOrigin::SampleField => match factor.name {
                "instrument" => sample.instrument.as_deref().map(MetadataLevel::Category),
                "campaign" => sample.campaign.as_deref().map(MetadataLevel::Category),
                _ => None,
            },
            MetadataOrigin::Declared => {
                match (
                    factor.kind,
                    self.metadata
                        .values
                        .get(&sample.sample_id)?
                        .get(factor.name)?
                        .as_ref()?,
                ) {
                    (MetadataKind::Categorical, MetadataValue::Text(t)) => {
                        Some(MetadataLevel::Category(t))
                    }
                    (MetadataKind::Continuous, MetadataValue::Number(v)) => {
                        Some(MetadataLevel::Value(*v + 0.0))
                    }
                    _ => None,
                }
            }
        }
    }
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
    /// Root seed: a JSON number or, for values above 2^53 sent from
    /// JavaScript, a canonical decimal string. Serialized as a string.
    #[serde(default, with = "u64_number_or_decimal")]
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
            // The partition is checked before any Y content: retained-test Y
            // is never read, not even to validate it.
            match by_id.get(value.sample_id.as_str()) {
                None => {
                    out.add(
                        "UNKNOWN_SAMPLE",
                        format!("{path}.values[{vi}].sample_id"),
                        "Target sample ID is not declared",
                        true,
                    );
                    continue;
                }
                Some(sample) if sample.partition == Partition::RetainedTest => continue,
                Some(_) => {}
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
    validate_metadata(input, &by_id, &mut out);
    // Partitions are checked on whole linked components, built on the original
    // rows before any aggregation or exclusion. Prediction rows take no role
    // but stay in the union as identity bridges. Declared independence groups
    // are dependencies whatever the analysis unit, so they always link here.
    let role = |s: &Sample| match s.partition {
        Partition::Development => Some("fit"),
        Partition::RetainedTest => Some("eval"),
        Partition::Prediction => None,
    };
    let crossing = |component: &[usize]| {
        let mut roles = BTreeMap::<usize, BTreeSet<&'static str>>::new();
        for (i, sample) in input.samples.iter().enumerate() {
            let entry = roles.entry(component[i]).or_default();
            if let Some(r) = role(sample) {
                entry.insert(r);
            }
        }
        roles
            .into_iter()
            .filter(|(_, r)| r.len() > 1)
            .map(|(root, _)| root)
            .collect::<BTreeSet<usize>>()
    };
    let identity = identity_components(input, &[], true);
    let identity_crossing = crossing(&identity);
    for &root in &identity_crossing {
        out.add(
            "IDENTITY_LEAKAGE",
            "samples",
            format!(
                "Linked identity component of sample {} spans development and retained test",
                input.samples[root].sample_id
            ),
            true,
        );
    }
    let targets: Vec<&Target> = input.targets.iter().collect();
    let full = identity_components(input, &targets, true);
    for root in crossing(&full) {
        let members: Vec<usize> = (0..full.len()).filter(|&i| full[i] == root).collect();
        if members
            .iter()
            .any(|&i| identity_crossing.contains(&identity[i]))
        {
            continue;
        }
        out.add(
            "REFERENCE_LEAKAGE",
            "targets",
            format!(
                "Reference groups link the component of sample {} across development and retained test",
                input.samples[root].sample_id
            ),
            true,
        );
    }
    out
}

/// Linked identity components of `input.samples`, built from every identity
/// link before any analytic exclusion: physical sample, individual,
/// augmentation parent, `independence_group` when it is the declared unit,
/// and the `reference_group_id` of every value of `targets` (all partitions
/// and statuses; identity fields only, never Y content). Returns, for each
/// sample index, the smallest sample index of its component.
pub fn independence_components<'a>(
    input: &'a QualificationInput,
    targets: &[&'a Target],
) -> Vec<usize> {
    identity_components(
        input,
        targets,
        input.options.independence_unit == IndependenceUnit::Group,
    )
}

/// Structured identity key: each kind and each field stays separate, so no
/// identifier containing a separator can collide with another key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IdentityKey<'a> {
    Sample(&'a str),
    Physical(&'a str),
    Individual(&'a str),
    Group(&'a str),
    /// (target_id, reference_group_id): reference groups are per target.
    Reference(&'a str, &'a str),
}

/// Union-find over all samples; `groups` adds `independence_group` links.
fn identity_components<'a>(
    input: &'a QualificationInput,
    targets: &[&'a Target],
    groups: bool,
) -> Vec<usize> {
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let index: HashMap<&str, usize> = input
        .samples
        .iter()
        .enumerate()
        .map(|(i, s)| (s.sample_id.as_str(), i))
        .collect();
    let mut parent: Vec<usize> = (0..input.samples.len()).collect();
    let mut first = HashMap::<IdentityKey<'a>, usize>::new();
    let mut link = |key: IdentityKey<'a>, i: usize, parent: &mut Vec<usize>| {
        if let Some(&j) = first.get(&key) {
            let (a, b) = (root(parent, i), root(parent, j));
            parent[a.max(b)] = a.min(b);
        } else {
            first.insert(key, i);
        }
    };
    for (i, sample) in input.samples.iter().enumerate() {
        link(IdentityKey::Sample(&sample.sample_id), i, &mut parent);
        if let Some(v) = &sample.physical_sample_id {
            link(IdentityKey::Physical(v), i, &mut parent);
        }
        if let Some(v) = &sample.individual_id {
            link(IdentityKey::Individual(v), i, &mut parent);
        }
        if let Some(v) = &sample.augmentation_parent_id {
            link(IdentityKey::Sample(v), i, &mut parent);
        }
        if groups {
            if let Some(v) = &sample.independence_group {
                link(IdentityKey::Group(v), i, &mut parent);
            }
        }
    }
    for target in targets {
        for value in &target.values {
            if let (Some(group), Some(&i)) = (
                &value.reference_group_id,
                index.get(value.sample_id.as_str()),
            ) {
                link(
                    IdentityKey::Reference(&target.target_id, group),
                    i,
                    &mut parent,
                );
            }
        }
    }
    (0..parent.len()).map(|i| root(&mut parent, i)).collect()
}

/// Typed metadata at the input boundary: declared columns, known samples and
/// names, JSON types, and (non-blocking) values varying inside the identity
/// components that association tests treat as one independence unit.
fn validate_metadata(
    input: &QualificationInput,
    by_id: &HashMap<&str, &Sample>,
    out: &mut ValidationResult,
) {
    let mut kinds = BTreeMap::<&str, MetadataKind>::new();
    for (ci, column) in input.metadata.columns.iter().enumerate() {
        let path = format!("metadata.columns[{ci}]");
        let name = column.name.as_str();
        if name.trim().is_empty()
            || SAMPLE_METADATA_FIELDS.contains(&name)
            || kinds.insert(name, column.kind).is_some()
        {
            out.add(
                "INVALID_METADATA_COLUMN",
                format!("{path}.name"),
                "Metadata column names must be nonempty, unique and distinct from instrument and campaign",
                true,
            );
        }
        match (column.kind, column.unit.as_deref()) {
            (MetadataKind::Categorical, Some(_)) => out.add(
                "INVALID_METADATA_COLUMN",
                format!("{path}.unit"),
                "Categorical metadata columns carry no unit",
                true,
            ),
            (MetadataKind::Continuous, Some(unit)) if unit.trim().is_empty() => out.add(
                "INVALID_METADATA_COLUMN",
                format!("{path}.unit"),
                "A declared metadata unit must be nonempty",
                true,
            ),
            (MetadataKind::Continuous, None) => out.add(
                "UNKNOWN_METADATA_UNIT",
                format!("{path}.unit"),
                "Continuous metadata column has no unit; its values are reported without one",
                false,
            ),
            _ => {}
        }
    }
    for (sample_id, row) in &input.metadata.values {
        let path = format!("metadata.values.{sample_id}");
        if !by_id.contains_key(sample_id.as_str()) {
            out.add(
                "UNKNOWN_SAMPLE",
                path.clone(),
                "Metadata sample ID is not declared",
                true,
            );
        }
        for (name, value) in row {
            let Some(kind) = kinds.get(name.as_str()) else {
                out.add(
                    "UNKNOWN_METADATA_COLUMN",
                    format!("{path}.{name}"),
                    "Metadata value names an undeclared column",
                    true,
                );
                continue;
            };
            match (kind, value) {
                (_, None) => {}
                (MetadataKind::Categorical, Some(MetadataValue::Text(t))) if t.trim().is_empty() => {
                    out.add(
                        "INVALID_METADATA_VALUE",
                        format!("{path}.{name}"),
                        "Categorical metadata levels must be nonempty",
                        true,
                    )
                }
                (MetadataKind::Continuous, Some(MetadataValue::Number(v))) if !v.is_finite() => {
                    out.add(
                        "INVALID_METADATA_VALUE",
                        format!("{path}.{name}"),
                        "Continuous metadata values must be finite",
                        true,
                    )
                }
                (MetadataKind::Categorical, Some(MetadataValue::Number(_)))
                | (MetadataKind::Continuous, Some(MetadataValue::Text(_))) => out.add(
                    "METADATA_TYPE_MISMATCH",
                    format!("{path}.{name}"),
                    "Categorical levels must be JSON strings and continuous values JSON numbers; nothing is converted",
                    true,
                ),
                _ => {}
            }
        }
    }
    if input.metadata.columns.is_empty() {
        return;
    }
    let targets: Vec<&Target> = input.targets.iter().collect();
    let component = independence_components(input, &targets);
    for (ci, column) in input.metadata.columns.iter().enumerate() {
        let mut seen = HashMap::<usize, &MetadataValue>::new();
        let mut varying = BTreeSet::<usize>::new();
        for (i, sample) in input.samples.iter().enumerate() {
            let Some(Some(value)) = input
                .metadata
                .values
                .get(&sample.sample_id)
                .and_then(|row| row.get(&column.name))
            else {
                continue;
            };
            if seen.entry(component[i]).or_insert(value) != &value {
                varying.insert(component[i]);
            }
        }
        if !varying.is_empty() {
            out.add(
                "METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT",
                format!("metadata.columns[{ci}]"),
                format!(
                    "Metadata {} varies inside {} linked identity component(s); association tests on it are not identifiable",
                    column.name,
                    varying.len()
                ),
                false,
            );
        }
    }
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
    pub eigenvalues: Vec<f64>,
    pub scores: Vec<Vec<f64>>,
    pub full_moments: [f64; 2],
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

/// Why a numerical provider did not return a result. The kind decides the
/// report status: only `unsupported` (a capability or a declared limit that
/// is absent or exceeded) maps to `unsupported`; numerical and internal
/// failures map to `error`. The reason is a stable code, identical for the
/// CPU and WASM adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    Unsupported,
    Numerical,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub reason: String,
}

impl ProviderError {
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Unsupported,
            reason: reason.into(),
        }
    }
    pub fn numerical(reason: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Numerical,
            reason: reason.into(),
        }
    }
    pub fn internal(reason: impl Into<String>) -> Self {
        Self {
            kind: ProviderErrorKind::Internal,
            reason: reason.into(),
        }
    }
    /// Report status of a metric that this error prevented.
    pub fn availability(&self) -> Availability {
        match self.kind {
            ProviderErrorKind::Unsupported => Availability::Unsupported,
            ProviderErrorKind::Numerical | ProviderErrorKind::Internal => Availability::Error,
        }
    }
    /// A Methods failure with its context message: a refusal outside the
    /// supported numerical domain (`N4M_ERR_UNSUPPORTED` with
    /// [`METHODS_DOMAIN_MESSAGE`]) is unsupported with reason
    /// [`NUMERICAL_DOMAIN_EXCEEDED`]; every other status maps as
    /// [`ProviderError::from_methods_status`]. Shared by every adapter.
    pub fn from_methods_error(status: i32, message: &str) -> Self {
        if status == 10 && message.contains(METHODS_DOMAIN_MESSAGE) {
            Self::unsupported(NUMERICAL_DOMAIN_EXCEEDED)
        } else {
            Self::from_methods_status(status)
        }
    }
    /// A non-zero Methods `n4m_status_t`, shared by every adapter: numerical
    /// and convergence failures are numerical; unsupported, not implemented,
    /// ABI, version and backend refusals are unsupported; anything else
    /// (argument, shape, memory, internal) is internal.
    pub fn from_methods_status(status: i32) -> Self {
        let name = match status {
            1 => "INVALID_ARGUMENT",
            2 => "NULL_POINTER",
            3 => "SHAPE_MISMATCH",
            4 => "DTYPE_MISMATCH",
            5 => "STRIDE_INVALID",
            6 => "NOT_FITTED",
            7 => "NUMERICAL_FAILURE",
            8 => "CONVERGENCE_FAILED",
            9 => "OUT_OF_MEMORY",
            10 => "UNSUPPORTED",
            11 => "NOT_IMPLEMENTED",
            12 => "ABI_MISMATCH",
            13 => "IO",
            14 => "CORRUPT_BUFFER",
            15 => "VERSION_INCOMPATIBLE",
            16 => "BACKEND_UNAVAILABLE",
            17 => "CANCELLED",
            255 => "INTERNAL",
            _ => return Self::internal(format!("METHODS_STATUS_{status}")),
        };
        let reason = format!("METHODS_{name}");
        match status {
            7 | 8 => Self::numerical(reason),
            10 | 11 | 12 | 15 | 16 => Self::unsupported(reason),
            _ => Self::internal(reason),
        }
    }
}

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

/// Root-seed transport: an unsigned JSON integer or a canonical decimal
/// string (digits only, no sign, no leading zero), so JavaScript hosts can
/// send every u64 without rounding. Serialized as a decimal string.
pub mod u64_number_or_decimal {
    use serde::{de, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Seed {
            Number(u64),
            Text(String),
        }
        match Seed::deserialize(deserializer)? {
            Seed::Number(v) => Ok(v),
            Seed::Text(t) => {
                let canonical = !t.is_empty()
                    && t.bytes().all(|b| b.is_ascii_digit())
                    && (t == "0" || !t.starts_with('0'));
                if !canonical {
                    return Err(de::Error::custom("seed must be a canonical decimal u64"));
                }
                t.parse()
                    .map_err(|_| de::Error::custom("seed is outside the u64 range"))
            }
        }
    }
}

pub const PERMUTATION_PLAN_VERSION: &str = "permutation_plan.v1";

/// Stable per-test seed: SplitMix64 finalizer of the root seed XOR the FNV-1a
/// 64 hash of a provider-specific derivation domain. Every permutation
/// protocol derives its seeds through this function with its own domain.
pub fn derive_seed(root: u64, domain: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in domain.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mut z = root ^ hash;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Versioned description of one permutation test, carried with its metric.
/// Metadata associations and confounding share this contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermutationPlan {
    pub plan_version: String,
    pub null_hypothesis: String,
    pub tested_effect: String,
    pub statistic: String,
    /// Independence unit whose labels are permuted (never acquisitions).
    pub exchangeable_unit: IndependenceUnit,
    pub exchangeability_declared: bool,
    /// `none_single_block` (units permuted freely in one block) or
    /// `within_blocks` (units permuted only inside their block; blocks never
    /// move, so unequal block sizes are never exchanged).
    pub restrictions: String,
    /// One size per block, in the plan's block order.
    pub block_sizes: Vec<usize>,
    pub reduced_model: Option<String>,
    pub draw_method: String,
    pub rng_algorithm: String,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
    pub seed_derivation: String,
    /// log10 of a combinatorial upper bound on distinct permutation outcomes
    /// (distinct arrangements); 1/bound is only a lower bound on the smallest
    /// attainable exact p-value.
    pub log10_distinct_admissible_permutations: Option<f64>,
    pub n_permutations_requested: usize,
    pub n_permutations_executed: usize,
    /// Monte Carlo step 1/(B+1).
    pub monte_carlo_step: f64,
    /// Distinct arrangements enumerated exactly; None when not enumerated.
    pub n_enumerated_arrangements: Option<usize>,
    /// Smallest attainable exact p-value #{T >= T_max}/N, from enumeration.
    pub exact_minimum_p_value: Option<f64>,
    /// Smallest p-value the plan can support: max(Monte Carlo step, exact
    /// minimum p-value) when enumerated, otherwise max(Monte Carlo step,
    /// 1/bound), which is then only a lower bound.
    pub resolution: Option<f64>,
    /// `exact_enumeration` or `lower_bound_from_combinatorial_bound`.
    pub resolution_basis: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrelationMethod {
    Pearson,
    /// Pearson correlation of average ranks (ties share their mean rank).
    Spearman,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationRequest {
    /// One row per exchangeable unit; y is permuted over all rows.
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub method: CorrelationMethod,
    pub n_permutations: usize,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationDiagnostics {
    /// None when x or y is constant.
    pub coefficient: Option<f64>,
    pub n_distinct_x: usize,
    pub n_distinct_y: usize,
    pub log10_distinct_permutations: f64,
    /// Two-sided Monte Carlo (1+b)/(1+B) on |coefficient|.
    pub p_value: Option<f64>,
    pub n_at_least_observed: usize,
    pub n_permutations_executed: usize,
    pub backend_version: String,
}

/// Exhaustive enumeration request for the factor-association statistic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssociationExactRequest {
    pub factor_codes: Vec<i64>,
    pub targets: Vec<f64>,
    pub categorical: bool,
    pub max_arrangements: usize,
}

/// Exhaustive enumeration request for |r| (Pearson or Spearman).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationExactRequest {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub method: CorrelationMethod,
    pub max_arrangements: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExactPermutationDiagnostics {
    /// Distinct arrangements N, each of probability 1/N.
    pub n_arrangements: usize,
    /// Exact p-value #{T >= T_obs}/N; None when the statistic is undefined.
    pub p_value: Option<f64>,
    /// Smallest attainable exact p-value #{T >= T_max}/N.
    pub minimum_p_value: Option<f64>,
    pub maximum_statistic: Option<f64>,
    pub backend_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BhRequest {
    pub p_values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BhDiagnostics {
    pub adjusted: Vec<f64>,
    pub backend_version: String,
}

/// Provider reason for a Methods refusal of inputs outside the supported
/// numerical domain (nonzero |x| in [2^-256, 2^256], max/min <= 2^64).
pub const NUMERICAL_DOMAIN_EXCEEDED: &str = "NUMERICAL_DOMAIN_EXCEEDED";
/// Prefix of the Methods context message for that refusal.
pub const METHODS_DOMAIN_MESSAGE: &str = "input outside the supported numerical domain";

/// PERMANOVA of one categorical term on Euclidean distances between rows,
/// optionally given strata (Methods ABI 2.20 `n4m_stats_permanova`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermanovaRequest {
    /// Coordinates whose Euclidean distances are analysed, one row per unit.
    pub matrix: Vec<Vec<f64>>,
    pub term_codes: Vec<i64>,
    /// None tests the term alone; rows are permuted only inside a stratum.
    pub strata_codes: Option<Vec<i64>>,
    pub n_permutations: usize,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermanovaDiagnostics {
    pub ss_total: f64,
    pub ss_strata: f64,
    /// SS(strata + term) - SS(strata).
    pub ss_term: f64,
    pub ss_residual: f64,
    pub r2: Option<f64>,
    pub partial_r2: Option<f64>,
    pub pseudo_f: Option<f64>,
    /// Identifiable term df: levels minus connected components; 0 when aliased.
    pub df_term: usize,
    pub df_residual: usize,
    pub n_levels: usize,
    pub n_strata: usize,
    /// log10 of the distinct within-strata level assignments.
    pub log10_distinct_permutations: f64,
    pub p_value: Option<f64>,
    pub n_at_least_observed: usize,
    pub n_permutations_executed: usize,
    pub backend_version: String,
}

/// Partial PERMANOVA of a term given the additive main effects of condition
/// factors, tested by Freedman-Lane permutation of the reduced-model
/// residuals (Methods ABI 2.20 `n4m_stats_permanova_freedman_lane`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreedmanLaneRequest {
    pub matrix: Vec<Vec<f64>>,
    pub term_codes: Vec<i64>,
    /// One code vector per condition factor (main effects, no interaction).
    pub condition_codes: Vec<Vec<i64>>,
    pub n_permutations: usize,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreedmanLaneDiagnostics {
    pub ss_total: f64,
    /// Model SS of the reduced design (intercept and condition main effects).
    pub ss_reduced: f64,
    pub ss_term: f64,
    pub ss_residual: f64,
    pub r2: Option<f64>,
    pub partial_r2: Option<f64>,
    pub pseudo_f: Option<f64>,
    /// rank(full) - rank(reduced); 0 when aliased with the conditions.
    pub df_term: usize,
    pub df_residual: usize,
    /// Rank of the reduced design, intercept included.
    pub rank_reduced: usize,
    /// log10(n!), bound on distinct residual permutations.
    pub log10_distinct_permutations: f64,
    pub p_value: Option<f64>,
    pub n_at_least_observed: usize,
    pub n_permutations_executed: usize,
    pub backend_version: String,
}

/// PERMDISP, vegan `betadisper(type = "centroid")` + `permutest`
/// (Methods ABI 2.20 `n4m_stats_permdisp`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermdispRequest {
    pub matrix: Vec<Vec<f64>>,
    pub group_codes: Vec<i64>,
    pub n_permutations: usize,
    #[serde(with = "u64_decimal")]
    pub seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermdispDiagnostics {
    /// Euclidean distance of each row to its group centroid.
    pub distances: Vec<f64>,
    /// Mean distance per group, in ascending group-code order.
    pub group_mean_distances: Vec<f64>,
    pub f: Option<f64>,
    pub df1: usize,
    pub df2: usize,
    pub n_groups: usize,
    /// log10(n! / prod n_g!).
    pub log10_distinct_permutations: f64,
    pub p_value: Option<f64>,
    pub n_at_least_observed: usize,
    pub n_permutations_executed: usize,
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
        Err(ProviderError::unsupported(
            "SUMMARY_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn nearest_neighbors(
        &self,
        _request: &NearestNeighborsRequest,
    ) -> Result<NearestNeighborsDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("KNN_PROVIDER_NOT_CONFIGURED"))
    }
    fn local_contrast(
        &self,
        _request: &LocalContrastRequest,
    ) -> Result<LocalContrastDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "LOCAL_CONTRAST_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn hdbscan(&self, _request: &HdbscanRequest) -> Result<HdbscanDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "HDBSCAN_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn adjusted_rand_index(
        &self,
        _request: &AdjustedRandRequest,
    ) -> Result<AdjustedRandDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("ARI_PROVIDER_NOT_CONFIGURED"))
    }
    fn snv(&self, _request: &SnvRequest) -> Result<SnvDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("SNV_PROVIDER_NOT_CONFIGURED"))
    }
    fn noise_proxy(
        &self,
        _request: &NoiseProxyRequest,
    ) -> Result<NoiseProxyDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "NOISE_PROXY_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn tolerance_pairs(
        &self,
        _request: &TolerancePairsRequest,
    ) -> Result<TolerancePairsDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "TOLERANCE_PAIRS_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn association(
        &self,
        _request: &AssociationRequest,
    ) -> Result<AssociationDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "ASSOCIATION_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn holm_adjust(&self, _request: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("HOLM_PROVIDER_NOT_CONFIGURED"))
    }
    fn correlation(
        &self,
        _request: &CorrelationRequest,
    ) -> Result<CorrelationDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "CORRELATION_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn bh_adjust(&self, _request: &BhRequest) -> Result<BhDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("BH_PROVIDER_NOT_CONFIGURED"))
    }
    fn association_exact(
        &self,
        _request: &AssociationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "EXACT_PERMUTATION_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn correlation_exact(
        &self,
        _request: &CorrelationExactRequest,
    ) -> Result<ExactPermutationDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "EXACT_PERMUTATION_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn permanova(
        &self,
        _request: &PermanovaRequest,
    ) -> Result<PermanovaDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "PERMANOVA_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn permdisp(&self, _request: &PermdispRequest) -> Result<PermdispDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "PERMDISP_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn permanova_freedman_lane(
        &self,
        _request: &FreedmanLaneRequest,
    ) -> Result<FreedmanLaneDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "FREEDMAN_LANE_PROVIDER_NOT_CONFIGURED",
        ))
    }
}

/// Methods operations a complete provider exposes, in report order.
pub const METHODS_CAPABILITY_IDS: [&str; 19] = [
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
    "methods.correlation",
    "methods.bh_adjust",
    "methods.association_exact",
    "methods.correlation_exact",
    "methods.permanova",
    "methods.permdisp",
    "methods.permanova_freedman_lane",
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
        Err(ProviderError::unsupported(
            "METHODS_PROVIDER_NOT_CONFIGURED",
        ))
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported(
            "METHODS_PROVIDER_NOT_CONFIGURED",
        ))
    }
}
