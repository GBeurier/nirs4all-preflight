// Documentary references: published signal-to-noise figures of commercial NIR spectrometers.
// Context only — they never define the internal gauge bands. Only values read on the cited
// source are filled (checked 2026-11-20); anything else stays null with "not verified".
// Photometric noise (AU / µAU) is never converted to an SNR.

export interface InstrumentReference {
  id: string;
  manufacturer: string;
  model: string;
  /** published amplitude ratio S/N, exactly as printed (null when not verified or not published) */
  snr: number | null;
  /** wording/unit of the published figure */
  unit: string;
  /** wavelength or condition at which the figure is stated */
  condition: string | null;
  spectralRange: string | null;
  protocol: string | null;
  /** "manufacturer" specification or independent "study" measurement */
  kind: "manufacturer" | "study";
  source: { title: string; url: string };
  verified: boolean;
  /** why this figure cannot be compared directly with the dataset estimate */
  limits: string;
}

/** Indicative documentary conversion 20·log10(S/N), assuming an amplitude ratio. */
export const referenceDb = (r: InstrumentReference): number | null => (r.snr !== null && r.snr > 0 ? 20 * Math.log10(r.snr) : null);

const SPEC = "Manufacturer specification; measurement protocol, integration time and noise definition are not harmonised with the dataset estimator.";
const UNITY = "Independent vendor study (Unity Scientific, 2014 white paper data): R99 reflectance standard, RMS and S/N over 3 static replicates. A competitor's measurement, not a manufacturer specification.";
const UNITY_SOURCE = { title: "Unity Scientific, IAOM 2017 presentation, slide 16 (Table 2, 2014 data)", url: "https://www.iaom.org/wp-content/uploads/04unityscwst17.pdf" };

