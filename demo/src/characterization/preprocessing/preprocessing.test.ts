import { describe, expect, it } from "vitest";
import { coerceParam, newStep, pipelineComparability, pipelinePreservesUnits, stepIssue, STEP_SPECS, stripIds, type StepRecipe } from "./catalog";
import { prepareExplorerData, sampleRows } from "./data";
import { applyPipeline, benchmarkGrid, comparisonMetrics, diagnose, evaluatePipeline, type ExplorerKernel, type EvaluationInput } from "./evaluate";
import {
  axisStep,
  bandDescriptor,
  bandSd,
  distortionProfile,
  diversityRetentionPercent,
  fineScaleReductionPercent,
  paretoFront,
  relativeRmsePercent,
  sharedHistogram,
  snrGainDb,
  spectralAngleDeg,
  type Matrix,
} from "./metrics";
import { CancelledError, StaleError, createExplorerHost, type ExplorerRequest, type ExplorerResponse, type WorkerLike } from "./protocol";
import type { EngineInput } from "../../input";

const mat = (rows: number[][]): Matrix => ({ data: Float64Array.from(rows.flat()), rows: rows.length, cols: rows[0]!.length });

/** Fake owner kernel: "scale" multiplies by params.k; noise σ = mean |second difference|. */
const fakeKernel: ExplorerKernel = {
  transform(step, X) {
    const k = step.kind === "snv" ? 0.5 : step.kind === "savgol" ? 1 : 2;
    return { data: X.data.map((v) => v * k), rows: X.rows, cols: X.cols };
  },
  noise(X) {
    const sigma: number[] = [], snrDb: number[] = [];
    for (let i = 0; i < X.rows; i++) {
      const r = X.data.subarray(i * X.cols, (i + 1) * X.cols);
      let s = 0, m = 0;
      for (let j = 1; j < r.length - 1; j++) s += Math.abs(r[j + 1]! - 2 * r[j]! + r[j - 1]!);
      for (const v of r) m += Math.abs(v);
      sigma.push(s / (r.length - 2));
      snrDb.push(20 * Math.log10(m / r.length / (s / (r.length - 2))));
    }
    return { sigma, snrDb };
  },
  events: () => null,
  noiseProfile: () => null,
  repeatability: () => null,
};

const input = (rows: number[][]): EvaluationInput => ({
  matrix: mat(rows),
  step: 1,
  groups: rows.map((_, i) => i),
  replicatedSamples: 0,
  settings: { eventThreshold: 8, eventMinSpectra: 5, noiseWindow: 5, noisePolyorder: 2 },
});

describe("catalog", () => {
  it("classifies pipeline comparability by the worst step", () => {
    expect(pipelineComparability([])).toBe("comparable");
    expect(pipelineComparability([newStep("savgol"), newStep("gaussian")])).toBe("comparable");
    expect(pipelineComparability([newStep("savgol"), newStep("msc")])).toBe("caution");
    expect(pipelineComparability([newStep("snv"), newStep("sg_d1")])).toBe("not_comparable");
    expect(pipelinePreservesUnits([newStep("detrend"), newStep("msc")])).toBe(true);
    expect(pipelinePreservesUnits([newStep("savgol"), newStep("snv")])).toBe(false);
  });
  it("coerces parameters to their spec", () => {
    const w = STEP_SPECS.savgol.params[0]!;
    expect(coerceParam(w, 10)).toBe(11);
    expect(coerceParam(w, 1000)).toBe(101);
    expect(coerceParam(w, Number.NaN)).toBe(3);
    expect(coerceParam(STEP_SPECS.wavelet.params[0]!, "nope")).toBe("db4");
  });
  it("explains impossible parameters before the kernel runs", () => {
    expect(stepIssue(newStep("savgol", { window: 11, polyorder: 2 }), 7)).toMatch(/exceeds/);
    expect(stepIssue(newStep("savgol", { window: 5, polyorder: 5 }), 50)).toMatch(/below the window/);
    expect(stepIssue(newStep("sg_d2", { window: 7, polyorder: 1 }), 50)).toMatch(/derivative order/);
    expect(stepIssue(newStep("wavelet", { family: "db4", level: 6, threshold_mode: "soft" }), 50)).toMatch(/Level/);
    expect(stepIssue(newStep("gaussian"), 50)).toBeNull();
  });
});

