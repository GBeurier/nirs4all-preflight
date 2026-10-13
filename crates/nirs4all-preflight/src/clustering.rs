//! Exploratory HDBSCAN partition and subsample stability on the canonical PCA
//! scores. Methods owns HDBSCAN, PCA, ARI and summaries; this module owns
//! eligibility, the subsampling plan, comparisons and statuses.
use crate::*;
use serde_json::{json, Value};

const N_SUBSAMPLES: usize = 50;
const MIN_ASSIGNED_FOR_ARI: usize = 10;
const MIN_INDEPENDENT_UNITS: usize = 5;
/// Products of rows^2 x (spectral columns + 2 score columns) over all replicates.
const STABILITY_WORK_BUDGET: f64 = 2.5e10;

/// Canonical structure geometry shared with `structure.*`.
pub(crate) struct Geometry<'a> {
    /// Aggregated spectra, re-centered and re-projected in each subsample.
    pub matrix: &'a [Vec<f64>],
    pub sample_ids: &'a [String],
    pub aggregation_keys: &'a [String],
    pub scores: &'a [Vec<f64>],
}

/// Frozen alpha rule: `max(5, ceil(n / 20))`; min_samples equals it.
fn min_cluster_size(n: usize) -> usize {
    5.max(n.div_ceil(20))
}

/// ceil(0.8 x) in integers.
fn four_fifths(x: usize) -> usize {
    (4 * x).div_ceil(5)
}

fn n_components(rows: usize, columns: usize) -> usize {
    10.min(rows.saturating_sub(2)).min(columns)
}

pub(crate) fn unavailable(
    report: &mut QualificationReport,
    source_id: &str,
    status: Availability,
    reason: &str,
) {
    for id in ["clustering.partition", "clustering.subsample_stability"] {
        let mut metric = Metric::unavailable(id, status.clone(), reason, Some(source_id), None);
        metric.view_id = "canonical:centered".into();
        report.metrics.push(metric);
    }
}

fn request(scores: &[Vec<f64>], min_cluster_size: usize, min_samples: usize) -> HdbscanRequest {
    HdbscanRequest {
        matrix: scores.to_vec(),
        min_cluster_size,
        min_samples: min_samples.min(scores.len()),
        selection: ClusterSelection::Eom,
        allow_single_cluster: false,
    }
}

fn valid(result: &HdbscanDiagnostics, n: usize) -> bool {
    let clusters = result.persistence.len();
    let tree = &result.tree;
    result.labels.len() == n
        && result.membership.len() == n
        && result.outlier_scores.len() == n
        && result
            .labels
            .iter()
            .all(|&l| l >= -1 && l < clusters as i64)
        && (0..clusters as i64).all(|c| result.labels.contains(&c))
        && result.membership.iter().all(|v| (0.0..=1.0).contains(v))
        && result
            .outlier_scores
            .iter()
            .all(|v| v.is_none_or(|v| (0.0..=1.0).contains(&v)))
        && result.persistence.iter().all(|v| v.is_finite())
        && !tree.is_empty()
        && tree[0].parent.is_none()
        && tree.iter().enumerate().skip(1).all(|(i, node)| {
            node.parent.is_some_and(|p| p < i)
                && node
                    .birth_distance
                    .is_some_and(|d| d.is_finite() && d >= 0.0)
        })
        && tree
            .iter()
            .all(|node| node.death_distance.is_finite() && node.death_distance >= 0.0)
        && (0..clusters).all(|c| tree.iter().filter(|node| node.label == Some(c)).count() == 1)
}

fn hdbscan(
    provider: &impl MethodsProvider,
    request: &HdbscanRequest,
) -> Result<HdbscanDiagnostics, (Availability, String)> {
    match provider.hdbscan(request) {
        Ok(result) if valid(&result, request.matrix.len()) => Ok(result),
        Ok(_) => Err((Availability::Error, "INVALID_PROVIDER_RESULT".into())),
        Err(e) => Err((Availability::Unsupported, e.0)),
    }
}

