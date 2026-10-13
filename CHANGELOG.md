# Changelog

## Unreleased

- `noise_proxy`, `snv_sensitivity` and `quasi_duplicates` change from `PROTOCOL_NOT_IMPLEMENTED` to available but unqualified (exploratory). New metrics: `measurement.noise_proxy`, `measurement.noise_proxy_pooled`, `structure.snv_pca_eigenvalues`, `structure.snv_effective_dimension`, `structure.snv_sensitivity`, `integrity.quasi_duplicate_pairs` and `integrity.cross_partition_quasi_duplicate_pairs`. New optional inputs: `options.noise_proxy`, `options.snv_sensitivity` and `options.quasi_duplicates` (the tolerance has no default). Requires Methods ABI 2.19 (`n4m_preflight_noise_proxy_compute`, `n4m_preflight_pairs_within_tolerance`) and the existing Methods SNV transform. Input schema version 1 gains only optional fields.

## 0.1.0-alpha.1 — 2026-10-13

First executable exploratory release. Rust input/report contracts, identity checks, CLI, C ABI, thin Python and WASM bindings, reusable Methods diagnostics and shared UI qualification components. The GitHub Pages demo runs the real engines in a worker. JSON/HTML exports retain context, availability and synthetic origin. This release does not close the V1 roadmap or claim R/MATLAB qualification.

## npm binding 0.1.0-alpha.2 — 2026-10-13

Correct the npm archive to include generated WASM assets. The generated wasm-pack ignore file previously excluded them. Packaging now verifies the required files and overrides that ignore rule; a fresh isolated installation runs the actual engines. Rust engine/protocol/crate versions remain 0.1.0-alpha.1.
