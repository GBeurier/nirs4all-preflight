// Chemometric comparison: population guard (retained-test never read), grouped folds, Methods PLS
// against known solutions, and leak-free fitting of learned preprocessing inside the folds.
import { PLSRegression } from "@nirs4all/methods";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineInput, InputTargetValue } from "../../input";
import { buildCalibrationPopulation, groupedFolds, runChemometricComparison, sampleScores, type CalibrationPopulation, type PlsKernel } from "./chemometrics";
import type { ExplorerKernel } from "./evaluate";
import { loadMethodsKernel, methodsPlsPath } from "./methodsKernel";
import type { Matrix } from "./metrics";

let kernel: ExplorerKernel & PlsKernel;
beforeAll(async () => {
  kernel = await loadMethodsKernel();
});

/** Deterministic LCG in [−0.5, 0.5). */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;

/**
 * 30 samples × 2 technical repeats (60 spectra, 80 bands) in development, plus 10 retained-test
 * samples and 4 prediction samples. Y = concentration of a Gaussian band; a multiplicative scatter
 * factor per spectrum.
 */
function dataset(opts: { binary?: boolean } = {}) {
  const p = 80, r = rng(11);
  const samples: EngineInput["samples"] = [];
  const values: InputTargetValue[] = [];
  const x: number[][] = [], sampleIds: string[] = [], obs: string[] = [];
  const add = (id: string, partition: "development" | "retained_test" | "prediction", conc: number, reps: number) => {
    samples.push({ sample_id: id, partition, physical_sample_id: `phys-${id}` });
    values.push(opts.binary ? { sample_id: id, category: conc > 0.5 ? "high" : "low", status: "exact" } : { sample_id: id, value: conc, status: "exact" });
    for (let k = 0; k < reps; k++) {
      const scatter = 1 + 0.15 * r();
      x.push(Array.from({ length: p }, (_, j) => scatter * (0.5 + 0.3 * Math.exp(-(((j - 20) / 6) ** 2)) + conc * Math.exp(-(((j - 50) / 5) ** 2))) + 0.002 * r()));
      sampleIds.push(id);
      obs.push(`${id}#${k}`);
    }
  };
  for (let i = 0; i < 30; i++) add(`s${i}`, "development", 0.05 + ((i * 37) % 30) / 30, 2);
  for (let i = 0; i < 10; i++) add(`t${i}`, "retained_test", 5 + i, 1);
  for (let i = 0; i < 4; i++) add(`q${i}`, "prediction", 9, 1);
  const input: EngineInput = {
    schema_version: 1,
    sources: [{ source_id: "nir", observation_ids: obs, sample_ids: sampleIds, x, axis: Array.from({ length: p }, (_, j) => 1000 + 2 * j) }],
    samples,
    targets: [{ target_id: "y", kind: opts.binary ? "categorical" : "continuous", values, unit: "%" }],
    options: { independence_unit: "sample" },
  };
  return input;
}

/** Makes every retained-test / prediction X row and reference field throw when read. */
function guard(input: EngineInput): EngineInput {
  const banned = new Set(input.samples.filter((s) => s.partition !== "development").map((s) => s.sample_id));
  const src = input.sources[0]!;
  const bannedRows = new Set(src.sample_ids.flatMap((id, r) => (banned.has(id) ? [r] : [])));
  const x = new Proxy(src.x, {
    get(target, key, recv) {
      if (typeof key === "string" && /^\d+$/.test(key) && bannedRows.has(Number(key))) throw new Error(`retained-test X row ${key} read`);
      return Reflect.get(target, key, recv);
    },
  });
  const values = input.targets[0]!.values.map((v) => {
    if (!banned.has(v.sample_id)) return v;
    const o = { sample_id: v.sample_id } as InputTargetValue;
    for (const k of ["value", "category", "status", "reference_id", "reference_group_id"]) {
      Object.defineProperty(o, k, { enumerable: true, get: () => { throw new Error(`retained-test reference ${v.sample_id}.${k} read`); } });
    }
    return o;
  });
  return { ...input, sources: [{ ...src, x }], targets: [{ ...input.targets[0]!, values }] };
}

