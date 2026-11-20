// Local null distribution of the engine's energy permutation test (interim, mirrors Preflight
// domain_shift.rs `test_candidate` / `run_family` and Methods c_api_preflight.cpp `n4m_stats_energy_distance`).
// The engine publishes the statistic, p-values and plan but not the permutation draws, so the demo recomputes
// them with the SAME rows (independence-unit means, engine order), space (leading label-free PCA of every
// development unit, or complete spectra for the audit / energy_on_spectra), group codes, statistic
// (Σ_{a<b} nₐn_b/(nₐ+n_b)·E_ab, V-statistic), generator (Methods `randomPermutations` = successive
// numpy default_rng(seed).permutation draws, the engine's PCG64), seed (the plan's derived seed),
// B and tie rule (T_perm − T ≥ −√ε|T|), p = (b+1)/(B+1). Only computed when the engine reports a valid test.
// Debt: docs/implementation/debt/characterization-domains.md (owner: Preflight engine + Methods).
import { leadingSpace, type loadMethods } from "./kernels";

type Methods = Awaited<ReturnType<typeof loadMethods>>;

/** Declared tie tolerance of the engine (`TIE_TOLERANCE` = √ε). */
export const TIE_TOLERANCE = 1.4901161193847656e-8;

/** Condensed Euclidean distances (pairs i < j, row-major), as the Methods energy kernel. */
export function condensedDistances(rows: readonly (readonly number[])[]): Float64Array {
  const n = rows.length;
  const out = new Float64Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = rows[i]!;
    for (let j = i + 1; j < n; j++, k++) {
      const b = rows[j]!;
      let s = 0;
      for (let c = 0; c < a.length; c++) {
        const d = a[c]! - b[c]!;
        s += d * d;
      }
      out[k] = Math.sqrt(s);
    }
  }
  return out;
}

/** K-sample energy statistic Σ_{a<b} nₐn_b/(nₐ+n_b)·(2M_ab − M_aa − M_bb) of one labelling (V-statistic means). */
export function energyStatistic(dist: Float64Array, n: number, labels: ArrayLike<number>, sizes: readonly number[], sums = new Float64Array(sizes.length * sizes.length)): number {
  const g = sizes.length;
  sums.fill(0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const row = labels[i]! * g;
    for (let j = i + 1; j < n; j++, k++) sums[row + labels[j]!]! += dist[k]!;
  }
  const mean = (a: number, b: number) => (a === b ? (2 * sums[a * g + a]!) / (sizes[a]! * sizes[a]!) : (sums[a * g + b]! + sums[b * g + a]!) / (sizes[a]! * sizes[b]!));
  let t = 0;
  for (let a = 0; a < g; a++) for (let b = a + 1; b < g; b++) t += ((sizes[a]! * sizes[b]!) / (sizes[a]! + sizes[b]!)) * (2 * mean(a, b) - mean(a, a) - mean(b, b));
  return t;
}

/** Engine `derive_seed`: SplitMix64 finalizer of root XOR FNV-1a 64 of the domain string. */
export function deriveSeed(root: bigint, domain: string): bigint {
  const M = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(domain)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & M;
  }
  let z = (root ^ hash) & M;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  return z ^ (z >> 31n);
}

/** Engine derivation domain of a domain-shift test seed. */
export const seedDomain = (sourceId: string, factor: string) => `nirs4all-preflight\0methods\0domain_shift.v2\0${sourceId}\0${factor}`;

export interface PermutationRequest {
  /** Unit-mean spectra of the tested units, engine order. */
  spectra: number[][];
  codes: number[];
  nGroups: number;
  /** Decimal u64 seed of the engine plan. */
  seed: string;
  permutations: number;
  /** Leading PCA space: every development unit and the index of each tested unit in it; null = complete spectra. */
  leading: { development: number[][]; index: number[] } | null;
  /** Engine p-values of the Holm family, with this test at `member` (replaced by the local p for the local Holm). */
  family: { pValues: number[]; member: number } | null;
}

export interface PermutationResult {
  observed: number;
  /** Permuted statistics, draw order. */
  draws: number[];
  /** Draws with T_perm − T ≥ −√ε|T|. */
  atLeast: number;
  permutations: number;
  pValue: number;
  /** Holm-adjusted local p within the engine family (other members keep their engine p). */
  pValueHolm: number | null;
  familySize: number | null;
  n: number;
  groupSizes: number[];
  space: "leading_pca" | "complete_spectra";
  dimensions: number;
}

/** Runs the local permutation null. Pure apart from the Methods kernels (PCA, permutations, Holm). */
export function permutationNull(m: Methods, req: PermutationRequest): PermutationResult {
  let rows = req.spectra;
  let space: PermutationResult["space"] = "complete_spectra";
  if (req.leading) {
    const reduced = leadingSpace(m, req.leading.development);
    if (reduced) {
      rows = req.leading.index.map((i) => reduced[i]!);
      space = "leading_pca";
    }
  }
  const n = rows.length;
  const sizes = Array.from({ length: req.nGroups }, (_, g) => req.codes.filter((c) => c === g).length);
  if (n < 2 || sizes.some((s) => s === 0)) throw new Error("Every group of the permutation test needs at least one unit.");
  const dist = condensedDistances(rows);
  const sums = new Float64Array(req.nGroups * req.nGroups);
  const observed = energyStatistic(dist, n, req.codes, sizes, sums);
  const threshold = -TIE_TOLERANCE * Math.abs(observed);
  const perms = m.randomPermutations(BigInt(req.seed), n, req.permutations);
  const labels = new Int32Array(n);
  const draws: number[] = [];
  let atLeast = 0;
  for (const perm of perms) {
    for (let i = 0; i < n; i++) labels[i] = req.codes[perm[i]!]!;
    const t = energyStatistic(dist, n, labels, sizes, sums);
    draws.push(t);
    if (t - observed >= threshold) atLeast++;
  }
  const pValue = (1 + atLeast) / (1 + req.permutations);
  let pValueHolm: number | null = null;
  if (req.family && req.family.member < req.family.pValues.length) {
    const ps = Float64Array.from(req.family.pValues);
    ps[req.family.member] = pValue;
    pValueHolm = m.preflightHolmAdjust(ps)[req.family.member] ?? null;
  }
  return { observed, draws, atLeast, permutations: req.permutations, pValue, pValueHolm, familySize: req.family?.pValues.length ?? null, n, groupSizes: sizes, space, dimensions: rows[0]?.length ?? 0 };
}

/**
 * Agreement of the local and engine p-values. With identical draws they are equal; otherwise two Monte-Carlo
 * estimates of the same p differ by about √(2p(1−p)/B): beyond twice that, the difference is reported.
 */
export function monteCarloAgreement(local: number, engine: number, permutations: number): { standardError: number; differs: boolean } {
  const se = Math.sqrt((2 * engine * (1 - engine)) / permutations);
  return { standardError: se, differs: Math.abs(local - engine) > 2 * se + 1 / (permutations + 1) };
}
