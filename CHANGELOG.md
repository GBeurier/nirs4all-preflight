# Changelog

## 0.1.0-alpha.1 — 2026-10-13

First executable exploratory release. Rust input/report contracts, identity checks, CLI, C ABI, thin Python and WASM bindings, reusable Methods diagnostics and shared UI qualification components. The GitHub Pages demo runs the real engines in a worker. JSON/HTML exports retain context, availability and synthetic origin. This release does not close the V1 roadmap or claim R/MATLAB qualification.

## npm binding 0.1.0-alpha.2 — 2026-10-13

Correct the npm archive to include generated WASM assets. The generated wasm-pack ignore file previously excluded them. Packaging now verifies the required files and overrides that ignore rule; a fresh isolated installation runs the actual engines. Rust engine/protocol/crate versions remain 0.1.0-alpha.1.
