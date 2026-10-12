# Third-party notices

nirs4all-preflight's Rust contracts and protocols are offered under CECILL-2.1 OR AGPL-3.0-or-later. Dependencies retain their own licenses.

| Component | Purpose | License |
| --- | --- | --- |
| nirs4all-methods / libn4m | Reusable native and WASM scientific diagnostics | CECILL-2.1 |
| nirs4all-ui | Shared React presentation and existing scientific charts | CECILL-2.1 OR AGPL-3.0-or-later |
| serde / serde_json | Rust JSON contracts | MIT OR Apache-2.0 |
| libloading | Native Methods ABI adapter | ISC |
| wasm-bindgen / js-sys | WASM host transport | MIT OR Apache-2.0 |
| React / React DOM | Browser demo | MIT |

Source repositories and exact dependency versions are recorded by Cargo.lock and npm lockfiles. The Linux Python wheel bundles libn4m, whose CECILL-2.1 terms apply to that library. The npm binding depends on the separately distributed Methods package. Relevant license texts accompany each distribution; build tools are not runtime components. No vendor parser, private dataset or proprietary input is bundled.