describe("pipeline composition and immutability", () => {
  it("applies steps in order on a copy", () => {
    const inp = input([[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]]);
    const before = Float64Array.from(inp.matrix.data);
    const out = applyPipeline(fakeKernel, inp.matrix, [{ kind: "gaussian", params: { sigma: 1 } }, { kind: "snv", params: {} }], 1);
    expect(Array.from(out.data)).toEqual(Array.from(before, (v) => v * 2 * 0.5));
    expect(inp.matrix.data).toEqual(before);
    expect(out.data).not.toBe(inp.matrix.data);
  });
  it("keeps the source input arrays untouched and copies them", () => {
    const x = [[1, 2, 3, 4, 5, 6], [2, 3, 4, null, 6, 7], [3, 4, 5, 6, 7, 8]];
    const engine = { sources: [{ source_id: "s", observation_ids: ["a", "b", "c"], sample_ids: ["A", "B", "C"], x, axis: [1, 2, 3, 4, 5, 6] }], samples: [], options: {} } as unknown as EngineInput;
    const snapshot = JSON.stringify(engine);
    const data = prepareExplorerData(engine, "s")!;
    expect(data.counts).toEqual({ total: 3, complete: 2, used: 2 });
    data.matrix.data[0] = 99;
    expect(JSON.stringify(engine)).toBe(snapshot);
  });
  it("groups only declared technical repeats, as the engine does, and signs the step of a descending axis", () => {
    const x = Array.from({ length: 6 }, (_, i) => [1 + i, 2, 3, 4, 5, 6]);
    const engine = {
      sources: [{
        source_id: "s", observation_ids: ["o1", "o2", "o3", "o4", "o5", "o6"], sample_ids: ["A", "A", "B", "B", "C", "C"], x,
        axis: [1000, 998, 996, 994, 992, 990], repetition_types: ["rescan", "rescan", "biological", "biological", "rescan", "rescan"],
      }],
      samples: [{ sample_id: "A" }, { sample_id: "B" }, { sample_id: "C", partition: "retained_test" }],
      options: {},
    } as unknown as EngineInput;
    const data = prepareExplorerData(engine, "s")!;
    // A: development technical repeats → one group; B (biological) and C (retained test) → one group per row.
    expect(data.groups).toEqual([0, 0, 1, 2, 3, 4]);
    expect(data.replicatedSamples).toBe(1);
    expect(data.step).toBe(-2);
  });
    it("refuses a kernel that changes the shape or emits non-finite values", () => {
    const bad: ExplorerKernel = { ...fakeKernel, transform: (_s, X) => ({ data: X.data.map(() => Number.NaN), rows: X.rows, cols: X.cols }) };
    expect(() => applyPipeline(bad, mat([[1, 2, 3, 4, 5]]), [{ kind: "gaussian", params: { sigma: 1 } }], 1)).toThrow(/non-finite/);
  });
});

describe("deterministic sampling", () => {
  it("keeps replicate groups together and respects the cap", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `S${Math.floor(i / 3)}`);
    const rows = ids.map((_, i) => i);
    const a = sampleRows(rows, ids, 300);
    expect(a.length).toBeLessThanOrEqual(300);
    expect(a.length).toBeGreaterThan(250);
    expect(sampleRows(rows, ids, 300)).toEqual(a);
    const bySample = new Map<string, number>();
    for (const r of a) bySample.set(ids[r]!, (bySample.get(ids[r]!) ?? 0) + 1);
    expect([...bySample.values()].every((n) => n === 3 || ids[a[a.length - 1]!] !== undefined)).toBe(true);
    expect(sampleRows([0, 1], ["a", "b"], 300)).toEqual([0, 1]);
  });
});

