// EXPLICITLY SYNTHETIC demo inputs. They only produce canonical *input* JSON for the engine
// (no analysis, no statistics). Triggered by user buttons and labelled as synthetic in the UI.
import type { EngineInput, InputSample, InputTargetValue, RepetitionType } from "./input";

export type SyntheticScenario = "clean" | "pitfalls";

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

const gaussian = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2));

/**
 * Pitfalls scenario, development samples only: s01–s08 have three declared rescans; s09 has two
 * acquisitions whose repetition type is "unknown" (not averaged by the engine); s10/s11 share one
 * identical spectrum under two physical IDs; s04 has a censored reference; s15 has a missing cell.
 */
export function syntheticInput(scenario: SyntheticScenario, seed = 20261012): EngineInput {
  const pitfalls = scenario === "pitfalls";
  const rnd = mulberry32(seed);
  const nSamples = 30;
  const axis = Array.from({ length: 60 }, (_, i) => 1100 + i * 20);
  const samples: InputSample[] = [];
  const obsIds: string[] = [];
  const obsSamples: string[] = [];
  const repetitionTypes: RepetitionType[] = [];
  const x: (number | null)[][] = [];
  const values: InputTargetValue[] = [];

  for (let i = 0; i < nSamples; i++) {
    const id = `s${String(i + 1).padStart(2, "0")}`;
    const retained = i >= 24;
    const conc = 5 + 20 * rnd();
    samples.push({
      sample_id: id,
      physical_sample_id: `p${i + 1}`,
      partition: retained ? "retained_test" : "development",
      instrument: "synthetic-a",
      campaign: i % 2 === 0 ? "2026-A" : "2026-B",
    });
    const nRep = pitfalls && !retained ? (i < 8 ? 3 : i === 8 ? 2 : 1) : 1;
    const base = axis.map((w) => 0.2 + 0.015 * conc * gaussian(w, 1450, 80) + 0.2 * gaussian(w, 1940, 120) + 0.0001 * (w - 1100));
    for (let r = 0; r < nRep; r++) {
      obsIds.push(`${id}-r${r + 1}`);
      obsSamples.push(id);
      repetitionTypes.push(nRep > 1 && i < 8 ? "rescan" : "unknown");
      x.push(base.map((v) => Number((v + (rnd() - 0.5) * 0.004).toFixed(6))));
    }
    const censored = pitfalls && i === 3;
    values.push(
      censored
        ? { sample_id: id, value: 5, status: "censored", reference_id: `ref-${id}` }
        : { sample_id: id, value: Number(conc.toFixed(3)), status: "exact", reference_id: `ref-${id}` },
    );
  }

  if (pitfalls) {
    // Undocumented repeat: same spectrum under two physical sample ids; plus a missing cell.
    const dupFrom = obsIds.indexOf("s10-r1");
    const dupTo = obsIds.indexOf("s11-r1");
    x[dupTo] = [...(x[dupFrom] ?? [])];
    const row = x[obsIds.indexOf("s15-r1")];
    if (row) row[7] = null;
  }

  return {
    schema_version: 1,
    data_origin: "synthetic",
    sources: [{
      source_id: "synthetic_nir",
      observation_ids: obsIds,
      sample_ids: obsSamples,
      x,
      axis,
      axis_unit: "nm",
      signal_unit: "absorbance",
      signal_type: "absorbance",
      ...(pitfalls ? { repetition_types: repetitionTypes } : {}),
    }],
    samples,
    targets: [{ target_id: "concentration", kind: "continuous", values, unit: "g/100g" }],
    options: { independence_unit: "sample", seed },
  };
}
