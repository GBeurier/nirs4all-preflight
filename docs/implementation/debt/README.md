# Characterization interpretability wave — debt index (2026-11-20)

The characterization interpretability wave (request in `_upgrade_request/`, implemented on branch
`feat/characterization-interpretability`) was delivered in the demo only. Owner packages
(Methods, DAG-ML, Core, IO, nirs4all-ui) and the Preflight crates/bindings were frozen
for the ongoing release. Every interim item is listed with its file and migration step in:

- [characterization-integrity.md](characterization-integrity.md): isolated peaks, abrupt changes (with the wave-3 local event-positions port), SNR (estimator validation, empirical benchmark by manufacturer) and distance to the mean spectrum.
- [characterization-repeatability.md](characterization-repeatability.md): per-band repeatability, noise proxy, residual heatmap and `AlignedTracks`.
- [characterization-preprocessing.md](characterization-preprocessing.md): interactive preprocessing explorer and benchmark.
- [characterization-overview.md](characterization-overview.md): overview cards, spectral quality map, comment framework and page wiring.
- [characterization-domains.md](characterization-domains.md): shift between domains (relative metrics, per-unit T²/Q, band profiles, nearest neighbours, internal energy benchmark; wave 3: local permutation null distribution validated equal to the engine p-values, high-Q residual profiles, pairwise level matrix, concentration ellipses, domain-shift preprocessing explorer, worker).
- [characterization-design.md](characterization-design.md): experimental design, dependency graph, crossing coverage, variance partition, statistical evidence matrix and PERMDISP (wave 3: units rebuilt and Methods PERMDISP distances validated equal to the engine per-level means; local exploratory BH; consistency checks, no engine defect found).
- [characterization-joint.md](characterization-joint.md): metadata and target associations (per-unit rows rebuilt and validated equal to the engine denominators and level summaries), joint X–Y landscape and interpretation rules, validation scenario audit (scenario generation, per-fold structural audit, development-only T²/Q monitors).

Formulas, hypotheses and heuristic bands are documented in [../CHARACTERIZATION_INTERPRETABILITY.md](../CHARACTERIZATION_INTERPRETABILITY.md).

## By owner

| Owner | Debt |
| --- | --- |
| **Methods** (ABI minor) | Per-spectrum event positions from `spectral_population_events_qc` (interim TypeScript port in the demo, validated equal to the engine counts, drives the event map, markers and merged events). An estimator-validation procedure (noise injection and recovery) next to `spectral_noise_proxy`. Median filter and despiking transformers (wave 3: computed locally in the demo, `preprocessing/localSteps.ts`). PLS predictions for 1..A components from one fit. Per-spectrum SG residuals from the noise-proxy kernel. Contrast SNR output. A preprocessing distortion procedure (relative RMSE, spectral angle, per-band SD/quantiles). A band descriptor. Per-band summary statistics (median, P5–P95, between-spectrum SD). Between-sample SD (ANOVA) from `n4m_preflight_repeatability` (the REML σb² is already in the engine report parameters; wave 3 reads it). Optional permutation draws (or a binned null) from `n4m_stats_energy_distance`, a PCA-monitor residual/reconstruction output, and a K-level pairwise shift kernel (wave 3: computed locally in the demo, `domains/`). |
| **Preflight engine/report** | Emit `measurement.between_sample_sd` (wave 3 reads the REML σb² from `icc_1_reml` parameters), a between-spectrum SD and `noise_to_diversity` per context. Emit context/group membership by observation id (the demo currently mirrors `analyze_repeats`/`real_rows` grouping). Emit per-band event fractions with denominators, the reference spectrum and envelope, SNV-space distances, the relative pooled noise proxy, and a preprocessing-impact family over a declared recipe. Domain shift: the permutation null (or its bins) of `domain_shift.energy_test`, unit membership per comparison, per-unit T²/Q and residual profiles, a pairwise level-by-level matrix, and a declared-recipe shift family fitted on the reference domain (all computed locally in the demo in wave 3). Association: the analysed unit rows of `association.metadata_target`; a validation-scenario family with per-fold domain-shift results (wave 3: `joint/`). |
| **nirs4all-ui** | All new graphical components: `AlignedTracks`, gauges, histograms, proportion bars, heatmaps, spectral quality map, overview cards, explorer charts, and `SpectraExplorer` zoom/marker props. Selectors and the deterministic comment rules (with their tests). |
| **DAG-ML** | Candidate validation splitters from declared groups, levels, intervals and level combinations (wave 3: `joint/scenarios.ts`). Leak-free chemometric comparison of preprocessings (wave 3: computed locally in the demo, opt-in; grouped nested CV, LV selection, scoring) and fit-scope execution of preprocessing recipes (`applyPipelineFitted`). |
| **Repository / Methods manifest** | Benchmark presets and unit-preservation metadata for the comparability classes. |
| **Ecosystem / Datasets catalogue** | Instrument SNR reference data (`integrity/instruments.ts`), with source snapshots. Instrument/manufacturer/representation metadata for public datasets (hand-curated `CATALOGUE` in `demo/scripts/noise-benchmark.test.ts`, from nirs4all-data documentation) and the empirical noise benchmark computed over the catalogue. |
| **Demo** | Register the remaining characterization strings in `i18n.ts` (wave 3 did overview/ and the repeatability leads). Wave 3 added the shared context selector, the shared hover cursor and the Raw / Preprocessed quality map (see the overview note). Deduplicate `bandEnvelope` (integrity and repeatability). Move the main-thread Methods load for residuals into the engine worker. |

## Data debt — Anopheles oocyst split (2026-11-20, to resume)

The retained-test split of the Maia et al. Anopheles oocyst data (Harvard Dataverse
`10.7910/DVN/YD34OX`) was defective in every derived copy, because they all come from an
earlier standardized "BACON" export. Of its 106 "test" rows, 59 copy oocyst calibration
spectra (labels disagree in 26 pairs) and 47 are sporozoite calibration spectra. None is an
oocyst validation spectrum. The evidence is row matching against the authors' MD5-verified
`.tdfx` calibration files.

| Copy | State | Next step |
| --- | --- | --- |
| Preflight demo (`demo/src/data/demo/anopheles/`) | **Fixed** in #20: rebuilt 227/106 from the original archive with `demo/scripts/build-anopheles-extract.py` (takes `dataverse_files.zip`, checks the Dataverse MD5s, labels y = `actual` − 1); `SOURCES.md` records the correction | — |
| nirs4all-datasets `harvard_dataverse_malaria_anopheles_gambiae_nir` (rebuilt from the BACON export) | Defective. A "Known data defects (tracked debt)" note is written in `docs/PUBLIC_ORIGIN_LOADING.md` but **not committed** (that checkout carries unrelated in-progress release changes) | Commit the note; rebuild from the original-source recipe with a guestbook response (guestbook 293), keeping the 227/106 split |
| nirs4all-data `regression/MALARIA/Malaria_Oocist_333_Maia` | Defective (same 59 + 47 pattern) | Regenerate from the original archive (the Preflight generator can be reused) |
| nirs4all-data `classification/MALARIA/Oocist2C_333_Maia_Acc87.6` | Defective (all 106 test rows equal calibration spectra) | Same |
| nirs4all-web demo `web-app/src/data/demo/anopheles` | Defective (bundled from the BACON export, commit 38ebfca) | Replace with the corrected Preflight extract and its provenance |

Until these copies are fixed, consumers must not use their test split as a hold-out.
The original archive is guestbook-gated: anyone can download it after declaring
name, email, institution and intended use. The raw archive is never committed.
