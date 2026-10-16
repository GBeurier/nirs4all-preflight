//! Exploratory HDBSCAN partition, subsample stability, cluster matching and a
//! unimodal Gaussian null model on the canonical PCA scores (`clustering.v3`).
//! Methods owns PCA, HDBSCAN, ARI, Jaccard, assignment, PCG64 draws and
//! summaries; this module owns eligibility, resampling units, plans, seed
//! derivation, the score-grid policy, comparisons, statuses and rules.
use crate::*;
use serde_json::{json, Value};

pub(crate) const PROTOCOL: &str = "clustering.v3";
const MATCHING_PROTOCOL: &str = "cluster_matching.v1";
const N_SUBSAMPLES: usize = 50;
const N_NULL_REPLICATES: usize = 99;
const MIN_ASSIGNED_FOR_ARI: usize = 10;
const MIN_INDEPENDENT_UNITS: usize = 5;
/// Products of rows^2 x (columns + 20) over the refits of one stability variant
/// or of the whole Gaussian null.
const WORK_BUDGET: f64 = 2.5e10;
/// Scores are rounded to 2^(e - 24) where max|score| lies in [2^(e-1), 2^e).
const SCORE_GRID_BITS: i32 = 24;
/// A reference cluster appears in a subsample when its matched Jaccard is above this.
const APPEARANCE_JACCARD: f64 = 0.5;
/// Null covariance: diag(eigenvalues) + RIDGE x mean(eigenvalues) x I.
const NULL_RIDGE: f64 = 1e-6;
/// Exploratory assessment thresholds (assessment rule v2, not validated).
const STABLE_MEDIAN_ARI: f64 = 0.8;
const STABLE_APPEARANCE: f64 = 0.8;
const STABLE_ASSIGNED_FRACTION: f64 = 0.5;
const NULL_TAIL: f64 = 0.05;
const VIEW: &str = "canonical:centered";

const METRIC_IDS: [&str; 7] = [
    "clustering.partition",
    "clustering.subsample_stability",
    "clustering.subsample_stability_constant_parameters",
    "clustering.cluster_appearance_frequency",
    "clustering.cluster_appearance_frequency_constant_parameters",
    "clustering.gaussian_null_model",
    "clustering.partition_assessment",
];

/// Canonical structure geometry shared with `structure.*`.
pub(crate) struct Geometry<'a> {
    /// Aggregated spectra, re-centered and re-projected in each subsample.
    pub matrix: &'a [Vec<f64>],
    pub sample_ids: &'a [String],
    pub aggregation_keys: &'a [String],
    pub scores: &'a [Vec<f64>],
    /// Methods PCA eigenvalues of `scores` (variance convention n - 1).
    pub eigenvalues: &'a [f64],
}

type Failure = (Availability, String);
type Plans = Vec<Vec<usize>>;

fn failure(status: Availability, reason: &str) -> Failure {
    (status, reason.into())
}

fn provider_failure(e: ProviderError) -> Failure {
    (e.availability(), e.reason)
}

