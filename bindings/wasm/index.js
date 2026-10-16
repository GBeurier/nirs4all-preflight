// SPDX-License-Identifier: CECILL-2.1 OR AGPL-3.0-or-later
// Host transport only: Rust owns protocols; Methods owns numeric kernels.
import init, * as rust from './native/nirs4all_preflight_wasm.js';
import * as methods from '@nirs4all/methods';

/** Adapter refusals carry the provider error kind and the same stable
 * reason as the native adapter: `unsupported` for a declared limit,
 * `internal` for a request that breaks the provider contract. */
const limit = reason => Object.assign(new RangeError(reason), { providerKind: 'unsupported' });
const invalid = reason => Object.assign(new TypeError(reason), { providerKind: 'internal' });

/** Methods exceptions keep their status, mapped to kind and reason by the
 * Rust engine exactly as the native adapter maps n4m_status_t. */
function providerError(error) {
  // A Methods refusal of the supported numerical domain keeps its reason.
  if (error instanceof methods.N4mError && error.status === 10 && String(error.message).includes('input outside the supported numerical domain')) {
    return { kind: 'unsupported', reason: 'NUMERICAL_DOMAIN_EXCEEDED' };
  }
  if (error instanceof methods.N4mError) return { methods_status: error.status };
  if (error?.providerKind) return { kind: error.providerKind, reason: error.message };
  return { kind: 'internal', reason: 'METHODS_CALLBACK_FAILED' };
}

function matrix(rows) {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  if (!n || !p || rows.some(row => row.length !== p)) throw invalid('INVALID_PROVIDER_MATRIX');
  if (n * p > 10_000_000) throw limit('PROVIDER_MEMORY_BUDGET_EXCEEDED');
  return { data: Float64Array.from(rows.flat()), rows: n, cols: p };
}
function nested(values, width) {
  const rows = [];
  for (let i = 0; i < values.length; i += width) rows.push(Array.from(values.slice(i, i + width)));
  return rows;
}
const nullable = value => Number.isFinite(value) ? value : null;

/** The u64 root seed travels as a decimal string: bigint and safe-integer
 * numbers are converted, unsafe numbers are refused (they are already
 * rounded), strings are validated by the Rust engine. */
function seedAsDecimal(input) {
  const seed = input?.options?.seed;
  if (seed === undefined || typeof seed === 'string') return input;
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) {
    throw new RangeError('SEED_NOT_SAFE_INTEGER: pass a bigint or a decimal string');
  }
  if (typeof seed !== 'number' && typeof seed !== 'bigint') throw new TypeError('SEED_TYPE');
  return { ...input, options: { ...input.options, seed: seed.toString() } };
}

