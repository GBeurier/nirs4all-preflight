import { describe, expect, it } from "vitest";
import { contiguousRuns, flagAtLeast, regionSpan, runRegions } from "./bands";

describe("contiguousRuns", () => {
  it("returns maximal runs of true flags, including one that reaches the end", () => {
    expect(contiguousRuns([false, true, true, false, true, true, true])).toEqual([{ start: 1, end: 2 }, { start: 4, end: 6 }]);
  });
  it("drops runs shorter than the minimum length and handles empty input", () => {
    expect(contiguousRuns([true, false, true, true, true], 3)).toEqual([{ start: 2, end: 4 }]);
    expect(contiguousRuns([])).toEqual([]);
    expect(contiguousRuns([false, false])).toEqual([]);
  });
});

describe("flagAtLeast", () => {
  it("never flags non-evaluable bands (null, NaN) and keeps negative values below the threshold", () => {
    expect(flagAtLeast([null, 0.3, 0.29, Number.NaN, 1, -2, undefined], 0.3)).toEqual([false, true, false, false, true, false, false]);
  });
});

describe("runRegions", () => {
  it("reports the axis values of the first and last band, also on a descending irregular axis", () => {
    const axis = [4000, 3990, 3970, 3930, 3900, 3800];
    const regions = runRegions(axis, [false, true, true, true, false, false], 3);
    expect(regions).toEqual([{ start: 1, end: 3, from: 3990, to: 3930, bands: 3 }]);
    expect(regionSpan(regions[0]!)).toEqual([3930, 3990]);
  });
  it("requires the minimum number of bands: a single band is never a region", () => {
    expect(runRegions([1, 2, 3, 4], [false, true, false, true], 3)).toEqual([]);
  });
});
