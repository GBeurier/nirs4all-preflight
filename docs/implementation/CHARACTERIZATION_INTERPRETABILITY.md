# Characterization interpretability (demo)

Scope: the Diagnostics page of the demo (`demo/src/characterization/`). Profile: `exploratory`. Nothing
here is a calibrated threshold, a global score or an automatic rejection rule. Every statement below is
labelled as one of: **computed** (engine report or Methods kernel), **display conversion** (arithmetic on
computed values in TypeScript), **documented reference** (published convention, cited) or **heuristic**
(indicative band chosen for readability, not validated).

## Page organisation

The page follows `_upgrade_request/image (15).png`, in this order (in-page anchors in brackets):

1. Dataset characterization overview (`s-characterization`): three separate cards, then the comment list.
2. Detailed spectral diagnostics (`s-detailed` heading, then `s-quality` and `s-repeat`): integrity, SNR and
   diversity panels (inside the spectral quality section) and repeatability / noise-proxy panels.
3. Interactive preprocessing explorer (`s-preprocessing`, loaded lazily with Methods WASM).
4. Spectral quality map (`s-quality-map`).

The remaining analyses (duplicates, structure, clustering, target, association, confounding, domains,
probe) follow unchanged. The three dimensions are never merged:

| Dimension | Question | Indicators |
| --- | --- | --- |
| Spectral integrity | Are there local anomalies or artefacts? | share of spectra with flagged isolated peaks / abrupt changes, events per affected spectrum, band frequency |
| Spectral noise and repeatability | How large is fine-scale variation and how well do repeats agree? | median SNR (dB), relative noise, noise proxy, ICC, repeatability SD |
| Spectral diversity | How heterogeneous are the samples? | distance to the mean spectrum, relative P95 distance, between-sample SD |

No indicator of one dimension is coloured good or bad using another dimension's result; diversity never
uses a good/bad colour.

## Formulas

All of these are **display conversions** of engine values unless stated otherwise.

**SNR conversions** (`shared/derive.ts`). The engine SNR is an amplitude ratio,
`SNR_dB = 20·log10(mean|x| / σ)` with `σ = MAD(second differences)·1.4826/√6` (Methods
`spectral_noise_proxy`). Hence `linear = 10^(SNR_dB/20)` and
`relative noise (%) = 100·10^(−SNR_dB/20)`. Example: 48.9 dB → 279:1 → 0.359 %. Percentiles of individual
SNRs use type-7 (linear interpolation) quantiles.

**Relative spectral distance.** `distance` is the engine `reference.rms` (RMS distance to the mean spectrum,
signal units). `typical absolute signal level` = median over spectra of the engine `noise.signal_mean_abs`
(the statistic is named wherever the value appears). `relative distance = distance / typical level`; the
card shows the P95 as a multiple (`2.73×`) and as a percentage of the typical level. It is not an error rate.
A zero or negligible typical level gives "not available", never an infinite ratio.

**Relative pooled noise proxy.** `100·pooled noise proxy / typical absolute signal level`. It can differ from
the SNR-derived relative noise (different estimator: SG smoothing residual pooled over bands vs second
differences per spectrum; curvature and anomalies inflate the residual). The repeatability module states
the divergence when the two differ by a factor of at least 2.

**Between-sample SD** (`repeatability/profiles.ts`, one-way random-effects model of the engine ICC).
Balanced groups of size r: `ICC(1,1) = (MSB − MSW)/(MSB + (r − 1)·MSW)`, `σw² = MSW`,
`σb² = (MSB − MSW)/r`, hence `σb = σw·√(ICC/(1 − ICC))` for 0 ≤ ICC < 1. A negative ICC has no real σb (null;
the ICC itself stays negative and unclipped); ICC = 1 means σw = 0 (null). With the REML ICC(1) of
unbalanced designs σb is approximate (σw stays the ANOVA pooled SD). Without replicate groups the
denominator is the between-spectrum SD (sample SD, n − 1, across development spectra) and is named so.

**ICC ↔ R.** `R = σb/σw = √(ICC/(1 − ICC))`, `ICC = R²/(1 + R²)`: ICC 0.50 ↔ R = 1, 0.75 ↔ 1.73,
0.90 ↔ 3, 0.99 ↔ 9.95. Presented only for the balanced ICC(1,1), which is the model actually fitted.

**Noise-to-diversity ratio.** `per-band noise proxy / between-sample SD` (between-spectrum SD without
replicate groups). Null where the denominator is not finite or below `1e-9 × typical signal level`; no
artificial large or infinite value. It is neither an ICC nor a share of variance due to instrument noise.

**Spectral quality map tracks.** Event frequency = engine band counts (`global_spike_band_counts`,
`global_jump_band_counts`) / spectra with a computed per-spectrum event count (a spike also counts on its two
neighbouring bands, so the counts are an upper envelope of the event positions). Preprocessing distortion
is the explorer's per-band `|mean_i (raw − processed)| / mean_i |raw|` (a fraction; see below).

**Preprocessing explorer metrics** (`preprocessing/metrics.ts`, `evaluate.ts`; Methods kernels for the
transforms and for σ/SNR/events/noise proxy/repeatability, interim TypeScript for the descriptive metrics):
SNR gain = median over spectra of `SNR_processed − SNR_raw` (paired); fine-scale reduction =
`100·(1 − median(σ_proc/σ_raw))`; relative spectral RMSE = `100·‖x − y‖₂/‖x‖₂` per spectrum (median shown);
spectral angle = `arccos(⟨x,y⟩/(‖x‖‖y‖))` per spectrum; diversity retention =
`100·√(Σ_b SD_b(proc)²/Σ_b SD_b(raw)²)`. Percentages that have no meaning after a unit or space change
(derivatives, SNV, MSC) are disabled with the reason. Diagnostic parameters are held fixed between raw and
processed; the dataset is never modified; at most 300 complete spectra are used and stated.

