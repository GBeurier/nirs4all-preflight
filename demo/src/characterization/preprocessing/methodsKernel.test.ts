// Real @nirs4all/methods WASM kernels on a controlled synthetic matrix (Node environment).
import { beforeAll, describe, expect, it } from "vitest";
import { STEP_KINDS, STEP_SPECS, type StepRecipe } from "./catalog";
import { benchmarkGrid, benchmarkPoint, diagnose, evaluatePipeline, type ExplorerKernel, type EvaluationInput } from "./evaluate";
import { loadMethodsKernel } from "./methodsKernel";

let kernel: ExplorerKernel;
beforeAll(async () => {
  kernel = await loadMethodsKernel();
});

/** 24 spectra (12 samples × 2 replicates), 128 bands: smooth bands + deterministic pseudo-noise. */
function synthetic(): EvaluationInput {
  const n = 24, p = 128;
  const data = new Float64Array(n * p);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  for (let i = 0; i < n; i++) {
    const sample = Math.floor(i / 2);
    for (let j = 0; j < p; j++) {
      data[i * p + j] = 1 + 0.05 * sample + 0.4 * Math.exp(-(((j - 60) / 8) ** 2)) * (1 + 0.1 * sample) + 0.002 * j + 0.01 * rnd();
    }
  }
  return {
    matrix: { data, rows: n, cols: p },
    step: 2,
    groups: Array.from({ length: n }, (_, i) => Math.floor(i / 2)),
    replicatedSamples: 12,
    settings: { eventThreshold: 8, eventMinSpectra: 5, noiseWindow: 11, noisePolyorder: 2 },
  };
}

describe("Methods kernel", () => {
  it("runs every catalog step and keeps the raw matrix immutable", () => {
    const inp = synthetic();
    const copy = Float64Array.from(inp.matrix.data);
    const before = diagnose(kernel, inp, inp.matrix);
    expect(before.noise!.snrDb.every((v) => v !== null)).toBe(true);
    expect(before.events).not.toBeNull();
    expect(before.profile!.band.length).toBe(128);
    expect(before.repeat!.sd.some((v) => v !== null)).toBe(true);
    for (const kind of STEP_KINDS) {
      const steps: StepRecipe[] = [{ kind, params: { ...STEP_SPECS[kind].defaults } }];
      const ev = evaluatePipeline(kernel, inp, before, steps);
      expect(ev.processed.rows).toBe(24);
      expect(ev.after.noise).not.toBeNull();
    }
    expect(inp.matrix.data).toEqual(copy);
  });

  it("scales derivatives by the signed axis step (descending axis flips d1, not d2)", () => {
    const inp = synthetic();
    for (const [kind, sign] of [["sg_d1", -1], ["sg_d2", 1]] as const) {
      const step: StepRecipe = { kind, params: { ...STEP_SPECS[kind].defaults } };
      const up = kernel.transform(step, inp.matrix, 2), down = kernel.transform(step, inp.matrix, -2), unit = kernel.transform(step, inp.matrix, 1);
      const k = kind === "sg_d1" ? 2 : 4;
      for (const j of [5, 64, 120]) {
        expect(down.data[j]).toBeCloseTo(sign * up.data[j]!, 12);
        expect(up.data[j]! * k).toBeCloseTo(unit.data[j]!, 12);
      }
    }
  });
    it("smoothing reduces fine-scale variation with small distortion; a composed pipeline runs in order", () => {
    const inp = synthetic();
    const before = diagnose(kernel, inp, inp.matrix);
    const sg = evaluatePipeline(kernel, inp, before, [{ kind: "savgol", params: { window: 11, polyorder: 2 } }]);
    expect(sg.metrics.fineScaleReduction.value!).toBeGreaterThan(50);
    expect(sg.metrics.snrGainDb.value!).toBeGreaterThan(3);
    expect(sg.metrics.relativeRmse.value!).toBeLessThan(2);
    expect(sg.metrics.diversityRetention.value!).toBeGreaterThan(90);
    const composed = evaluatePipeline(kernel, inp, before, [
      { kind: "savgol", params: { window: 11, polyorder: 2 } },
      { kind: "snv", params: {} },
    ]);
    expect(composed.comparability).toBe("caution");
    const means = Array.from({ length: 24 }, (_, i) => composed.processed.data.subarray(i * 128, (i + 1) * 128).reduce((a, b) => a + b, 0) / 128);
    expect(Math.max(...means.map(Math.abs))).toBeLessThan(1e-9);
  });

  it("benchmark points carry distortion and reduction", () => {
    const inp = synthetic();
    const before = diagnose(kernel, inp, inp.matrix);
    const points = benchmarkGrid(128).map((c) => benchmarkPoint(kernel, inp, before, c));
    expect(points.filter((p) => p.error)).toEqual([]);
    expect(points.every((p) => p.distortion !== null && p.reduction !== null)).toBe(true);
  });
});
