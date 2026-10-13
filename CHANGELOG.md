# Changelog

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
