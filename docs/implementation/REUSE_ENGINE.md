# Engine reuse and current alpha boundary

The preflight Rust engine owns input validation, population selection, source and context separation, protocol orchestration, report status, and finding rules. It does not reimplement generic numerical methods.

| Capability | Owner | Alpha integration |
| --- | --- | --- |
| File parsing and joins | `nirs4all-formats` and `nirs4all-io` | Caller supplies aligned typed input. |
| PCA eigenvalues, scores and full spectral moments | `nirs4all-methods` | `MethodsProvider::pca`; exact full moments permit effective dimension with truncated scores. |
| Pooled repeatability and balanced ICC(1,1) | `nirs4all-methods` | `MethodsProvider::repeatability` on homogeneous technical contexts. Per-band mask and status retained. |
| Quantiles and descriptive numerical summary | `nirs4all-methods` | `MethodsProvider::summary`. |
| Independent nearest neighbors in PCA score space | `nirs4all-methods` | `MethodsProvider::nearest_neighbors`, excluding the declared independence group. |
| Global local X–Y contrast | `nirs4all-methods` | `MethodsProvider::local_contrast` receives exact targets, admissible neighbor indices and linked group IDs; Preflight owns eligibility and statuses. |
| HDBSCAN partition, membership, GLOSH, persistence, condensed tree | `nirs4all-methods` | `MethodsProvider::hdbscan` on the canonical PCA scores; Preflight owns eligibility, parameter policy, subsampling plan and findings. |
| Adjusted Rand index | `nirs4all-methods` | `MethodsProvider::adjusted_rand_index` on samples assigned in both partitions. |
| Cross-validation, preprocessing selection and OOF | `dag-ml` | Unavailable until a qualified validation provider can execute a complete probe. Preflight has no second CV loop. |
| Aggregate package facades | `nirs4all-core` | Separate upstream integration; this crate carries the implementation. |

The explicit `UnavailableMethodsProvider` lets callers validate and inspect population/target coverage without implying that unavailable numerical diagnostics were computed. Every unavailable metric has a status, reason, and null value. The report is marked `exploratory`; alpha thresholds have not been qualified. The CLI uses this provider unless a Methods library is selected by `--methods-library` or `N4M_LIBRARY_PATH`.

For structure, observations from the same physical object are averaged only inside one source, instrument and campaign when every repeated acquisition has a declared technical repetition type. Physical objects occurring in multiple contexts, or under multiple sample IDs, are excluded from this single-context PCA profile with counts reported. Unknown or biological repeat types remain excluded from PCA aggregation with counts reported; single observations remain eligible. Rows with masked bands are excluded from complete-case PCA and counted. Retained-test and augmented samples are excluded. Technical repeatability is computed separately for each repetition type, instrument and campaign. No silent imputation, interpolation, source concatenation or reference reconciliation occurs.

Identity linkage is validated before any Methods call, including transitive physical aliases, shared individuals and augmentation parents. Reference groups spanning development and retained-test populations are rejected. The current validator does not verify external fold plans because the DAG validation provider is not connected; that capability stays unavailable.

The alpha integrity pass counts exact spectral pairs spanning declared physical samples after normalizing negative zero and honoring masks. It separately counts exact pairs across real development and retained-test observations under different physical IDs, with affected-observation denominators. This integrity check reads retained-test X only; it does not fit on test rows or inspect retained-test Y. Findings remain suspicions with unknown confidence. Quasi-duplicate distances and a calibrated repetition detection threshold are not yet available; exact matches never rewrite sample identity automatically.

The JSON input and report schemas are version 1. Internal Methods adapter contracts are Rust structs in `nirs4all-preflight-core/src/lib.rs`; host adapters must validate native shapes, finite numbers, and ABI versions before returning values. C API, WASM and language bindings must call this same engine, never duplicate the protocol.

PCA reports scores with actual representative declared sample IDs and separate aggregation keys inline up to 100,000 score cells, full variance moments, and retained explained-variance fraction. The inline limit is an explicit alpha report budget; a future asset transport is needed for larger score tables. A zero-rank source has undefined PCA geometry and local contrast. Input and report carry an optional `data_origin` label, including `synthetic` for demonstrations. The HTML export prints audit context and summarizes large arrays; JSON remains the complete scientific record.

Clustering (PF-05, exploratory, unqualified) uses the same eligible aggregated samples and canonical PCA scores as `structure.*`, in their canonical BTreeMap order. HDBSCAN results depend on row order and tie order, so that order is part of the protocol. The policy is frozen as follows:

- Parameters: `min_cluster_size = min_samples = max(5, ceil(n/20))`, where `min_samples` includes the sample itself, with EOM selection and `allow_single_cluster = false`. Fewer than `2 × min_cluster_size` eligible samples gives `FEWER_THAN_TWO_MIN_CLUSTER_SIZES`.
- Subsampling: 50 seeded subsamples without replacement of `ceil(0.8 × U)` independent units. A unit is the eligible physical sample, or the declared `independence_group` when `independence_unit = group`; a missing group gives `MISSING_INDEPENDENCE_GROUP`. The RNG is SplitMix64 seeded with `seed xor fnv1a64(source_id)`, followed by a partial Fisher–Yates shuffle.
- Refit: each subsample repeats centering, PCA (`min(10, m-2, p)` components) and HDBSCAN on the aggregated spectra. It does this twice: with `ceil(0.8 × parameter)` (floors 2 and 1), and with the constant full-sample parameters as a sensitivity variant.
- Comparison: on common sample identities against the full partition. ARI is computed only on samples assigned in both partitions, when at least 10 such samples exist and both partitions have two clusters there. Methods summarizes the distributions of ARI, assigned/noise agreement, cluster count, noise fraction, intersection size and compared fraction.
- Budget: work above `50 × n² × (p + 20) = 2.5e10` gives `STABILITY_WORK_BUDGET_EXCEEDED`.

Two protocol parts are not delivered yet and are reported as unavailable: cluster appearance frequency (`CLUSTER_MATCHING_NOT_QUALIFIED`) and the Gaussian null model (`NULL_MODEL_NOT_IMPLEMENTED`). Findings are `structure.clustering.uncertain_partition.v1` or `structure.clustering.continuous_structure.v1`, both with confidence `unknown`. They never state a firm number of clusters, and membership is labelled as a relative strength, not a probability. On a 60-sample three-blob input, native and WASM gave identical labels, counts and denominators, with numeric values within 1.3e-15 relative. Because HDBSCAN breaks exact ties, last-ulp PCA differences between hosts could still flip a near-tie on other data, so cross-host partition parity is not claimed beyond such checks.