describe("metric definitions", () => {
  it("relative RMSE and spectral angle", () => {
    const raw = mat([[3, 4], [0, 0]]);
    const proc = mat([[3, 0], [1, 1]]);
    expect(relativeRmsePercent(raw, proc)).toEqual([80, null]);
    expect(spectralAngleDeg(raw, mat([[6, 8], [1, 1]]))[0]).toBeCloseTo(0, 5);
    expect(spectralAngleDeg(mat([[1, 0]]), mat([[0, 1]]))[0]).toBeCloseTo(90, 9);
  });
  it("SNR gain is the median paired difference; fine-scale reduction uses σ ratios", () => {
    expect(snrGainDb([10, 20, null, 30], [13, 22, 50, 40])).toEqual({ value: 3, n: 3 });
    expect(fineScaleReductionPercent([2, 4, 0], [1, 1, 5])).toEqual({ value: 62.5, n: 2 });
    expect(fineScaleReductionPercent([1], [2]).value).toBe(-100);
  });
  it("diversity retention and per-band SD", () => {
    const m = mat([[1, 10], [3, 10]]);
    expect(bandSd(m)[1]).toBe(0);
    expect(bandSd(mat([[1, 2]]))).toEqual([null, null]);
    expect(diversityRetentionPercent([2, 0], [1, 0]).value).toBeCloseTo(50, 9);
    expect(diversityRetentionPercent([0, 0], [1, 1]).value).toBeNull();
  });
  it("distortion profile and band descriptor", () => {
    expect(distortionProfile(mat([[2, 0], [2, 0]]), mat([[1, 0], [1, 0]]))).toEqual([0.5, null]);
    const axis = [0, 1, 2, 3, 4, 5, 6];
    const d = bandDescriptor(axis, [1, 1, 2, 5, 2, 1, 1], 0, 6)!;
    expect(d.position).toBe(3);
    expect(d.height).toBe(4);
    expect(d.width).toBe(0);
    expect(bandDescriptor(axis, [1, 1, 1, 1, 1, 1, 1], 0, 6)).toBeNull();
    expect(bandDescriptor(axis, [1, 2, 3], 0, 1)).toBeNull();
  });
  it("axis step detects irregular axes", () => {
    expect(axisStep([1000, 1002, 1004])).toEqual({ step: 2, irregular: false });
    expect(axisStep([1, 2, 4, 5]).irregular).toBe(true);
    expect(axisStep([1]).step).toBeNull();
  });
  it("shared histogram uses common edges, constant values included", () => {
    const h = sharedHistogram([[1, 1, 1], [1]], 4)!;
    expect(h.counts.map((c) => c.reduce((a, b) => a + b, 0))).toEqual([3, 1]);
    expect(sharedHistogram([[null]], 4)).toBeNull();
  });
});

describe("comparability rules", () => {
  const rows = [[1, 3, 2, 5, 4, 6], [2, 4, 3, 6, 5, 7], [1, 2, 4, 3, 6, 5]];
  it("disables SNR and % deltas for derivatives and unit-changing steps", () => {
    const inp = input(rows);
    const before = diagnose(fakeKernel, inp, inp.matrix);
    const ev = evaluatePipeline(fakeKernel, inp, before, [{ kind: "sg_d1", params: { window: 5, polyorder: 2 } }]);
    expect(ev.comparability).toBe("not_comparable");
    expect(ev.metrics.snrGainDb.disabled).toMatch(/new spectral space/);
    expect(ev.metrics.fineScaleReduction.value).toBeNull();
    expect(ev.metrics.relativeRmse.disabled).toMatch(/unit/);
    expect(ev.residual).toBeNull();
    expect(ev.distortion).toBeNull();
  });
  it("keeps SNR for SNV with caution but withholds unit-based metrics", () => {
    const inp = input(rows);
    const before = diagnose(fakeKernel, inp, inp.matrix);
    const ev = evaluatePipeline(fakeKernel, inp, before, [{ kind: "snv", params: {} }]);
    expect(ev.comparability).toBe("caution");
    expect(ev.metrics.snrGainDb.disabled).toBeNull();
    expect(ev.metrics.snrGainDb.value).toBeCloseTo(0, 9);
    expect(ev.metrics.diversityRetention.disabled).not.toBeNull();
    // σ ratio across a rescaling is the scale factor, not a fine-scale change.
    expect(ev.metrics.fineScaleReduction.disabled).toMatch(/unit/);
  });
  it("identity pipeline gives zero change", () => {
    const inp = input(rows);
    const before = diagnose(fakeKernel, inp, inp.matrix);
    const ev = evaluatePipeline(fakeKernel, inp, before, []);
    expect(ev.metrics.relativeRmse.value).toBe(0);
    expect(ev.metrics.diversityRetention.value).toBeCloseTo(100, 9);
    expect(comparisonMetrics(inp.matrix, inp.matrix, { ...before, noise: null }, before, "comparable", true).snrGainDb.disabled).toMatch(/unavailable/);
  });
});

