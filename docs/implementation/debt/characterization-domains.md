# Characterization debt: shift between domains (waves 2–3, 2026-11-20)

Demo-only upgrade of the `domain_shift` section (`_upgrade_request/domain_shift.txt`, mockups image (16) and (17)).
Code: `demo/src/characterization/domains/`; `DomainShiftSection` in `demo/src/Blocks.tsx` now renders `DomainShiftView`
and keeps the former engine matrix as the "Full numerical table". Engine values are read through `extractDomainShift`
plus the raw `domain_shift.*` metric values; everything below is interim.

| What | Where | Target owner | Migration step |
| --- | --- | --- | --- |
| Relative centre shift = `centroid_distance / sqrt(reference_total_variance)` (reference RMS distance to its centroid, ddof 1, same space); squared share outside the subspace = `residual² / centroid²`; relative energy = `energy_e / mean_within_reference_distance`; relative total variance, relative SD, % difference | `model.ts:comparisonModel` | Preflight engine (report fields) | Emit them in `domain_shift.center_shift` / `dispersion` / `distribution_distance` with units and definitions; drop the TS derivation. |
| Independence units rebuilt in TS (engine `aggregate` mirrored; identity components approximated by physical sample or declared group); unit counts checked against engine denominators, mismatch labelled "approximate" | `populations.ts:domainPopulations` | Preflight engine | Publish unit membership (unit id → sample ids) per comparison. |
| Per-unit T²/Q (compared, full reference fit) and out-of-fold reference T²/Q via Methods `statsPcaMonitor` on the same space; label-free leading PCA (`preflightPca`, k = min(50, n−2, p)) for factor comparisons | `kernels.ts:computeDiagnostics` | Preflight engine | Emit per-unit T²/Q and reference OOF statistics in `domain_shift.coverage`. |
| Per-band profiles: means, P5–P95, SD, signed and standardized difference (÷ pooled SD, masked when negligible), local variance ratio; dominant-difference window | `kernels.ts:bandProfiles`, `dominantRegion` | Methods (per-band summary kernel) + Preflight report | Per-band domain profiles in the report. |
| Reference-only PCA overlap scores (compared projected in TS onto reference loadings) | `kernels.ts:computeDiagnostics` | Preflight engine | Emit reference-fitted scores of both domains. |
| Nearest-neighbour distances (Methods `preflightNearestNeighbors`, k = N) and bidirectional coverage shares (supported / represented, P95 rule) | `kernels.ts:neighbourSummary` | Methods (coverage kernel) + Preflight engine | Documented asymmetric coverage estimator in the engine. |
| Internal energy benchmark: 199 seeded splits (`randomPermutations`, seed 20261120) of reference units, V-statistic energies from Methods distances in TS; "approximate" because disjoint subsets cannot match the observed sizes; capped at 1,500 units | `kernels.ts:energyBenchmark` | Methods (resampled energy kernel) + Preflight engine | Size-matched resampled reference distribution in the report. |
| Charts: normalized T²/Q scatter, PCA overlap (with empirical concentration ellipses, `concentrationEllipse`), ECDF, ratio scale, four-panel illustration, null histogram card, pairwise matrix table, explorer step editor | `charts.tsx`, `PermutationPanel.tsx`, `PairwiseMatrix.tsx`, `ShiftExplorer.tsx` | nirs4all-ui | Move to the shared kit (requested in `KIT_REQUESTS.md`). |
| Strings and interpretation rules (`interpret`, `missingDeclarations`) | `strings.ts`, `model.ts` | nirs4all-ui / demo i18n | Move rules to selectors; register strings. |

## Wave 3 (maintainer override: owner numerics implemented locally, labelled interim in the UI)

