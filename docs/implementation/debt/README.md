# Characterization interpretability wave — debt index (2026-11-20)

The characterization interpretability wave (request in `_upgrade_request/`, implemented on branch
`feat/characterization-interpretability`) was delivered in the demo only. Owner packages
(Methods, DAG-ML, Core, IO, nirs4all-ui) and the Preflight crates/bindings were frozen
for the ongoing release. Every interim item is listed with its file and migration step in:

- [characterization-integrity.md](characterization-integrity.md): isolated peaks, abrupt changes, SNR and distance to the mean spectrum.
- [characterization-repeatability.md](characterization-repeatability.md): per-band repeatability, noise proxy, residual heatmap and `AlignedTracks`.
- [characterization-preprocessing.md](characterization-preprocessing.md): interactive preprocessing explorer and benchmark.
- [characterization-overview.md](characterization-overview.md): overview cards, spectral quality map, comment framework and page wiring.

Formulas, hypotheses and heuristic bands are documented in [../CHARACTERIZATION_INTERPRETABILITY.md](../CHARACTERIZATION_INTERPRETABILITY.md).

## By owner

| Owner | Debt |
| --- | --- |
| **Methods** (ABI minor) | Per-spectrum event positions from `spectral_population_events_qc` (blocks the spectra × wavelength heatmap, the anomaly markers and the merging of contiguous events). Median filter and despiking transformers. Per-spectrum SG residuals from the noise-proxy kernel. Contrast SNR output. A preprocessing distortion procedure (relative RMSE, spectral angle, per-band SD/quantiles). A band descriptor. Per-band summary statistics (median, P5–P95, between-spectrum SD). Between-sample SD (ANOVA and REML) from `n4m_preflight_repeatability`. |
| **Preflight engine/report** | Emit `measurement.between_sample_sd`, a between-spectrum SD and `noise_to_diversity` per context. Emit context/group membership by observation id (the demo currently mirrors `analyze_repeats`/`real_rows` grouping). Emit per-band event fractions with denominators, the reference spectrum and envelope, SNV-space distances, the relative pooled noise proxy, and a preprocessing-impact family over a declared recipe. |
| **nirs4all-ui** | All new graphical components: `AlignedTracks`, gauges, histograms, proportion bars, heatmaps, spectral quality map, overview cards, explorer charts, and `SpectraExplorer` zoom/marker props. Selectors and the deterministic comment rules (with their tests). |
| **DAG-ML** | Leak-free chemometric comparison of preprocessings when a target Y is available (placeholder only). |
| **Repository / Methods manifest** | Benchmark presets and unit-preservation metadata for the comparability classes. |
| **Ecosystem / Datasets catalogue** | Instrument SNR reference data (`integrity/instruments.ts`), with source snapshots. |
| **Demo** | Register the characterization strings in `i18n.ts`. Add a shared context selector for multi-context datasets. Deduplicate `bandEnvelope` (integrity and repeatability). Move the main-thread Methods load for residuals into the engine worker. |
