# Changelog

## Unreleased

- Grouped validation probe (`validation_probe.v1`, PF-04, exploratory, unqualified). Nested grouped selection runs in DAG-ML (`dag_ml_core::execute_nested_selection`, next release after 0.3.41). PLS/PCR come from Methods through DAG-ML controllers: native role controllers on CPU, and `N4mWasmRegressionController` in the browser through dag-ml-wasm `execute_nested_selection_json`.
  - Preflight owns the population, the shared `independence_components`, the plan (outer `min(5, G)`, inner `min(3, outer − 1)`, and a grid bounded by bands, numerical rank and the smallest inner training pool), the fit budget, the refusals before any fit, and the statuses and findings.
  - Preflight re-verifies every returned fold, selection (minimum inner RMSE, ties to fewer components), fold-ID uniqueness, fit count and score, and refuses contradictions with `PROVIDER_*` reasons.
  - Methods kernels compute repeat aggregation (`n4m_stats_group_means`), fold-train means (`summary`) and every published score (`n4m_stats_regression_scores`). Domains stay structured `(instrument, campaign)` pairs.
  - DAG-ML errors keep their taxonomy code, are reported as `error`, and carry the fold and candidate in `provider_error_detail` (new optional `ProviderError::detail`).
  - Methods refusals outside the declared domain are `unsupported` with `NUMERICAL_DOMAIN_EXCEEDED` (`METHODS_DOMAIN_MESSAGE`).
- New API and options:
  - `ValidationProvider` (`ProbeRequest`, `ProbeResult`, `UnavailableValidationProvider`), `analyze_with_validation`, `capabilities_with_validation`;
  - `dagml::{nested_probe, probe_result, DagMlValidationProvider}`;
  - `MethodsProvider::group_means` and `MethodsProvider::regression_scores`, with capabilities `methods.group_means` and `methods.regression_scores`;
  - option `options.validation_probe` (`enabled`, `estimators`, `max_fits`).
- Metrics: `probe.plan`, `probe.folds`, `probe.oof_predictions`, `probe.rmse`, `probe.mae`, `probe.r2_oof`, `probe.skill_vs_train_mean`, `probe.train_mean_rmse`, `probe.train_mean_mae` and `probe.domain_scores`, all with `numerical_domain`. Finding: `probe.no_skill_over_train_mean.v1`.
- Capabilities: `validation_probe`, which requires a validation provider and the four Methods kernels and is no longer `PROTOCOL_NOT_IMPLEMENTED`; `validation.nested_grouped_probe`; and `validation_probe.classification`, unavailable with `CLASSIFICATION_PROBE_NOT_QUALIFIED`.
- The CLI (`--methods-library`), the C ABI and Python run the probe with `DagMlValidationProvider`. The npm package depends on `dag-ml-wasm` and accepts `dagMlWasmModule`.
- Until the dag-ml release, local builds use `cargo --config .cargo/dag-ml-local.toml` against a sibling `../dag-ml`.
- Example: `examples/validation_probe.json`.

Requires Methods ABI 2.20 (`n4m_stats_correlation_test`, `n4m_stats_bh_adjust`, `n4m_stats_factor_association_exact`, `n4m_stats_correlation_exact`); the native and WASM providers refuse older libraries (`METHODS_ABI_2_20_REQUIRED`). All capabilities stay exploratory and unqualified.

