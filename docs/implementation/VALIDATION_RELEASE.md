# Release validation — 0.1.0-alpha.1

13 October 2026. This is an exploratory alpha, not completion of the V1 roadmap.

Ownership was checked before implementation: Methods owns reusable numerical diagnostics, Rust owns qualification protocols, UI owns pure presentation, and the host owns imports/state/worker lifecycle. The audits in this directory record existing PCA, ABI, UI and DAG-ML capabilities. No second CV engine or proprietary parser was added.

Codex reviewed backend contracts and fixed overflow, cumulative budgets, linked-identity checks, provider response validation and public ABI adapters. Sol medium authored Methods and the engine. Sonnet 5.5 authored the frontend; Opus 5.5 performed the executed review in `REVIEW_OPUS_IMPLEMENTATION.md` and corrected frontend issues. Actual agent receipts are in `AGENT_RECEIPTS.json`.

The Opus backend findings were reconciled before release: cross-partition exact matches have an X-only integrity metric; HTML preserves versions, scoped context, units, denominators, severity/confidence and availability; PCA sample IDs are declared IDs with separate aggregation keys; inputs/reports carry synthetic origin; exclusion counts name prediction data; provider reason codes are stable; release dependencies use published versions; the C ABI version string derives from package metadata. Context parameters distinguish repeatability results sharing a metric name.

| Gate | Executed result |
| --- | --- |
| Methods | 21 native CTest tests; full JS/WASM tests; Emscripten build; ABI snapshots, version sync and C11 header compile. Analytic covariance, omitted-spectrum moments, balanced/negative ICC, unequal repeats, type-7 quantiles, excluded-group neighbors, categorical/continuous contrast and extreme finite inputs. |
| Rust | Workspace fmt, clippy `-D warnings`, 25 tests with the actual Methods Release ABI. WASM target clippy and build passed. |
| WASM runtime | Two tests using the real Rust and Methods modules: computed diagnostics and refusal of identity leakage. CPU/WASM parity on both browser scenarios was checked by Opus, with maximum relative difference 2.7e-15. |
| Python | Installed Linux x86_64 wheel under isolated Python 3.11; four fixtures exactly match CLI reports, three binding tests pass. See `VALIDATION_PYTHON.md`. |
| UI | Typecheck, 420 tests, build and package smoke; the qualification domain passed independent Opus review. |
| Demo | Typecheck, ten tests and production build. Actual headless Chromium exercised analysis, PCA/table, filters, JSON/HTML downloads, cancel/rerun, stale responses and 320 px layout, with zero console errors. See `CHROMIUM_SMOKE.json`. |
| Rust distribution | The CLI was installed from crates.io in a separate installation root; the installed `n4pf validate` accepted the synthetic example. |

Screenshots depict synthetic data only: [report](screenshots/smoke-report.png), [PCA and equivalent table](screenshots/smoke-structure.png), [narrow layout](screenshots/smoke-320.png). The numerical/report artifacts, not screenshots, remain the evidence of scientific calculations.

Open qualification gates: nested validation probe, clustering, domain shift, calibrated permutations/inference, noise proxy, SNV sensitivity, quasi-duplicate thresholds, repetition uncertainty, progress/partial cancellation snapshots, R/MATLAB bindings, other platforms, Firefox/WebKit, screen reader and full memory/performance profiling. Availability and exploratory status remain explicit in the report. The Linux wheel does not claim a manylinux baseline. No PyPI upload was performed; the wheel is a GitHub release artifact.
