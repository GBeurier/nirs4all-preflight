# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the shared reference for Claude and Codex: workspace rules come from `../AGENTS.md` / `../CLAUDE.md`, and all project content is in English. This file only adds what is specific to this repository.

## What this is

Portable qualification of NIRS datasets before training. Rust owns the protocols and the input/report contracts; **every reusable numerical kernel lives in `nirs4all-methods`** (reached through its C ABI natively, or `@nirs4all/methods` in WASM), the grouped validation probe runs through **`dag-ml` nested selection**, dataset assembly and vendor decoding stay in **`nirs4all-io` / `nirs4all-formats`**, and presentation components come from **`nirs4all-ui`**. Do not add scientific kernels, parsers, implicit joins or UI charts here — extend the owning repo instead. `docs/implementation/REUSE_*.md` record these ownership checks.

The profile is `exploratory`: no calibrated thresholds, no global score, every finding has confidence `unknown`. Keep claims in docs, reports and UI consistent with that (see README limits).

## Commands

Rust gate (same as `.github/workflows/ci.yml`):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
N4M_LIBRARY_PATH=/path/to/libn4m.so cargo test --workspace
cargo run -p nirs4all-preflight-cli -- validate examples/first_run.json
```

- Single test: `cargo test -p nirs4all-preflight --test confounding <name>`.
- Native-provider tests (`native_provider`, `clustering_golden`, `confounding`, `domain_shift`, `repeatability`) silently skip their analytic part when `N4M_LIBRARY_PATH` is unset. The selected Methods **1.3.15 / ABI 2.22** cohort is built by CI from the commit pinned in `ci.yml` (`cmake --preset dev-release && cmake --build --preset dev-release --target n4m_c`). Older local builds in `../nirs4all-methods/build/` may lack that selected ABI surface.
- CLI: `n4pf <capabilities|validate|analyze> [input.json|-] [--methods-library libn4m.so] [--html out.html]`.

WASM / npm binding (`bindings/wasm`, excluded from the Cargo workspace, needs `wasm-pack` and the `wasm32-unknown-unknown` target):

```sh
npm ci --prefix bindings/wasm
npm run build:native --prefix bindings/wasm
npm test --prefix bindings/wasm        # node --test tests/*.test.mjs
```

Demo (`demo/`, Vite + React 19, deployed to GitHub Pages by `pages.yml`):

```sh
npm ci --prefix demo
npm test --prefix demo                 # vitest; single file: (cd demo && npx vitest run src/dataset.test.ts)
npm run build --prefix demo            # tsc --noEmit && vite build
npm run preview --prefix demo && CHROME=/path/to/chrome npm run test:browser --prefix demo
```

Python (`bindings/python`): build `nirs4all-preflight-capi` in release, then `python scripts/stage-python.py` copies the C ABI library into `src/nirs4all_preflight/_native/` (never commit it); the pinned Methods Python distribution supplies its own library; tests are in `bindings/python/tests/`. `N4PF_LIBRARY_PATH` / `N4M_LIBRARY_PATH` override the selected native libraries.

## Architecture

Cargo workspace (all crates version-locked with exact `=X.Y.Z` path deps):

- `nirs4all-preflight-core` — the contracts: `QualificationInput` (canonical JSON dataset: sources, samples, partitions, targets, metadata, declared identities/repetitions/independence units, `Options`), `validate_input`, `QualificationReport` (`Metric`, `Finding`, `Capability`, `Availability`, provenance), and the provider traits with their typed request/diagnostics structs. `MethodsProvider` methods default to `unsupported(..._NOT_CONFIGURED)`, so an absent kernel becomes an explicit "unavailable" capability, never a silent fallback.
- `nirs4all-preflight` — the engine. `lib.rs` has `analyze` / `analyze_with_validation` (validate first, then run each protocol and record availability, populations, denominators and limitations) and `report_html`; each advanced protocol is its own module (`association`, `clustering`, `confounding`, `domain_shift`, `repeatability`, `probe`). `native.rs` is a thin `libloading` adapter to the Methods C ABI (`NativeMethodsProvider`); `dagml.rs` is the `ValidationProvider` backed by `dag-ml-core` nested selection. Both are non-wasm only.
- `nirs4all-preflight-capi` — versioned C ABI (`n4pf_*`, header in `include/nirs4all_preflight.h`) with JSON in/out buffers; used by the Python facade.
- `nirs4all-preflight-cli` — `n4pf` binary.

Bindings stay thin:

- `bindings/wasm` — `src/lib.rs` exposes the engine via wasm-bindgen; `index.js` (`createQualificationRuntime`) implements the provider callbacks by calling `@nirs4all/methods` and `dag-ml-wasm`. Same Rust protocols as native; only the kernel transport differs.
- `bindings/python` — ctypes facade (`analyze`, `validate`, `report_html`) over the C ABI; no calculations in Python.

Demo data flow: files → the source-built IO browser-owner snapshot in `demo/vendor/io-browser-owner` + `@nirs4all/formats-wasm` (`src/dataset-io.ts`; `scripts/browser-wasm.ts` adapts only Formats' Node-target glue) → `src/dataset.ts` maps the IO schema 3 contract to `QualificationInput`, using the snapshot's owner `numericCoordinates` helper for exact axes → `src/engine.ts` / `engine.worker.ts` run this checkout’s `@nirs4all/preflight` (`file:../bindings/wasm`; build the WASM binding before demo checks) in a worker (cancellation = worker termination) → `nirs4all-ui/qualification` components and selectors render the report. The IO snapshot comes from tag `v0.3.1` / commit `28e47c9d6491b83a31dd36a25f2b0a35eeab9860`; its `PROVENANCE.json` records the unpublished browser profile, which is distinct from the registry package. `src/checks.ts` turns engine counts into control points (zero → OK, never a calibrated threshold). `nirs4all-ui` uses the vendored `demo/vendor/nirs4all-ui-0.2.2-local.20261107.2.tgz` (SHA-256 `237a3bf306bdb6fec5088783c425381bcf125540ba7ad25e1aec0604198d7728`) with `demo/vendor/nirs4all-ui-0.2.2-local.20261107.2.provenance.json`; the Preflight binding is local `file:../bindings/wasm`.

## Testing data and goldens

Goldens live in `crates/nirs4all-preflight/tests/fixtures/` (`clustering_v4_golden.json` from `scripts/generate_clustering_golden.py`, `probe_sklearn_v1.json` from its generator next to it). Regenerate only with a stated rationale. Demo datasets and their provenance are in `demo/public/data/demo/` (`SOURCES.md`, `SHA256SUMS`).

## Releases

Versions are plain `X.Y.Z`, aligned across crates, npm and the Python wheel. Current upstream pins (dag-ml 0.4.0, Methods 1.3.15 / ABI 2.22) appear in `Cargo.toml`s, `bindings/wasm/package.json`, `ci.yml` and the README — change them together. Release evidence goes in `docs/implementation/` (`RELEASE_MANIFEST.json`, `VALIDATION_*.md`). `docs/` design documents (SPECIFICATION, ROADMAP, SYNTHESE, DECISIONS_REVUES, reviews) are the preserved design record; `docs/SPECIFICATION.md` is the scientific and integration reference.
