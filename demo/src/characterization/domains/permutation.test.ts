// Local permutation null, pairwise matrix, residual profiles, concentration ellipses and the preprocessing
// explorer kernel on synthetic data with the real @nirs4all/methods WASM kernels (Node).
import { beforeAll, describe, expect, it } from "vitest";
import { loadMethodsKernel } from "../preprocessing/methodsKernel";
import { concentrationEllipse } from "./charts";
import { computeDiagnostics, loadMethods, matrix } from "./kernels";
import { pairwiseMatrix } from "./pairwise";
import { condensedDistances, energyStatistic, monteCarloAgreement, permutationNull } from "./permutation";
import { domainPopulations } from "./populations";
import { exploreShift } from "./shiftExplorer";
import { auditInput } from "./testkit";

let m: Awaited<ReturnType<typeof loadMethods>>;
beforeAll(async () => {
  m = await loadMethods();
});

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
const cloud = (n: number, p: number, shift = 0, scale = 1) => Array.from({ length: n }, () => Array.from({ length: p }, () => shift + scale * rnd()));

describe("energy statistic and permutation null", () => {
  it("K-sample statistic equals the Methods energy kernel (3 groups, unequal sizes)", () => {
    const X = [...cloud(7, 5), ...cloud(5, 5, 0.3), ...cloud(9, 5, 0, 2)];
    const codes = [...Array(7).fill(0), ...Array(5).fill(1), ...Array(9).fill(2)] as number[];
    const e = m.statsEnergyDistance(matrix(X), codes, 3, 0, 0);
    expect(energyStatistic(condensedDistances(X), X.length, codes, [7, 5, 9])).toBeCloseTo(e.statistic, 12);
  });

  it("identical distributions: p is not small; a large shift gives the minimal p; draws are reproducible", () => {
    const same = permutationNull(m, { spectra: cloud(30, 4), codes: [...Array(15).fill(0), ...Array(15).fill(1)], nGroups: 2, seed: "42", permutations: 199, leading: null, family: null });
    expect(same.pValue).toBeGreaterThan(0.01);
    const shifted = [...cloud(12, 4), ...cloud(12, 4, 3)];
    const codes = [...Array(12).fill(0), ...Array(12).fill(1)];
    const a = permutationNull(m, { spectra: shifted, codes, nGroups: 2, seed: "7", permutations: 199, leading: null, family: { pValues: [0.5, 0.01], member: 0 } });
    expect(a.pValue).toBeCloseTo(1 / 200, 12);
    // Holm over the family {local p, 0.01}: min(1, 2 · 0.005) for the smallest p.
    expect(a.pValueHolm).toBeCloseTo(0.01, 12);
    const b = permutationNull(m, { spectra: shifted, codes, nGroups: 2, seed: "7", permutations: 199, leading: null, family: null });
    expect(b.draws).toEqual(a.draws);
    const e = m.statsEnergyDistance(matrix(shifted), codes, 2, 199, 7n);
    expect(a.atLeast).toBe(e.nAtLeastObserved);
  });

  it("Monte-Carlo agreement flags only differences beyond the sampling error", () => {
    expect(monteCarloAgreement(0.21, 0.2, 999).differs).toBe(false);
    expect(monteCarloAgreement(0.4, 0.2, 999).differs).toBe(true);
  });
});

describe("pairwise matrix", () => {
  it("explicit direction: reference → compared ratios are reciprocal, a constant level gives n/a", () => {
    const dev = [...cloud(8, 6), ...cloud(8, 6, 1, 2), ...cloud(8, 6, -1, 0.5)];
    const codes = [...Array(8).fill(0), ...Array(8).fill(1), ...Array(8).fill(2)];
    const r = pairwiseMatrix(m, { development: dev, index: dev.map((_, i) => i), codes, levels: ["a", "b", "c"], energyOnSpectra: true, monitorOnSpectra: true });
    const cell = (a: number, b: number) => r.cells.find((c) => c.reference === a && c.compared === b)!;
    expect(r.cells).toHaveLength(6);
    expect(cell(0, 1).dispersionRatio! * cell(1, 0).dispersionRatio!).toBeCloseTo(1, 12);
    expect(cell(0, 1).dispersionRatio).toBeGreaterThan(1.5);
    expect(cell(0, 2).relativeCentre).toBeGreaterThan(0.5);
    const flat = [...Array.from({ length: 4 }, () => [1, 1, 1]), ...cloud(4, 3)];
    const z = pairwiseMatrix(m, { development: flat, index: flat.map((_, i) => i), codes: [0, 0, 0, 0, 1, 1, 1, 1], levels: ["const", "x"], energyOnSpectra: true, monitorOnSpectra: true });
    expect(z.cells.find((c) => c.reference === 0)!.relativeCentre).toBeNull();
    expect(z.cells.find((c) => c.reference === 0)!.relativeEnergy).toBeNull();
  });
});