describe("calibration population", () => {
  it("never reads retained-test or prediction rows and their Y", () => {
    const res = buildCalibrationPopulation(guard(dataset()), "nir", "y");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pop = res.population;
    expect(pop.counts).toMatchObject({ development: 60, notDevelopment: 14, used: 60, samples: 30, groups: 30 });
    expect(Math.max(...pop.y)).toBeLessThan(2);
    // The guard really fires when a banned row is read.
    expect(() => guard(dataset()).sources[0]!.x[60]).toThrow(/retained-test/);
    expect(() => guard(dataset()).targets[0]!.values[30]!.value).toThrow(/retained-test/);
  });

  it("keeps repeats of one physical sample in one group, also across sample ids", () => {
    const input = dataset();
    input.samples[1]!.physical_sample_id = input.samples[0]!.physical_sample_id!;
    const res = buildCalibrationPopulation(input, "nir", "y");
    if (!res.ok) throw new Error(res.reason);
    const g = res.population.groups;
    expect(new Set(g.slice(0, 4)).size).toBe(1);
    expect(res.population.counts.groups).toBe(29);
  });

  it("keeps identical spectra of different physical samples in one group", () => {
    const input = dataset();
    const src = input.sources[0]!;
    src.x[10] = [...src.x[0]!];
    const res = buildCalibrationPopulation(input, "nir", "y");
    if (!res.ok) throw new Error(res.reason);
    const g = res.population.groups;
    // Rows 0–1 (s0) and 10–11 (s5) merge through the copied spectrum; nothing else does.
    expect(g[10]).toBe(g[0]);
    expect(g[11]).toBe(g[0]);
    expect(res.population.counts.groups).toBe(29);
  });

  it("refuses without a target, with too few groups, or a non-binary categorical target", () => {
    expect(buildCalibrationPopulation({ ...dataset(), targets: [] }, "nir", null).ok).toBe(false);
    const few = dataset();
    few.samples.forEach((s) => (s.physical_sample_id = s.sample_id < "s2" ? "A" : "B"));
    const r = buildCalibrationPopulation(few, "nir", "y");
    expect(r.ok ? null : r.reason).toMatch(/independent groups/);
    const multi = dataset({ binary: true });
    multi.targets[0]!.values[3]!.category = "medium";
    const m = buildCalibrationPopulation(multi, "nir", "y");
    expect(m.ok ? null : m.reason).toMatch(/binary target only/);
  });
});

