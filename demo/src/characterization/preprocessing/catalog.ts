// Preprocessing step catalog for the explorer. Every step is a `@nirs4all/methods` 1.5 transformer
// (see methodsKernel.ts) except the median filter and despiking, which Methods does not expose yet:
// they are interim local transformers (localSteps.ts, `local: true`), recorded as Methods debt.

/** How a step's output can be compared with the raw spectra on the same scale. */
export type Comparability = "comparable" | "caution" | "not_comparable";

export type StepKind = "savgol" | "gaussian" | "wavelet" | "median" | "despike" | "snv" | "msc" | "detrend" | "sg_d1" | "sg_d2";

export type ParamSpec =
  | { name: string; label: string; type: "int"; min: number; max: number; step?: number; odd?: boolean; unit?: string }
  | { name: string; label: string; type: "float"; min: number; max: number; step: number; unit?: string }
  | { name: string; label: string; type: "choice"; choices: readonly string[] };

export type ParamValues = Record<string, number | string>;

export interface StepSpec {
  kind: StepKind;
  label: string;
  /** Methods catalog method id, for provenance. */
  methodId: string;
  family: "smoothing" | "denoising" | "scatter" | "baseline" | "derivative";
  comparability: Comparability;
  /** Output keeps the raw signal unit and scale (residual raw − processed is meaningful). */
  preservesUnits: boolean;
  params: readonly ParamSpec[];
  defaults: ParamValues;
  note: string;
  /** Interim implementation computed in the demo (localSteps.ts), not a Methods transformer. */
  local?: boolean;
  /** Learns parameters from the rows it is fitted on (applyPipelineFitted fits them on reference rows only). */
  learned?: boolean;
}

const window = (max = 101): ParamSpec => ({ name: "window", label: "Window length", type: "int", min: 3, max, step: 2, odd: true, unit: "bands" });

export const STEP_SPECS: Record<StepKind, StepSpec> = {
  savgol: {
    kind: "savgol", label: "Savitzky–Golay smoothing", methodId: "preprocessing.derivatives.savitzky_golay", family: "smoothing",
    comparability: "comparable", preservesUnits: true,
    params: [window(), { name: "polyorder", label: "Polynomial order", type: "int", min: 0, max: 6 }],
    defaults: { window: 11, polyorder: 2 }, note: "Local polynomial fit; the window is counted in bands, not axis units.",
  },
  gaussian: {
    kind: "gaussian", label: "Gaussian smoothing", methodId: "preprocessing.smoothing.gaussian", family: "smoothing",
    comparability: "comparable", preservesUnits: true,
    params: [{ name: "sigma", label: "Sigma", type: "float", min: 0.25, max: 20, step: 0.25, unit: "bands" }],
    defaults: { sigma: 1.5 }, note: "Gaussian kernel, sigma in bands, reflect edges, truncated at 4 sigma.",
  },
  wavelet: {
    kind: "wavelet", label: "Wavelet denoising", methodId: "preprocessing.wavelets.wavelet_denoise", family: "denoising",
    comparability: "comparable", preservesUnits: true,
    params: [
      { name: "family", label: "Wavelet family", type: "choice", choices: ["db4", "sym4", "coif1", "haar"] },
      { name: "level", label: "Decomposition level", type: "int", min: 1, max: 8 },
      { name: "threshold_mode", label: "Threshold", type: "choice", choices: ["soft", "hard"] },
    ],
    defaults: { family: "db4", level: 3, threshold_mode: "soft" }, note: "Universal threshold with a median (MAD) noise estimate, periodization edges.",
  },
  median: {
    kind: "median", label: "Median filter", methodId: "local.median_filter", family: "denoising",
    comparability: "comparable", preservesUnits: true, local: true,
    params: [{ name: "window", label: "Window length", type: "int", min: 3, max: 51, step: 2, odd: true, unit: "bands" }],
    defaults: { window: 5 },
    note: "Running median over the window; edges reflected (half-sample symmetric, as scipy.ndimage 'reflect'). Computed locally in the demo (interim, no Methods transformer yet).",
  },
  despike: {
    kind: "despike", label: "Despiking (Whitaker–Hayes)", methodId: "local.despike_whitaker_hayes", family: "denoising",
    comparability: "comparable", preservesUnits: true, local: true,
    params: [
      { name: "threshold", label: "Modified z-score threshold", type: "float", min: 2, max: 20, step: 0.5 },
      { name: "half_window", label: "Replacement half-window", type: "int", min: 1, max: 10, unit: "bands" },
    ],
    defaults: { threshold: 6, half_window: 3 },
    note: "Flags points whose first difference has |modified z| = |0.6745·(Δ − median Δ)/MAD| above the threshold; each is replaced by the median of the unflagged points within the half-window. Computed locally in the demo (interim, no Methods transformer yet).",
  },
  snv: {
    kind: "snv", label: "SNV", methodId: "preprocessing.scatter.snv", family: "scatter",
    comparability: "caution", preservesUnits: false, params: [], defaults: {},
    note: "Each spectrum centred and divided by its own SD: the output is dimensionless.",
  },
  msc: {
    kind: "msc", label: "MSC", methodId: "preprocessing.scatter.msc", family: "scatter",
    comparability: "caution", preservesUnits: true, params: [], defaults: {}, learned: true,
    note: "Reference = mean of the spectra the step is fitted on: the explorer subset here; the training fold only in the chemometric validation.",
  },
  detrend: {
    kind: "detrend", label: "Detrending", methodId: "preprocessing.baselines.detrend", family: "baseline",
    comparability: "caution", preservesUnits: true,
    params: [{ name: "polyorder", label: "Polynomial order", type: "int", min: 0, max: 4 }],
    defaults: { polyorder: 1 }, note: "Per-spectrum polynomial baseline removed (fit over band index).",
  },
  sg_d1: {
    kind: "sg_d1", label: "Savitzky–Golay 1st derivative", methodId: "preprocessing.derivatives.savitzky_golay", family: "derivative",
    comparability: "not_comparable", preservesUnits: false,
    params: [window(), { name: "polyorder", label: "Polynomial order", type: "int", min: 1, max: 6 }],
    defaults: { window: 11, polyorder: 2 }, note: "Scaled by the median axis step: signal unit per axis unit.",
  },
  sg_d2: {
    kind: "sg_d2", label: "Savitzky–Golay 2nd derivative", methodId: "preprocessing.derivatives.savitzky_golay", family: "derivative",
    comparability: "not_comparable", preservesUnits: false,
    params: [window(), { name: "polyorder", label: "Polynomial order", type: "int", min: 2, max: 6 }],
    defaults: { window: 15, polyorder: 3 }, note: "Scaled by the squared median axis step: signal unit per axis unit².",
  },
};