fn parameters(
    min_cluster_size: usize,
    min_samples: usize,
    columns: usize,
    backend: &str,
) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("algorithm".into(), json!("hdbscan")),
        (
            "implementation".into(),
            json!("methods_n4m_cluster_hdbscan_sklearn_1_9_1_port_stable_mst_ties"),
        ),
        ("metric".into(), json!("euclidean")),
        ("input".into(), json!("canonical_pca_scores")),
        ("n_components".into(), json!(columns)),
        ("min_cluster_size".into(), json!(min_cluster_size)),
        (
            "min_cluster_size_rule".into(),
            json!("max(5, ceil(n_eligible / 20))"),
        ),
        ("min_samples".into(), json!(min_samples)),
        (
            "min_samples_convention".into(),
            json!("includes_the_sample_itself"),
        ),
        ("cluster_selection".into(), json!("eom")),
        ("allow_single_cluster".into(), json!(false)),
        ("noise_label".into(), json!(-1)),
        (
            "membership_semantics".into(),
            json!("relative_strength_not_probability"),
        ),
        ("backend_version".into(), json!(backend)),
    ])
}

fn finish(metric: &mut Metric, n: usize, params: &BTreeMap<String, Value>) {
    metric.view_id = "canonical:centered".into();
    metric.denominators.insert("n_eligible_samples".into(), n);
    metric.parameters.extend(params.clone());
}

