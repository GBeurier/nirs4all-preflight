// Exact between-sample SD for unbalanced replicate designs, validated on the REAL engine: the demo reads
// the engine's per-band REML variance components (measurement.icc_1_reml parameters) and this test checks
// (1) σb²/(σb² + σw²) reproduces the engine's REML ICC per band, (2) the Methods REML kernel run locally on
// rows grouped by `contextGroups` (the demo mirror of the engine's `analyze_repeats`) gives the same
// components, so the grouping the inspection views use is the engine's, and (3) the profiles use √σb².
import { beforeAll, describe, expect, it } from "vitest";
import { loadModule, statsVarianceComponentsReml } from "@nirs4all/methods";
import { createQualificationRuntime } from "@nirs4all/preflight";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";
import { syntheticInput } from "../../synthetic";
import { cell, contextGroups, remlComponents, repeatProfiles } from "./profiles";

const fsName = "node:fs/promises";
const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(path: URL): Promise<Uint8Array> };
const modules = new URL("../../../node_modules/", import.meta.url);
const runtime = await createQualificationRuntime({
  wasmModule: await fs.readFile(new URL("@nirs4all/preflight/native/nirs4all_preflight_wasm_bg.wasm", modules)),
  dagMlWasmModule: await fs.readFile(new URL("../../bindings/wasm/node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm", modules)),
});

/** Pitfalls synthetic set made unbalanced: s02 keeps 2 of its 3 rescans (context rescan · synthetic-a · 2026-B → sizes 2, 3, 3). */
function unbalancedInput(): EngineInput {
  const input = syntheticInput("pitfalls");
  const src = input.sources[0]!;
  const drop = src.observation_ids.indexOf("s02-r3");
  const keep = (_: unknown, i: number) => i !== drop;
  src.observation_ids = src.observation_ids.filter(keep);
  src.sample_ids = src.sample_ids.filter(keep);
  src.x = src.x.filter(keep);
  src.repetition_types = src.repetition_types!.filter(keep);
  return input;
}

beforeAll(async () => {
  await loadModule();
});

describe("REML between-sample SD (real engine, unbalanced replicates)", () => {
  const input = unbalancedInput();
  const report = runtime.analyze(input) as EngineReport;
  const view = buildQualificationReportView(report);
  const sourceId = "synthetic_nir";
  const source = input.sources[0]!;
  const profiles = repeatProfiles(view, sourceId);
  const reml = profiles.filter((p) => p.iccKind === "icc_1_reml");

  it("has an unbalanced context reported with the REML ICC", () => {
    expect(reml.length).toBeGreaterThan(0);
    expect(reml.every((p) => p.betweenKind === "reml")).toBe(true);
  });

  it("σb²/(σb² + σw²) of the engine components equals the engine REML ICC per band", () => {
    for (const p of reml) {
      const c = remlComponents(view, sourceId, p.context)!;
      let compared = 0;
      p.icc!.forEach((icc, i) => {
        const b = c.between[i];
        const w = c.within[i];
        if (icc === null || b === null || w === null || b === undefined || w === undefined) return;
        expect(b / (b + w)).toBeCloseTo(icc, 10);
        expect(p.betweenSd[i]).toBeCloseTo(Math.sqrt(b), 12);
        compared++;
      });
      expect(compared).toBeGreaterThan(50);
    }
  });

  it("the Methods REML kernel on the demo's engine-mirrored groups reproduces the engine components", () => {
    for (const p of reml) {
      const groups = contextGroups(input, source, p.context);
      const rows = groups.flatMap((g) => g.rows);
      const ids = groups.flatMap((g, k) => g.rows.map(() => k));
      const cols = source.axis.length;
      const data = new Float64Array(rows.length * cols);
      const mask = new Uint8Array(rows.length * cols);
      rows.forEach((r, i) => source.axis.forEach((_, c) => {
        const v = cell(source, r, c);
        data[i * cols + c] = v ?? 0;
        mask[i * cols + c] = v === null ? 0 : 1;
      }));
      const local = statsVarianceComponentsReml({ data, rows: rows.length, cols }, ids, mask);
      const engine = remlComponents(view, sourceId, p.context)!;
      let compared = 0;
      for (let i = 0; i < cols; i++) {
        const b = engine.between[i];
        const w = engine.within[i];
        if (b === null || w === null || b === undefined || w === undefined) continue;
        const scale = Math.max(b + w, 1e-300);
        expect(Math.abs(local.sigma2Between[i]! - b) / scale).toBeLessThan(1e-9);
        expect(Math.abs(local.sigma2Within[i]! - w) / scale).toBeLessThan(1e-9);
        expect(local.icc[i]!).toBeCloseTo(p.icc![i]!, 9);
        compared++;
      }
      expect(compared).toBeGreaterThan(50);
    }
  });
});
