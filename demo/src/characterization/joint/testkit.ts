// Heterogeneous synthetic inputs for the joint module tests: arbitrary factor / target names and designs.
// Test support only (never imported by production code).
import type { EngineInput, InputMetadataColumn, InputSample, InputTarget } from "../../input";

export interface FactorSpec {
  name: string;
  kind: "categorical" | "continuous";
  /** Level (categorical) or value (continuous) of unit i; null = missing. */
  of: (i: number) => string | number | null;
  unit?: string;
}

export interface TargetSpec {
  id: string;
  kind: "continuous" | "categorical";
  /** Value of unit i (continuous) or class label (categorical). */
  of: (i: number, levels: Record<string, string | number | null>) => number | string;
  unit?: string;
}

export interface SynthOptions {
  units: number;
  factors?: FactorSpec[];
  targets?: TargetSpec[];
  /** Units i with retained(i) true are retained test. */
  retained?: (i: number) => boolean;
  /** Spectra per unit (technical rescans). */
  repeats?: number;
  bands?: number;
  seed?: number;
  /** Factor names whose level shifts the spectra. */
  spectralFactors?: string[];
  instrument?: (i: number) => string | undefined;
  exchangeable?: boolean;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthInput(o: SynthOptions): EngineInput {
  const rand = rng(o.seed ?? 7);
  const p = o.bands ?? 24;
  const reps = o.repeats ?? 1;
  const factors = o.factors ?? [];
  const samples: InputSample[] = [];
  const values: Record<string, Record<string, string | number | null>> = {};
  const x: number[][] = [];
  const observationIds: string[] = [];
  const sampleIds: string[] = [];
  const levelCode = new Map<string, number>();
  for (let i = 0; i < o.units; i++) {
    const id = `obj-${String(i).padStart(3, "0")}`;
    const meta: Record<string, string | number | null> = {};
    for (const f of factors) meta[f.name] = f.of(i);
    values[id] = meta;
    const s: InputSample = { sample_id: id, physical_sample_id: `phys-${i}`, partition: o.retained?.(i) ? "retained_test" : "development" };
    const ins = o.instrument?.(i);
    if (ins !== undefined) s.instrument = ins;
    samples.push(s);
    let shift = 0;
    for (const name of o.spectralFactors ?? []) {
      const v = meta[name];
      if (typeof v === "string") {
        if (!levelCode.has(`${name}:${v}`)) levelCode.set(`${name}:${v}`, levelCode.size);
        shift += 0.4 * levelCode.get(`${name}:${v}`)!;
      } else if (typeof v === "number") shift += 0.05 * v;
    }
    const base = rand();
    for (let r = 0; r < reps; r++) {
      x.push(Array.from({ length: p }, (_, c) => 1 + Math.sin(c / 4) * (0.5 + base) + shift * Math.cos(c / 6) + 0.01 * (rand() - 0.5)));
      observationIds.push(`${id}#${r}`);
      sampleIds.push(id);
    }
  }
  const targets: InputTarget[] = (o.targets ?? []).map((t) => ({
    target_id: t.id,
    kind: t.kind,
    ...(t.unit ? { unit: t.unit } : {}),
    values: samples.map((s, i) => {
      const v = t.of(i, values[s.sample_id]!);
      return t.kind === "continuous" ? { sample_id: s.sample_id, value: v as number, status: "exact" as const } : { sample_id: s.sample_id, category: String(v), status: "exact" as const };
    }),
  }));
  const columns: InputMetadataColumn[] = factors.map((f) => ({ name: f.name, kind: f.kind, ...(f.unit ? { unit: f.unit } : {}) }));
  return {
    schema_version: 1,
    data_origin: "synthetic",
    sources: [{ source_id: "src", observation_ids: observationIds, sample_ids: sampleIds, x, axis: Array.from({ length: p }, (_, c) => 1000 + 2 * c), axis_unit: "nm", signal_unit: "a.u.", ...(reps > 1 ? { repetition_types: observationIds.map(() => "rescan" as const) } : {}) }],
    samples,
    targets,
    ...(columns.length ? { metadata: { columns, values } } : {}),
    options: { independence_unit: "sample", seed: 11, exchangeable_units: o.exchangeable ?? true },
  };
}

/** Wraps the targets so that reading `value` / `category` of a retained-test row throws. */
export function guardRetainedTargets(input: EngineInput): EngineInput {
  const partition = new Map(input.samples.map((s) => [s.sample_id, s.partition ?? "development"]));
  const targets = input.targets.map((t) => ({
    ...t,
    values: t.values.map((v) => {
      if (partition.get(v.sample_id) === "development") return v;
      const guarded = { sample_id: v.sample_id, status: v.status } as typeof v;
      for (const key of ["value", "category"] as const) {
        Object.defineProperty(guarded, key, { enumerable: true, get() { throw new Error(`retained-test target ${key} accessed (${v.sample_id})`); } });
      }
      return guarded;
    }),
  }));
  return { ...input, targets };
}