pub(crate) fn analyze(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    geometry: &Geometry,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let source_id = source.source_id.as_str();
    let n = geometry.scores.len();
    let columns = geometry.scores.first().map_or(0, Vec::len);
    let min_size = min_cluster_size(n);
    if n < 2 * min_size {
        unavailable(
            report,
            source_id,
            Availability::InsufficientData,
            "FEWER_THAN_TWO_MIN_CLUSTER_SIZES",
        );
        return;
    }
    let full = match hdbscan(provider, &request(geometry.scores, min_size, min_size)) {
        Ok(result) => result,
        Err((status, reason)) => {
            unavailable(report, source_id, status, &reason);
            return;
        }
    };
    let params = parameters(min_size, min_size, columns, &full.backend_version);
    let clusters = full.persistence.len();
    let noise = full.labels.iter().filter(|&&l| l < 0).count();

    let mut partition = Metric::computed(
        "clustering.partition",
        json!({
            "sample_ids": geometry.sample_ids,
            "aggregation_keys": geometry.aggregation_keys,
            "labels": full.labels,
            "membership": full.membership,
            "outlier_scores": full.outlier_scores,
        }),
        Some(source_id),
        None,
    );
    finish(&mut partition, n, &params);
    partition
        .parameters
        .insert("outlier_score".into(), json!("glosh"));
    report.metrics.push(partition);

    let mut count = Metric::computed(
        "clustering.candidate_cluster_count",
        json!(clusters),
        Some(source_id),
        None,
    );
    finish(&mut count, n, &params);
    report.metrics.push(count);

    let mut noise_metric = Metric::computed(
        "clustering.noise_fraction",
        json!(noise as f64 / n as f64),
        Some(source_id),
        None,
    );
    finish(&mut noise_metric, n, &params);
    noise_metric.denominators.insert("n_noise".into(), noise);
    report.metrics.push(noise_metric);

    let per_cluster: Vec<Value> = (0..clusters)
        .map(|c| {
            let node = full
                .tree
                .iter()
                .find(|node| node.label == Some(c))
                .expect("validated tree label");
            json!({
                "label": c,
                "n_members": full.labels.iter().filter(|&&l| l == c as i64).count(),
                "persistence": full.persistence[c],
                "stability": node.stability,
                "birth_distance": node.birth_distance,
                "death_distance": node.death_distance,
            })
        })
        .collect();
    let mut cluster_metric = Metric::computed(
        "clustering.clusters",
        json!(per_cluster),
        Some(source_id),
        None,
    );
    finish(&mut cluster_metric, n, &params);
    cluster_metric.parameters.insert(
        "persistence_definition".into(),
        json!("stability / (n_members * max_lambda); hdbscan 0.8.44 cluster_persistence_"),
    );
    report.metrics.push(cluster_metric);

    let mut tree = Metric::computed(
        "clustering.condensed_tree",
        json!(full.tree),
        Some(source_id),
        None,
    );
    finish(&mut tree, n, &params);
    tree.parameters.insert(
        "distance_scale".into(),
        json!("mutual_reachability_in_pca_score_units"),
    );
    report.metrics.push(tree);

    let mut stability_ids = Vec::new();
    for (constant, id) in [
        (false, "clustering.subsample_stability"),
        (true, "clustering.subsample_stability_constant_parameters"),
    ] {
        stability_ids.push(id);
        let metric = stability(
            source,
            input,
            samples,
            geometry,
            provider,
            &full.labels,
            min_size,
            constant,
            id,
        );
        report.metrics.push(metric);
    }
    for (id, reason) in [
        (
            "clustering.cluster_appearance_frequency",
            "CLUSTER_MATCHING_NOT_QUALIFIED",
        ),
        (
            "clustering.gaussian_null_model",
            "NULL_MODEL_NOT_IMPLEMENTED",
        ),
    ] {
        let mut metric =
            Metric::unavailable(id, Availability::Unsupported, reason, Some(source_id), None);
        metric.view_id = "canonical:centered".into();
        report.metrics.push(metric);
    }

    let mut evidence = vec![
        "clustering.partition".to_string(),
        "clustering.candidate_cluster_count".into(),
    ];
    evidence.extend(stability_ids.iter().map(|s| s.to_string()));
    report.findings.push(if clusters < 2 {
        Finding {
            rule_id: "structure.clustering.continuous_structure.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence,
            message: format!(
                "HDBSCAN found no density-separated groups in {source_id}; the data are compatible with a continuous structure (exploratory, no null model)"
            ),
            action: "Do not derive group-based splits from clustering; inspect PCA scores and metadata".into(),
        }
    } else {
        Finding {
            rule_id: "structure.clustering.uncertain_partition.v1".into(),
            severity: "info".into(),
            confidence: "unknown".into(),
            evidence,
            message: format!(
                "HDBSCAN proposes {clusters} candidate groups in {source_id} with {noise} of {n} samples as noise; the partition is uncertain because no calibrated rule supports a firm number of clusters"
            ),
            action: "Treat candidate groups as hypotheses; check subsample stability and metadata before using them".into(),
        }
    });
}

struct SplitMix64(u64);
impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Unbiased integer in [0, bound) by rejection.
    fn below(&mut self, bound: usize) -> usize {
        let bound = bound as u64;
        let zone = u64::MAX - u64::MAX % bound;
        loop {
            let v = self.next();
            if v < zone {
                return (v % bound) as usize;
            }
        }
    }
}

fn source_seed(seed: u64, source_id: &str) -> u64 {
    source_id
        .bytes()
        .fold(seed ^ 0xCBF2_9CE4_8422_2325, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01B3)
        })
}

