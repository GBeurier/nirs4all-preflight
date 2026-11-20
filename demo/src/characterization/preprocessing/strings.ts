// English UI text of the preprocessing explorer (kept here, not in demo/src/i18n.ts).
export const S = {
  title: "Interactive spectral preprocessing explorer",
  lead: "Explore how preprocessing affects noise, localized anomalies, repeatability and sample diversity, while watching for loss or distortion of spectral information.",
  noData: "The explorer needs at least two complete spectra with five or more bands in the selected source.",
  denominators: (used: number, complete: number, total: number, cap: number) =>
    `Computed on ${used} of ${total} spectra (complete spectra only: ${complete}; deterministic subset of at most ${cap}, replicate groups kept together). The original dataset is never modified.`,
  fixedDiagnostics: (threshold: number, window: number, polyorder: number) =>
    `Diagnostics are fixed for every comparison and are not preprocessing parameters: noise σ = MAD(second differences)·1.4826/√6 (Methods spectral_noise_proxy); events relative to the other spectra at the same band (threshold ${threshold}, at least 5 spectra, within this subset, so counts can differ from the full-dataset report); noise proxy profile = Savitzky–Golay residual (window ${window}, order ${polyorder}).`,
  irregularAxis: "Irregular spectral axis: derivatives are scaled by the median axis step and windows count bands, not axis units.",
  controls: "Preprocessing",
  addStep: "Add a step",
  remove: "Remove",
  up: "Move up",
  down: "Move down",
  emptyPipeline: "No step: processed = raw.",
  unavailable: "not in this build",
  computing: "Recomputing…",
  shownSpectra: "Spectra drawn",
  comparabilityTitle: { comparable: "Comparable scale", caution: "Interpret with caution", not_comparable: "Not directly comparable" },
  comparability: {
    comparable: "Smoothing / denoising keep the raw scale: before/after noise indicators are comparable under the usual assumptions. A smaller smoothing residual is not independent evidence of lower instrumental noise.",
    caution: "Scatter or baseline correction rescales or shifts the signal: SNR changes need caution and unit-based metrics are withheld when the scale changes.",
    not_comparable: "Derivative: the processed signal lives in another spectral space (signal unit per axis unit). SNR and percentage changes are disabled.",
  },
  neverImprovement: "A higher SNR or a lower diversity is not necessarily an analytical improvement; no configuration is designated as optimal.",
  tracksTitle: "Spectra and per-band profiles",
  tracksSub: "One synchronized stack: hover for values at a band, drag to select a band range, Ctrl/⌘ + wheel to zoom.",
  bandTitle: "Selected band: position, amplitude and width on the median spectrum",
  bandHint: "Drag across an absorption band on any track to compare its position, height and width before and after.",
  bandDisabled: "Band descriptors are disabled for derivatives (the band shape changes by construction).",
  distributionsTitle: "Per-spectrum distributions",
  distributionsSub: "Same spectra: raw (grey, upper) and processed (teal, lower) on shared bins, dashed line = median.",
  impactTitle: "Impact on spectral characteristics",
  impactSub: (n: number) => `Same ${n} spectra and bands, fixed diagnostics. Delta = processed − raw (dB, percentage points or ×).`,
  impactPrimary: "Overview indicators",
  impactComparison: "Before/after comparison metrics",
  impactOther: "Other indicators",
  benchmark: "Noise reduction vs spectral distortion",
  benchmarkSub: "Automatic evaluation of smoothing and denoising settings on the same spectra. Click a point to load it.",
  benchmarkFoot: "Dashed line: Savitzky–Golay (order 2) window sweep from the raw origin. No configuration is optimal without a defined analytical objective.",
  runBenchmark: (n: number) => `Rerun (${n} configurations)`,
  cancel: "Cancel",
  pareto: "Highlight non-dominated settings",
  otherFront: "Also plot those of other methods",
  benchmarkTable: "Benchmark values",
  definitions: "Metric definitions",
  precautions: "When is a before/after SNR comparison meaningful?",
  principle: "Principle: a smoother spectrum is not necessarily a better spectrum",
  principleCaption: "Schematic illustration (synthetic curves, not the loaded data). Excessive smoothing removes noise and also band resolution.",
  workflowLabel: "Recommended organisation",
  chemometricNote: "Optional, not available: with a declared target Y, compare preprocessing by PLS RMSECV/RMSEP, bias and latent variables under leak-free cross-validation (preprocessing fitted inside each fold). That scheduling belongs to the DAG-ML owner.",
  syntheticNote: "Synthetic noise scenarios (dataset picker) remain only an optional validation of the noise estimator.",
};