describe("grouped folds", () => {
  it("never splits a group, is deterministic and balanced", () => {
    const groups = Array.from({ length: 100 }, (_, i) => Math.floor(i / 3));
    const a = groupedFolds(groups, 5, 7), b = groupedFolds(groups, 5, 7);
    expect(a).toEqual(b);
    for (let i = 0; i < 100; i++) expect(a[i]).toBe(a[groups.indexOf(groups[i]!)]);
    const sizes = [0, 1, 2, 3, 4].map((f) => a.filter((v) => v === f).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(3);
    expect(groupedFolds(groups, 5, 8)).not.toEqual(a);
  });

  it("scores per sample (repeats averaged)", () => {
    const s = sampleScores([1, 3, 2, 2], [2, 2, 1, 1], [0, 0, 1, 1], false);
    expect(s.n).toBe(2);
    expect(s.rmse).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(s.bias).toBeCloseTo(0.5, 12);
  });
});

describe("Methods PLS path", () => {
  const mat = (n: number, p: number, seed: number): Matrix => {
    const r = rng(seed);
    return { data: Float64Array.from({ length: n * p }, () => r()), rows: n, cols: p };
  };

  it("equals the OLS solution when the LV count reaches the rank (known solution)", () => {
    const X = mat(12, 3, 3);
    const y = Float64Array.from({ length: 12 }, (_, i) => 2 + 3 * X.data[i * 3]! - X.data[i * 3 + 1]! + 0.5 * X.data[i * 3 + 2]!);
    const Xt = mat(4, 3, 5);
    const path = methodsPlsPath(X, y, 3, Xt);
    for (let i = 0; i < 4; i++) expect(path[2]![i]).toBeCloseTo(2 + 3 * Xt.data[i * 3]! - Xt.data[i * 3 + 1]! + 0.5 * Xt.data[i * 3 + 2]!, 8);
  });

  it("prefix predictions equal separate a-component Methods fits", () => {
    const X = mat(30, 40, 9), Xt = mat(7, 40, 10);
    const y = Float64Array.from({ length: 30 }, (_, i) => X.data[i * 40 + 3]! - 2 * X.data[i * 40 + 17]! + 0.1 * i);
    const path = methodsPlsPath(X, y, 6, Xt);
    for (const a of [1, 3, 6]) {
      const est = new PLSRegression({ n_components: a, solver: "nipals", center_x: true, scale_x: false, center_y: true, scale_y: false });
      est.fit(X, y);
      const pred = est.predict(Xt);
      est.dispose();
      for (let i = 0; i < 7; i++) expect(path[a - 1]![i]).toBeCloseTo(pred.data[i]!, 8);
    }
  });
});

describe("nested grouped PLS comparison", () => {
  const population = (binary = false): CalibrationPopulation => {
    const res = buildCalibrationPopulation(dataset({ binary }), "nir", "y");
    if (!res.ok) throw new Error(res.reason);
    return res.population;
  };

  it("fits learned preprocessing on training rows only (fit and apply rows always disjoint)", () => {
    const pop = population();
    const calls: { fit: Matrix; apply: Matrix[] }[] = [];
    const spy: ExplorerKernel & PlsKernel = {
      ...kernel,
      fitTransform(step, fit, apply, axisStep) {
        calls.push({ fit, apply: [...apply] });
        return kernel.fitTransform!(step, fit, apply, axisStep);
      },
    };
    const res = runChemometricComparison(spy, pop, [{ label: "MSC", steps: [{ kind: "msc", params: {} }] }]);
    expect(res.configs[0]!.error).toBeNull();
    // 5 outer folds × (5 inner fits + 1 outer fit).
    expect(calls.length).toBe(30);
    const key = (m: Matrix, i: number) => m.data.subarray(i * m.cols, (i + 1) * m.cols).join(",");
    for (const c of calls) {
      const fitRows = new Set(Array.from({ length: c.fit.rows }, (_, i) => key(c.fit, i)));
      for (const a of c.apply) for (let i = 0; i < a.rows; i++) expect(fitRows.has(key(a, i))).toBe(false);
    }
  });

  it("reports nested RMSECV, R², bias, selected LVs and a fixed LV curve; deterministic", () => {
    const pop = population();
    const configs = [{ label: "Raw", steps: [] }, { label: "SNV", steps: [{ kind: "snv" as const, params: {} }] }];
    const a = runChemometricComparison(kernel, pop, configs);
    const b = runChemometricComparison(kernel, pop, configs);
    expect(a).toEqual(b);
    expect(a.folds).toBe(5);
    expect(a.maxLv).toBe(15);
    for (const c of a.configs) {
      expect(c.error).toBeNull();
      expect(c.nested!.n).toBe(30);
      expect(c.nested!.r2!).toBeGreaterThan(0.9);
      expect(c.selectedLv).toHaveLength(5);
      expect(c.curve).toHaveLength(15);
    }
    expect(a.configs[1]!.nested!.rmse).not.toBe(a.configs[0]!.nested!.rmse);
  });

  it("binary target: PLS-DA on a 0/1 coding with balanced accuracy", () => {
    const pop = population(true);
    expect(pop.mode).toBe("binary");
    const res = runChemometricComparison(kernel, pop, [{ label: "SNV", steps: [{ kind: "snv", params: {} }] }]);
    expect(res.configs[0]!.nested!.balancedAccuracy!).toBeGreaterThan(80);
  });
});
