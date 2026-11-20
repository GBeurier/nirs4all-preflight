// Published explorer profile: per-band diagnostics for the quality map's Raw / Preprocessed toggle.
import { describe, expect, it } from "vitest";
import { explorerTrackInputs, hasPublishedBands, type PublishedBands } from "../overview/processed";
import { bandDiagnostics, getDistortionProfile, publishDistortionProfile, type DistortionProfile } from "./distortion";
import { diagnose, evaluatePipeline, type ExplorerKernel, type EvaluationInput } from "./evaluate";

const kernel: ExplorerKernel = {
  transform: (step, X) => ({ data: X.data.map((v) => (step.kind === "snv" ? v - 1 : v * 0.5)), rows: X.rows, cols: X.cols }),
  noise: () => null,
  events: (X) => ({ spikes: new Array(X.rows).fill(0), jumps: new Array(X.rows).fill(0), spikeBands: Array.from({ length: X.cols }, (_, j) => (j === 2 ? 1 : 0)), jumpBands: new Array(X.cols).fill(0) }),
  noiseProfile: (X) => ({ band: Array.from({ length: X.cols }, (_, j) => X.data[j]! * 0.01), pooled: 0.01 }),
  repeatability: (X) => ({ sd: new Array(X.cols).fill(0.1), icc: new Array(X.cols).fill(0.9) }),
  reference: () => null,
};
const input: EvaluationInput = {
  matrix: { data: Float64Array.from({ length: 4 * 5 }, (_, k) => 1 + k), rows: 4, cols: 5 },
  step: 1,
  groups: [0, 0, 1, 1],
  replicatedSamples: 2,
  settings: { eventThreshold: 8, eventMinSpectra: 5, noiseWindow: 3, noisePolyorder: 1 },
};
const axis = [10, 11, 12, 13, 14];

describe("published band diagnostics", () => {
  it("reshapes raw and processed diagnostics and satisfies the quality map's structural contract", () => {
    const before = diagnose(kernel, input, input.matrix);
    const ev = evaluatePipeline(kernel, input, before, [{ kind: "savgol", params: { window: 3, polyorder: 1 } }]);
    const raw = bandDiagnostics(before, 4), processed = bandDiagnostics(ev.after, 4);
    expect(raw.spikeBands).toEqual([0, 0, 1, 0, 0]);
    expect(raw.observations).toBe(4);
    expect(raw.icc).toEqual([0.9, 0.9, 0.9, 0.9, 0.9]);
    expect(processed.noiseProxy![0]).toBeCloseTo(raw.noiseProxy![0]! * 0.5, 12);
    const profile: DistortionProfile = { sourceId: "s", axis, values: ev.distortion, label: "SG", n: 4, fineScaleReductionPercent: null, bands: { raw, processed, preservesUnits: ev.preservesUnits, comparability: ev.comparability } };
    publishDistortionProfile(profile);
    const got = getDistortionProfile() as PublishedBands | null;
    expect(hasPublishedBands(got, axis)).toBe(true);
    const inputs = explorerTrackInputs(got as Parameters<typeof explorerTrackInputs>[0], "processed", "AU");
    expect(inputs.profiles!.diversity).toEqual(processed.diversity);
    publishDistortionProfile(null);
  });

  it("publishes a withheld distortion (unit change) as null values with bands kept", () => {
    const before = diagnose(kernel, input, input.matrix);
    const ev = evaluatePipeline(kernel, input, before, [{ kind: "snv", params: {} }]);
    expect(ev.distortion).toBeNull();
    const p: PublishedBands = { sourceId: "s", axis, values: ev.distortion, label: "SNV", n: 4, bands: { raw: bandDiagnostics(before, 4), processed: bandDiagnostics(ev.after, 4), preservesUnits: ev.preservesUnits, comparability: ev.comparability } };
    expect(hasPublishedBands(p, axis)).toBe(true);
    expect(explorerTrackInputs(p as Parameters<typeof explorerTrackInputs>[0], "processed", "AU").profiles!.unit).toBe("processed units");
  });
});
