import { describe, expect, it, vi } from "vitest";
import { createEngineHost, EngineError } from "./engine";
import { buildEngineInput, defaultConfig, parseCanonicalInput, parseSeed } from "./input";
import { syntheticInput } from "./synthetic";

// Field lists of the Rust structs (`#[serde(deny_unknown_fields)]` in nirs4all-preflight-core).
const RUST_FIELDS = {
  input: ["data_origin", "schema_version", "sources", "samples", "targets", "options"],
  source: ["source_id", "observation_ids", "sample_ids", "x", "valid_mask", "axis", "axis_unit", "signal_unit", "signal_type", "repetition_types"],
  sample: ["sample_id", "physical_sample_id", "partition", "independence_group", "instrument", "campaign", "individual_id", "augmentation_parent_id"],
  target: ["target_id", "kind", "values", "unit"],
  value: ["sample_id", "value", "category", "status", "reference_id", "reference_group_id"],
  options: ["independence_unit", "assume_one_observation_per_sample", "seed", "max_cells", "max_samples"],
};
const unknownKeys = (o: object, allowed: readonly string[]) => Object.keys(o).filter((k) => !allowed.includes(k));

describe("canonical input boundary", () => {
  it("rejects non-JSON, wrong schema and missing fields", () => {
    expect(parseCanonicalInput("{")).toMatchObject({ ok: false, code: "not_json" });
    expect(parseCanonicalInput("[]")).toMatchObject({ ok: false, code: "not_object" });
    expect(parseCanonicalInput('{"schema_version":2}')).toMatchObject({ ok: false, code: "schema_version" });
    expect(parseCanonicalInput('{"schema_version":1,"sources":[]}')).toMatchObject({ ok: false, code: "missing_field", detail: "samples" });
    expect(parseCanonicalInput('{"schema_version":1,"sources":[{"source_id":"a","x":[],"axis":[]}],"samples":[]}')).toMatchObject({ ok: false, code: "missing_field", detail: "sources[0].observation_ids" });
  });

  it("defaults optional targets/options like the Rust serde defaults", () => {
    const parsed = parseCanonicalInput('{"schema_version":1,"sources":[],"samples":[]}');
    expect(parsed).toMatchObject({ ok: true, input: { targets: [], options: {} } });
  });

  it("sends every source and target, keeps declared budgets and only edits options", () => {
    const input = syntheticInput("pitfalls");
    input.options.max_cells = 5000;
    const config = { ...defaultConfig(input), independenceUnit: "group" as const, seed: 7 };
    const built = buildEngineInput(input, config);
    expect(built.sources).toBe(input.sources);
    expect(built.targets).toBe(input.targets);
    expect(built.samples).toBe(input.samples);
    expect(built.options).toEqual({ independence_unit: "group", seed: 7, max_cells: 5000 });
    expect(buildEngineInput(input, { ...config, seed: null }).options).not.toHaveProperty("seed");
  });

  it("accepts only seeds JS can carry exactly", () => {
    expect(parseSeed("")).toBeNull();
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("-1")).toBe("invalid");
    expect(parseSeed("1.5")).toBe("invalid");
    expect(parseSeed("18446744073709551615")).toBe("invalid");
  });
});

describe("synthetic inputs follow the Rust schema", () => {
  for (const scenario of ["clean", "pitfalls"] as const) {
    it(`${scenario}: no field outside the typed schema`, () => {
      const input = syntheticInput(scenario);
      expect(unknownKeys(input, RUST_FIELDS.input)).toEqual([]);
      expect(unknownKeys(input.options, RUST_FIELDS.options)).toEqual([]);
      for (const s of input.sources) expect(unknownKeys(s, RUST_FIELDS.source)).toEqual([]);
      for (const s of input.samples) expect(unknownKeys(s, RUST_FIELDS.sample)).toEqual([]);
      for (const t of input.targets) {
        expect(unknownKeys(t, RUST_FIELDS.target)).toEqual([]);
        for (const v of t.values) expect(unknownKeys(v, RUST_FIELDS.value)).toEqual([]);
      }
    });
  }

  it("pitfalls declares repetition types per row on the source", () => {
    const s = syntheticInput("pitfalls").sources[0]!;
    expect(s.repetition_types).toHaveLength(s.x.length);
    const typesOf = (sample: string) => s.sample_ids.flatMap((id, i) => (id === sample ? [s.repetition_types![i]] : []));
    expect(typesOf("s01")).toEqual(["rescan", "rescan", "rescan"]);
    expect(typesOf("s09")).toEqual(["unknown", "unknown"]);
    expect(typesOf("s20")).toEqual(["unknown"]);
    expect(syntheticInput("clean").sources[0]).not.toHaveProperty("repetition_types");
  });

  it("pitfalls contain a null cell and an exact cross-sample duplicate", () => {
    const s = syntheticInput("pitfalls").sources[0]!;
    expect(s.x.some((r) => r.includes(null))).toBe(true);
    expect(s.x[s.observation_ids.indexOf("s10-r1")]).toEqual(s.x[s.observation_ids.indexOf("s11-r1")]);
    expect(syntheticInput("clean").sources[0]!.x.some((r) => r.includes(null))).toBe(false);
  });
});

describe("engine host", () => {
  it("cancel terminates the worker and rejects pending calls", async () => {
    const terminate = vi.fn();
    class FakeWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal("Worker", FakeWorker);
    const host = createEngineHost();
    const pending = host.analyze(syntheticInput("clean"));
    host.cancel();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "CANCELLED" });
    expect(terminate).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("a response from a terminated worker cannot resolve the next job", async () => {
    const workers: { onmessage: ((e: { data: unknown }) => void) | null; posted: { id: number }[] }[] = [];
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      posted: { id: number }[] = [];
      constructor() { workers.push(this); }
      postMessage(m: { id: number }) { this.posted.push(m); }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    const host = createEngineHost();
    const first = host.analyze(syntheticInput("clean")).catch((e: unknown) => e);
    host.cancel();
    const second = host.analyze(syntheticInput("clean"));
    const stale = workers[0]!;
    stale.onmessage?.({ data: { id: stale.posted[0]!.id, ok: true, result: "stale" } });
    const fresh = workers[1]!;
    fresh.onmessage?.({ data: { id: fresh.posted[0]!.id, ok: true, result: "fresh" } });
    expect(await first).toMatchObject({ code: "CANCELLED" });
    expect(await second).toBe("fresh");
    vi.unstubAllGlobals();
  });
});
