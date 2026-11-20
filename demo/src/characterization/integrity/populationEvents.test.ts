// Branches the engine datasets do not exercise (valid_mask, physical irregular axis, too few spectra),
// checked against the Methods kernel itself, plus the merging rule and the noise-injection validation.
import { SpectralNoiseProxy, SpectralPopulationEventsQc, loadModule, type Matrix } from "@nirs4all/methods";
import { beforeAll, describe, expect, it } from "vitest";
import { gaussianSequence } from "./model";
import { injectNoise, validateNoiseEstimator, type NoiseEstimate } from "./noiseValidation";
import { MERGE_GAP, engineMatrix, mergeEvents, perSpectrum, populationEvents, type EventsMatrix } from "./populationEvents";

beforeAll(async () => { await loadModule(); });

/** Smooth spectra with a little noise, a few planted spikes and steps; deterministic. */
function synthetic(n: number, p: number, seed = 7): EventsMatrix {
  const g = gaussianSequence(n * p, seed);
  const x = new Float64Array(n * p);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) x[i * p + j] = 1 + 0.4 * Math.sin(j / 9 + i / 13) + 0.002 * g[i * p + j]!;
  x[3 * p + 20] = x[3 * p + 20]! + 0.3;
  x[5 * p + 41] = x[5 * p + 41]! - 0.25;
  for (let j = 30; j < p; j++) x[8 * p + j] = x[8 * p + j]! + 1;
  return { n, p, x, mask: null, physical: false, axis: null };
}

function methods(m: EventsMatrix, threshold: number, minSpectra = 5) {
  const params: Record<string, unknown> = { outlier_threshold: threshold, min_spectra: minSpectra, axis_basis: m.physical ? "physical" : "index" };
  if (m.physical) params.axis_values = [...m.axis!];
  if (m.mask) params.valid_mask = Array.from(m.mask);
  const out = new SpectralPopulationEventsQc(params as never).run({ rows: m.n, cols: m.p, data: m.x } satisfies Matrix);
  const counts = (kind: string) => {
    const v: (number | null)[] = new Array(m.n).fill(null);
    const values = out[`${kind}_count_values`] as Matrix | undefined;
    (out[`${kind}_count_rows`] as number[] | undefined)?.forEach((r, k) => { v[r] = values!.data[k]!; });
    return v;
  };
  return { spike: counts("spike"), jump: counts("jump"), spikeBands: Array.from(out.spike_band_counts as number[]), jumpBands: Array.from(out.jump_band_counts as number[]), spikeEvaluated: Array.from(out.spike_band_evaluated as number[]) };
}

describe("population events port = Methods kernel", () => {
  const cases: [string, () => EventsMatrix, number][] = [
    ["index axis", () => synthetic(30, 80), 6],
    ["index axis, low threshold", () => synthetic(30, 80), 2.5],
    ["valid_mask with holes", () => {
      const m = synthetic(30, 80);
      const mask = new Uint8Array(m.n * m.p).fill(1);
      for (let t = 0; t < mask.length; t += 37) { mask[t] = 0; m.x[t] = 0; }
      return { ...m, mask };
    }, 4],
    ["physical irregular decreasing axis", () => ({ ...synthetic(25, 60), physical: true, axis: Array.from({ length: 60 }, (_, j) => 4000 - 3.7 * j - 0.02 * j * j) }), 5],
  ];
  for (const [name, make, threshold] of cases) {
    it(name, () => {
      const m = make();
      const local = populationEvents(m, threshold);
      const owner = methods(m, threshold);
      expect(local.spike.counts).toEqual(owner.spike);
      expect(local.jump.counts).toEqual(owner.jump);
      expect(Array.from(local.spike.bandCounts)).toEqual(owner.spikeBands);
      expect(Array.from(local.jump.bandCounts)).toEqual(owner.jumpBands);
      expect(Array.from(local.spike.bandEvaluated)).toEqual(owner.spikeEvaluated);
    });
  }

  it("fewer spectra than min_spectra: no evaluated position, every count unavailable", () => {
    const local = populationEvents(synthetic(4, 30), 4);
    expect(local.spike.counts.every((c) => c === null)).toBe(true);
    expect(local.spike.status).toBe(1);
  });

  it("finds the planted spike at its band and the step as a jump", () => {
    const local = populationEvents(synthetic(30, 80), 8);
    const spikeAt = [...local.spike.rows].map((r, t) => [r, local.spike.bands[t]]);
    expect(spikeAt).toContainEqual([3, 20]);
    const jumpAt = [...local.jump.rows].map((r, t) => [r, local.jump.bands[t]]);
    expect(jumpAt).toContainEqual([8, 30]);
  });

  it("assembles the engine matrix from observation ids (masking nulls and valid_mask, input untouched)", () => {
    const source = { axis: [1, 2, 3], x: [[1, null, 3], [4, 5, 6], [7, 8, 9]], observation_ids: ["a", "b", "c"], valid_mask: [[true, true, true], [true, false, true], [true, true, true]] };
    const { matrix, missing } = engineMatrix(source, ["c", "a", "zz"], { physical: false });
    expect(missing).toEqual(["zz"]);
    expect(Array.from(matrix.x)).toEqual([7, 8, 9, 1, 0, 3]);
    expect(Array.from(matrix.mask!)).toEqual([1, 1, 1, 1, 0, 1]);
    expect(source.x[0]).toEqual([1, null, 3]);
  });
});

