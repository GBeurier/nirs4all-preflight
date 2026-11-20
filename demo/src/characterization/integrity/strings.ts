// UI text of the integrity / SNR / diversity panels (English only; owned by this module).
export const S = {
  eventsTitle: "Spectra with isolated peaks and abrupt changes",
  eventsLead:
    "Detect localized spectral anomalies by comparing derivatives across spectra at each wavelength. These tests identify unusual spikes or abrupt transitions that may deserve inspection, rather than absorption features shared by the spectral population.",
  eventsWarning:
    "These are inspection flags, not automatic rejection criteria. Unusual but chemically meaningful spectral features may also be detected. Common artifacts shared by most spectra may remain undetected.",
  eventsLimits: [
    "Flags mark derivatives atypical relative to the other spectra at the same band (robust deviation above the threshold), not confirmed defects.",
    "The number of events is not a severity: several adjacent flagged positions may belong to a single physical anomaly. Per-spectrum event positions are not reported by the engine, so contiguous flags cannot be merged here.",
    "In the band profile a spike also counts on its two neighbouring bands; band counts are therefore not event counts.",
    "The flag rate depends on the number of bands, the spectral step and the reference population (development spectra); rare chemical bands can be flagged and an artifact common to all spectra can pass unnoticed.",
  ],
  eventsInvestigate: [
    "Open the flagged spectra and look at the selected band region before deciding anything.",
    "If flags recur in one region, check detector splices, order-sorting filters or a contaminant band there.",
    "If flags concentrate in a few spectra, check those acquisitions (session, operator, sample presentation).",
    "Compare with a despiking preprocessing in the preprocessing explorer rather than excluding spectra.",
  ],
  heatmapUnavailable:
    "Spectra × wavelength map unavailable: the engine reports per-spectrum event counts and per-band counts, but not the positions of the events within each spectrum, and the Methods kernel does not expose them either. Recomputing them here would duplicate the owner kernel.",
  snrTitle: "Estimated signal-to-noise ratio",
  snrLead:
    "Estimate the magnitude of fine-scale spectral fluctuations relative to the overall signal level. This indicator provides an exploratory assessment of spectral roughness and should not be interpreted as a calibrated instrumental signal-to-noise ratio.",
  snrDefinition:
    "Per spectrum: SNR = 20·log10(mean|x| / σ), σ = MAD of second differences × 1.4826 / √6 (Methods diagnostics.spectral_noise_proxy). Linear SNR = 10^(SNR/20); estimated relative noise = 100 × 10^(−SNR/20) % of the mean absolute signal.",
  snrBandsNote:
    "Indicative bands: they describe the estimated relative amplitude of fine-scale variation and are not validated analytical quality thresholds. They are mathematical landmarks, independent of the instrument references.",
  snrCompare: "Compare only datasets with similar acquisition, wavelength sampling, signal representation and preprocessing.",
  snrLimits: [
    "The estimator measures fine-scale roughness (second differences), not instrument noise measured on a reference: narrow real absorption features, spikes and the spectral step all contribute.",
    "mean|x| depends on the signal representation and any constant offset: absorbance, reflectance or preprocessed spectra give different values.",
    "The median of the per-spectrum dB values is reported; its conversions are exact inverses of the dB definition.",
  ],
  snrInvestigate: [
    "Inspect the spectra with the lowest SNR (table below) for detector saturation, low reflectance or acquisition problems.",
    "If the SNR spread is large, check whether low-SNR spectra share a session, instrument or sample type.",
    "Use the preprocessing explorer to see how smoothing changes fine-scale variation, keeping in mind that higher SNR is not necessarily better analytically.",
  ],
  contrastNote:
    "Contrast-based SNR (interim, computed in this page): 20·log10([Q95(x) − Q5(x)] / σ) per spectrum, with σ the engine noise estimate and Q5/Q95 over that spectrum's valid bands. Less sensitive to a constant offset than mean|x|.",
  instrumentsTitle: "Published instrument figures (documentary context)",
  diversityTitle: "Distance from the mean spectrum",
  diversityLead:
    "Characterize spectral diversity by measuring how far individual spectra differ from the mean spectrum. Large distances may reflect sample heterogeneity, baseline shifts, scattering effects, acquisition differences or unusual spectral profiles. Spectral diversity is not inherently a quality defect.",
  diversityWarning:
    "Large spectral distances indicate heterogeneity, not necessarily poor data quality. Investigate whether the observed variability reflects meaningful sample differences or unwanted acquisition effects.",
  diversityLimits: [
    "Distance = RMS difference between a spectrum and the mean spectrum of the evaluated spectra (Methods diagnostics.spectral_reference_qc), in signal units.",
    "Typical absolute signal level = median over spectra of the mean absolute signal (engine noise.signal_mean_abs). The relative distance is a scale indication, not an error rate; it is N/A when that level is zero or negligible, and it remains sensitive to the representation and to constant offsets.",
    "No universal threshold of good or bad diversity exists: spectra are only atypical relative to this dataset's own distribution.",
  ],
  diversityInvestigate: [
    "Select a range of the distribution to overlay those spectra on the mean spectrum and its P5–P95 envelope.",
    "Compare raw and SNV distances to see whether the dispersion comes from overall level/scale or from spectral shape.",
    "Check whether the most distant spectra share metadata (instrument, campaign, sample type) in the structure and confounding sections.",
  ],
} as const;