#[allow(clippy::too_many_arguments)]
fn stability(
    source: &SpectralSource,
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    geometry: &Geometry,
    provider: &impl MethodsProvider,
    full_labels: &[i64],
    min_size: usize,
    constant: bool,
    id: &str,
) -> Metric {
    let source_id = source.source_id.as_str();
    let fail = |status: Availability, reason: &str| {
        let mut metric = Metric::unavailable(id, status, reason, Some(source_id), None);
        metric.view_id = "canonical:centered".into();
        metric
    };
    let n = geometry.matrix.len();
    let spectral_columns = geometry.matrix.first().map_or(0, Vec::len);
    // Each eligible row is one physical sample; groups bind rows together.
    let mut unit_rows = BTreeMap::<String, Vec<usize>>::new();
    for (row, sample_id) in geometry.sample_ids.iter().enumerate() {
        let key = if input.options.independence_unit == IndependenceUnit::Group {
            match &samples[sample_id.as_str()].independence_group {
                Some(group) => group.clone(),
                None => return fail(Availability::NotIdentifiable, "MISSING_INDEPENDENCE_GROUP"),
            }
        } else {
            format!("row:{row}")
        };
        unit_rows.entry(key).or_default().push(row);
    }
    let units: Vec<Vec<usize>> = unit_rows.into_values().collect();
    if units.len() < MIN_INDEPENDENT_UNITS {
        return fail(
            Availability::InsufficientData,
            "FEWER_THAN_FIVE_INDEPENDENT_UNITS",
        );
    }
    let work = N_SUBSAMPLES as f64 * (n as f64).powi(2) * (spectral_columns + 20) as f64;
    if work > STABILITY_WORK_BUDGET {
        return fail(Availability::Unsupported, "STABILITY_WORK_BUDGET_EXCEEDED");
    }
    let (sub_size, sub_samples) = if constant {
        (min_size, min_size)
    } else {
        (2.max(four_fifths(min_size)), 1.max(four_fifths(min_size)))
    };
    let chosen_units = four_fifths(units.len());
    let mut rng = SplitMix64(source_seed(input.options.seed, source_id));
    let mut ari = Vec::new();
    let mut agreement = Vec::new();
    let mut cluster_counts = Vec::new();
    let mut noise_fractions = Vec::new();
    let mut intersections = Vec::new();
    let mut backend = String::new();
    let mut order: Vec<usize> = (0..units.len()).collect();
    for _ in 0..N_SUBSAMPLES {
        for i in 0..chosen_units {
            let j = i + rng.below(units.len() - i);
            order.swap(i, j);
        }
        let mut rows: Vec<usize> = order[..chosen_units]
            .iter()
            .flat_map(|&u| units[u].iter().copied())
            .collect();
        rows.sort_unstable();
        let k = n_components(rows.len(), spectral_columns);
        if k == 0 || rows.len() < 2 * sub_size {
            return fail(Availability::InsufficientData, "SUBSAMPLE_TOO_SMALL");
        }
        let pca = PcaRequest {
            source_id: source_id.into(),
            sample_ids: rows
                .iter()
                .map(|&r| geometry.sample_ids[r].clone())
                .collect(),
            matrix: rows.iter().map(|&r| geometry.matrix[r].clone()).collect(),
            n_components: k,
        };
        let scores = match provider.pca(&pca) {
            Ok(result)
                if result.scores.len() == rows.len()
                    && result
                        .scores
                        .iter()
                        .all(|s| s.len() == k && s.iter().all(|v| v.is_finite())) =>
            {
                result.scores
            }
            Ok(_) => return fail(Availability::Error, "INVALID_PROVIDER_RESULT"),
            Err(e) => return fail(Availability::Unsupported, &e.0),
        };
        let sub = match hdbscan(provider, &request(&scores, sub_size, sub_samples)) {
            Ok(result) => result,
            Err((status, reason)) => return fail(status, &reason),
        };
        backend.clone_from(&sub.backend_version);
        let full: Vec<i64> = rows.iter().map(|&r| full_labels[r]).collect();
        let same_status = full
            .iter()
            .zip(&sub.labels)
            .filter(|(a, b)| (**a >= 0) == (**b >= 0))
            .count();
        agreement.push(same_status as f64 / rows.len() as f64);
        intersections.push(rows.len() as f64);
        cluster_counts.push(sub.persistence.len() as f64);
        noise_fractions
            .push(sub.labels.iter().filter(|&&l| l < 0).count() as f64 / rows.len() as f64);
        let (a, b): (Vec<i64>, Vec<i64>) = full
            .iter()
            .zip(&sub.labels)
            .filter(|(a, b)| **a >= 0 && **b >= 0)
            .map(|(a, b)| (*a, *b))
            .unzip();
        let distinct = |v: &[i64]| v.iter().collect::<BTreeSet<_>>().len();
        if a.len() >= MIN_ASSIGNED_FOR_ARI && distinct(&a) >= 2 && distinct(&b) >= 2 {
            match provider.adjusted_rand_index(&AdjustedRandRequest {
                labels_a: a,
                labels_b: b,
            }) {
                Ok(result) if result.ari.is_none_or(|v| (-1.0..=1.0).contains(&v)) => {
                    ari.extend(result.ari)
                }
                Ok(_) => return fail(Availability::Error, "INVALID_PROVIDER_RESULT"),
                Err(e) => return fail(Availability::Unsupported, &e.0),
            }
        }
    }
    let summarize = |values: &[f64]| -> Result<Value, ProviderError> {
        if values.is_empty() {
            return Ok(Value::Null);
        }
        let s = provider.summary(&SummaryRequest {
            values: values.to_vec(),
        })?;
        Ok(
            json!({"count": s.count, "min": s.min, "q25": s.q25, "median": s.median,
                  "q75": s.q75, "max": s.max, "mean": s.mean}),
        )
    };
    let compared: Vec<f64> = intersections.iter().map(|v| v / n as f64).collect();
    let value = (|| -> Result<Value, ProviderError> {
        Ok(json!({
            "ari_assigned_in_both": summarize(&ari)?,
            "assigned_noise_agreement": summarize(&agreement)?,
            "cluster_count": summarize(&cluster_counts)?,
            "noise_fraction": summarize(&noise_fractions)?,
            "intersection_size": summarize(&intersections)?,
            "compared_fraction": summarize(&compared)?,
        }))
    })();
    let value = match value {
        Ok(value) => value,
        Err(e) => return fail(Availability::Unsupported, &e.0),
    };
    let mut metric = Metric::computed(id, value, Some(source_id), None);
    metric.view_id = "canonical:centered".into();
    metric.denominators.insert("n_eligible_samples".into(), n);
    metric
        .denominators
        .insert("n_subsamples".into(), N_SUBSAMPLES);
    metric
        .denominators
        .insert("n_ari_evaluable_subsamples".into(), ari.len());
    metric
        .denominators
        .insert("n_independent_units".into(), units.len());
    metric
        .denominators
        .insert("n_units_per_subsample".into(), chosen_units);
    for (key, value) in [
        ("subsample_fraction", json!(0.8)),
        ("subsample_with_replacement", json!(false)),
        (
            "rng",
            json!("splitmix64(seed xor fnv1a64(source_id)), partial Fisher-Yates"),
        ),
        ("seed", json!(input.options.seed)),
        (
            "refit_per_subsample",
            json!("centering, pca, hdbscan on aggregated spectra"),
        ),
        (
            "comparison",
            json!("common sample identities against the full partition"),
        ),
        ("min_cluster_size", json!(sub_size)),
        ("min_samples", json!(sub_samples)),
        (
            "parameter_policy",
            json!(if constant {
                "constant_full_sample_parameters"
            } else {
                "ceil(0.8 * full), floors min_cluster_size 2 and min_samples 1"
            }),
        ),
        ("min_assigned_for_ari", json!(MIN_ASSIGNED_FOR_ARI)),
        (
            "ari_requires",
            json!("two clusters in both partitions on the assigned-in-both samples"),
        ),
        ("backend_version", json!(backend)),
    ] {
        metric.parameters.insert(key.into(), value);
    }
    if input.options.independence_unit != IndependenceUnit::Group {
        metric.parameters.insert(
            "independence_assumption".into(),
            json!("one_unit_per_eligible_physical_sample"),
        );
    }
    metric
}