export const STEP_KINDS = Object.keys(STEP_SPECS) as StepKind[];


export interface PipelineStep {
  /** Stable client id for React keys and reordering. */
  id: string;
  kind: StepKind;
  params: ParamValues;
}

let counter = 0;
export const newStep = (kind: StepKind, params?: ParamValues): PipelineStep => ({
  id: `step-${++counter}`,
  kind,
  params: { ...STEP_SPECS[kind].defaults, ...params },
});

/** Clamp/round a parameter to its spec (odd windows, integer ranges, known choices). */
export function coerceParam(spec: ParamSpec, raw: number | string): number | string {
  if (spec.type === "choice") return spec.choices.includes(String(raw)) ? String(raw) : spec.choices[0]!;
  let v = Number(raw);
  if (!Number.isFinite(v)) v = spec.min;
  v = Math.min(spec.max, Math.max(spec.min, v));
  if (spec.type === "int") {
    v = Math.round(v);
    if (spec.odd && v % 2 === 0) v = v + 1 <= spec.max ? v + 1 : v - 1;
  }
  return v;
}

/**
 * Parameter consistency against the spectrum width; returns a reason or null when the step can run.
 * The Methods kernels refuse invalid shapes too; this only explains the refusal in the UI first.
 */
export function stepIssue(step: PipelineStep, bands: number): string | null {
  const p = step.params;
  if (step.kind === "savgol" || step.kind === "sg_d1" || step.kind === "sg_d2") {
    const w = Number(p.window), k = Number(p.polyorder);
    const deriv = step.kind === "sg_d1" ? 1 : step.kind === "sg_d2" ? 2 : 0;
    if (w > bands) return `Window ${w} exceeds the ${bands} bands.`;
    if (k >= w) return `Polynomial order ${k} must be below the window ${w}.`;
    if (k < deriv) return `Polynomial order must be at least the derivative order ${deriv}.`;
  }
  if (step.kind === "median" && Number(p.window) > bands) return `Window ${p.window} exceeds the ${bands} bands.`;
  if (step.kind === "detrend" && Number(p.polyorder) >= bands) return `Polynomial order must be below the ${bands} bands.`;
  if (step.kind === "wavelet" && 2 ** Number(p.level) > bands) return `Level ${p.level} needs at least ${2 ** Number(p.level)} bands.`;
  return null;
}

/** Worst comparability over the pipeline; an empty pipeline is comparable (identity). */
export function pipelineComparability(steps: readonly PipelineStep[]): Comparability {
  const rank: Record<Comparability, number> = { comparable: 0, caution: 1, not_comparable: 2 };
  return steps.reduce<Comparability>((worst, s) => (rank[STEP_SPECS[s.kind].comparability] > rank[worst] ? STEP_SPECS[s.kind].comparability : worst), "comparable");
}

/** True when every step keeps the raw signal unit and scale. */
export const pipelinePreservesUnits = (steps: readonly PipelineStep[]): boolean => steps.every((s) => STEP_SPECS[s.kind].preservesUnits);

/** Short human-readable label, e.g. "Savitzky–Golay smoothing (window 11, polyorder 2) → SNV". */
export function pipelineLabel(steps: readonly PipelineStep[]): string {
  if (!steps.length) return "Raw (no preprocessing)";
  return steps
    .map((s) => {
      const spec = STEP_SPECS[s.kind];
      const args = spec.params.map((ps) => `${ps.name} ${s.params[ps.name]}`).join(", ");
      return args ? `${spec.label} (${args})` : spec.label;
    })
    .join(" → ");
}

/** Pipeline without client ids (worker payloads, benchmark keys). */
export const stripIds = (steps: readonly PipelineStep[]) => steps.map(({ kind, params }) => ({ kind, params: { ...params } }));
export type StepRecipe = ReturnType<typeof stripIds>[number];
