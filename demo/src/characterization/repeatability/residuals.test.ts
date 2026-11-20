import { describe, expect, it } from "vitest";
import type { InputSource } from "../../input";
import { capRows, computeResiduals } from "./residuals";

const p = 30;
const axis = Array.from({ length: p }, (_, i) => 900 + 2 * i);
const source = (): InputSource => ({
  source_id: "nir",
  observation_ids: ["a", "b", "c"],
  sample_ids: ["a", "b", "c"],
  axis,
  // quadratic (exactly reproduced by an order-2 SG smoother), a quadratic + alternating component, and one with a missing value
  x: [
    axis.map((_, j) => 1 + 0.1 * j + 0.01 * j * j),
    axis.map((_, j) => 1 + 0.1 * j + 0.01 * j * j + (j % 2 ? 0.05 : -0.05)),
    axis.map((_, j) => (j === 15 ? null : 2 + 0.02 * j)),
  ],
});

describe("Savitzky–Golay residuals (Methods WASM kernel)", () => {
  it("are ~0 for polynomial signals, signed for alternating noise, null around missing cells, and leave the input unchanged", async () => {
    const src = source();
    const before = JSON.stringify(src);
    const r = await computeResiduals(src, [0, 1, 2], 7, 2);
    expect(r.backend).toMatch(/^@nirs4all\/methods 1\.5\./);
    for (let j = 3; j < p - 3; j++) expect(Math.abs(r.residual[0]![j]!)).toBeLessThan(1e-9);
    expect(r.residual[1]![10]! * r.residual[1]![11]!).toBeLessThan(0);
    for (let j = 12; j <= 18; j++) expect(r.residual[2]![j]).toBeNull();
    expect(r.residual[2]![11]).not.toBeNull();
    expect(r.raw[2]![15]).toBeNull();
    expect(r.edge).toEqual([{ i0: 0, i1: 2 }, { i0: p - 3, i1: p - 1 }]);
    expect(r.medianResidual).toHaveLength(p);
    expect(r.spreadResidual.every((v) => v === null || v >= 0)).toBe(true);
    expect(JSON.stringify(src)).toBe(before);
  });

  it("caps rows evenly", () => {
    expect(capRows([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 2, 5, 7]);
    expect(capRows([1, 2], 5)).toEqual([1, 2]);
  });
});
