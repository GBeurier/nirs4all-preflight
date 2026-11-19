# Preflight 0.3.0 qualification

19 November 2026. The release remains exploratory. This record preserves the
historical alpha release manifest and validation records in this directory.

## Change and scope

Preflight 0.3.0 adopts Methods 1.5.0 / ABI 2.24.0 and the DAG-ML 0.5 series.
The minor bump is required because Methods corrects existing wide PCA scores:
scores are projected onto the final loadings rather than retaining the earlier
Gram-space values. Existing Preflight scores and downstream reports can change.
DAG-ML 0.5 also makes the independently versioned Methods 1.5 series explicit.
The crates, excluded WASM crate, npm binding, Python facade and demo version
remain aligned at 0.3.0. No Preflight numerical implementation, schema, C ABI,
scientific tolerance or fixture oracle was changed.

The intrinsic conformance fixture retains its original Methods 1.4.1 provenance;
the current provider identity is checked separately against Methods 1.5.0.
The profile status remains `exploratory` and finding confidence remains `unknown`.

## Initial candidate evidence

The following Linux x86_64 checks used the release-wave Methods 1.5.0 native
library and its already-built JS/WASM candidate. During this baseline,
the Rust lockfile selected DAG-ML 0.4.0 / n4m 0.4.2 and the installed npm runtime
selected DAG-ML 0.4.5. These results establish the Methods PCA adoption; they
do not replace the final DAG-ML 0.5 registry-cohort checks.

