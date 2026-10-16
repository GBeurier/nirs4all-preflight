# nirs4all-preflight

Portable qualification of NIRS datasets before training. Rust owns the protocols and input/report contracts; reusable numerical diagnostics live in [nirs4all-methods](https://github.com/GBeurier/nirs4all-methods), and shared presentation components in [nirs4all-ui](https://github.com/GBeurier/nirs4all-ui).

**nirs4all-preflight 0.1.0 (engine, crates and npm binding), exploratory profile.** This release computes integrity and linked-identity checks, exact and declared-tolerance quasi-duplicate suspicions including development/test overlap, a smoothing-residual noise proxy, an SNV sensitivity view, per-band technical repeatability, balanced ICC(1,1), centered PCA with full variance moments, target distributions, metadata–target associations with group-level permutation tests and Holm adjustment, an exploratory HDBSCAN partition with subsample stability, and group-excluding local descriptive contrasts. It produces JSON and accessible HTML, with explicit availability, population, denominator, context and provenance. Synthetic data are labelled in the exported artifact. It has no global qualification score.

[Browser demo](https://gbeurier.github.io/nirs4all-preflight/) · [npm binding](https://www.npmjs.com/package/@nirs4all/preflight) · [Scientific and integration specification](docs/SPECIFICATION.md)

```sh
cargo install nirs4all-preflight-cli --version 0.1.0
n4pf validate dataset.json
n4pf analyze dataset.json --methods-library /path/to/libn4m.so.2 --html report.html
```

The input is a canonical JSON dataset already assembled by its host. See [first_run.json](examples/first_run.json). Vendor decoding and dataset assembly remain in Formats and IO; this package adds neither parsers nor implicit joins. Without a Methods provider, the report explicitly marks dependent diagnostics unavailable. Native Methods ABI 2.20 or later is required.

```js
import { createQualificationRuntime } from '@nirs4all/preflight';
const runtime = await createQualificationRuntime();
const report = runtime.analyze(dataset);
```

Run the browser runtime in a worker to support cancellation by worker termination. The demo processes files locally and uses the same Rust protocols and Methods kernels as the native binding.

Python's thin C ABI facade and a Linux x86_64 wheel are provided under [bindings/python](bindings/python); use `analyze`, `validate` and `report_html`. The release wheel is tested from an isolated Python installation. The [C header](include/nirs4all_preflight.h) describes buffer ownership and versioning.

The alpha has **not** completed the V1 roadmap. Clustering, noise proxy, SNV sensitivity, quasi-duplicates and metadata associations are available but unqualified: their defaults and thresholds are declared, not calibrated. Clustering never states a firm number of clusters and has no null model or cluster matching yet; association tests require declared exchangeable units. The grouped PLS/PCR validation probe is exploratory. It runs through DAG-ML nested selection on CPU (`n4pf --methods-library`, C ABI, Python) and in the browser (dag-ml-wasm with the Methods JS controller). It requires a dag-ml release after 0.3.41 and the Methods kernels `n4m_stats_group_means` and `n4m_stats_regression_scores`. Confounding, domain shift, repeatability uncertainty, partial cancellation snapshots, R and MATLAB qualification, and full multi-platform scientific validation remain unavailable. The report lists these limits and retains `profile_status: exploratory`.

Until that dag-ml release, build against a sibling `../dag-ml` checkout of branch `feat/preflight-probe` with the local-only override: `cargo test --config .cargo/dag-ml-local.toml --workspace` (also `cargo clippy --config ...`, and `wasm-pack build . --target web --out-dir native --release -- --config ../../.cargo/dag-ml-local.toml` in `bindings/wasm`). Never commit a lock file generated with it. Development: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`. Set `N4M_LIBRARY_PATH` for the analytic test against the real Methods ABI. Browser binding: `npm ci --prefix bindings/wasm`, `npm run build:native --prefix bindings/wasm`, `npm test --prefix bindings/wasm`. Demo: `npm ci --prefix demo`, `npm test --prefix demo`, `npm run build --prefix demo`.

[Reuse audits and implementation review](docs/implementation/) document the ownership checks, actual execution evidence and unresolved limits. Historical design documents, [roadmap](docs/ROADMAP.md), [summary](docs/SYNTHESE.md), [decisions](docs/DECISIONS_REVUES.md), original DOCX files and earlier reviews are preserved as the design record; their initial “not implemented” statements describe the documentary phase.

Licensing: CECILL-2.1 OR AGPL-3.0-or-later for this project's source; dependencies retain their own terms. See [LICENSING.md](LICENSING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