/** Recommended organisation of the preprocessing workflow (request, "organisation recommandée"). */
export const WORKFLOW: readonly { n: number; title: string; caption: string; href: string | null }[] = [
  { n: 1, title: "Raw characterization", caption: "Anomalies, noise, diversity, instrument references.", href: "#s-characterization" },
  { n: 2, title: "Preprocessing explorer", caption: "Real spectra, pipeline, parameters, residuals.", href: "#pp-controls" },
  { n: 3, title: "Impact assessment", caption: "Before/after table, SNR distributions, preserved information.", href: "#pp-impact" },
  { n: 4, title: "Benchmark", caption: "Parameter sweep, noise/distortion trade-off.", href: "#pp-bench" },
  { n: 5, title: "Chemometric validation", caption: "Optional; not available in this demo.", href: null },
];

/** Methodological precautions: which preprocessing families allow a before/after SNR comparison. */
export const PRECAUTIONS: readonly { family: string; snr: string; level: "comparable" | "caution" | "not_comparable" }[] = [
  { family: "Smoothing, denoising, despiking", snr: "Meaningful under assumptions", level: "comparable" },
  { family: "SNV, MSC, detrending", snr: "Interpret with caution", level: "caution" },
  { family: "First and second derivatives", snr: "Not directly comparable", level: "not_comparable" },
  { family: "Reflectance ↔ absorbance conversion", snr: "Not directly comparable", level: "not_comparable" },
  { family: "Spectral resampling", snr: "Depends on the new spectral step", level: "caution" },
];

export const DEFINITIONS: readonly { term: string; text: string }[] = [
  { term: "SNR (per spectrum)", text: "20·log10(mean|x| / σ), σ = MAD(second differences)·1.4826/√6 — Methods diagnostics.spectral_noise_proxy, same estimator as the engine. Descriptive amplitude ratio, not an instrument specification. Relative noise = 100·10^(−SNR/20) %." },
  { term: "Isolated peaks / abrupt changes (spectra)", text: "Share of spectra with at least one event, Methods diagnostics.spectral_population_events_qc at the fixed threshold, computed within the explorer subset." },
  { term: "Relative spectral distance (P95)", text: "P95 over spectra of the RMS distance to the subset mean spectrum (Methods diagnostics.spectral_reference_qc), divided by the median mean|x| (× typical signal level). Withheld when the processing rescales the signal." },
  { term: "Spectral distortion", text: "Median over spectra of the relative spectral RMSE below; the raw spectra are the reference (0 %)." },
  { term: "SNR gain (dB)", text: "Median over spectra of (SNR_processed − SNR_raw), paired spectrum by spectrum. Disabled for derivatives." },
  { term: "Fine-scale variation reduction (%)", text: "100·(1 − median_i σ_processed,i / σ_raw,i). Negative = more fine-scale variation after processing. Measures smoothness, not removal of instrumental noise only. Disabled for derivatives and unit changes (SNV)." },
  { term: "Relative spectral RMSE (%)", text: "Median over spectra of 100·‖x_raw − x_processed‖₂ / ‖x_raw‖₂ over all bands. Only when the processing keeps the signal unit and scale." },
  { term: "Spectral angle (°)", text: "Median over spectra of arccos(⟨x_raw, x_processed⟩ / (‖x_raw‖‖x_processed‖)): shape change insensitive to a global gain, sensitive to offsets. Disabled for derivatives." },
  { term: "Between-sample diversity retention (%)", text: "100·sqrt(Σ_b SD_b(processed)² / Σ_b SD_b(raw)²), SD_b the SD across spectra at band b. Lower is not an improvement by itself." },
  { term: "Transformation residual", text: "r(λ) = x_raw(λ) − x_processed(λ), median and P5–P95 across spectra. A residual shaped like absorption bands suggests that useful signal is removed." },
  { term: "Band descriptors", text: "Within the selected range, on the median spectrum: maximum above the straight line joining the range ends (position), its height and its full width at half height (null if the band is not closed in the range)." },
  { term: "Distortion profile (quality map)", text: "Per band |mean_i r_ib| / mean_i |x_raw,ib| for the configuration loaded in the explorer." },
];