export const INSTRUMENT_REFERENCES: readonly InstrumentReference[] = [
  { id: "asd-labspec4-700", manufacturer: "Malvern Panalytical (ASD)", model: "LabSpec 4 Standard-Res (VNIR)", snr: 9000, unit: "S/N ratio (9,000:1)", condition: "at 700 nm", spectralRange: "350–2500 nm", protocol: null, kind: "manufacturer", verified: true, limits: SPEC, source: { title: "LabSpec 4 Standard-Res lab analyzer — Malvern Panalytical product page", url: "https://www.malvernpanalytical.com/fr/products/product-range/asd-range/labspec-range/labspec-4-standard-res-lab-analyzer" } },
  { id: "asd-labspec4-1400", manufacturer: "Malvern Panalytical (ASD)", model: "LabSpec 4 Standard-Res (SWIR 1)", snr: 9000, unit: "S/N ratio (9,000:1)", condition: "at 1400 nm", spectralRange: "350–2500 nm", protocol: null, kind: "manufacturer", verified: true, limits: SPEC, source: { title: "LabSpec 4 Standard-Res lab analyzer — Malvern Panalytical product page", url: "https://www.malvernpanalytical.com/fr/products/product-range/asd-range/labspec-range/labspec-4-standard-res-lab-analyzer" } },
  { id: "asd-labspec4-2100", manufacturer: "Malvern Panalytical (ASD)", model: "LabSpec 4 Standard-Res (SWIR 2)", snr: 4000, unit: "S/N ratio (4,000:1)", condition: "at 2100 nm", spectralRange: "350–2500 nm", protocol: null, kind: "manufacturer", verified: true, limits: SPEC, source: { title: "LabSpec 4 Standard-Res lab analyzer — Malvern Panalytical product page", url: "https://www.malvernpanalytical.com/fr/products/product-range/asd-range/labspec-range/labspec-4-standard-res-lab-analyzer" } },
  { id: "asd-fieldspec4", manufacturer: "Malvern Panalytical (ASD)", model: "FieldSpec 4 Standard-Res", snr: null, unit: "not published as S/N (noise-equivalent radiance only)", condition: null, spectralRange: "350–2500 nm", protocol: null, kind: "manufacturer", verified: false, limits: "No numerical S/N is published; NEdL radiance noise is not convertible to an S/N without the signal radiance.", source: { title: "ASD FieldSpec 4 Standard-Res spectroradiometer — Malvern Panalytical product page", url: "https://www.malvernpanalytical.com/en/products/product-range/asd-range/fieldspec-range/fieldspec-4-standard-res-spectroradiometer" } },
  { id: "foss-ds2500", manufacturer: "FOSS", model: "NIRS DS2500", snr: 22689, unit: "S/N ratio", condition: "1100–2500 nm", spectralRange: null, protocol: "R99 reflectance standard, 3 static replicates", kind: "study", verified: true, limits: UNITY, source: UNITY_SOURCE },
  { id: "buchi-n500", manufacturer: "Büchi", model: "NIRFlex N-500", snr: 10000, unit: "S/N", condition: "peak-to-peak noise of a linear-corrected baseline, 5600–6000 cm⁻¹", spectralRange: "800–2500 nm (12500–4000 cm⁻¹)", protocol: "NIRFlex Liquids, 2 × 64 scans, Blackman apodisation", kind: "manufacturer", verified: true, limits: `${SPEC} Read on a third-party mirror of the operation manual (document 11593575G, 08.2023).`, source: { title: "N-500 NIRFlex Operation Manual, 11593575G (manualsnet mirror)", url: "https://manualsnet.com/buchi/n-500-nirflex" } },
  { id: "buchi-n500-unity", manufacturer: "Büchi", model: "NIRFlex N-500", snr: 5952, unit: "S/N ratio", condition: "1100–2500 nm", spectralRange: null, protocol: "R99 reflectance standard, 3 static replicates", kind: "study", verified: true, limits: UNITY, source: UNITY_SOURCE },
  { id: "bruker-tango", manufacturer: "Bruker", model: "TANGO", snr: 1446, unit: "S/N ratio", condition: "1100–2500 nm", spectralRange: null, protocol: "R99 reflectance standard, 3 static replicates", kind: "study", verified: true, limits: UNITY, source: UNITY_SOURCE },
  { id: "bruker-mpa", manufacturer: "Bruker", model: "MPA", snr: null, unit: "not verified", condition: null, spectralRange: null, protocol: null, kind: "manufacturer", verified: false, limits: "No published S/N figure was verified.", source: { title: "Not verified", url: "" } },
  { id: "ti-nirscan-evm", manufacturer: "Texas Instruments", model: "DLP NIRscan EVM (high-performance)", snr: 30000, unit: "S/N ratio (30,000:1)", condition: "transmissive head", spectralRange: "1350–2490 nm", protocol: null, kind: "manufacturer", verified: true, limits: `${SPEC} Evaluation module, not a production analyser.`, source: { title: "DLPNIRSCANEVM evaluation board — TI.com", url: "https://www.ti.com/tool/DLPNIRSCANEVM" } },
  { id: "ti-nirscan-nano", manufacturer: "Texas Instruments", model: "DLP NIRscan Nano EVM", snr: 6000, unit: "S/N ratio (6,000:1)", condition: "reflective head", spectralRange: "900–1700 nm", protocol: null, kind: "manufacturer", verified: true, limits: `${SPEC} Evaluation module, not a production analyser.`, source: { title: "DLPNIRNANOEVM evaluation board — TI.com", url: "https://www.ti.com/tool/DLPNIRNANOEVM" } },
  { id: "viavi-micronir-onsite-w", manufacturer: "VIAVI Solutions", model: "MicroNIR OnSite-W", snr: 25000, unit: "S/N ratio (typical)", condition: "typical value", spectralRange: "908–1676 nm", protocol: null, kind: "manufacturer", verified: true, limits: SPEC, source: { title: "MicroNIR OnSite-W — VIAVI Solutions product page", url: "https://www.viavisolutions.com/en-us/osp/products/micronir-onsite-w" } },
];

/**
 * Listed apart, never plotted: its specification is photometric RMS noise (µAU), which is not an
 * S/N and cannot be converted without the reference signal level and measurement conditions.
 */
export const NON_CONVERTIBLE_REFERENCES = [
  {
    id: "perkinelmer-spectrum-two-n",
    manufacturer: "PerkinElmer",
    model: "Spectrum Two N (FT-NIR)",
    published: "Specified as typical RMS photometric noise in µAU (transmission / reflectance / remote sampling). Value not verified: the cited specification sheet could not be retrieved on 2026-11-20.",
    verified: false,
    source: { title: "Spectrum Two N FT-NIR specifications (2017)", url: "https://s4science.at/wordpress/wp-content/uploads/2018/02/Spectrum-Two-N-FT-NIR-Specifications_English.pdf" },
    limits: "Photometric noise in absorbance units is not a signal-to-noise ratio; no conversion is made.",
  },
] as const;

export const INSTRUMENT_DISCLAIMER =
  "Manufacturer specifications and dataset-derived SNR estimates are obtained using different measurement and estimation protocols. This comparison provides context only and cannot be used to rank instruments or assess compliance with manufacturer specifications.";
