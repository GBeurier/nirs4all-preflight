// Domain-shift estimators on synthetic data, with the real @nirs4all/methods WASM kernels (Node).
import { beforeAll, describe, expect, it } from "vitest";
import { bandProfiles, computeDiagnostics, dominantRegion, energyBenchmark, energyFromDistances, loadMethods, monitorShape } from "./kernels";
import { domainPopulations, type Unit } from "./populations";
import { auditInput } from "./testkit";

let m: Awaited<ReturnType<typeof loadMethods>>;
beforeAll(async () => {
  m = await loadMethods();
});

const unit = (spectrum: number[], i: number): Unit => ({ key: `u${i}`, members: [`s${i}`], rows: 1, spectrum });
const audit = { audit: true, factor: "partition", referenceLevels: ["development"], comparedLevel: "retained_test" } as const;
const opts = { audit: true, energyOnSpectra: false, monitorOnSpectra: false };

describe("band profiles", () => {
  it("identical distributions: zero difference, ratio one", () => {
    const us = [[1, 2, 3], [2, 3, 5], [3, 1, 4]].map(unit);
    const b = bandProfiles(us, us)!;
    expect(b.diff).toEqual([0, 0, 0]);
    expect(b.localRatio.every((r) => r === 1)).toBe(true);
  });

  it("additive shift, multiplicative spread and constant bands", () => {
    const ref = [[1, 5], [2, 5], [3, 5]].map(unit);
    const add = [[3, 5], [4, 5], [5, 5]].map(unit);
    const b = bandProfiles(ref, add)!;
    expect(b.diff[0]).toBeCloseTo(2, 12);
    expect(b.standardized[0]).toBeCloseTo(2, 12); // pooled SD 1
    // constant band: zero variance in both domains → masked, never an artificial huge value
    expect(b.standardized[1]).toBeNull();
    expect(b.localRatio[1]).toBeNull();
    const wide = [[0, 5], [2, 5], [4, 5]].map(unit);
    expect(bandProfiles(ref, wide)!.localRatio[0]).toBeCloseTo(4, 12);
  });

  it("locates the region carrying the centre difference", () => {
    const diff = Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 50 ? 1 : 0.01));
    expect(dominantRegion(diff)).toMatchObject({ i0: 40, i1: 49 });
    expect(dominantRegion(new Array(100).fill(1))).toBeNull();
  });
});

describe("Methods diagnostics", () => {
  it("rebuilds the engine units and fits the monitor on the reference only", async () => {
    const pop = domainPopulations(auditInput(), "nir", audit)!;
    expect(pop.reference).toHaveLength(24);
    expect(pop.compared).toHaveLength(10);
    const a = await computeDiagnostics(pop, opts, null);
    // compared rows changed far away: the reference statistics and limits are unchanged (no refit on them)
    const far = { ...pop, compared: pop.compared.map((u) => ({ ...u, spectrum: u.spectrum.map((v, j) => v + (j % 2 ? 5 : -5)) })) };
    const b = await computeDiagnostics(far, opts, null);
    expect(b.monitor!.t2Limit).toBe(a.monitor!.t2Limit);
    expect(b.monitor!.qLimit).toBe(a.monitor!.qLimit);
    expect(b.monitor!.referenceQ).toEqual(a.monitor!.referenceQ);
    // outside the reference subspace: every compared unit is beyond the Q limit
    expect(b.monitor!.nBeyondQ).toBe(10);
    expect(b.monitor!.comparedQ.every((q) => q > b.monitor!.qLimit)).toBe(true);
    expect(monitorShape(24, 40)).toEqual([10, 10]);
  });

  it("recomputes the engine energy from Methods distances and contextualizes it", async () => {
    const pop = domainPopulations(auditInput({ shift: 0.5 }), "nir", audit)!;
    const ref = pop.reference.map((u) => u.spectrum);
    const cmp = pop.compared.map((u) => u.spectrum);
    const all = [...ref, ...cmp];
    const X = { data: Float64Array.from(all.flat()), rows: all.length, cols: all[0]!.length };
    const engine = m.statsEnergyDistance(X, all.map((_, i) => (i < ref.length ? 0 : 1)), 2, 0, 0).energy[1]!;
    const d = await computeDiagnostics(pop, opts, engine);
    expect(d.energy.observed).toBeCloseTo(engine, 9);
    expect(d.energy.status).toBe("approximate");
    expect(d.energy.sizes).toEqual([10, 14]);
    expect(d.energy.percentile).toBe(1);
    // reproducible splits
    const again = await computeDiagnostics(pop, opts, engine);
    expect(again.energy.values).toEqual(d.energy.values);
    // shifted domain: compared units are poorly supported, the overlap PCA is reference-fitted
    expect(d.overlap!.reference).toHaveLength(24);
    expect(d.overlap!.compared).toHaveLength(10);
  });

  it("identical populations sit inside the internal distribution", () => {
    const N = 8;
    const D = new Float64Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) D[i * N + j] = Math.abs(i - j);
    expect(energyFromDistances(D, N, [0, 1], [0, 1])).toBe(0);
    const small = energyBenchmark(D, N, 5, 3, null, () => []);
    expect(small.status).toBe("unavailable");
    const approx = energyBenchmark(D, N, 6, 2, 0, (n, b) => Array.from({ length: b }, () => Array.from({ length: n }, (_, i) => i)));
    expect(approx.status).toBe("unavailable"); // m = 2 < 3
  });

  it("unequal sizes and narrower compared domain", async () => {
    const pop = domainPopulations(auditInput({ nDev: 30, nTest: 6, scale: 0.2 }), "nir", audit)!;
    const d = await computeDiagnostics(pop, opts, null);
    expect(d.neighbours!.support.supported).toBeGreaterThan(0.5);
    expect(d.neighbours!.refToRef).toHaveLength(30);
    expect(d.neighbours!.cmpToCmp).toHaveLength(6);
  });
});
