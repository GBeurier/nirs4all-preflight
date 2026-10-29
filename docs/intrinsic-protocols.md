# Optional intrinsic spectral protocols

`options.intrinsic_qc: {}` enables descriptive signatures on **real development
observations only**. Retained-test spectra and augmented observations do not enter
these computations; test references are never read. Existing profiles omit this
option and keep their behavior. Native Methods and Methods WASM own the numerical
kernels through the same generic procedure registry and existing ABI 2.20.
Availability is discovered by procedure ID: an older ABI-compatible library can
refuse an absent procedure without producing a numerical placeholder.

These signatures are observations, not calibrated probabilities, diagnoses of
physical causes, or estimates of model performance. No global quality score is
introduced. `population_weighting` declares observation weighting; physical IDs
are retained and repeated spectra are not asserted to be independent samples.
Domains owns train/test coverage, target-specific context and performance claims.

## Mapping from Datasets

| Datasets field/family | Methods / Preflight mapping | Definition and migration |
| --- | --- | --- |
| `reference.rms_to_mean_spectrum[_p95]` | `diagnostics.spectral_reference_qc`; `intrinsic.reference.rms_median` / `rms_p95` | RMS in declared signal units, to the development dataset mean per valid feature; no external calibration reference implied. |
| `reference.sam_to_mean_spectrum[_p95]` | Same procedure; `sam_median` / `sam_p95` | Spectral angle in radians, common valid coordinates, nonzero norms. |
| `reference.affine_offset_*`, `affine_gain_*`, `affine_residual_rms_*` | Same procedure; `affine_offset`, `affine_abs_offset`, `affine_gain`, `affine_abs_gain_delta`, `affine_residual_rms` summaries | Native OLS `x = offset + gain * reference`. Residual RMS denominator is common coordinate count; constant reference refuses the affine fit. Absolute offset/delta summaries have distinct IDs. |
| `artefacts.jump_count/rate`, `spike_count/rate` | `diagnostics.spectral_events_qc`; `intrinsic.events.*` | Index first/second differences by default, median/MAD scale with sample-SD fallback and declared threshold. Only adjacent valid pairs/triples count; no bridging masked holes. Physical mode explicitly divides by the actual axis gaps in its declared unit. |
| `artefacts.clip_fraction` | `observed_extrema_occupancy_fraction` | Historical occupancy near **observed extrema**, retained as a descriptive proxy. It cannot establish sensor saturation. |
| Actual sensor clipping | `declared_clip_*` | Requires declared lower/upper sensor bound(s), in signal units, and explicit tolerance. Missing bounds produce `not_applicable`, `PHYSICAL_SENSOR_BOUNDS_NOT_DECLARED`, and null value. |
| `noise.noise_rms`, `noise.snr`, `noise.snr_db` | `diagnostics.spectral_noise_proxy`; `intrinsic.noise.global_noise_sigma`, `global_signal_noise_ratio`, `global_signal_noise_db` | Second-difference MAD ×1.4826/√6; median row noise and mean absolute valid signal. Ratio/dB are descriptive index-space proxies, not instrument SNR. Zero measured noise stays zero; its ratio is undefined. |
| `noise.bandwise_snr_*`, `worst_band_*` | Retained legacy protocol, explicitly inventoried by Datasets | The existing SG residual `measurement.noise_proxy` is a different protocol, not a replacement or numerical-equivalence claim. |
| `shape.baseline_slope`, curvature/D1/area, wavelength-shift search | Retained legacy protocols | Distinct operations. Index differences must not be labelled physical derivatives; affine residuals do not replace shift search. |
| PCA, Q/SPE, T², Mahalanobis summaries | Existing Methods fitted PCA, `diagnostics.pca_reference_qc`, Preflight canonical PCA / PCA monitoring | Freeze fit population and preprocessing before querying another population. Legacy covariance/threshold/rank choices are not automatically equivalent; an intrinsic dataset fit is not train/test coverage. |
| Repeatability RMS/SAM/CV | Existing Methods repeatability / Preflight `repeatability.*` | Preserve physical IDs and declared repetition type. REML within-variance/ICC and interval protocols are distinct from pairwise RMS, SAM and coefficient-of-variation summaries. Unknown grouping stays unavailable. |
| Legacy `structure.local_outlier_factor_p95` | Rename legacy mean-neighbour-distance/median proxy; new true `diagnostics.local_density`, `intrinsic.local_density.lof[_p95]` | Native LOF with explicit training/novelty mode and k, not the historical distance ratio. Optional (`local_density: true`) because cost is quadratic. Complete finite coordinates required; no silent imputation. |
| Isolation Forest and target-dependent fields | Retained distinct protocol / Domains | No new Preflight estimator or model-performance proxy is inferred from an intrinsic signature. |

The reference migration deliberately changes missing-data behavior: legacy
Datasets column-imputes before computing reference distances; the new protocol
uses common valid coordinates. An all-missing observation therefore remains
unavailable instead of becoming an imputed mean spectrum with a clean zero.
Event denominators likewise count eligible differences. Differences are annotated
in the conformance fixture rather than hidden by modifying reference goldens.

## Lossless transport and consumer integration

Each row signal retains observation/sample/physical IDs, native status codes and
null for unavailable observations. Native medians and p95 use Hyndman–Fan type 7;
Rust and JavaScript do not recalculate summaries. All native counts, reference
coordinates/masks, sparse row indices and other outputs remain in
`intrinsic.<family>.protocol_evidence`. This field records successful transport,
not a quality verdict. Scalar summaries have their own availability and reason.

Use `n4pf analyze canonical.json --methods-library /explicit/library` and then
`n4pf extract-assessment report.json context.json` (or `extract-findings`) to
produce the optional shared JSON envelope. `examples/assessment/` contains the
report, context, scalar assessment and findings contracts. The content hash and
source/population/context are supplied explicitly by the consumer. Intrinsic
context refuses split/fit/evaluation IDs; task context belongs to Domains.
No dependency on Datasets or Domains is required by the runtime, and no report
import triggers a silent legacy recomputation.

Assessment metrics and findings evidence optionally carry `metric_context_id`,
an opaque `sha256:<64hex>` producer token derived from recursively sorted JSON
of native parameters and denominators. This distinguishes, for example,
instrument and campaign instances of `domain_shift.design`. Consumers still
preserve and compare the original parameters and denominators; the token cannot
authorize an otherwise ambiguous scalar mapping. Older envelopes without the
field remain valid. The scalar envelope's schema marker is string `"1"`,
distinct from the native report's integer `1`.

LOF refuses missing coordinates with `LOF_REQUIRES_COMPLETE_SPECTRA`, and work
above 2.5 billion row-pair-coordinate operations with
`LOF_SHAPE_OR_WORK_BUDGET_EXCEEDED`, before entering the native kernel.

## Conformance

`scripts/generate_intrinsic_conformance.py --legacy-root <clean-checkout>
--output crates/nirs4all-preflight/tests/fixtures/intrinsic_legacy_v1.json`
records the exact legacy commit, source hash and NumPy/SciPy versions. The fixture
uses original synthetic spectra, includes repeated physical IDs and annotates
complete-data equivalence, masked population differences, zero norms and
constant references. Native/WASM integration checks consume these fixed legacy
observations, with exact counts/statuses and declared floating-point tolerances.
Scientific validity remains descriptive; this is numerical conformance, not
calibration of causal confidence or predictive coverage.
