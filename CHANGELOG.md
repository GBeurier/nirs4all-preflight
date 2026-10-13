# Changelog

## Unreleased

Requires Methods ABI 2.20 (`n4m_cluster_jaccard_matrix`, `n4m_linear_sum_assignment`, `n4m_random_permutations`, `n4m_random_multivariate_normal`, and the HDBSCAN out-of-bounds fix). Clustering protocol `clustering.v2`, exploratory and unqualified.

- Cluster appearance frequency (`clustering.cluster_appearance_frequency` and `_constant_parameters`, `cluster_matching.v1`): Jaccard on drawn identities, one-to-one maximum-Jaccard assignment with the SciPy tie order, appearance when the matched Jaccard is above 0.5, per-cluster evaluable/appearance counts and matched-Jaccard and drawn-member summaries.
- Unimodal Gaussian null model (`clustering.gaussian_null_model`): covariance `diag(λ) + 1e-6 mean(λ) I` in the canonical PCA space, 99 seeded replicates through the identical protocol (PCA, score grid, HDBSCAN, stability on the same plans), null distributions of cluster count, noise fraction and median ARI, marginal and joint-dominance tail fractions, declared limitations.
- `clustering.partition_assessment` (`clustering_assessment.v1`): published criteria and thresholds deciding `no_density_separated_groups`, `compatible_with_continuous_structure`, `stable_candidate_partition` or `uncertain_partition`. Findings become `structure.clustering.continuous_structure.v2`, `structure.clustering.uncertain_partition.v2` and the new `structure.clustering.stable_candidate_partition.v1`, all with confidence `unknown`; none states a firm number of clusters.
- Fixes from the 2026-10-13 review: (P0) `reference_group` and `unknown` independence units no longer fall back to independent rows. Reference groups come from identities over all targets (`MISSING_REFERENCE_GROUP`, `AMBIGUOUS_REFERENCE_GROUP`), and `unknown` is labelled a descriptive sensitivity (`independent_unit_resampling = false`). The reason `FEWER_THAN_FIVE_INDEPENDENT_UNITS` becomes `FEWER_THAN_FIVE_RESAMPLING_UNITS` and the denominator `n_independent_units` becomes `n_resampling_units`. (P0) Stability publishes per-subsample intersection and assigned-in-both sizes with each ARI; `compared_fraction` is replaced by explicit fractions of eligible samples and of the intersection, summarized over the ARI-evaluable subsamples. (P0) Score matrices are rounded to a `2^(e−24)` binary grid before HDBSCAN, so native and WASM partitions agree on the tie-heavy review case. (P1) Subsampling plans come from Methods PCG64 (`default_rng(seed).permutation(U)`) with a documented seed derivation, replacing the Rust SplitMix64 shuffle; the 50 unit plans are published.
- Full-chain golden `crates/nirs4all-preflight/tests/fixtures/clustering_v2_golden.json` (generator `scripts/generate_clustering_golden.py`, NumPy 2.4.6, SciPy 1.18.1, scikit-learn 1.9.1), checked by the native and WASM tests.
- Native, canonical and supervised structures are not compared yet: only the canonical view is clustered and no supervised latent space exists.

## 0.1.0-alpha.3 — 2026-10-13

Engine, crates, Python and npm binding move together to 0.1.0-alpha.3 and require Methods 1.3.6 (ABI 2.19). All new capabilities are exploratory and unqualified.

- Clustering capability (PF-05, exploratory, unqualified). Methods ABI 2.19
  `n4m_cluster_hdbscan` runs on the same eligible samples and canonical
  PCA scores as `structure.*`. It reports per-sample labels, membership
  strengths and GLOSH scores, candidate cluster count, noise fraction,
  per-cluster persistence and the condensed tree. Stability uses 50 seeded
  subsamples without replacement of 80 % of independent units. Each subsample
  repeats centering, PCA and HDBSCAN, with scaled and constant parameters. It
  reports ARI (Methods `n4m_preflight_adjusted_rand_index`) on samples
  assigned in both partitions, assigned/noise agreement, intersection size,
  compared fraction, cluster counts and noise fractions, summarized by Methods.
  Cluster appearance frequency (matching not qualified) and the Gaussian null
  model are reported as unavailable. Findings never state a firm number of
  clusters. The native and WASM providers require Methods ABI 2.19.

- `noise_proxy`, `snv_sensitivity` and `quasi_duplicates` change from `PROTOCOL_NOT_IMPLEMENTED` to available but unqualified (exploratory). New metrics: `measurement.noise_proxy`, `measurement.noise_proxy_pooled`, `structure.snv_pca_eigenvalues`, `structure.snv_effective_dimension`, `structure.snv_sensitivity`, `integrity.quasi_duplicate_pairs` and `integrity.cross_partition_quasi_duplicate_pairs`. New optional inputs: `options.noise_proxy`, `options.snv_sensitivity` and `options.quasi_duplicates` (the tolerance has no default). Requires Methods ABI 2.19 (`n4m_preflight_noise_proxy_compute`, `n4m_preflight_pairs_within_tolerance`) and the existing Methods SNV transform. Input schema version 1 gains only optional fields.

- Metadata–target associations become available but unqualified (`metadata_association_tests`). New metrics: `association.metadata_target` (eta² or Cramér V, ANOVA F or χ², per-level Y coverage), `association.metadata_target_test` (permutation p-value, Holm-adjusted p-value and a versioned `PermutationPlan`), and `association.metadata_target_family` (Holm family). The new input option `exchangeable_units` declares unit exchangeability; without it, tests are `not_identifiable`. Requires Methods ABI 2.19. The example `examples/metadata_association.json` exercises the protocol.

## 0.1.0-alpha.1 — 2026-10-13

First executable exploratory release. Rust input/report contracts, identity checks, CLI, C ABI, thin Python and WASM bindings, reusable Methods diagnostics and shared UI qualification components. The GitHub Pages demo runs the real engines in a worker. JSON/HTML exports retain context, availability and synthetic origin. This release does not close the V1 roadmap or claim R/MATLAB qualification.

## npm binding 0.1.0-alpha.2 — 2026-10-13

Correct the npm archive to include generated WASM assets. The generated wasm-pack ignore file previously excluded them. Packaging now verifies the required files and overrides that ignore rule; a fresh isolated installation runs the actual engines. Rust engine/protocol/crate versions remain 0.1.0-alpha.1.