| What | Where | Target owner | Migration step |
| --- | --- | --- | --- |
| Permutation null distribution of `domain_shift.energy_test`: same units (engine order), space (label-free leading PCA of every development unit, or complete spectra for the audit / `energy_on_spectra`), K-sample statistic Σ nₐn_b/(nₐ+n_b)·E (V-statistic), seed (plan seed, `deriveSeed` mirror of `derive_seed`), draws (Methods `randomPermutations` = the engine PCG64 stream, `labels[i] = codes[perm[i]]`), B, tie rule T_perm − T ≥ −√ε\|T\|, p = (b+1)/(B+1); local Holm via Methods `preflightHolmAdjust` over the engine family with the local p substituted. Run only when the engine test is computed; blocked tests keep "Statistical inference unavailable". Mismatch beyond 2·√(2p(1−p)/B) + 1/(B+1), or a statistic mismatch, is reported in the card. | `permutation.ts:permutationNull`, `energyStatistic`, `deriveSeed`, `monteCarloAgreement`; `model.ts:testPlan`; `populations.ts:testPopulation`; `PermutationPanel.tsx` | Preflight engine + Methods | Methods: optional draws (or bins) output of `n4m_stats_energy_distance`; engine: publish them in the metric value; drop the local recomputation. |
| Residual spectral profiles x − x̂ of compared units above the Q limit (reference mean, monitor's k resolved Methods PCA components, complete spectra) with the in-sample reference residual P5–P95 envelope; equals the monitor Q when the monitor runs on complete spectra (tested), otherwise labelled as a complete-spectrum view | `kernels.ts:referenceResiduals`, `computeDiagnostics` (`residuals`) | Methods (monitor reconstruction output) + Preflight engine | Emit per-unit residual profiles (or the reference loadings) in `domain_shift.coverage`. |
| Pairwise matrix of normalized metrics between every ordered pair of factor levels (relative centre shift, dispersion ratio, relative energy) in the engine's monitor / energy spaces; reproduces the engine level-vs-rest values for two levels (tested) | `pairwise.ts:pairwiseMatrix`, `PairwiseMatrix.tsx` | Preflight engine | Emit a pairwise comparison family with explicit reference direction. |
| §13 domain-shift preprocessing explorer: agent C's `applyPipelineFittedRows` fitted on reference rows only, unit means, then local relative centre shift, dispersion ratio, relative energy, T²/Q coverage (Methods `statsPcaMonitor`, reference-only) and reference-fitted PCA overlap, raw vs processed. Defaults to development comparisons; audit is read-only X-only; nothing optimized | `shiftExplorer.ts:exploreShift`, `shiftMetrics`; `ShiftExplorer.tsx` | Preflight engine (declared-recipe shift family) + DAG-ML (fit-scope execution) | Run the declared recipe in the engine with reference-only fit scope; drop the local metrics. |
| Unit tooltips (member samples, physical sample, instrument, campaign, declared metadata, spectra; never targets) and readable JSON sample ids | `populations.ts:unitDescriber`, `sampleLabel` | nirs4all-ui selectors | Move to a shared unit-label selector. |
| Worker: diagnostics, permutation null, pairwise matrix and explorer run in `domains.worker.ts` (inline fallback without Worker) | `host.ts`, `tasks.ts`, `domains.worker.ts` | Demo | Merge into the engine worker when the engine emits these values. |

Validation (vitest, real engine and Methods WASM): `permutation.integration.test.ts` runs the Preflight engine on the
synthetic set with declared exchangeable sample units; for the campaign factor (leading PCA space) and the
development / retained-test audit (complete spectra) the local statistic equals the engine statistic (relative
1e-9), the plan seed equals `deriveSeed`, b and p equal the engine exactly, the local Holm p equals the engine Holm p,
and b equals Methods `statsEnergyDistance` with the same seed; the pairwise matrix equals the engine level-vs-rest
relative metrics. `permutation.test.ts`: K-sample statistic vs Methods (3 unequal groups), reproducible draws,
residual Q reproduction, ellipse coverage, MSC fitted on the reference only.

Retained-test protection: no file of the module reads `input.targets`; `protection.test.tsx` renders the view (explorer included) with a
throwing `targets` getter, runs the explorer task on the audit, and scans every source file (worker included).