describe("merging contiguous flags into physical events", () => {
  const flags = (rows: number[], bands: number[], scores: number[]) => ({ rows: Int32Array.from(rows), bands: Int32Array.from(bands), scores: Float64Array.from(scores) });
  it(`merges flags of one spectrum ≤ ${MERGE_GAP} bands apart, never across spectra`, () => {
    const spike = flags([0, 0, 0, 0, 1], [10, 11, 12, 30, 11], [9, 20, 9, 12, 15]);
    const jump = flags([0, 0, 1], [11, 12, 40], [10, 11, 9]);
    const merged = mergeEvents(spike, jump);
    expect(merged.map((e) => [e.row, e.start, e.end, e.spikeFlags, e.jumpFlags])).toEqual([[0, 10, 12, 3, 2], [0, 30, 30, 1, 0], [1, 11, 11, 1, 0], [1, 40, 40, 0, 1]]);
    expect(merged[0]).toMatchObject({ maxScore: 20, maxBand: 11, maxKind: "spike" });
    const per = perSpectrum(merged);
    expect(per.map((s) => [s.row, s.physical, s.spikes, s.jumps, s.maxScore])).toEqual([[0, 2, 4, 2, 20], [1, 2, 1, 1, 15]]);
  });
  it("a gap of three bands starts a new event", () => {
    expect(mergeEvents(flags([2, 2], [5, 8], [9, 9]), flags([], [], []))).toHaveLength(2);
  });
});

describe("noise-injection validation with the Methods estimator", () => {
  const estimate = (m: EventsMatrix): NoiseEstimate => {
    const out = new SpectralNoiseProxy(m.mask ? { valid_mask: Array.from(m.mask) } : {}).run({ rows: m.n, cols: m.p, data: m.x });
    const read = (name: string) => {
      const v: (number | null)[] = new Array(m.n).fill(null);
      const values = out[`${name}_values`] as Matrix;
      (out[`${name}_rows`] as number[]).forEach((r, k) => { v[r] = values.data[k]!; });
      return v;
    };
    return { sigma: read("noise_sigma"), meanAbs: read("signal_mean_abs") };
  };

  it("injection is seeded, leaves the input untouched and keeps masked cells", () => {
    const m = { ...synthetic(5, 20), mask: new Uint8Array(100).fill(1) };
    m.mask[3] = 0;
    const before = Float64Array.from(m.x);
    const a = injectNoise(m, 0.01, [1, 1, 1, 1, 1], 11);
    const b = injectNoise(m, 0.01, [1, 1, 1, 1, 1], 11);
    expect(Array.from(m.x)).toEqual(Array.from(before));
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(a.x[3]).toBe(m.x[3]);
    expect(a.x[4]).not.toBe(m.x[4]);
  });

  it("recovers the injected relative noise once it dominates the spectra's own variation", () => {
    const r = validateNoiseEstimator(synthetic(40, 400), estimate)!;
    expect(r.levels).toHaveLength(6);
    const top = r.levels[r.levels.length - 1]!;
    expect(top.injected / r.baseline.p50).toBeCloseTo(100, 6);
    expect(top.excess.p50 / top.injected).toBeGreaterThan(0.9);
    expect(top.excess.p50 / top.injected).toBeLessThan(1.1);
    // Recovered total noise grows monotonically with the injected level.
    for (let k = 1; k < r.levels.length; k++) expect(r.levels[k]!.recovered.p50).toBeGreaterThan(r.levels[k - 1]!.recovered.p50);
  });
});