fn invalid() -> Failure {
    failure(Availability::Error, "INVALID_PROVIDER_RESULT")
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

fn pow2(k: i32) -> f64 {
    f64::from_bits(((k + 1023) as u64) << 52)
}

/// Rounds every score to the binary grid 2^(e - 24), where max|score| lies in
/// [2^(e-1), 2^e). Power-of-two steps make the rounding exact and identical
/// on every host, so last-ulp PCA differences between backends no longer
/// reach the HDBSCAN tie order (except for a value lying within that noise of
/// a grid midpoint).
fn quantize(matrix: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let largest = matrix.iter().flatten().fold(0.0f64, |a, v| a.max(v.abs()));
    let exponent = ((largest.to_bits() >> 52) & 0x7ff) as i32 - 1022;
    if !largest.is_normal() || exponent - SCORE_GRID_BITS < -1022 {
        return matrix.to_vec();
    }
    let step = pow2(exponent - SCORE_GRID_BITS);
    matrix
        .iter()
        .map(|row| {
            row.iter()
                .map(|v| (v / step).round() * step + 0.0)
                .collect()
        })
        .collect()
}

pub(crate) fn unavailable(
    report: &mut QualificationReport,
    source_id: &str,
    status: Availability,
    reason: &str,
) {
    for id in METRIC_IDS {
        push_unavailable(report, id, source_id, (status.clone(), reason.into()));
    }
}

fn push_unavailable(report: &mut QualificationReport, id: &str, source_id: &str, f: Failure) {
    let mut metric = Metric::unavailable(id, f.0, &f.1, Some(source_id), None);
    metric.view_id = VIEW.into();
    if f.1 == NUMERICAL_DOMAIN_EXCEEDED {
        metric.parameters.insert(
            "numerical_domain".into(),
            json!(DIFFERENCE_NUMERICAL_DOMAIN),
        );
    }
    report.metrics.push(metric);
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
        && tree.len() <= n
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

/// HDBSCAN on grid-rounded scores (EOM, no single cluster).
fn hdbscan(
    provider: &impl MethodsProvider,
    scores: &[Vec<f64>],
    min_cluster_size: usize,
    min_samples: usize,
) -> Result<HdbscanDiagnostics, Failure> {
    let request = HdbscanRequest {
        matrix: quantize(scores),
        min_cluster_size,
        min_samples: min_samples.min(scores.len()),
        selection: ClusterSelection::Eom,
        allow_single_cluster: false,
    };
    match provider.hdbscan(&request) {
        Ok(result) if valid(&result, scores.len()) => Ok(result),
        Ok(_) => Err(invalid()),
        Err(e) => Err(provider_failure(e)),
    }
}

/// Centered PCA of `rows` of `matrix` with the canonical component rule.
fn refit_scores(
    provider: &impl MethodsProvider,
    source_id: &str,
    matrix: &[Vec<f64>],
    sample_ids: &[String],
    rows: &[usize],
) -> Result<Vec<Vec<f64>>, Failure> {
    let columns = matrix.first().map_or(0, Vec::len);
    let k = n_components(rows.len(), columns);
    if k == 0 {
        return Err(failure(
            Availability::InsufficientData,
            "SUBSAMPLE_TOO_SMALL",
        ));
    }
    let request = PcaRequest {
        source_id: source_id.into(),
        sample_ids: rows.iter().map(|&r| sample_ids[r].clone()).collect(),
        matrix: rows.iter().map(|&r| matrix[r].clone()).collect(),
        n_components: k,
    };
    match provider.pca(&request) {
        Ok(result)
            if result.scores.len() == rows.len()
                && result
                    .scores
                    .iter()
                    .all(|s| s.len() == k && s.iter().all(|v| v.is_finite()))
                && result.unresolved.len() == k =>
        {
            // Same rule as the canonical PCA: unresolved components are
            // dropped before the scores reach HDBSCAN.
            let resolved = result.resolved();
            if resolved.eigenvalues.is_empty() {
                return Err(failure(Availability::Undefined, "ZERO_NUMERICAL_RANK"));
            }
            Ok(resolved.scores)
        }
        Ok(_) => Err(invalid()),
        Err(e) => Err(provider_failure(e)),
    }
}

fn summarize(provider: &impl MethodsProvider, values: &[f64]) -> Result<Value, Failure> {
    if values.is_empty() {
        return Ok(Value::Null);
    }
    let s = provider
        .summary(&SummaryRequest {
            values: values.to_vec(),
        })
        .map_err(provider_failure)?;
    Ok(
        json!({"count": s.count, "min": s.min, "q25": s.q25, "median": s.median,
              "q75": s.q75, "max": s.max, "mean": s.mean}),
    )
}

fn median_of(provider: &impl MethodsProvider, values: &[f64]) -> Result<Option<f64>, Failure> {
    Ok(summarize(provider, values)?["median"].as_f64())
}

/// Resampling units: rows merged by declared identities, never by Y values.
struct Units {
    members: Vec<Vec<usize>>,
    label: &'static str,
    independent: bool,
}

fn build_units(
    input: &QualificationInput,
    samples: &HashMap<&str, &Sample>,
    geometry: &Geometry,
) -> Result<Units, Failure> {
    let n = geometry.sample_ids.len();
    let mut reference_groups = HashMap::<&str, BTreeSet<&str>>::new();
    if input.options.independence_unit == IndependenceUnit::ReferenceGroup {
        for target in &input.targets {
            for value in &target.values {
                if let Some(group) = &value.reference_group_id {
                    reference_groups
                        .entry(value.sample_id.as_str())
                        .or_default()
                        .insert(group.as_str());
                }
            }
        }
    }
    let mut keys = Vec::with_capacity(n);
    for sample_id in geometry.sample_ids {
        let sample = samples[sample_id.as_str()];
        let mut row_keys = Vec::new();
        if let Some(individual) = &sample.individual_id {
            row_keys.push(format!("individual:{individual}"));
        }
        match input.options.independence_unit {
            IndependenceUnit::Group => match &sample.independence_group {
                Some(group) => row_keys.push(format!("group:{group}")),
                None => {
                    return Err(failure(
                        Availability::NotIdentifiable,
                        "MISSING_INDEPENDENCE_GROUP",
                    ))
                }
            },
            IndependenceUnit::ReferenceGroup => {
                let groups = reference_groups.get(sample_id.as_str());
                match groups.map(BTreeSet::len) {
                    Some(1) => row_keys.push(format!(
                        "reference:{}",
                        groups.and_then(|g| g.first()).expect("one group")
                    )),
                    Some(0) | None => {
                        return Err(failure(
                            Availability::NotIdentifiable,
                            "MISSING_REFERENCE_GROUP",
                        ))
                    }
                    Some(_) => {
                        return Err(failure(
                            Availability::NotIdentifiable,
                            "AMBIGUOUS_REFERENCE_GROUP",
                        ))
                    }
                }
            }
            IndependenceUnit::Sample | IndependenceUnit::Unknown => {}
        }
        keys.push(row_keys);
    }
    let mut parent: Vec<usize> = (0..n).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut first = HashMap::<&str, usize>::new();
    for (row, row_keys) in keys.iter().enumerate() {
        for key in row_keys {
            if let Some(&other) = first.get(key.as_str()) {
                let (a, b) = (root(&mut parent, row), root(&mut parent, other));
                parent[a.max(b)] = a.min(b);
            } else {
                first.insert(key, row);
            }
        }
    }
    let mut members = BTreeMap::<usize, Vec<usize>>::new();
    for row in 0..n {
        members.entry(root(&mut parent, row)).or_default().push(row);
    }
    // Roots are the smallest member, so units are ordered by first eligible row.
    let members: Vec<Vec<usize>> = members.into_values().collect();
    let (label, independent) = match input.options.independence_unit {
        IndependenceUnit::Sample => ("physical_sample", true),
        IndependenceUnit::Group => ("independence_group", true),
        IndependenceUnit::ReferenceGroup => ("reference_group", true),
        IndependenceUnit::Unknown => ("eligible_sample_undeclared_independence", false),
    };
    Ok(Units {
        members,
        label,
        independent,
    })
}

fn plan_seed(root: u64, source_id: &str) -> u64 {
    nirs4all_preflight_core::derive_seed(
        root,
        &format!("nirs4all-preflight\0methods\0{PROTOCOL}\0subsample_plans\0{source_id}"),
    )
}

fn null_seed(root: u64, source_id: &str, replicate: usize) -> u64 {
    nirs4all_preflight_core::derive_seed(
        root,
        &format!(
            "nirs4all-preflight\0methods\0{PROTOCOL}\0gaussian_null\0{source_id}\0{replicate}"
        ),
    )
}

/// Plan b keeps the units at sorted(permutation_b[..ceil(0.8 U)]) of 50
/// successive Methods PCG64 permutations (`default_rng(seed).permutation(U)`);
/// returns the unit plans and their sorted eligible rows.
fn subsample_plans(
    provider: &impl MethodsProvider,
    units: &Units,
    seed: u64,
) -> Result<(Plans, Plans), Failure> {
    let u = units.members.len();
    let result = provider
        .random_permutations(&RandomPermutationsRequest {
            seed,
            n: u,
            n_permutations: N_SUBSAMPLES,
        })
        .map_err(provider_failure)?;
    let valid = result.permutations.len() == N_SUBSAMPLES
        && result.permutations.iter().all(|p| {
            let mut sorted = p.clone();
            sorted.sort_unstable();
            sorted.into_iter().eq(0..u)
        });
    if !valid {
        return Err(invalid());
    }
    let chosen = four_fifths(u);
    Ok(result
        .permutations
        .iter()
        .map(|perm| {
            let mut kept = perm[..chosen].to_vec();
            kept.sort_unstable();
            let mut rows: Vec<usize> = kept
                .iter()
                .flat_map(|&unit| units.members[unit].iter().copied())
                .collect();
            rows.sort_unstable();
            (kept, rows)
        })
        .unzip())
}

/// Subsample partitions of one data block (spectra or simulated scores).
struct Block<'a> {
    matrix: &'a [Vec<f64>],
    sample_ids: &'a [String],
}

fn subsample_partitions(
    provider: &impl MethodsProvider,
    source_id: &str,
    block: &Block,
    plans: &[Vec<usize>],
    params: (usize, usize),
) -> Result<Vec<Vec<i64>>, Failure> {
    plans
        .iter()
        .map(|rows| {
            if rows.len() < 2 * params.0 {
                return Err(failure(
                    Availability::InsufficientData,
                    "SUBSAMPLE_TOO_SMALL",
                ));
            }
            let scores = refit_scores(provider, source_id, block.matrix, block.sample_ids, rows)?;
            Ok(hdbscan(provider, &scores, params.0, params.1)?.labels)
        })
        .collect()
}

/// Comparison of one subsample partition with the full partition on the
/// drawn identities (every drawn identity is common to both).
struct Comparison {
    drawn: usize,
    assigned_in_both: usize,
    same_status: usize,
    clusters: usize,
    noise: usize,
    ari: Option<f64>,
}

fn compare(
    provider: &impl MethodsProvider,
    full: &[i64],
    rows: &[usize],
    sub: &[i64],
) -> Result<Comparison, Failure> {
    let reference: Vec<i64> = rows.iter().map(|&r| full[r]).collect();
    let (a, b): (Vec<i64>, Vec<i64>) = reference
        .iter()
        .zip(sub)
        .filter(|(a, b)| **a >= 0 && **b >= 0)
        .map(|(a, b)| (*a, *b))
        .unzip();
    let distinct = |v: &[i64]| v.iter().collect::<BTreeSet<_>>().len();
    let ari = if a.len() >= MIN_ASSIGNED_FOR_ARI && distinct(&a) >= 2 && distinct(&b) >= 2 {
        match provider.adjusted_rand_index(&AdjustedRandRequest {
            labels_a: a.clone(),
            labels_b: b,
        }) {
            Ok(result) if result.ari.is_none_or(|v| (-1.0..=1.0).contains(&v)) => result.ari,
            Ok(_) => return Err(invalid()),
            Err(e) => return Err(provider_failure(e)),
        }
    } else {
        None
    };
    Ok(Comparison {
        drawn: rows.len(),
        assigned_in_both: a.len(),
        same_status: reference
            .iter()
            .zip(sub)
            .filter(|(a, b)| (**a >= 0) == (**b >= 0))
            .count(),
        clusters: sub.iter().max().map_or(0, |&m| (m + 1).max(0) as usize),
        noise: sub.iter().filter(|&&l| l < 0).count(),
        ari,
    })
}

struct Stability {
    comparisons: Vec<Comparison>,
    median_ari: Option<f64>,
    median_assigned_fraction: Option<f64>,
    value: Value,
}

fn stability_value(
    provider: &impl MethodsProvider,
    comparisons: Vec<Comparison>,
    n: usize,
) -> Result<Stability, Failure> {
    let all = |f: &dyn Fn(&Comparison) -> f64| comparisons.iter().map(f).collect::<Vec<_>>();
    let evaluable: Vec<&Comparison> = comparisons.iter().filter(|c| c.ari.is_some()).collect();
    let on_ari =
        |f: &dyn Fn(&Comparison) -> f64| evaluable.iter().map(|c| f(c)).collect::<Vec<_>>();
    let ari: Vec<f64> = evaluable.iter().filter_map(|c| c.ari).collect();
    let nf = n as f64;
    let per_subsample: Vec<Value> = comparisons
        .iter()
        .map(|c| {
            json!({
                "intersection_size": c.drawn,
                "assigned_in_both_size": c.assigned_in_both,
                "ari": c.ari,
                "cluster_count": c.clusters,
                "noise_fraction": c.noise as f64 / c.drawn as f64,
                "assigned_noise_agreement": c.same_status as f64 / c.drawn as f64,
            })
        })
        .collect();
    let assigned_fraction = all(&|c| c.assigned_in_both as f64 / nf);
    let value = json!({
        "per_subsample": per_subsample,
        "ari_assigned_in_both": summarize(provider, &ari)?,
        "ari_population_size": summarize(provider, &on_ari(&|c| c.assigned_in_both as f64))?,
        "ari_population_fraction_of_eligible": summarize(provider, &on_ari(&|c| c.assigned_in_both as f64 / nf))?,
        "ari_population_fraction_of_intersection": summarize(provider, &on_ari(&|c| c.assigned_in_both as f64 / c.drawn as f64))?,
        "assigned_in_both_size": summarize(provider, &all(&|c| c.assigned_in_both as f64))?,
        "assigned_in_both_fraction_of_eligible": summarize(provider, &assigned_fraction)?,
        "intersection_size": summarize(provider, &all(&|c| c.drawn as f64))?,
        "intersection_fraction_of_eligible": summarize(provider, &all(&|c| c.drawn as f64 / nf))?,
        "assigned_noise_agreement": summarize(provider, &all(&|c| c.same_status as f64 / c.drawn as f64))?,
        "cluster_count": summarize(provider, &all(&|c| c.clusters as f64))?,
        "noise_fraction": summarize(provider, &all(&|c| c.noise as f64 / c.drawn as f64))?,
    });
    Ok(Stability {
        median_ari: value["ari_assigned_in_both"]["median"].as_f64(),
        median_assigned_fraction: median_of(provider, &assigned_fraction)?,
        comparisons,
        value,
    })
}

/// Per reference cluster appearance under one-to-one Jaccard matching.
fn appearance(
    provider: &impl MethodsProvider,
    full: &[i64],
    k_ref: usize,
    plans: &[Vec<usize>],
    partitions: &[Vec<i64>],
) -> Result<(Value, Option<f64>), Failure> {
    let mut matched = vec![Vec::<f64>::new(); k_ref];
    let mut present = vec![Vec::<f64>::new(); k_ref];
    let members: Vec<usize> = (0..k_ref)
        .map(|c| full.iter().filter(|&&l| l == c as i64).count())
        .collect();
    for (rows, sub) in plans.iter().zip(partitions) {
        let reference: Vec<i64> = rows.iter().map(|&r| full[r]).collect();
        let k_sub = sub.iter().max().map_or(0, |&m| (m + 1).max(0) as usize);
        let (jaccard, sizes) = if k_sub == 0 {
            let sizes = (0..k_ref)
                .map(|c| reference.iter().filter(|&&l| l == c as i64).count())
                .collect::<Vec<_>>();
            (vec![vec![0.0; 0]; k_ref], sizes)
        } else {
            let result = provider
                .cluster_jaccard(&ClusterJaccardRequest {
                    labels_a: reference.clone(),
                    labels_b: sub.clone(),
                    n_clusters_a: k_ref,
                    n_clusters_b: k_sub,
                })
                .map_err(provider_failure)?;
            if result.jaccard.len() != k_ref
                || result.sizes_a.len() != k_ref
                || result.jaccard.iter().any(|row| {
                    row.len() != k_sub
                        || row
                            .iter()
                            .any(|v| v.is_none_or(|v| !(0.0..=1.0).contains(&v)))
                })
            {
                return Err(invalid());
            }
            let jaccard: Vec<Vec<f64>> = result
                .jaccard
                .iter()
                .map(|row| row.iter().map(|v| v.unwrap_or_default()).collect())
                .collect();
            (jaccard, result.sizes_a)
        };
        let mut best = vec![0.0; k_ref];
        if k_sub > 0 {
            let pairs = provider
                .linear_sum_assignment(&LinearAssignmentRequest {
                    cost: jaccard.clone(),
                    maximize: true,
                })
                .map_err(provider_failure)?;
            if pairs.row_indices.len() != k_ref.min(k_sub)
                || pairs.column_indices.len() != pairs.row_indices.len()
                || pairs
                    .row_indices
                    .iter()
                    .zip(&pairs.column_indices)
                    .any(|(&r, &c)| r >= k_ref || c >= k_sub)
            {
                return Err(invalid());
            }
            for (&r, &c) in pairs.row_indices.iter().zip(&pairs.column_indices) {
                best[r] = jaccard[r][c];
            }
        }
        for c in 0..k_ref {
            present[c].push(sizes[c] as f64 / members[c] as f64);
            if sizes[c] > 0 {
                matched[c].push(best[c]);
            }
        }
    }
    let mut lowest: Option<f64> = None;
    let clusters = (0..k_ref)
        .map(|c| {
            let appeared = matched[c]
                .iter()
                .filter(|&&j| j > APPEARANCE_JACCARD)
                .count();
            let frequency =
                (!matched[c].is_empty()).then(|| appeared as f64 / matched[c].len() as f64);
            if let Some(f) = frequency {
                lowest = Some(lowest.map_or(f, |l: f64| l.min(f)));
            }
            Ok(json!({
                "label": c,
                "n_members": members[c],
                "n_evaluable_subsamples": matched[c].len(),
                "n_appeared": appeared,
                "appearance_frequency": frequency,
                "matched_jaccard": summarize(provider, &matched[c])?,
                "present_member_fraction": summarize(provider, &present[c])?,
            }))
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    Ok((json!({ "clusters": clusters }), lowest))
}

fn base_parameters(min_size: usize, columns: usize, backend: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("protocol".into(), json!(PROTOCOL)),
        ("algorithm".into(), json!("hdbscan")),
        (
            "implementation".into(),
            json!("methods_n4m_cluster_hdbscan_sklearn_1_9_1_port_stable_mst_ties"),
        ),
        ("metric".into(), json!("euclidean")),
        ("input".into(), json!("canonical_pca_scores")),
        (
            "input_grid".into(),
            json!(format!(
                "scores rounded half away from zero to multiples of 2^(e-{SCORE_GRID_BITS}), max|score| in [2^(e-1), 2^e), per score matrix"
            )),
        ),
        (
            "cross_host_parity".into(),
            json!("native and WASM partitions are pinned by goldens, not guaranteed: a score within one ulp of a grid midpoint, or a max|score| within one ulp of a power of two, can round to a different grid value on another host"),
        ),
        ("n_components".into(), json!(columns)),
        ("min_cluster_size".into(), json!(min_size)),
        (
            "min_cluster_size_rule".into(),
            json!("max(5, ceil(n_eligible / 20))"),
        ),
        ("min_samples".into(), json!(min_size)),
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

fn computed(id: &str, value: Value, source_id: &str, n: usize) -> Metric {
    let mut metric = Metric::computed(id, value, Some(source_id), None);
    metric.view_id = VIEW.into();
    metric.denominators.insert("n_eligible_samples".into(), n);
    metric.parameters.insert(
        "numerical_domain".into(),
        json!(DIFFERENCE_NUMERICAL_DOMAIN),
    );
    metric
}

struct Resampling {
    units: Units,
    seed: u64,
    /// Sorted unit indices kept by each subsample.
    unit_plans: Plans,
    /// Sorted eligible rows of each subsample.
    plans: Plans,
}

struct Variant {
    stability: Stability,
    lowest_appearance: Option<f64>,
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
    let full = match hdbscan(provider, geometry.scores, min_size, min_size) {
        Ok(result) => result,
        Err(f) => {
            unavailable(report, source_id, f.0, &f.1);
            return;
        }
    };
    let params = base_parameters(min_size, columns, &full.backend_version);
    let clusters = full.persistence.len();
    let noise = full.labels.iter().filter(|&&l| l < 0).count();
    push_partition(report, source_id, geometry, &full, &params);

    let spectral_columns = geometry.matrix.first().map_or(0, Vec::len);
    let resampling = build_units(input, samples, geometry).and_then(|units| {
        if units.members.len() < MIN_INDEPENDENT_UNITS {
            return Err(failure(
                Availability::InsufficientData,
                "FEWER_THAN_FIVE_RESAMPLING_UNITS",
            ));
        }
        let work = N_SUBSAMPLES as f64 * (n as f64).powi(2) * (spectral_columns + 20) as f64;
        if work > WORK_BUDGET {
            return Err(failure(
                Availability::Unsupported,
                "STABILITY_WORK_BUDGET_EXCEEDED",
            ));
        }
        let seed = plan_seed(input.options.seed, source_id);
        let (unit_plans, plans) = subsample_plans(provider, &units, seed)?;
        Ok(Resampling {
            units,
            seed,
            unit_plans,
            plans,
        })
    });

    let block = Block {
        matrix: geometry.matrix,
        sample_ids: geometry.sample_ids,
    };
    let mut variants = Vec::new();
    let mut metric_note = None;
    for constant in [false, true] {
        let (stability_id, appearance_id) = if constant {
            (
                "clustering.subsample_stability_constant_parameters",
                "clustering.cluster_appearance_frequency_constant_parameters",
            )
        } else {
            (
                "clustering.subsample_stability",
                "clustering.cluster_appearance_frequency",
            )
        };
        let sub_params = if constant {
            (min_size, min_size)
        } else {
            (2.max(four_fifths(min_size)), 1.max(four_fifths(min_size)))
        };
        let outcome = resampling.as_ref().map_err(Clone::clone).and_then(|r| {
            let partitions =
                subsample_partitions(provider, source_id, &block, &r.plans, sub_params)?;
            let comparisons = r
                .plans
                .iter()
                .zip(&partitions)
                .map(|(rows, sub)| compare(provider, &full.labels, rows, sub))
                .collect::<Result<Vec<_>, _>>()?;
            let stability = stability_value(provider, comparisons, n)?;
            let matching = if clusters == 0 {
                Err(failure(
                    Availability::NotApplicable,
                    "NO_REFERENCE_CLUSTERS",
                ))
            } else {
                appearance(provider, &full.labels, clusters, &r.plans, &partitions)
            };
            Ok((r, stability, matching))
        });
        match outcome {
            Ok((r, stability, matching)) => {
                let mut value = stability.value.clone();
                if constant {
                    metric_note = Some("same unit_plans as clustering.subsample_stability");
                } else {
                    value["unit_plans"] = json!(r.unit_plans);
                    value["unit_first_rows"] =
                        json!(r.units.members.iter().map(|m| m[0]).collect::<Vec<_>>());
                }
                let mut metric = computed(stability_id, value, source_id, n);
                if let Some(note) = metric_note.take() {
                    metric.parameters.insert("unit_plans".into(), json!(note));
                }
                resampling_metadata(&mut metric, r, input.options.seed, sub_params, constant);
                metric.denominators.insert(
                    "n_ari_evaluable_subsamples".into(),
                    stability
                        .comparisons
                        .iter()
                        .filter(|c| c.ari.is_some())
                        .count(),
                );
                metric
                    .parameters
                    .insert("min_assigned_for_ari".into(), json!(MIN_ASSIGNED_FOR_ARI));
                metric.parameters.insert(
                    "ari_population".into(),
                    json!("drawn identities assigned to a cluster in both the full and the subsample partition"),
                );
                metric.parameters.insert(
                    "ari_requires".into(),
                    json!("at least min_assigned_for_ari such identities and two clusters in both partitions on them"),
                );
                metric.parameters.insert(
                    "fraction_denominators".into(),
                    json!({"of_eligible": "n_eligible_samples", "of_intersection": "identities drawn in the subsample"}),
                );
                report.metrics.push(metric);
                let lowest_appearance = match matching {
                    Ok((value, lowest)) => {
                        let mut metric = computed(appearance_id, value, source_id, n);
                        resampling_metadata(
                            &mut metric,
                            r,
                            input.options.seed,
                            sub_params,
                            constant,
                        );
                        matching_parameters(&mut metric);
                        report.metrics.push(metric);
                        lowest
                    }
                    Err(f) => {
                        push_unavailable(report, appearance_id, source_id, f);
                        None
                    }
                };
                variants.push(Some(Variant {
                    stability,
                    lowest_appearance,
                }));
            }
            Err(f) => {
                push_unavailable(report, stability_id, source_id, f.clone());
                push_unavailable(report, appearance_id, source_id, f);
                variants.push(None);
            }
        }
    }

    let observed = Observed {
        clusters,
        noise_fraction: noise as f64 / n as f64,
        labels: &full.labels,
    };
    let null = gaussian_null(
        provider,
        input.options.seed,
        source_id,
        geometry,
        min_size,
        resampling.as_ref().ok(),
        &observed,
    );
    let null_summary = match null {
        Ok((metric, summary)) => {
            report.metrics.push(metric);
            Some(summary)
        }
        Err(f) => {
            push_unavailable(report, "clustering.gaussian_null_model", source_id, f);
            None
        }
    };
    assess(
        report,
        source_id,
        n,
        &observed,
        resampling.as_ref().ok().map(|r| &r.units),
        &variants,
        null_summary.as_ref(),
    );
}

fn push_partition(
    report: &mut QualificationReport,
    source_id: &str,
    geometry: &Geometry,
    full: &HdbscanDiagnostics,
    params: &BTreeMap<String, Value>,
) {
    let n = full.labels.len();
    let clusters = full.persistence.len();
    let noise = full.labels.iter().filter(|&&l| l < 0).count();
    let with_params = |mut metric: Metric| {
        metric.parameters.extend(params.clone());
        metric
    };
    let mut partition = with_params(computed(
        "clustering.partition",
        json!({
            "sample_ids": geometry.sample_ids,
            "aggregation_keys": geometry.aggregation_keys,
            "labels": full.labels,
            "membership": full.membership,
            "outlier_scores": full.outlier_scores,
        }),
        source_id,
        n,
    ));
    partition
        .parameters
        .insert("outlier_score".into(), json!("glosh"));
    report.metrics.push(partition);
    report.metrics.push(with_params(computed(
        "clustering.candidate_cluster_count",
        json!(clusters),
        source_id,
        n,
    )));
    let mut noise_metric = with_params(computed(
        "clustering.noise_fraction",
        json!(noise as f64 / n as f64),
        source_id,
        n,
    ));
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
    let mut cluster_metric = with_params(computed(
        "clustering.clusters",
        json!(per_cluster),
        source_id,
        n,
    ));
    cluster_metric.parameters.insert(
        "persistence_definition".into(),
        json!("stability / (n_members * max_lambda); hdbscan 0.8.44 cluster_persistence_"),
    );
    report.metrics.push(cluster_metric);
    let mut tree = with_params(computed(
        "clustering.condensed_tree",
        json!(full.tree),
        source_id,
        n,
    ));
    tree.parameters.insert(
        "distance_scale".into(),
        json!("mutual_reachability_in_grid_rounded_pca_score_units"),
    );
    report.metrics.push(tree);
}

fn resampling_metadata(
    metric: &mut Metric,
    r: &Resampling,
    root: u64,
    sub_params: (usize, usize),
    constant: bool,
) {
    let units = r.units.members.len();
    metric
        .denominators
        .insert("n_subsamples".into(), N_SUBSAMPLES);
    metric
        .denominators
        .insert("n_resampling_units".into(), units);
    if r.units.independent {
        metric
            .denominators
            .insert("n_independent_units".into(), units);
    }
    metric
        .denominators
        .insert("n_units_per_subsample".into(), four_fifths(units));
    for (key, value) in [
        ("protocol", json!(PROTOCOL)),
        ("resampling_unit", json!(r.units.label)),
        ("independent_unit_resampling", json!(r.units.independent)),
        (
            "unit_definition",
            json!("eligible rows merged by shared individual_id and, by independence_unit, independence_group or the single reference_group_id over all targets; never by Y values"),
        ),
        ("subsample_fraction", json!(0.8)),
        ("subsample_with_replacement", json!(false)),
        (
            "plan_rule",
            json!("units ordered by first eligible row; subsample b keeps units sorted(permutation_b[0:ceil(0.8 U)])"),
        ),
        (
            "rng",
            json!("methods_n4m_random_permutations_pcg64 (numpy default_rng(seed).permutation(U), 50 successive draws)"),
        ),
        ("root_seed", json!(root.to_string())),
        ("seed", json!(r.seed.to_string())),
        (
            "seed_derivation",
            json!(format!(
                "splitmix64_finalizer(root_seed XOR fnv1a64(\"nirs4all-preflight\\0methods\\0{PROTOCOL}\\0subsample_plans\\0\" + source_id))"
            )),
        ),
        (
            "refit_per_subsample",
            json!("centering, pca (min(10, m-2, p) components), score grid, hdbscan on aggregated spectra"),
        ),
        ("min_cluster_size", json!(sub_params.0)),
        ("min_samples", json!(sub_params.1)),
        (
            "parameter_policy",
            json!(if constant {
                "constant_full_sample_parameters"
            } else {
                "ceil(0.8 * full), floors min_cluster_size 2 and min_samples 1"
            }),
        ),
    ] {
        metric.parameters.insert(key.into(), value);
    }
}

fn matching_parameters(metric: &mut Metric) {
    for (key, value) in [
        ("matching_protocol", json!(MATCHING_PROTOCOL)),
        (
            "similarity",
            json!("jaccard between the reference cluster restricted to the drawn identities and each subsample cluster; noise belongs to no cluster (methods n4m_cluster_jaccard_matrix)"),
        ),
        (
            "assignment",
            json!("one-to-one maximum total jaccard, methods n4m_linear_sum_assignment (scipy 1.18.1 linear_sum_assignment algorithm with exact-sum duals, exact optimum); rows reference labels ascending, columns subsample labels ascending"),
        ),
        (
            "tie_rule",
            json!("scipy 1.18.1 shortest augmenting path order on exact values: columns scanned last to first, unassigned column first on equal reduced cost"),
        ),
        ("appearance_rule", json!("matched jaccard > 0.5")),
        ("appearance_threshold", json!(APPEARANCE_JACCARD)),
        ("unmatched_jaccard", json!(0.0)),
        (
            "evaluable_subsample",
            json!("at least one member of the reference cluster drawn"),
        ),
    ] {
        metric.parameters.insert(key.into(), value);
    }
}

struct Observed<'a> {
    clusters: usize,
    noise_fraction: f64,
    labels: &'a [i64],
}

struct NullSummary {
    /// Exploratory fitted-null tail of the coverage-weighted stability, when decisional.
    tail_fraction: Option<f64>,
    decisional: bool,
    fraction_two_or_more: f64,
}

fn tail(null: &[Option<f64>], observed: f64, b: usize) -> Value {
    let ge = null
        .iter()
        .filter(|v| v.is_some_and(|v| v >= observed))
        .count();
    let le = null
        .iter()
        .filter(|v| v.is_none_or(|v| v <= observed))
        .count();
    json!({
        "observed": observed,
        "n_null_greater_or_equal": ge,
        "n_null_less_or_equal": le,
        "upper_tail_fraction": (1 + ge) as f64 / (1 + b) as f64,
        "lower_tail_fraction": (1 + le) as f64 / (1 + b) as f64,
    })
}

/// Frozen-projection stability: subsamples of a fixed score matrix (no PCA
/// refit) clustered with the scaled parameters and compared with `full`.
/// Returns the coverage-weighted stability, the median over subsamples of
/// ARI x (assigned in both / drawn), with 0 for a subsample without
/// evaluable ARI, and the median of the evaluable ARIs.
fn frozen_stability(
    provider: &impl MethodsProvider,
    scores: &[Vec<f64>],
    full: &[i64],
    plans: &[Vec<usize>],
    params: (usize, usize),
) -> Result<(f64, Option<f64>), Failure> {
    let (mut weighted, mut aris) = (Vec::new(), Vec::new());
    for rows in plans {
        let sub: Vec<Vec<f64>> = rows.iter().map(|&r| scores[r].clone()).collect();
        let labels = hdbscan(provider, &sub, params.0, params.1)?.labels;
        let c = compare(provider, full, rows, &labels)?;
        weighted.push(
            c.ari
                .map_or(0.0, |a| a * c.assigned_in_both as f64 / c.drawn as f64),
        );
        aris.extend(c.ari);
    }
    let statistic = median_of(provider, &weighted)?.ok_or_else(invalid)?;
    Ok((statistic, median_of(provider, &aris)?))
}

fn gaussian_null(
    provider: &impl MethodsProvider,
    root: u64,
    source_id: &str,
    geometry: &Geometry,
    min_size: usize,
    resampling: Option<&Resampling>,
    observed: &Observed,
) -> Result<(Metric, NullSummary), Failure> {
    let n = geometry.scores.len();
    let d = geometry.eigenvalues.len();
    let full_work = N_NULL_REPLICATES as f64 * (n as f64).powi(2) * (d + 20) as f64;
    if d == 0 || full_work > WORK_BUDGET {
        return Err(failure(
            Availability::Unsupported,
            "NULL_MODEL_WORK_BUDGET_EXCEEDED",
        ));
    }
    let with_stability =
        resampling.filter(|_| full_work * (1 + N_SUBSAMPLES) as f64 <= WORK_BUDGET);
    // Simulated rows are independent, so the comparison decides only when
    // every resampling unit is one declared-independent row.
    let decisional_reason = match resampling {
        None => Some("RESAMPLING_UNAVAILABLE"),
        Some(r) if !r.units.independent => Some("INDEPENDENCE_UNIT_UNDECLARED"),
        Some(r) if r.units.members.iter().any(|m| m.len() > 1) => {
            Some("MULTI_ROW_RESAMPLING_UNITS")
        }
        Some(_) if with_stability.is_none() => Some("NULL_STABILITY_WORK_BUDGET_EXCEEDED"),
        Some(_) => None,
    };
    let sub_params = (2.max(four_fifths(min_size)), 1.max(four_fifths(min_size)));
    let observed_frozen = match with_stability {
        Some(r) => Some(frozen_stability(
            provider,
            geometry.scores,
            observed.labels,
            &r.plans,
            sub_params,
        )?),
        None => None,
    };
    // Mean of the eigenvalues without an overflowing intermediate sum.
    let mean_eigenvalue = geometry
        .eigenvalues
        .iter()
        .map(|v| v / d as f64)
        .sum::<f64>();
    let ridge = NULL_RIDGE * mean_eigenvalue;
    let covariance: Vec<Vec<f64>> = (0..d)
        .map(|i| {
            (0..d)
                .map(|j| {
                    if i == j {
                        geometry.eigenvalues[i] + ridge
                    } else {
                        0.0
                    }
                })
                .collect()
        })
        .collect();
    let (mut counts, mut noises, mut statistics, mut aris) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut backend = String::new();
    for b in 0..N_NULL_REPLICATES {
        let draw = provider
            .multivariate_normal(&MultivariateNormalRequest {
                seed: null_seed(root, source_id, b),
                mean: vec![0.0; d],
                covariance: covariance.clone(),
                n_samples: n,
            })
            .map_err(provider_failure)?;
        if draw.samples.len() != n
            || draw
                .samples
                .iter()
                .any(|row| row.len() != d || row.iter().any(|v| !v.is_finite()))
        {
            return Err(invalid());
        }
        backend.clone_from(&draw.backend_version);
        // The draws are already in the frozen canonical score space.
        let full = hdbscan(provider, &draw.samples, min_size, min_size)?;
        counts.push(full.persistence.len());
        noises.push(full.labels.iter().filter(|&&l| l < 0).count() as f64 / n as f64);
        if let Some(r) = with_stability {
            let (statistic, median_ari) =
                frozen_stability(provider, &draw.samples, &full.labels, &r.plans, sub_params)?;
            statistics.push(statistic);
            aris.push(median_ari);
        }
    }
    let count_f: Vec<f64> = counts.iter().map(|&c| c as f64).collect();
    let two_or_more = counts.iter().filter(|&&c| c >= 2).count() as f64 / N_NULL_REPLICATES as f64;
    let somes = |v: &[f64]| v.iter().map(|&x| Some(x)).collect::<Vec<_>>();
    // Exploratory fitted-null tail: the Gaussian is fitted on the same data,
    // so observed and simulated statistics are not exchangeable and the tail
    // fraction carries no type-I error guarantee.
    let fitted_tail = match observed_frozen {
        Some((obs, _)) => {
            let ge = statistics.iter().filter(|&&t| t >= obs).count();
            json!({
                "statistic": "coverage_weighted_stability",
                "observed": obs,
                "n_null_greater_or_equal": ge,
                "tail_fraction": (1 + ge) as f64 / (1 + N_NULL_REPLICATES) as f64,
                "resolution": 1.0 / (1 + N_NULL_REPLICATES) as f64,
                "threshold": NULL_TAIL,
                "type_i_error_control": "none_demonstrated",
                "decisional": decisional_reason.is_none(),
                "decisional_reason": decisional_reason,
            })
        }
        None => Value::Null,
    };
    let tail_fraction = fitted_tail["tail_fraction"]
        .as_f64()
        .filter(|_| decisional_reason.is_none());
    // Joint dominance stays descriptive: it is not a calibrated tail.
    let joint = match observed_frozen {
        Some((obs, _)) => {
            let count = (0..N_NULL_REPLICATES)
                .filter(|&b| {
                    counts[b] >= observed.clusters
                        && noises[b] <= observed.noise_fraction
                        && statistics[b] >= obs
                })
                .count();
            json!({"n_null_dominating": count})
        }
        None => Value::Null,
    };
    let per_replicate: Vec<Value> = (0..N_NULL_REPLICATES)
        .map(|b| {
            json!({
                "cluster_count": counts[b],
                "noise_fraction": noises[b],
                "coverage_weighted_stability": statistics.get(b),
                "median_ari": aris.get(b).copied().flatten(),
            })
        })
        .collect();
    let value = json!({
        "observed": {
            "cluster_count": observed.clusters,
            "noise_fraction": observed.noise_fraction,
            "coverage_weighted_stability": observed_frozen.map(|o| o.0),
            "frozen_projection_median_ari": observed_frozen.and_then(|o| o.1),
        },
        "null": {
            "cluster_count": summarize(provider, &count_f)?,
            "noise_fraction": summarize(provider, &noises)?,
            "coverage_weighted_stability": summarize(provider, &statistics)?,
            "fraction_with_at_least_two_clusters": two_or_more,
        },
        "fitted_null_tail": fitted_tail,
        "description": {
            "cluster_count": tail(&somes(&count_f), observed.clusters as f64, N_NULL_REPLICATES),
            "noise_fraction": tail(&somes(&noises), observed.noise_fraction, N_NULL_REPLICATES),
            "joint_dominance": joint,
        },
        "per_replicate": per_replicate,
    });
    let mut metric = computed("clustering.gaussian_null_model", value, source_id, n);
    metric
        .denominators
        .insert("n_replicates".into(), N_NULL_REPLICATES);
    for (key, value) in [
        ("protocol", json!(PROTOCOL)),
        ("model", json!("unimodal_gaussian_fitted_on_the_same_data_independent_rows")),
        ("space", json!("canonical_pca_scores (frozen full-sample projection)")),
        (
            "fit",
            json!("zero mean and diag(Methods PCA eigenvalues, ddof 1) of the eligible rows: the canonical scores are centered and uncorrelated"),
        ),
        (
            "regularization",
            json!(format!("ridge {NULL_RIDGE:e} x mean(eigenvalues) added to every variance")),
        ),
        ("ridge", json!(ridge)),
        ("n_simulated_rows", json!(n)),
        (
            "draws",
            json!("methods n4m_random_multivariate_normal = numpy default_rng(seed).multivariate_normal(0, cov, size=n, method='cholesky')"),
        ),
        ("root_seed", json!(root.to_string())),
        (
            "seed_derivation",
            json!(format!(
                "replicate b: splitmix64_finalizer(root_seed XOR fnv1a64(\"nirs4all-preflight\\0methods\\0{PROTOCOL}\\0gaussian_null\\0\" + source_id + \"\\0\" + decimal(b)))"
            )),
        ),
        (
            "comparison_protocol",
            json!("frozen projection on both sides: observed canonical scores and simulated scores are subsampled with the same 50 plans without PCA refit, score grid, hdbscan with scaled parameters; full partitions use the full-sample parameters. The refit stability metrics are not compared with this null."),
        ),
        (
            "statistic",
            json!("coverage_weighted_stability = median over the 50 subsamples of ARI x (assigned in both / drawn), 0 when ARI is not evaluable; pre-specified"),
        ),
        (
            "tail_fraction",
            json!("exploratory fitted-null tail (1 + #null >= observed) / (1 + B), B = 99, resolution 0.01; ties count against the observation. The Gaussian (PCA eigenvalues and retained dimension) is estimated from the same data, so observed and simulated statistics are not exchangeable: this is not an exact Monte Carlo test and no type-I error level is guaranteed"),
        ),
        (
            "decision_rule",
            json!("tail_fraction > 0.05: compatible with the fitted Gaussian; threshold declared and not validated"),
        ),
        (
            "qualification_path",
            json!("parametric bootstrap re-estimating the PCA and the Gaussian in every simulated dataset, with the level of the resulting rule checked by simulation, before any calibrated claim"),
        ),
        (
            "decisional_scope",
            json!("simulated rows are independent: the test is decisional only when every resampling unit is one declared-independent row; with multi-row units it would erase within-unit dependence and is descriptive only"),
        ),
        (
            "description",
            json!("marginal tails (1 + #null >= observed) / (1 + B) and (1 + #null <= observed) / (1 + B), and the count of replicates dominating on cluster count, noise and statistic, are descriptive and not calibrated"),
        ),
        (
            "limitations",
            json!("exploratory comparison with one unimodal Gaussian only; it does not represent curved or branched manifolds, gradients, heavy tails or heteroscedastic continua"),
        ),
        ("backend_version", json!(backend)),
    ] {
        metric.parameters.insert(key.into(), value);
    }
    Ok((
        metric,
        NullSummary {
            tail_fraction,
            decisional: decisional_reason.is_none(),
            fraction_two_or_more: two_or_more,
        },
    ))
}

fn assess(
    report: &mut QualificationReport,
    source_id: &str,
    n: usize,
    observed: &Observed,
    units: Option<&Units>,
    variants: &[Option<Variant>],
    null_summary: Option<&NullSummary>,
) {
    let scaled = variants[0].as_ref();
    let constant = variants[1].as_ref();
    let criterion = |value: Option<f64>, threshold: f64, at_least: bool| {
        json!({
            "value": value,
            "threshold": threshold,
            "passed": value.map(|v| if at_least { v >= threshold } else { v <= threshold }),
        })
    };
    let criteria = json!({
        "independent_units_declared": {"value": units.map(|u| u.independent), "passed": units.map(|u| u.independent)},
        "median_ari_scaled": criterion(scaled.and_then(|v| v.stability.median_ari), STABLE_MEDIAN_ARI, true),
        "median_ari_constant": criterion(constant.and_then(|v| v.stability.median_ari), STABLE_MEDIAN_ARI, true),
        "lowest_appearance_frequency_scaled": criterion(scaled.and_then(|v| v.lowest_appearance), STABLE_APPEARANCE, true),
        "median_assigned_in_both_fraction_of_eligible_scaled": criterion(scaled.and_then(|v| v.stability.median_assigned_fraction), STABLE_ASSIGNED_FRACTION, true),
        "null_decisional": {"value": null_summary.map(|s| s.decisional), "passed": null_summary.map(|s| s.decisional)},
        "fitted_null_tail_fraction": criterion(null_summary.and_then(|s| s.tail_fraction), NULL_TAIL, false),
    });
    let passed = |key: &str| criteria[key]["passed"].as_bool();
    let assessment = if observed.clusters < 2 {
        "no_density_separated_groups"
    } else if passed("fitted_null_tail_fraction") == Some(false) {
        "compatible_with_fitted_gaussian"
    } else if criteria
        .as_object()
        .expect("object")
        .keys()
        .all(|k| passed(k) == Some(true))
    {
        "stable_candidate_versus_fitted_gaussian"
    } else {
        "uncertain_partition"
    };
    let mut metric = computed(
        "clustering.partition_assessment",
        json!({"assessment": assessment, "candidate_cluster_count": observed.clusters, "criteria": criteria}),
        source_id,
        n,
    );
    for (key, value) in [
        ("rule_version", json!("clustering_assessment.v3")),
        ("status", json!("exploratory_uncalibrated")),
        (
            "rule",
            json!("fewer than 2 clusters: no_density_separated_groups; else decisional fitted-null tail fraction > 0.05: compatible_with_fitted_gaussian; else every criterion passed: stable_candidate_versus_fitted_gaussian; otherwise uncertain_partition. The tail fraction compares with a Gaussian fitted to the same data and guarantees no type-I error level; thresholds are declared and not validated."),
        ),
        ("confidence", json!("unknown")),
        (
            "firm_cluster_count",
            json!("never stated: no calibrated rule supports a number of clusters"),
        ),
        (
            "not_compared",
            json!("native/canonical/supervised structures: only the canonical view is clustered; no supervised latent space exists in this alpha"),
        ),
    ] {
        metric.parameters.insert(key.into(), value);
    }
    report.metrics.push(metric);

    let evidence = vec![
        "clustering.partition".to_string(),
        "clustering.candidate_cluster_count".into(),
        "clustering.subsample_stability".into(),
        "clustering.subsample_stability_constant_parameters".into(),
        "clustering.cluster_appearance_frequency".into(),
        "clustering.gaussian_null_model".into(),
        "clustering.partition_assessment".into(),
    ];
    let clusters = observed.clusters;
    let null_two = null_summary.map_or("unavailable".to_string(), |s| {
        format!("{:.0} %", 100.0 * s.fraction_two_or_more)
    });
    let (rule_id, message, action) = match assessment {
        "no_density_separated_groups" => (
            "structure.clustering.continuous_structure.v3",
            format!("HDBSCAN found no density-separated groups in {source_id}; the data are compatible with a continuous structure (exploratory; Gaussian null replicates with at least two groups: {null_two})"),
            "Do not derive group-based splits from clustering; inspect PCA scores and metadata",
        ),
        "compatible_with_fitted_gaussian" => (
            "structure.clustering.continuous_structure.v3",
            format!("HDBSCAN proposes {clusters} candidate groups in {source_id}, but a unimodal Gaussian fitted to the same data, run through the same frozen-projection protocol, gives a coverage-weighted stability at least as high in more than 5 % of replicates; the data are compatible with this continuous model (exploratory fitted-null tail, no type-I error guarantee; replicates with at least two groups: {null_two})"),
            "Do not derive group-based splits from clustering; inspect PCA scores and metadata",
        ),
        "stable_candidate_versus_fitted_gaussian" => (
            "structure.clustering.stable_candidate_partition.v2",
            format!("HDBSCAN proposes {clusters} candidate groups in {source_id} that pass the exploratory stability and appearance rules and are more stable than a Gaussian fitted to the same data in at least 95 % of replicates (exploratory fitted-null tail, no type-I error guarantee); this number of groups is not confirmed because the rules are not calibrated"),
            "Treat the candidate groups as hypotheses to check against metadata and chemistry before any use in validation splits",
        ),
        _ => (
            "structure.clustering.uncertain_partition.v3",
            format!("HDBSCAN proposes {clusters} candidate groups in {source_id} with {:.0} % of samples as noise; the partition is uncertain because the exploratory stability, appearance or fitted-Gaussian comparison rules are not all met", 100.0 * observed.noise_fraction),
            "Treat candidate groups as hypotheses; check subsample stability and metadata before using them",
        ),
    };
    report.findings.push(Finding {
        rule_id: rule_id.into(),
        severity: "info".into(),
        confidence: "unknown".into(),
        evidence,
        message,
        action: action.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review 2026-10-13: the residual cross-host risk of the score grid is a
    /// value within one ulp of a grid midpoint. This pins the outcome: one ulp
    /// below a midpoint rounds down, the midpoint and one ulp above round up
    /// (half away from zero, symmetric in sign), so a one-ulp host difference
    /// there moves the score by exactly one grid step (2^-24 of the scale
    /// exponent). One ulp away from any other point leaves it unchanged.
    /// Robustness rule: the grid follows the exponent of max|score|, so
    /// scaling the scores by 2^k scales the rounded scores by exactly 2^k
    /// while the step stays normal, and leaves them unchanged otherwise.
    #[test]
    fn grid_is_scale_equivariant() {
        let base = vec![vec![1.5, -0.3, 0.123_456_789], vec![-1.25, 0.7, 1e-9]];
        let q0 = quantize(&base);
        for k in [-1074 + 60, -1022, -500, -100, 100, 500, 1000] {
            let scaled: Vec<Vec<f64>> = base
                .iter()
                .map(|r| r.iter().map(|v| v * 2f64.powi(k)).collect())
                .collect();
            let q = quantize(&scaled);
            let step_exponent = 1 + k - SCORE_GRID_BITS;
            for (row, row0) in q.iter().zip(&q0) {
                for (v, v0) in row.iter().zip(row0) {
                    if step_exponent >= -1022 {
                        assert_eq!(*v, v0 * 2f64.powi(k), "k={k}");
                    }
                }
            }
            if step_exponent < -1022 {
                assert_eq!(
                    q, scaled,
                    "k={k}: below the normal range the scores are kept"
                );
            }
        }
    }

    #[test]
    fn grid_rounding_at_one_ulp_of_a_midpoint() {
        // max|score| = 1.5 lies in [2^0, 2^1): e = 1, step = 2^-23.
        let step = pow2(1 - SCORE_GRID_BITS);
        let up = |v: f64| f64::from_bits(v.to_bits() + 1);
        let down = |v: f64| f64::from_bits(v.to_bits() - 1);
        let mid = 1000.5 * step;
        let off = 1000.3 * step;
        let row = vec![
            1.5,
            mid,
            down(mid),
            up(mid),
            -mid,
            -down(mid),
            -up(mid),
            down(off),
            up(off),
        ];
        let q = quantize(&[row]);
        assert_eq!(q[0][0], 1.5);
        assert_eq!(q[0][1], 1001.0 * step);
        assert_eq!(q[0][2], 1000.0 * step);
        assert_eq!(q[0][3], 1001.0 * step);
        assert_eq!(q[0][4], -1001.0 * step);
        assert_eq!(q[0][5], -1000.0 * step);
        assert_eq!(q[0][6], -1001.0 * step);
        assert_eq!(q[0][7], 1000.0 * step);
        assert_eq!(q[0][8], 1000.0 * step);
        // The step follows the exponent of max|score|: doubling the scale by
        // one ulp across a power of two doubles the step.
        let q = quantize(&[vec![2.0, mid]]);
        assert_eq!(pow2(2 - SCORE_GRID_BITS), 2.0 * step);
        assert_eq!(q[0][1], 500.0 * pow2(2 - SCORE_GRID_BITS));
        let q = quantize(&[vec![down(2.0), mid]]);
        assert_eq!(q[0][1], 1001.0 * step);
    }
}
