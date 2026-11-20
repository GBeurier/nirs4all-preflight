// English UI strings of the "Shift between domains" section (wave 2). Exploratory profile: no calibrated
// thresholds, no global domain-shift score, significance kept apart from magnitude.

export const DOMAINS = {
  title: "Shift between domains",
  lead: "Compare spectral populations across sample groups, instruments, acquisition contexts or calibration and validation domains. Assess differences in spectral centres, diversity and coverage to identify potential domain shifts and limitations in population representativeness. Spectral differences alone do not establish a loss of predictive performance.",
  dimensions: [
    { id: "location", title: "Location shift", text: "Typical spectra: distance between the domain centres." },
    { id: "dispersion", title: "Dispersion shift", text: "Diversity: total spectral variance of each domain." },
    { id: "coverage", title: "Domain coverage", text: "Compatibility with the reference spectral space (T² and Q)." },
    { id: "distribution", title: "Distribution shift", text: "Overall difference of the distributions (energy distance)." },
  ],
  noScore: "No global domain-shift score is computed: the four dimensions are read separately, and statistical significance is kept apart from magnitude and practical relevance.",
  reference: "Reference",
  compared: "Compared",
  inferenceUnavailableTitle: "Statistical inference unavailable",
  inferenceUnavailableText: "The spectral populations can be compared descriptively, but an energy permutation test requires a valid definition of independent experimental units and an appropriate exchangeability structure.",
  inferenceMissing: "Missing or unresolved declarations",
  inferenceNoInvent: "Groups are never invented from row identifiers; the descriptive diagnostics below remain available.",
  openSettings: "Open dataset settings",
  targetProtected: "Target shift is intentionally not evaluated. Retained-test target values remain protected.",
  targetProtectedNote: "Retained-test Y is never read, summarized, cached or passed to these views (engine reason RETAINED_TEST_Y_NEVER_READ). This is distinct from a missing target.",
  centreHeader: "Measure the displacement between the mean spectra of the reference and compared domains. A centre shift may reflect differences in sample composition, scattering, baseline, acquisition conditions or instrument response.",
  dispersionHeader: "Compare the overall spectral variability of the two domains. A ratio below one indicates a narrower compared population, while a ratio above one indicates greater spectral diversity.",
  overlapHeader: "Explore whether the two populations occupy similar regions of spectral space and whether their distributions differ in position, spread or shape.",
  coverageHeader: "Assess whether compared samples occupy regions and spectral structures represented by the reference population. Hotelling T² measures distance within the reference latent space, while Q measures residual variation outside that space.",
  energyHeader: "Quantify overall differences between spectral distributions, including differences in location, dispersion and shape that may not be captured by mean spectra or PCA projections alone.",
  testHeader: "Assess whether the observed spectral distribution difference is larger than expected under an appropriate exchangeability hypothesis.",
  asymmetryHeader: "Two separate questions: is the compared population supported by the reference population, and does it represent the reference diversity?",
  illustrationTitle: "Illustration of principle: four kinds of population shift",
  illustrationNote: "Simulated two-dimensional points drawn for illustration only; they are not your data.",
  lowerIsNotBetter: "Lower dispersion is not better quality: it only means a narrower population.",
  unionNote: "Two nominal 5 % limits do not imply a combined 5 % rate: the share beyond either limit is never compared to 5 %.",
  notFailure: "Exceedance is descriptive coverage, not a probability of prediction failure.",
  twoPcNote: "Overlap in two principal components does not establish overlap in the full spectral space.",
  percentileNotP: "The reference percentile is a descriptive position within resampled internal distances, not a p-value.",
  nonSignificant: "No statistically significant evidence of distribution shift under the specified test. This is not evidence of equivalence.",
  significant: "A significant test does not establish a deterioration of prediction performance.",
  computing: "Computing per-sample diagnostics with the Methods WASM kernels…",
} as const;

/** Reason codes of a blocked energy permutation test → the missing declaration, in plain words. */
export const BLOCKING_REASONS: Record<string, string> = {
  INDEPENDENCE_UNIT_UNKNOWN: "Independent experimental unit (sample, reference group or declared group) is not declared.",
  MISSING_INDEPENDENCE_GROUP: "An independence group is missing for some samples.",
  EXCHANGEABILITY_NOT_DECLARED: "Exchangeability of the independent units is not declared.",
  FACTOR_VARIES_WITHIN_INDEPENDENCE_UNIT: "Blocks or contexts: the domain factor varies within an independent unit.",
  UNEQUAL_UNIT_COMPOSITION: "Technical replicate grouping: units hold different numbers of acquisitions, so no balanced test is qualified.",
  PERMUTATION_RESOLUTION_INSUFFICIENT: "Too few distinct permutations to resolve the family level.",
};