## Heuristic bands and references

| Band set | Classes | Status |
| --- | --- | --- |
| ICC | < 0 (negative, kept as estimated), < 0.50 poor, 0.50–0.75 moderate, 0.75–0.90 good, ≥ 0.90 excellent | documented reference: Koo & Li (2016), *J Chiropr Med* 15(2):155–163. General ICC conventions, not NIR criteria. The "negative" class is ours: it keeps negative estimates visible instead of clipping them to poor. |
| Noise-to-diversity ratio | < 0.10 low, 0.10–0.30 moderate, 0.30–1.00 substantial, ≥ 1.00 exceeds diversity | heuristic, exploratory, not metrologically validated |
| Relative noise from SNR | < 20 dB very high … > 80 dB extremely low (7 classes) | heuristic, describes relative amplitude only |
| Elevated-region threshold of the comments | ratio ≥ 0.30, at least 3 consecutive evaluable bands | heuristic (same "substantial" class) |

Instrument SNR references (integrity module) are documentary, sourced separately and never used to define the
internal bands.

## Comment framework

`overview/comments.ts`. A rule is `{ id, dimension, when(ctx), text(ctx) }`; the order is the declaration
order within a dimension and the dimensions are ordered integrity, noise, diversity, repeatability, cross.
Duplicates are dropped by rule id and by normalised text. Texts come from explicit templates over computed
values; there is no text generation and no comment is emitted without the result that demonstrates it.
Single-dimension rules live with their owners and reach the list through their summaries
(`integritySummary`, `snrSummary`, `diversitySummary`, `repeatabilitySummary`, `noiseProxySummary`).
Cross-dimension rules (`CROSS_RULES`):

| Id | Emitted when | Not emitted when |
| --- | --- | --- |
| `cross.low-snr-flagged` | at least 5 spectra in the lowest-SNR list, at least 3 and at least half of them carry a flagged event, and that share is at least twice the dataset-wide flagged rate | fewer than 3 flagged, below half, dataset rate already as high, rate unknown |
| `cross.events-in-elevated-regions` | at least 3 flagged bands, at least half of them inside runs of ≥ 3 consecutive bands with ratio ≥ 0.30, and at least twice the share of evaluable bands those runs cover | flagged bands outside the runs, too few, no enrichment, length mismatch |
| `cross.distance-dominates-noise` | relative P95 distance / relative noise ≥ 10 | either value missing or ≤ 0, ratio below 10 |
| `cross.distance-near-noise` | same ratio ≤ 3 | ratio between 3 and 10, values missing |
| `cross.noise-proxy-only` | repeatability unavailable and noise proxy computed | replicates available or noise proxy not computed |
| `cross.preprocessing-distortion` | explorer pipeline with fine-scale reduction ≥ 10 % and median distortion ≥ 5 % of the local mean absolute signal (selected interval, else whole range) | reduction withheld or small, mild distortion, no distortion profile |

The distortion and reduction thresholds are heuristic and stated in the comment. Examples quoted in the
request (e.g. "Several contiguous wavelength regions exhibit elevated fine-scale variation…") are produced by the
owner modules' rules; they are not duplicated here.

## Spectral quality map

Tracks (each with its own scale and legend, in this order): repeatability SD, ICC, local noise proxy,
noise-to-diversity ratio, isolated peak frequency, abrupt change frequency, preprocessing distortion,
between-sample (or between-spectrum) diversity.

- Intensities use ordered single-hue sequential ramps (ColorBrewer), from each track's own minimum to maximum
  (frequencies start at zero). Categorical classes only for ICC and the noise-to-diversity ratio.
- No red/green pair anywhere; diversity uses a purple ramp with no good/bad meaning.
- Non-evaluable bands are hatched grey; values and classes are also in the tooltip, the interval summary,
  the legend counts and the chart data table (so colour is never the only carrier).
- Unavailable tracks are not drawn; the reason replaces the strip (for example "no technical replicate groups
  have been declared"; "not computed, open the preprocessing explorer").
- Interactions (shared aligned-tracks component): hover cursor and tooltip across all tracks, drag to select an
  interval, Ctrl/⌘ + wheel zoom, Shift + drag pan, keyboard arrows. A click on a band opens the detailed panel of
  that track; an interval offers the matching panels. Selected intervals can be marked "to investigate"
  (local state, JSON export). The marks are never used by an analysis.
- Provenance of estimator parameters (SG window and order, ICC model and context, denominator) is printed
  in each legend. Axes may be wavelength, wavenumber or band index, in any direction and spacing; no fixed range
  is assumed.

## Exports

`Section`'s generic "Export tables (CSV)" exports the quality-map data table (axis, track values, class labels)
with the demo's CSV dialect; the map chart is exported as SVG by the shared chart exporter where applicable; the
manual regions export as `<source>-regions-to-investigate.json`.

## Limits

- Heuristic classes are indicative only; they do not rank instruments or certify quality.
- The noise proxy and SNR are exploratory roughness estimates: real narrow features and systematic artefacts
  contribute to them.
- The map reads the first repeatability and first noise-proxy context of the source; other contexts remain in
  their panels.
- A high ICC means good repeatability relative to sample diversity; a low ICC may reflect little between-sample
  variability.
- Cross-dimension comments state co-occurrence, not cause.
- Raw/Preprocessed comparison on the map itself is not implemented: the explorer holds the comparison, and the
  map shows the distortion of the configuration currently loaded there.
