# Third-party notices

nirs4all-preflight's Rust contracts and protocols are offered under CECILL-2.1 OR AGPL-3.0-or-later. Dependencies retain their own licenses.

| Component | Purpose | License |
| --- | --- | --- |
| nirs4all-methods / libn4m | Reusable native and WASM scientific diagnostics | CECILL-2.1 |
| nirs4all-io / nirs4all-formats | Browser dataset inference, assembly and spectral decoding | CECILL-2.1 OR AGPL-3.0-or-later |
| idb-keyval | Browser dataset library | Apache-2.0 |
| nirs4all-ui | Shared React presentation and existing scientific charts | CECILL-2.1 OR AGPL-3.0-or-later |
| serde / serde_json | Rust JSON contracts | MIT OR Apache-2.0 |
| libloading | Native Methods ABI adapter | ISC |
| wasm-bindgen / js-sys | WASM host transport | MIT OR Apache-2.0 |
| React / React DOM | Browser demo | MIT |

Source repositories and exact dependency versions are recorded by Cargo.lock and npm lockfiles. The Linux Python wheel bundles libn4m, whose CECILL-2.1 terms apply to that library. The npm binding depends on the separately distributed Methods package. Relevant license texts accompany each distribution; build tools are not runtime components. The browser demo uses the separately published Formats WASM parsers; no private dataset or proprietary input is bundled.

The browser demo includes real Beer CSV extracts from OHPL (GPL-3.0 option)
and Anopheles oocyst-presence extracts derived from Maia et al., Harvard Dataverse,
DOI 10.7910/DVN/YD34OX (CC BY 4.0). Sources, authors, inherited transformations,
checksums and license texts accompany them under `demo/public/data/demo/` and
are served with the website. The original train/test splits come from Web.