describe("benchmark", () => {
  it("grid holds comparable families only and respects the width", () => {
    const g = benchmarkGrid(8);
    expect(g.every((c) => c.steps.every((s) => STEP_SPECS[s.kind].comparability === "comparable"))).toBe(true);
    expect(g.some((c) => c.steps[0]!.params.window === 9)).toBe(false);
  });
  it("Pareto front: minimise distortion, maximise reduction", () => {
    const pts = [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 2, y: 15 }, { x: 3, y: 20 }, { x: null, y: 50 }, { x: 0.5, y: 5 }];
    expect([...paretoFront(pts)].sort()).toEqual([0, 1, 5]);
  });
});

describe("explorer host", () => {
  class FakeWorker implements WorkerLike {
    onmessage: WorkerLike["onmessage"] = null;
    onerror: WorkerLike["onerror"] = null;
    sent: ExplorerRequest[] = [];
    terminated = false;
    postMessage(m: ExplorerRequest) {
      this.sent.push(m);
    }
    terminate() {
      this.terminated = true;
    }
    answer(m: ExplorerResponse) {
      this.onmessage?.({ data: m } as MessageEvent<ExplorerResponse>);
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const inp = input([[1, 2, 3, 4, 5]]);
  const diag = diagnose(fakeKernel, inp, inp.matrix);

  it("drops stale evaluations and cancels by termination", async () => {
    const workers: FakeWorker[] = [];
    const host = createExplorerHost(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const init = host.init(inp);
    workers[0]!.answer({ id: workers[0]!.sent[0]!.id, ok: true, op: "init", before: diag });
    await init;
    const steps: StepRecipe[] = stripIds([newStep("gaussian")]);
    const first = host.evaluate(steps);
    const second = host.evaluate(steps);
    await tick();
    const [e1, e2] = workers[0]!.sent.slice(1);
    const evaluation = evaluatePipeline(fakeKernel, inp, diag, steps);
    workers[0]!.answer({ id: e1!.id, ok: true, op: "evaluate", evaluation });
    workers[0]!.answer({ id: e2!.id, ok: true, op: "evaluate", evaluation });
    await expect(first).rejects.toBeInstanceOf(StaleError);
    await expect(second).resolves.toBe(evaluation);

    const points: number[] = [];
    const bench = host.benchmark([{ label: "a", steps }], (_p, done) => points.push(done));
    await tick();
    const b = workers[0]!.sent.at(-1)!;
    workers[0]!.answer({ id: b.id, ok: true, op: "progress", done: 1, total: 2, point: { key: "k", label: "a", steps, distortion: 1, reduction: 2, snrGainDb: 0, error: null } });
    host.cancel();
    await expect(bench).rejects.toBeInstanceOf(CancelledError);
    expect(points).toEqual([1]);
    expect(workers[0]!.terminated).toBe(true);
    // The next call re-initialises a fresh worker with the same subset.
    void host.evaluate(steps).catch(() => undefined);
    await tick();
    expect(workers[1]!.sent[0]!.op).toBe("init");
    host.dispose();
  });
});
