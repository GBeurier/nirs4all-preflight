// SPDX-License-Identifier: CECILL-2.1 OR AGPL-3.0-or-later
// Host transport only: Rust owns protocols; Methods owns numeric kernels.
import init, * as rust from './native/nirs4all_preflight_wasm.js';
import * as methods from '@nirs4all/methods';

function matrix(rows) {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  if (!n || !p || n * p > 10_000_000 || rows.some(row => row.length !== p)) {
    throw new RangeError('PROVIDER_MATRIX_BUDGET_OR_SHAPE');
  }
  return { data: Float64Array.from(rows.flat()), rows: n, cols: p };
}
function nested(values, width) {
  const rows = [];
  for (let i = 0; i < values.length; i += width) rows.push(Array.from(values.slice(i, i + width)));
  return rows;
}
const nullable = value => Number.isFinite(value) ? value : null;

/** Create in a worker; the host cancels by terminating that worker. */
export async function createQualificationRuntime(options = {}) {
  await init(options.wasmModule ? { module_or_path: options.wasmModule } : undefined);
  await methods.loadModule();
  const abi = methods.abiVersion();
  if (abi[0] !== 2 || abi[1] < 20) throw new Error('METHODS_ABI_2_20_REQUIRED');
  const backend_version = methods.version();
  const methodsCapabilities = ['pca', 'repeatability', 'summary', 'nearest_neighbors', 'local_contrast', 'hdbscan', 'adjusted_rand_index', 'snv', 'noise_proxy', 'tolerance_pairs', 'association', 'holm_adjust'].map(id => ({
    capability_id: `methods.${id}`, available: true, qualified: false,
    reason: `${backend_version}; alpha protocol`,
  }));
  const callback = (operation, payload) => {
    const request = JSON.parse(payload);
    let result;
    switch (operation) {
      case 'capabilities': result = methodsCapabilities; break;
      case 'pca': {
        const output = methods.preflightPca(matrix(request.matrix), request.n_components);
        result = { eigenvalues: Array.from(output.eigenvalues), scores: nested(output.scores.data, output.scores.cols), full_moments: output.fullMoments, resolution: output.resolution, unresolved: Array.from(output.unresolved, Boolean), backend_version };
        break;
      }
      case 'repeatability': {
        const output = methods.preflightRepeatability(matrix(request.matrix), request.group_ids, Uint8Array.from(request.valid_mask.flat(), Boolean));
        result = { pooled_sd: Array.from(output.pooledSd, nullable), icc: Array.from(output.icc, nullable), n_complete_groups: output.nCompleteGroups, band_status: Array.from(output.bandStatus), backend_version };
        break;
      }
      case 'summary': {
        if (!request.values.length || request.values.length > 10_000_000) throw new RangeError('SUMMARY_WORK_BUDGET');
        const output = methods.preflightSummary(Float64Array.from(request.values));
        result = { count: output[0], min: output[1], max: output[2], mean: output[3], sample_sd: nullable(output[4]), q25: output[5], median: output[6], q75: output[7], backend_version };
        break;
      }
      case 'nearest_neighbors': {
        const query = matrix(request.query), reference = matrix(request.reference);
        if (query.rows * reference.rows * query.cols > 250_000_000 || request.k > 100) throw new RangeError('KNN_WORK_BUDGET');
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
        if (x.rows * x.rows * x.cols > 2.5e9) throw new RangeError('HDBSCAN_WORK_BUDGET');
        const output = methods.clusterHdbscan(x, { minClusterSize: request.min_cluster_size, minSamples: request.min_samples, selection: request.selection, allowSingleCluster: request.allow_single_cluster });
        const tree = output.tree.map(node => ({
          parent: node.parent < 0 ? null : node.parent, size: node.size, label: node.label < 0 ? null : node.label,
          birth_distance: node.parent < 0 ? null : 1 / node.lambdaBirth, death_distance: 1 / node.lambdaDeath, stability: nullable(node.stability),
        }));
        result = { labels: output.labels, membership: Array.from(output.membership), outlier_scores: Array.from(output.outlierScores, nullable), persistence: Array.from(output.persistence), tree, backend_version };
        break;
      }
      case 'adjusted_rand_index': {
        if (request.labels_a.length > 10_000_000) throw new RangeError('ARI_WORK_BUDGET');
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
        if (work * query.cols > 250_000_000 || request.max_pairs > 1_000_000) throw new RangeError('TOLERANCE_PAIRS_WORK_BUDGET');
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
      case 'holm_adjust': {
        result = { adjusted: Array.from(methods.preflightHolmAdjust(Float64Array.from(request.p_values))), backend_version };
        break;
      }
      default: throw new Error(`METHODS_OPERATION_UNSUPPORTED: ${operation}`);
    }
    return JSON.stringify(result);
  };
  return {
    analyze: input => JSON.parse(rust.analyze_json(JSON.stringify(input), callback)),
    validate: input => JSON.parse(rust.validate_json(JSON.stringify(input))),
    reportHtml: report => rust.report_html_json(JSON.stringify(report)),
    capabilities: () => JSON.parse(rust.capabilities_json(callback)),
  };
}