describe("residual profiles of high-Q units", () => {
  it("complete-spectra monitor: ‖x − x̂‖² reproduces the monitor Q of the units above the limit", async () => {
    const input = auditInput({ outside: 0.4, nDev: 30, nTest: 8 });
    const pop = domainPopulations(input, "nir", { audit: true, factor: "partition", referenceLevels: ["development"], comparedLevel: "retained_test" })!;
    const d = await computeDiagnostics(pop, { audit: true, energyOnSpectra: false, monitorOnSpectra: false }, null);
    expect(d.residuals).not.toBeNull();
    const r = d.residuals!;
    expect(r.sameSpace).toBe(true);
    expect(r.total).toBe(d.monitor!.comparedQ.filter((q) => q > d.monitor!.qLimit).length);
    r.units.forEach((u, k) => expect(Math.abs(r.q[k]! - d.monitor!.comparedQ[u]!) / d.monitor!.comparedQ[u]!).toBeLessThan(1e-6));
    expect(r.refP5.every((v, c) => v <= r.refP95[c]!)).toBe(true);
  });
});

describe("empirical concentration ellipse", () => {
  it("holds about the requested share of points and refuses degenerate inputs", () => {
    const pts = Array.from({ length: 400 }, () => [rnd() * 3, rnd() + 0.5 * rnd()] as const);
    const e = concentrationEllipse(pts, 0.9)!;
    const inside = (x: number, y: number) => {
      let c = false;
      for (let i = 0, j = e.length - 1; i < e.length; j = i++) {
        const [xi, yi] = e[i]!;
        const [xj, yj] = e[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const share = pts.filter(([x, y]) => inside(x, y)).length / pts.length;
    expect(share).toBeGreaterThan(0.86);
    expect(share).toBeLessThan(0.94);
    expect(concentrationEllipse(pts.slice(0, 2))).toBeNull();
    expect(concentrationEllipse([[0, 0], [1, 1], [2, 2], [3, 3]])).toBeNull();
  });
});

describe("domain-shift preprocessing explorer", () => {
  const pop = () => domainPopulations(auditInput({ shift: 0.2, nDev: 20, nTest: 8 }), "nir", { audit: true, factor: "partition", referenceLevels: ["development"], comparedLevel: "retained_test" })!;
  const request = (scaleCompared: number) => {
    const p = pop();
    const rows = [...p.reference.map((u) => u.spectrum), ...p.compared.map((u) => u.spectrum.map((v) => v * scaleCompared))];
    const data = new Float64Array(rows.length * rows[0]!.length);
    rows.forEach((r, i) => data.set(r, i * r.length));
    return { X: { data, rows: rows.length, cols: rows[0]!.length }, reference: p.reference.map((_, i) => [[i]]), compared: p.compared.map((_, i) => [[p.reference.length + i]]), axisStep: 2 };
  };

  it("no step: processed equals raw; metrics are reference-normalized", async () => {
    const k = await loadMethodsKernel();
    const r = exploreShift(m, k, { ...request(1), steps: [] });
    expect(r.processed).toBe(r.raw);
    expect(r.raw.relativeCentre).toBeGreaterThan(0);
    expect(r.raw.beyondEither).not.toBeNull();
  });

  it("MSC is fitted on the reference only: changing the compared spectra leaves the processed reference unchanged", async () => {
    const k = await loadMethodsKernel();
    const steps = [{ kind: "msc" as const, params: {} }];
    const a = exploreShift(m, k, { ...request(1), steps });
    const b = exploreShift(m, k, { ...request(3), steps });
    expect(b.processed.overlap!.reference).toEqual(a.processed.overlap!.reference);
    expect(b.processed.overlap!.compared).not.toEqual(a.processed.overlap!.compared);
  });
});
