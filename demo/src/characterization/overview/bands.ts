// Pure band helpers of the characterization overview (comment rules and quality map). Bands are
// always in source-axis order (the order of `source.axis`), whatever its direction or spacing.

/** Maximal runs of consecutive `true` flags (inclusive indices) of at least `minLength` bands. */
export function contiguousRuns(flags: readonly boolean[], minLength = 1): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLength) runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/** Flags of the evaluable bands at or above a threshold; non-evaluable bands never count. */
export const flagAtLeast = (values: readonly (number | null | undefined)[], threshold: number): boolean[] => values.map((v) => v !== null && v !== undefined && Number.isFinite(v) && v >= threshold);

export interface RegionRun {
  /** Inclusive band indices and the axis values of the first and last band. */
  start: number;
  end: number;
  from: number;
  to: number;
  bands: number;
}

export function runRegions(axis: readonly number[], flags: readonly boolean[], minLength: number): RegionRun[] {
  return contiguousRuns(flags, minLength).map((r) => ({ ...r, from: axis[r.start]!, to: axis[r.end]!, bands: r.end - r.start + 1 }));
}

/** Axis interval of a region in ascending order, e.g. for text ("1,520–1,560"). */
export const regionSpan = (r: Pick<RegionRun, "from" | "to">): [number, number] => (r.from <= r.to ? [r.from, r.to] : [r.to, r.from]);
