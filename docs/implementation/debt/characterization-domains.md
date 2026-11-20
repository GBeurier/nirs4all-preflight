# Characterization debt: shift between domains (wave 2, 2026-11-20)

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
| Permutation null distribution is not published (only statistic, p, Holm p, B) | `DomainShiftView.tsx:PermutationCard` | Preflight engine | Emit the permutation draws or a binned null distribution. |
| Charts: normalized T²/Q scatter, PCA overlap, ECDF, ratio scale, four-panel illustration | `charts.tsx` | nirs4all-ui | Move to the shared kit (requested in `KIT_REQUESTS.md`). |
| Strings and interpretation rules (`interpret`, `missingDeclarations`) | `strings.ts`, `model.ts` | nirs4all-ui / demo i18n | Move rules to selectors; register strings. |
| §13 interactive domain-shift explorer (preprocessing effect on shift metrics, reference-only fitting) | not implemented | Demo + Methods | Build on the preprocessing explorer kernel once the engine emits per-unit diagnostics. |
| Methods runs on the main thread (lazy dynamic import) | `kernels.ts:loadMethods` | Demo | Move into a worker. |

Retained-test protection: no file of the module reads `input.targets`; `protection.test.tsx` renders the view with a
throwing `targets` getter and scans the sources.