/** Create in a worker; the host cancels by terminating that worker. */
export async function createQualificationRuntime(options = {}) {
  await init(options.wasmModule ? { module_or_path: options.wasmModule } : undefined);
  await methods.loadModule();
  const abi = methods.abiVersion();
  if (abi[0] !== 2 || abi[1] < 20) throw new Error('METHODS_ABI_2_20_REQUIRED');
  const backend_version = methods.version();
  const methodsCapabilities = ['pca', 'repeatability', 'summary', 'nearest_neighbors', 'local_contrast', 'hdbscan', 'adjusted_rand_index', 'snv', 'noise_proxy', 'tolerance_pairs', 'association', 'holm_adjust', 'correlation', 'bh_adjust', 'association_exact', 'correlation_exact', 'permanova', 'permdisp', 'permanova_freedman_lane', 'energy_distance', 'pca_monitor'].map(id => ({
    capability_id: `methods.${id}`, available: true, qualified: false,
    reason: `${backend_version}; alpha protocol`,
  }));
  const dispatch = (operation, payload) => {
    const request = JSON.parse(payload);
    let result;
    switch (operation) {
      case 'capabilities': result = methodsCapabilities; break;
      case 'pca': {
        const output = methods.preflightPca(matrix(request.matrix), request.n_components);
        result = { eigenvalues: Array.from(output.eigenvalues), scores: nested(output.scores.data, output.scores.cols), full_moments: output.fullMoments, backend_version };
        break;
      }
      case 'repeatability': {
        const output = methods.preflightRepeatability(matrix(request.matrix), request.group_ids, Uint8Array.from(request.valid_mask.flat(), Boolean));
        result = { pooled_sd: Array.from(output.pooledSd, nullable), icc: Array.from(output.icc, nullable), n_complete_groups: output.nCompleteGroups, band_status: Array.from(output.bandStatus), backend_version };
        break;
      }
      case 'summary': {
        if (!request.values.length || request.values.length > 10_000_000) throw invalid('INVALID_SUMMARY_VALUES');
        const output = methods.preflightSummary(Float64Array.from(request.values));
        result = { count: output[0], min: output[1], max: output[2], mean: output[3], sample_sd: nullable(output[4]), q25: output[5], median: output[6], q75: output[7], backend_version };
        break;
      }
      case 'nearest_neighbors': {
        const query = matrix(request.query), reference = matrix(request.reference);
        if (query.rows * reference.rows * query.cols > 250_000_000 || request.k > 100) throw limit('KNN_SHAPE_OR_WORK_BUDGET_EXCEEDED');
        const output = methods.preflightNearestNeighbors(query, reference, request.k, request.query_group_ids, request.reference_group_ids);
        result = { indices: nested(output.indices, output.k), distances: nested(Array.from(output.distances, nullable), output.k), backend_version };
        break;
      }
      case 'local_contrast': {
        const output = methods.preflightLocalContrast(Float64Array.from(request.targets), request.neighbor_indices.flat(), request.neighbor_indices[0]?.length ?? 0, request.categorical, request.group_ids);
        result = { contrast: nullable(output.contrast), fraction_rows_with_neighbors: output.fractionRowsWithNeighbors, observed_same_class_fraction: nullable(output.observedSameClassFraction), expected_same_class_fraction: nullable(output.expectedSameClassFraction), backend_version };
        break;
      }
      case 'hdbscan': {
        const x = matrix(request.matrix);
        if (x.rows * x.rows * x.cols > 2.5e9) throw limit('HDBSCAN_SHAPE_OR_WORK_BUDGET');
        const output = methods.clusterHdbscan(x, { minClusterSize: request.min_cluster_size, minSamples: request.min_samples, selection: request.selection, allowSingleCluster: request.allow_single_cluster });
        const tree = output.tree.map(node => ({
          parent: node.parent < 0 ? null : node.parent, size: node.size, label: node.label < 0 ? null : node.label,
          birth_distance: node.parent < 0 ? null : 1 / node.lambdaBirth, death_distance: 1 / node.lambdaDeath, stability: nullable(node.stability),
        }));
        result = { labels: output.labels, membership: Array.from(output.membership), outlier_scores: Array.from(output.outlierScores, nullable), persistence: Array.from(output.persistence), tree, backend_version };
        break;
      }
      case 'adjusted_rand_index': {
        if (request.labels_a.length > 10_000_000) throw limit('ARI_SHAPE_OR_WORK_BUDGET');
        result = { ari: nullable(methods.preflightAdjustedRandIndex(request.labels_a, request.labels_b)), backend_version };
        break;
      }
      case 'snv': {
        // Methods registry SNV: row mean and population SD (ddof 0).
        const x = matrix(request.matrix);
        const op = methods.ppCreate('StandardNormalVariate');
        try {
          result = { matrix: nested(methods.ppTransform(op, x.data, x.rows, x.cols), x.cols), backend_version };
        } finally {
          methods.ppDestroy(op);
        }
        break;
      }
      case 'noise_proxy': {
        const x = matrix(request.matrix);
        const output = methods.preflightNoiseProxy(x, request.window_length, request.polyorder, Uint8Array.from(request.valid_mask.flat(), Boolean));
        result = { band_noise: Array.from(output.bandNoise, nullable), band_counts: output.bandCounts, pooled: nullable(output.pooled), residual_gain: output.gain, backend_version };
        break;
      }
      case 'tolerance_pairs': {
        const query = matrix(request.query);
        const reference = request.reference ? matrix(request.reference) : undefined;
        const n = query.rows, work = reference ? n * reference.rows : n * (n - 1) / 2;
        if (work * query.cols > 250_000_000 || request.max_pairs > 1_000_000) throw limit('TOLERANCE_PAIRS_SHAPE_OR_WORK_BUDGET_EXCEEDED');
        const output = methods.preflightPairsWithinTolerance(query, request.tolerance, request.max_pairs, reference, request.query_group_ids, reference ? request.reference_group_ids : undefined);
        result = { pairs: nested(output.pairs, 2), distances: Array.from(output.distances), query_flags: Array.from(output.queryFlags, Boolean), reference_flags: Array.from(output.referenceFlags, Boolean), total_pairs: output.totalPairs, candidate_pairs: output.candidatePairs, backend_version };
        break;
      }
      case 'association': {
        // Seeds travel as decimal strings so no u64 is rounded by JSON.
        const output = methods.preflightFactorAssociation(request.factor_codes, Float64Array.from(request.targets), request.categorical, request.n_permutations, BigInt(request.seed));
        result = { effect_size: nullable(output.effectSize), statistic: nullable(output.statistic), df1: nullable(output.df1), df2: nullable(output.df2), n_levels: output.nLevels, n_target_values: output.nTargetValues, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'permanova': {
        const x = matrix(request.matrix);
        const output = methods.statsPermanova(x, request.term_codes, request.strata_codes ?? undefined, request.n_permutations, BigInt(request.seed));
        result = { ss_total: output.ssTotal, ss_strata: output.ssStrata, ss_term: output.ssTerm, ss_residual: output.ssResidual, r2: nullable(output.r2), partial_r2: nullable(output.partialR2), pseudo_f: nullable(output.pseudoF), df_term: output.dfTerm, df_residual: output.dfResidual, n_levels: output.nLevels, n_strata: output.nStrata, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'permanova_freedman_lane': {
        const x = matrix(request.matrix);
        const output = methods.statsPermanovaFreedmanLane(x, request.term_codes, request.condition_codes, request.n_permutations, BigInt(request.seed));
        result = { ss_total: output.ssTotal, ss_reduced: output.ssReduced, ss_term: output.ssTerm, ss_residual: output.ssResidual, r2: nullable(output.r2), partial_r2: nullable(output.partialR2), pseudo_f: nullable(output.pseudoF), df_term: output.dfTerm, df_residual: output.dfResidual, rank_reduced: output.rankReduced, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'permdisp': {
        const x = matrix(request.matrix);
        const output = methods.statsPermdisp(x, request.group_codes, request.n_permutations, BigInt(request.seed));
        result = { distances: Array.from(output.distances), group_mean_distances: Array.from(output.groupMeanDistances), f: nullable(output.f), df1: output.df1, df2: output.df2, n_groups: output.nGroups, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'energy_distance': {
        // Same budgets as the native adapter, before any WASM allocation.
        const n = request.matrix.length, g = request.n_groups;
        const pairs = n * (n - 1) / 2;
        if (pairs > 20_000_000 || g * g > 10_000_000 || pairs * ((request.matrix[0]?.length ?? 0) + request.n_permutations + 1) > 2.5e9) throw limit('ENERGY_DISTANCE_WORK_BUDGET');
        const output = methods.statsEnergyDistance(matrix(request.matrix), request.group_codes, g, request.n_permutations, BigInt(request.seed));
        result = { energy: nested(output.energy, g), energy_bounds: nested(output.energyBounds, g), mean_distances: nested(output.meanDistances, g), statistic: output.statistic, statistic_bound: output.statisticBound, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'pca_monitor': {
        const reference = matrix(request.reference), monitored = matrix(request.monitored);
        if ((reference.rows + monitored.rows) * reference.cols > 10_000_000) throw limit('PCA_MONITOR_WORK_BUDGET');
        const output = methods.statsPcaMonitor(reference, monitored, request.max_components, request.n_folds, request.alpha);
        const k = output.effectiveComponents;
        result = { effective_components: k, eigenvalues: Array.from(output.eigenvalues.slice(0, k)), reference_t2: Array.from(output.referenceT2, nullable), reference_q: Array.from(output.referenceQ), monitored_t2: Array.from(output.monitoredT2, nullable), monitored_q: Array.from(output.monitoredQ), t2_limit: nullable(output.t2Limit), q_limit: output.qLimit, t2_limit_interval: k > 0 ? output.t2LimitInterval : null, q_limit_interval: output.qLimitInterval, n_beyond_t2: output.nBeyondT2, n_beyond_q: output.nBeyondQ, n_beyond_either: output.nBeyondEither, n_undetermined_t2: output.nUndeterminedT2, n_undetermined_q: output.nUndeterminedQ, n_undetermined_either: output.nUndeterminedEither, reference_total_variance: output.referenceTotalVariance, monitored_total_variance: nullable(output.monitoredTotalVariance), centroid_distance: output.centroidDistance, centroid_subspace_distance: output.centroidSubspaceDistance, centroid_residual_distance: output.centroidResidualDistance, centroid_t2: nullable(output.centroidT2), retained_fraction: nullable(output.retainedFraction), backend_version };
        break;
      }
      case 'holm_adjust': {
        result = { adjusted: Array.from(methods.preflightHolmAdjust(Float64Array.from(request.p_values))), backend_version };
        break;
      }
      case 'correlation': {
        const output = methods.statsCorrelationTest(Float64Array.from(request.x), Float64Array.from(request.y), request.method, request.n_permutations, BigInt(request.seed));
        result = { coefficient: nullable(output.coefficient), n_distinct_x: output.nDistinctX, n_distinct_y: output.nDistinctY, log10_distinct_permutations: output.log10DistinctPermutations, p_value: nullable(output.pValue), n_at_least_observed: output.nAtLeastObserved, n_permutations_executed: output.nPermutationsExecuted, backend_version };
        break;
      }
      case 'association_exact': {
        const output = methods.statsFactorAssociationExact(request.factor_codes, Float64Array.from(request.targets), request.categorical, request.max_arrangements);
        result = { n_arrangements: output.nArrangements, p_value: nullable(output.pValue), minimum_p_value: nullable(output.minimumPValue), maximum_statistic: nullable(output.maximumStatistic), backend_version };
        break;
      }
      case 'correlation_exact': {
        const output = methods.statsCorrelationExact(Float64Array.from(request.x), Float64Array.from(request.y), request.method, request.max_arrangements);
        result = { n_arrangements: output.nArrangements, p_value: nullable(output.pValue), minimum_p_value: nullable(output.minimumPValue), maximum_statistic: nullable(output.maximumStatistic), backend_version };
        break;
      }
      case 'bh_adjust': {
        result = { adjusted: Array.from(methods.statsBhAdjust(Float64Array.from(request.p_values))), backend_version };
        break;
      }
      default: throw limit('METHODS_OPERATION_UNSUPPORTED');
    }
    return result;
  };
  const callback = (operation, payload) => {
    try {
      return JSON.stringify({ ok: dispatch(operation, payload) });
    } catch (error) {
      return JSON.stringify({ provider_error: providerError(error) });
    }
  };
  return {
    analyze: input => JSON.parse(rust.analyze_json(JSON.stringify(seedAsDecimal(input)), callback)),
    validate: input => JSON.parse(rust.validate_json(JSON.stringify(seedAsDecimal(input)))),
    // JSON-text entry points: the text reaches the Rust parser unchanged, so
    // nothing is rounded or decoded by JavaScript (u64 seeds, reserved Y).
    analyzeJson: text => rust.analyze_json(text, callback),
    validateJson: text => rust.validate_json(text),
    reportHtml: report => rust.report_html_json(JSON.stringify(report)),
    capabilities: () => JSON.parse(rust.capabilities_json(callback)),
  };
}