- Typed metadata in the input contract (schema version 1, optional fields only): `metadata.columns` (`name`, `kind` categorical/continuous, `unit`) and `metadata.values` (`sample_id` → column → JSON string level or JSON number, `null` = missing), validated at the boundary (`INVALID_METADATA_COLUMN`, `UNKNOWN_METADATA_COLUMN`, `METADATA_TYPE_MISMATCH`, `INVALID_METADATA_VALUE`, `UNKNOWN_SAMPLE`; warnings `UNKNOWN_METADATA_UNIT`, `METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT`). Accessors `QualificationInput::metadata_factors()` and `metadata_value()` expose instrument, campaign and declared columns; `independence_components()` exposes the identity components.
- `metadata_association_tests` covers continuous metadata: Spearman's rho with Pearson's r descriptive against continuous targets, eta²/F of the metadata across classes of categorical targets, with the same permutation machinery and Holm family. New parameters `metadata_kind`, `metadata_origin`, `metadata_unit`, `association_type`; new reason codes `CONSTANT_METADATA_VALUE` and `SATURATED_DESIGN`.
- Exploratory Benjamini–Hochberg view (`p_value_bh_exploratory`, family `exploratory_secondary`), never used for findings.
- Review fixes: units are built from every identity and reference link before exclusions, so the order of references no longer changes the units; retained-test Y is no longer inspected by validation (the report is invariant to it); `options.seed` accepts a canonical decimal string (and is serialized as one), the WASM wrapper converts bigint seeds and refuses unsafe numbers; the permutation plan separates the Monte Carlo step, the combinatorial bound and the exact minimal p-value of enumerated spaces (`monte_carlo_step`, `n_enumerated_arrangements`, `exact_minimum_p_value`, `resolution_basis`); structural non-identifiability is reported before `SINGLE_METADATA_LEVEL`; executed permutations are kept when Holm is unavailable (`multiplicity_available = false`, family `holm_available`). Methods fixes the translation instability of eta²/F.
- Second review fixes: retained-test `value`/`category` are dropped unread at parse time whatever their JSON type (invariance tested through the CLI, the C ABI and WASM); partition leakage is checked on whole linked components (identity links, declared independence groups, reference groups, prediction rows as bridges); Methods refuses oversized categorical association tables before allocation.
- Third review fixes: retained-test target content is kept as unparsed JSON text (`RawValue`), so tokens such as `1e400` are never decoded (textual fixtures through the CLI, the C ABI and the new WASM `analyzeJson`/`validateJson`); identity components and local-contrast groups use structured keys (`IdentityKey`), removing false `REFERENCE_LEAKAGE` from identifiers containing separators; association metrics declare their `numerical_domain`, with CPU and WASM magnitude sweeps from 2^-1060 to 2^1000 and translations by 1e300.
- `examples/metadata_association.json` declares `site` and `temperature` (degC).
- Confounding becomes available but unqualified (PF-06 first half, exploratory). Requires Methods ABI 2.20 (`n4m_stats_permanova`, `n4m_stats_permdisp`). On the canonical PCA scores of `structure.*`, aggregated per independence unit, it reports `confounding.design` (levels, crossings, nominal and identifiable df given the other factors, aliasing), `confounding.variance_partition` (marginal, unique and all-cell R², never summed), `confounding.dispersion` (PERMDISP), and permutation tests `confounding.permanova_marginal_test` (free), `confounding.permanova_conditional_test` (within the other factors' cells) and `confounding.permdisp_test` with `permutation_plan.v1` and per-source Holm families; draws count `F_perm >= F_obs − sqrt(eps)` as vegan. Units are the shared `independence_components`, projected onto the structure rows; factors come from `metadata_factors()`. Aliased factors are `not_identifiable` (`FACTOR_ALIASED_WITH_OTHER_FACTORS`); unit `reference_group` without a resolved reference group is `not_identifiable` (`REFERENCE_GROUP_UNRESOLVED`). New findings: `confounding.aliased_factors.v1`, `confounding.marginal_structure.v1`, `confounding.conditional_structure.v1`, `confounding.dispersion_heterogeneity.v1`, all with confidence `unknown`. The permutation plan gains the `within_blocks` restriction; seed derivation is shared through `derive_seed`. Example: `examples/confounding.json`.
- `confounding.permanova_freedman_lane_test`: partial PERMANOVA of each factor given the additive main effects of the other factors, by Freedman–Lane permutation of the reduced-model residuals (Methods `n4m_stats_permanova_freedman_lane`), next to the within-cells test whose null also excludes interactions. The plan carries `reduced_model`; saturated reduced models (`REDUCED_MODEL_SATURATED`), aliased factors and designs without residual df (`SATURATED_DESIGN`, also for the other PERMANOVA tests) are `not_identifiable`. New finding `confounding.main_effect_structure.v1`. The within-cells plan no longer fills `reduced_model`.
- Confounding robustness: the design separates `aliased_with_other_factor_cells` (relative to the cells of the other factors, interactions included) from `identifiable_under_additive_model`; a factor aliased only by cells gives the info finding `confounding.aliased_with_other_cells.v1`, and `confounding.aliased_factors.v1` now means neither model separates it. Unit coordinates are running means. Metrics carry `numerical_domain`; Methods kernels compute explicit residual sums of squares, choose scales from centred variation and fail explicitly on unrepresentable values. Requires the Methods robustness commit.
- Provider errors are structured (`ProviderError { kind, reason }`, kinds `unsupported`, `numerical`, `internal`). Only absent capabilities and declared limits are reported `unsupported`; numerical and internal provider failures are now `error`, with stable `METHODS_<STATUS>` reasons identical in the native and WASM adapters (previously every failure was `unsupported`, with `METHODS_STATUS_<n>` natively and `METHODS_CALLBACK_FAILED` in WASM). The WASM callback replies `{ok}` or `{provider_error}`.

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
