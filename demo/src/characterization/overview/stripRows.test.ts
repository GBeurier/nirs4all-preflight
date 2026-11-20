import { describe, expect, it } from "vitest";
import { classRuns } from "../shared/charts/SegmentStrip";
import { binValues, niceTicks } from "../shared/charts/scale";
import { meanSpectrum, bandSd } from "./bandStats";
import { sequentialClass, stripRows, windowed } from "./stripRows";
import { buildTracks } from "./tracks";

const f = (v: number) => String(Number(v.toPrecision(3)));

describe("quality map strips", () => {
  it("bins sequential values into 5 classes of the track's own domain", () => {
    expect(sequentialClass([0, 10], 0)).toBe(0);
    expect(sequentialClass([0, 10], 10)).toBe(4);
    expect(sequentialClass([0, 10], 5)).toBe(2);
    expect(sequentialClass([3, 3], 3)).toBe(0);
  });

  it("orders rows like the mockup and keeps nulls as not evaluable", () => {
    const axis = [1000, 1002, 1004, 1006];
    const tracks = buildTracks({ axis, observations: 10, spikes: { axis, counts: [0, 2, 2, 0] }, jumps: null, distortion: null, profiles: { axis, repeatabilitySd: null, icc: null, noiseProxy: [0.1, null, 0.3, 0.4], noiseToDiversity: null, diversity: null, unit: "a.u.", diversityBasis: "spectrum", provenance: {}, unavailable: {} } });
    const rows = stripRows(tracks, f);
    expect(rows.map((r) => r.label).slice(0, 2)).toEqual(["Noise", "Spikes"]);
    expect(rows[0]!.values[1]).toBeNull();
    expect(rows[0]!.classes).toHaveLength(5);
  });
});

describe("strip legend shares", () => {
  it("counts individual bands, not the coarsened window extremes", () => {
    const axis = Array.from({ length: 96 }, (_, i) => 1000 + 2 * i);
    const noise = axis.map((_, i) => (i % 2 ? 1 : 0));
    const tracks = buildTracks({ axis, observations: 10, spikes: null, jumps: null, distortion: null, profiles: { axis, repeatabilitySd: null, icc: null, noiseProxy: noise, noiseToDiversity: null, diversity: null, unit: "a.u.", diversityBasis: "spectrum", provenance: {}, unavailable: {} } });
    const row = stripRows(tracks, f).find((r) => r.label === "Noise")!;
    expect(row.values.every((v) => v === "c4")).toBe(true);
    expect(row.bandValues!.filter((v) => v === "c4")).toHaveLength(48);
  });
});

describe("strip windows", () => {
  it("keeps the window extreme so a local peak is not averaged away, and nulls only all-null windows", () => {
    const v = [0, 0, 5, 0, null, null, 1, 2];
    expect(windowed(v, "max", 4)).toEqual([0, 0, 5, 5, null, null, 2, 2]);
    expect(windowed(v, "min", 4)).toEqual([0, 0, 0, 0, null, null, 1, 1]);
    expect(windowed([1, 2], "max", 4)).toEqual([1, 2]);
  });
});

describe("chart kit helpers", () => {
  it("merges identical consecutive classes into runs", () => {
    expect(classRuns(["a", "a", null, "b", "b", "b"])).toEqual([{ start: 0, end: 1, id: "a" }, { start: 2, end: 2, id: null }, { start: 3, end: 5, id: "b" }]);
    expect(classRuns([])).toEqual([]);
  });

  it("bins values and ignores non-finite ones", () => {
    const bins = binValues([0, 1, 2, 3, null, Number.NaN, 4], 4);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(5);
    expect(bins[3]!.count).toBe(2);
    expect(binValues([], 4)).toEqual([]);
    expect(binValues([2, 2], 4)).toEqual([{ lo: 2, hi: 2, count: 2 }]);
  });

  it("produces nice ticks", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe("band statistics", () => {
  it("computes mean and SD per band over finite values without mutating the input", () => {
    const x = [[1, null, 3], [3, 2, 3]] as const;
    const copy = JSON.stringify(x);
    expect(meanSpectrum(x, 3)).toEqual([2, 2, 3]);
    expect(bandSd(x, 3)).toEqual([Math.SQRT2, null, 0]);
    expect(JSON.stringify(x)).toBe(copy);
  });
});
