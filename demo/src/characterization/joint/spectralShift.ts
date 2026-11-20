// Spectral description of one development / validation split (spec §10), on unit-mean spectra:
// - centre shift: Euclidean norm of the centroid difference / sqrt(development total variance, ddof 1), the
//   definition of the engine's relative centre shift (domain_shift.rs; mirrored in domains/model.ts `CentreModel`);
// - dispersion ratio: validation total variance / development total variance (ddof 1, engine `variance_ratio`);
// - reference T²/Q coverage: Methods `statsPcaMonitor` fitted on the development units only (engine monitor shape,
//   complete spectra, alpha 0.05), share of validation units inside both limits.
// Methods kernels via the domain module's loader; display arithmetic only in TS. Interim demo computation
// (debt: docs/implementation/debt/characterization-joint.md).
import { loadMethods, matrix, monitorShape } from "../domains/kernels";

export interface FoldSpectral {
  centreShift: number | null;
  dispersionRatio: number | null;
  /** Share of validation units inside both development T² and Q limits. */
  coverage: number | null;
  nBeyondEither: number | null;
  components: number | null;
  note: string | null;
}

type Methods = Awaited<ReturnType<typeof loadMethods>>;

function moments(rows: readonly (readonly number[])[]): { mean: number[]; total: number | null } {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  const mean = new Array<number>(p).fill(0);
  for (const r of rows) for (let c = 0; c < p; c++) mean[c]! += r[c]! / n;
  if (n < 2) return { mean, total: null };
  let total = 0;
  for (const r of rows) for (let c = 0; c < p; c++) total += (r[c]! - mean[c]!) ** 2;
  return { mean, total: total / (n - 1) };
}

export function foldSpectral(m: Methods, dev: readonly (readonly number[])[], val: readonly (readonly number[])[]): FoldSpectral {
  const d = moments(dev);
  const v = moments(val);
  let dist = 0;
  d.mean.forEach((x, c) => (dist += (x - v.mean[c]!) ** 2));
  dist = Math.sqrt(dist);
  const centreShift = d.total !== null && d.total > 0 ? dist / Math.sqrt(d.total) : null;
  const dispersionRatio = d.total !== null && d.total > 0 && v.total !== null ? v.total / d.total : null;
  const p = dev[0]?.length ?? 0;
  if (dev.length < 3 || !val.length || p < 1) return { centreShift, dispersionRatio, coverage: null, nBeyondEither: null, components: null, note: "FEWER_THAN_THREE_DEVELOPMENT_UNITS" };
  const [folds, k] = monitorShape(dev.length, p);
  if (k < 1) return { centreShift, dispersionRatio, coverage: null, nBeyondEither: null, components: null, note: "NO_MONITOR_COMPONENT" };
  const r = m.statsPcaMonitor(matrix(dev), matrix(val), k, folds, 0.05);
  return { centreShift, dispersionRatio, coverage: 1 - r.nBeyondEither / val.length, nBeyondEither: r.nBeyondEither, components: r.effectiveComponents, note: null };
}

export interface SpectralRequest {
  spectra: number[][];
  folds: { development: number[]; validation: number[] }[];
}

export async function scenarioSpectral(req: SpectralRequest): Promise<(FoldSpectral | { error: string })[]> {
  const m = await loadMethods();
  return req.folds.map((f) => {
    try {
      return foldSpectral(m, f.development.map((i) => req.spectra[i]!), f.validation.map((i) => req.spectra[i]!));
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
}
