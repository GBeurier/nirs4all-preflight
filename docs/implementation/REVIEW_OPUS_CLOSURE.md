# Opus 5.5 targeted closure review

13 October 2026. Read-only review of the release corrections after the full executed implementation review.

**Closure verdict: no unresolved critical or high findings in the alpha.2 corrections.** This was a targeted check of those corrections, not a V1 qualification.

What I checked:
- **B1 (high) fixed.** `crates/nirs4all-preflight/src/lib.rs:305-358` hashes retained-test X against development X. It only counts pairs whose physical IDs differ. It publishes `integrity.cross_partition_exact_duplicate_pairs` with affected-row counts and a note that test access is X only, no fit, no Y. A non-zero count raises a high finding, `identity.possible_cross_partition_duplicate.v1`.
- **B2 fixed.** The HTML export (`lib.rs:1358-1400`) now shows schema, engine and protocol versions and the data origin, uses wire-format status names, and prints scope, population, view, unit, denominators and parameters. Tables have `<caption>` and `scope`, and findings show severity and confidence.
- **B3 fixed.** `pca_scores.sample_ids` now holds one real `sample_id` per unit, and the composite keys moved to `aggregation_keys` (`lib.rs:534`). The UI label `pcaUnitId` ("Sample (sample_id)") matches.
- **B4 fixed.** `DataOrigin` in core (`unknown` by default, or `synthetic` / `user_provided`) is carried into the report and the HTML. On the frontend, `input.ts:62,137` passes it through, `synthetic.ts:75` sets `synthetic`, and `App.tsx:132,251,268` drives the demo banner and file names.
- **B6 fixed:** renamed to `n_excluded_retained_prediction_or_augmented`. **B7 fixed:** the WASM binding now returns only the stable `METHODS_CALLBACK_*` codes (`bindings/wasm/src/lib.rs:23-28`). **B9 fixed:** the C API version comes from `CARGO_PKG_VERSION`. **B8 is also fixed:** `@nirs4all/methods` is pinned to `1.3.5` instead of the local `/tmp` path.
- **Packaging.** `prepack` runs `build:native`, which fails if a WASM asset is missing and then writes `native/.npmignore` so npm stops dropping the native files. The alpha.2 pack receipt lists all three `native/*` assets (wasm 449,374 B). The installed `/tmp/nirs4all-preflight-alpha2-install` copy is version 0.1.0-alpha.2, and its `.wasm` is byte-identical to `bindings/wasm/native`.
- **Tests.** `cargo test --workspace` passed 27 tests in 10 suites. The demo vitest suite and `node --test` did **not** run: the Linux Node in this shell is too old (no `--test`, ESM builtin error) and `npx` resolved to Windows. I rely on root's tarball run for the JS/WASM side.

Low, not blocking:
- `PROTOCOL_BUNDLE_VERSION` is still `0.1.0-alpha.1`. That's fine if it is versioned separately from the package; bump it if it isn't.
- B5 (no stable context key) is still open.
