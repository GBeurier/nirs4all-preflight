// Test-only generator of heterogeneous synthetic engine inputs with arbitrary factor names, levels and sizes
// (no dataset-specific names). Each unit is one physical sample with one spectrum; factor levels add a smooth
// spectral bump so marginal and adjusted associations differ between designs.
import type { EngineInput, InputSample, InputTargetValue } from "../../input";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DesignSpec {
  /** factor name -> level of each unit (same length for all factors) */
  factors: Record<string, readonly string[]>;
  /** spectral effect amplitude per factor (default 0.05) */
  effects?: Record<string, number>;
  /** continuous target (true) or none (false, default) */
  target?: boolean;
  bands?: number;
  seed?: number;
  exchangeable?: boolean;
  /** factor names declared through `instrument` / `campaign` instead of metadata columns */
  asSampleField?: Record<string, "instrument" | "campaign">;
  /** explicit per-unit noise sd (default 0.01) */
  noise?: number;
  /** units declared with a shared independence group label (merged into one unit when independence_unit = group) */
  groups?: readonly string[];
}

export function designInput(spec: DesignSpec): EngineInput {
  const names = Object.keys(spec.factors);
  const n = names.length ? spec.factors[names[0]!]!.length : 12;
  const rnd = mulberry32(spec.seed ?? 7);
  const p = spec.bands ?? 40;
  const axis = Array.from({ length: p }, (_, i) => 100 + i * 3.5);
  const samples: InputSample[] = [];
  const x: number[][] = [];
  const values: InputTargetValue[] = [];
  const meta: Record<string, Record<string, string>> = {};
  const levelIndex = (f: string, l: string) => [...new Set(spec.factors[f])].sort().indexOf(l);
  for (let i = 0; i < n; i++) {
    const id = `u${String(i + 1).padStart(3, "0")}`;
    const sample: InputSample = { sample_id: id, physical_sample_id: `ph-${id}`, partition: "development" };
    if (spec.groups) sample.independence_group = spec.groups[i]!;
    const row = axis.map((w, j) => 0.3 + 0.1 * Math.sin(j / 7) + (rnd() - 0.5) * 2 * (spec.noise ?? 0.01));
    names.forEach((f, k) => {
      const level = spec.factors[f]![i]!;
      const field = spec.asSampleField?.[f];
      if (field) sample[field] = level;
      else (meta[id] ??= {})[f] = level;
      const amp = (spec.effects?.[f] ?? 0.05) * levelIndex(f, level);
      const centre = axis[Math.floor(((k + 1) * p) / (names.length + 1))]!;
      row.forEach((_, j) => { row[j]! += amp * Math.exp(-(((axis[j]! - centre) / 12) ** 2)); });
    });
    samples.push(sample);
    x.push(row.map((v) => Number(v.toFixed(6))));
    values.push({ sample_id: id, value: Number((10 + 5 * rnd()).toFixed(3)), status: "exact" });
  }
  const columns = names.filter((f) => !spec.asSampleField?.[f]).map((name) => ({ name, kind: "categorical" as const }));
  return {
    schema_version: 1,
    data_origin: "synthetic",
    sources: [{ source_id: "src_a", observation_ids: samples.map((s) => `${s.sample_id}-o`), sample_ids: samples.map((s) => s.sample_id), x, axis, axis_unit: "arb", signal_unit: "arb" }],
    samples,
    targets: spec.target ? [{ target_id: "response_q", kind: "continuous", values }] : [],
    ...(columns.length ? { metadata: { columns, values: meta } } : {}),
    options: {
      independence_unit: spec.groups ? "group" : "sample",
      seed: spec.seed ?? 11,
      exchangeable_units: spec.exchangeable ?? true,
      analysis_families: { spectral_quality: false, sensitivity: false, repeatability: false, clustering: false, association: true, confounding: true, domain_shift: false, probe: false },
    },
  };
}

/** Repeats `levels` cyclically to n entries. */
export const cycle = (levels: readonly string[], n: number, every = 1) => Array.from({ length: n }, (_, i) => levels[Math.floor(i / every) % levels.length]!);
