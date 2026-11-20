import { describe, expect, it } from "vitest";
import { applyPipeline, applyPipelineFitted, benchmarkGrid, sweepOf, type ExplorerKernel } from "./evaluate";
import { despike1d, localTransform, medianFilter, medianFilter1d, reflectIndex } from "./localSteps";
import { STEP_SPECS, stepIssue } from "./catalog";

const noKernel: ExplorerKernel = {
  transform: () => {
    throw new Error("Methods kernel must not be called for a local step");
  },
  noise: () => null,
  events: () => null,
  noiseProfile: () => null,
  repeatability: () => null,
  reference: () => null,
};

describe("median filter", () => {
  it("reflects edges like scipy.ndimage.median_filter (mode reflect)", () => {
    expect([-1, -2, 0, 4, 5, 6].map((j) => reflectIndex(j, 5))).toEqual([0, 1, 0, 4, 4, 3]);
    // scipy.ndimage.median_filter([1, 5, 2, 8, 3], size=3) -> [1, 2, 5, 3, 3]
    expect(Array.from(medianFilter1d([1, 5, 2, 8, 3], 3))).toEqual([1, 2, 5, 3, 3]);
    // size=5: windows [5,1,1,5,2] [1,1,5,2,8] [1,5,2,8,3] [5,2,8,3,3] [2,8,3,3,8]
    expect(Array.from(medianFilter1d([1, 5, 2, 8, 3], 5))).toEqual([2, 2, 3, 3, 3]);
  });

  it("keeps constants and linear ramps, removes an isolated outlier, never writes its input", () => {
    expect(Array.from(medianFilter1d([4, 4, 4, 4], 3))).toEqual([4, 4, 4, 4]);
    const ramp = Array.from({ length: 9 }, (_, j) => 2 * j + 1);
    expect(Array.from(medianFilter1d(ramp, 3)).slice(1, -1)).toEqual(ramp.slice(1, -1));
    const x = [1, 1, 1, 9, 1, 1, 1];
    const copy = [...x];
    expect(Array.from(medianFilter1d(x, 3))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(x).toEqual(copy);
    expect(Array.from(medianFilter1d([3, 1, 2], 1))).toEqual([3, 1, 2]);
  });

  it("applies row by row and through the pipeline without the Methods kernel", () => {
    const X = { data: Float64Array.from([1, 5, 2, 8, 3, 0, 0, 7, 0, 0]), rows: 2, cols: 5 };
    expect(Array.from(medianFilter(X, 3).data)).toEqual([1, 2, 5, 3, 3, 0, 0, 0, 0, 0]);
    const out = applyPipeline(noKernel, X, [{ kind: "median", params: { window: 3 } }], 1);
    expect(Array.from(out.data)).toEqual([1, 2, 5, 3, 3, 0, 0, 0, 0, 0]);
    expect(Array.from(X.data)).toEqual([1, 5, 2, 8, 3, 0, 0, 7, 0, 0]);
    expect(stepIssue({ id: "", kind: "median", params: { window: 7 } }, 5)).toMatch(/exceeds/);
  });
});

describe("Whitaker–Hayes despiking", () => {
  const smooth = (p: number) => Array.from({ length: p }, (_, j) => Math.sin(j / 9) + 0.01 * ((j * 7919) % 13) / 13);

  it("flags and replaces an isolated spike, leaves the rest untouched", () => {
    const x = smooth(120);
    const spiked = [...x];
    spiked[50] = spiked[50]! + 5;
    const { values, flagged } = despike1d(spiked, 6, 3);
    expect(flagged).toContain(50);
    expect(Math.abs(values[50]! - x[50]!)).toBeLessThan(0.1);
    for (let j = 0; j < 120; j++) if (!flagged.includes(j)) expect(values[j]).toBe(spiked[j]);
    // Only the spike and its right neighbour (the difference back down) can be flagged.
    expect(flagged.every((j) => j === 50 || j === 51)).toBe(true);
  });

  it("flags nothing on a clean spectrum, a ramp (MAD = 0) or a short vector", () => {
    expect(despike1d(smooth(120), 6, 3).flagged).toEqual([]);
    expect(despike1d(Array.from({ length: 20 }, (_, j) => j), 3.5, 3).flagged).toEqual([]);
    expect(despike1d([1, 9], 2, 1).flagged).toEqual([]);
  });

  it("replaces a flagged point from unflagged neighbours only", () => {
    const x = Array.from({ length: 30 }, (_, j) => Math.sin(j * 2.3));
    x[11] = 50;
    const r = despike1d(x, 3.5, 1);
    expect(r.flagged).toEqual([11, 12]);
    // 11: only 10 is unflagged in [10, 12]; 12: only 13 is unflagged in [11, 13].
    expect(r.values[11]).toBe(x[10]);
    expect(r.values[12]).toBe(x[13]);
  });

  it("is a comparable, unit-preserving local step in the benchmark grid and fits nothing", () => {
    expect(STEP_SPECS.despike.local && STEP_SPECS.median.local).toBe(true);
    expect(STEP_SPECS.despike.comparability).toBe("comparable");
    const grid = benchmarkGrid(200);
    expect(grid.some((g) => g.steps[0]!.kind === "median")).toBe(true);
    expect(grid.some((g) => g.steps[0]!.kind === "despike")).toBe(true);
    expect(sweepOf([{ kind: "median", params: { window: 7 } }])?.short).toBe("Median 7");
    const X = { data: Float64Array.from([...smooth(40), ...smooth(40)]), rows: 2, cols: 40 };
    const step = { kind: "despike" as const, params: { threshold: 6, half_window: 3 } };
    const fitted = applyPipelineFitted(noKernel, [step], X, [X], 1);
    expect(Array.from(fitted.apply[0]!.data)).toEqual(Array.from(localTransform(step, X)!.data));
  });
});
