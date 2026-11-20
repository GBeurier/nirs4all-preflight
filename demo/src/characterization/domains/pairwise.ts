// Pairwise matrix of normalized domain-shift metrics between every ordered pair of levels of one factor
// (interim, computed locally in the demo; the engine publishes level-vs-rest comparisons only). Same units,
// spaces and definitions as the engine comparison metrics: centre shift and dispersion in the monitor input
// space, energy in the energy input space (leading label-free PCA of every development unit unless the
// complete-spectra options are declared), V-statistic means. Direction is explicit: reference → compared.
import { leadingSpace, type loadMethods } from "./kernels";
import { condensedDistances } from "./permutation";

type Methods = Awaited<ReturnType<typeof loadMethods>>;

export interface PairwiseRequest {
  development: number[][];
  /** Index (into development) and level code of each analysed unit. */
  index: number[];
  codes: number[];
  levels: string[];
  energyOnSpectra: boolean;
  monitorOnSpectra: boolean;
}

export interface PairCell {
  reference: number;
  compared: number;
  /** ‖mean_c − mean_r‖ ÷ √(trace of the reference covariance, ddof 1). */
  relativeCentre: number | null;
  /** trace(cov_c) ÷ trace(cov_r). */
  dispersionRatio: number | null;
  /** energy_e(r, c) ÷ mean within-reference distance (V-statistic, self-pairs included). */
  relativeEnergy: number | null;
}

export interface PairwiseResult {
  levels: string[];
  sizes: number[];
  cells: PairCell[];
  monitorSpace: "leading_pca" | "complete_spectra";
  energySpace: "leading_pca" | "complete_spectra";
}

function moments(rows: readonly (readonly number[])[]): { mean: number[]; total: number | null } {
  const p = rows[0]?.length ?? 0;
  const mean = new Array<number>(p).fill(0);
  for (const r of rows) r.forEach((v, c) => (mean[c]! += v / rows.length));
  if (rows.length < 2) return { mean, total: null };
  let s = 0;
  for (const r of rows) r.forEach((v, c) => (s += (v - mean[c]!) ** 2));
  return { mean, total: s / (rows.length - 1) };
}

export function pairwiseMatrix(m: Methods, req: PairwiseRequest): PairwiseResult {
  const reduced = req.energyOnSpectra && req.monitorOnSpectra ? null : leadingSpace(m, req.development);
  const pick = (onSpectra: boolean) => req.index.map((i) => (reduced && !onSpectra ? reduced[i]! : req.development[i]!));
  const mon = pick(req.monitorOnSpectra);
  const en = pick(req.energyOnSpectra);
  const L = req.levels.length;
  const members = Array.from({ length: L }, (_, g) => req.codes.map((c, i) => (c === g ? i : -1)).filter((i) => i >= 0));
  const mom = members.map((idx) => moments(idx.map((i) => mon[i]!)));
  // V-statistic mean distances between levels from one condensed matrix (self-pairs are zero).
  const n = en.length;
  const dist = condensedDistances(en);
  const sums = new Float64Array(L * L);
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++, k++) sums[req.codes[i]! * L + req.codes[j]!]! += dist[k]!;
  const size = members.map((x) => x.length);
  const M = (a: number, b: number) => (a === b ? (2 * sums[a * L + a]!) / (size[a]! * size[a]!) : (sums[a * L + b]! + sums[b * L + a]!) / (size[a]! * size[b]!));
  const cells: PairCell[] = [];
  for (let r = 0; r < L; r++) {
    for (let c = 0; c < L; c++) {
      if (r === c) continue;
      const tr = mom[r]!.total;
      const tc = mom[c]!.total;
      const shift = Math.hypot(...mom[c]!.mean.map((v, j) => v - mom[r]!.mean[j]!));
      const within = M(r, r);
      const e = 2 * M(r, c) - M(r, r) - M(c, c);
      cells.push({
        reference: r,
        compared: c,
        relativeCentre: tr !== null && tr > 0 ? shift / Math.sqrt(tr) : null,
        dispersionRatio: tr !== null && tc !== null && tr > 0 ? tc / tr : null,
        relativeEnergy: within > 0 ? Math.max(0, e) / within : null,
      });
    }
  }
  return {
    levels: req.levels,
    sizes: size,
    cells,
    monitorSpace: reduced && !req.monitorOnSpectra ? "leading_pca" : "complete_spectra",
    energySpace: reduced && !req.energyOnSpectra ? "leading_pca" : "complete_spectra",
  };
}