| Gate | Result |
| --- | --- |
| `cargo fmt --all --check` | Passed |
| `CARGO_BUILD_JOBS=4 cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `N4M_LIBRARY_PATH=<selected libn4m.so.2.24.0> CARGO_BUILD_JOBS=4 cargo test --workspace --locked` | 216 passed, none ignored; native analytics executed |
| `CARGO_BUILD_JOBS=4 cargo build --locked --release -p nirs4all-preflight-capi -p nirs4all-preflight-cli` | Passed |
| `target/release/n4pf validate examples/first_run.json` | Valid, no issues |
| Staged C ABI, source Python binding tests excluding installed-distribution test | 3 passed, installed test deferred |
| `CARGO_BUILD_JOBS=4 npm run build:native --prefix bindings/wasm` | Passed |
| `npm test --prefix bindings/wasm` | 41 passed, none skipped |
| `npm test --prefix demo` with the existing sibling dataset checkout made available at its expected location | 87 passed, none skipped |
| `npm run build --prefix demo` | TypeScript and Vite passed |
| Chromium `demo/scripts/dataset-smoke.mjs` | Passed: imports, repetition declarations, persisted reuse, mobile, Beer and Anopheles |
| Chromium `demo/scripts/review-smoke.mjs` | Passed: metadata roles, scoped selection, SVG/CSV and filtered JSON/HTML exports, mobile; no page errors |

The candidate npm packages were installed without saving local dependency
references. npm 10.9.4 hit an Arborist `edgesOut` failure while resolving demo
peers; the candidate-only install used `--legacy-peer-deps --no-save
--package-lock=false`. The final public-registry install must pass `npm ci`
without that workaround.

## Weak-component production-path probe

The frozen Methods owner fixture `preflight_pca_weak_scores_v1.json` contains
exact binary64 input and a 100-decimal-digit independent SVD reference for PC5.
Its input SHA-256 is
`ac3b5248cc741c2c4e6b27b2b7d40035f089444f2e5eb624077ae3c0ac98bf39`.
The probe passes the 24-by-25 input through the production Preflight CLI and
WASM report paths, using both row orders and scales 2^-30, 1 and 2^30.

All six cases passed the unchanged owner relative-L2 tolerance of `2e-9`.
The largest PC5 error against the independent reference was
`1.1538647412727309e-10`; the largest native/WASM PC5 discrepancy was
`1.111285305698583e-11`. Returned sample IDs preserve alignment and exclude
the declared retained-test sample. Changing its spectra leaves the fitted
development PCA scores exactly unchanged in both native and WASM reports. The existing
clustering, confounding, domain-shift, repeatability and nested-validation
goldens passed without regeneration or tolerance changes.

## DAG-ML 0.5 candidate source integration

The reviewed DAG-ML source `d3608565a5fe27875d4b64e54035eb8b4c05b204`
was subsequently qualified through an external process-scoped Cargo override,
without adding a local source dependency to the distributable manifests.
Published n4m 0.5.0 supplies the Rust Methods adapter. Rust stable 1.96.0 on
Linux x86_64 passed formatting and workspace Clippy with warnings denied.

All 216 native workspace tests passed with the exact tagged Methods 1.5 source
library, and all 216 passed again with the actual public Methods 1.5 manylinux
wheel library; no tests were ignored. The public wheel SHA-256 is
`520bcbeed49f3217350fc83c5cfb691fc7b0549d5698e94ff91ce4480dd0d718`,
and its native library SHA-256 is
`215c57f294f43dc61c6b1ca9c2635758ce03fa15646834f01b134caa6869f042`.
The excluded Rust-WASM release build and wasm-opt completed successfully on
the same DAG candidate source. The owner-qualified DAG Web package
(`529d42988d9baf53143bc90216fc431845fe27d356a2eaaa143ea3a1b39e6a50`)
and the actual public Methods 1.5 npm runtime passed all 41 binding tests and
87 demo tests, the TypeScript/Vite build, both actual Chromium journeys and the
six weak-PC5 probes. Oracle and native/WASM error bounds remain those above;
retained-test isolation is exact on both hosts. No tolerance or oracle changed.

The newly built C ABI was staged into a Linux x86_64 wheel whose native member
was checked byte-for-byte. Installing it alongside the actual public Methods
wheel passed all four Python binding tests with all path overrides cleared.
The local Preflight wheel SHA-256 is
`1a078d7d581f712c8ed4cfa74590ca7bf8cb1223aa304578f40800033c71cbe3`.
This local artifact does not claim a manylinux baseline or other-platform
qualification. Original registry Cargo locks were restored byte-for-byte after
candidate compilation; no local source override is part of the shipped source.

The demo also ships all 16 unchanged Methods license/notice files, with exact
archive/source/hash provenance under `public/legal/methods`. The built runtime
WASM matches the public artifact, and its notice copies were checked in `dist`.

## Public registry cohort

All four final locks (`Cargo.lock`, `bindings/wasm/Cargo.lock`,
`bindings/wasm/package-lock.json`, `demo/package-lock.json`) now select the
0.3.0 package identities, public Methods 1.5.0, DAG-ML 0.5.0 and n4m 0.5.0.
The existing demo link to the same repository's WASM binding is retained.
No candidate source patch, filesystem dependency or candidate archive reference
is present in these distributable locks. Both ordinary `npm ci` commands passed
without `--legacy-peer-deps`; final registry fmt and locked Clippy also passed.

At source freeze, the locked native workspace/release and excluded Rust-WASM
builds are running. Their final public-cohort binding/demo tests, installed
artifact smoke and browser/probe outcomes will be recorded in the coordinated
release receipt before publication. The completed source-candidate owner/binding,
installed Python and real browser checks above are retained separately.
This evidence does not claim other-platform scientific qualification,
calibrated thresholds, R/MATLAB qualification, or package/site publication.

## Independent source review

A read-only Opus review found the scope and scientific placement sound. Its two
release-document findings were corrected: the Python README now states the
Methods `>=1.5.0,<1.6` range consistently and the changelog names the numeric
change and downstream consumers. The native-override caveat is documented:
ABI-compatible older libraries remain admissible, their backend version is
reported, and corrected wide PCA scores require Methods 1.5.0 or newer. No
runtime version gate or fallback was introduced.

A final read-only Opus review independently verified the exact notice bytes,
source/archive provenance, version lockstep and numerical scope, with no blocking
findings. Its low documentation findings were corrected in all three notices:
Methods retains its dual license, Python wheels depend on its separate wheel,
and DAG-ML is identified as a runtime component. The public-registry lock and
clean-install requirements are explicit above. No oracle or tolerance changed.
