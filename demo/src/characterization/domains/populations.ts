// Unit-mean spectra of the two domains of one engine comparison, mirroring the engine aggregation
// (crates/nirs4all-preflight/src/lib.rs `aggregate`, domain_shift.rs `population`): real rows of the partition
// (no augmentation), grouped by (physical sample, instrument, campaign); multi-context physical samples,
// ambiguous repeats and incomplete spectra are excluded; groups are then merged into independence units.
// Interim (Preflight engine debt): the engine's identity components (`independence_components`) are
// approximated by the aggregated physical sample, or by the declared group when independence_unit = group.
// The caller compares the unit counts with the engine denominators and labels any mismatch.
//
// Retained-test protection: only X rows, sample partitions and declared domain levels are read here.
import type { EngineInput, InputSample, InputSource } from "../../input";
import type { ComparisonModel } from "./model";

export interface Unit {
  key: string;
  /** Aggregated groups (physical samples) of the unit. */
  members: string[];
  /** Spectra (X rows) aggregated into the unit. */
  rows: number;
  spectrum: number[];
}

interface Group {
  key: string;
  physical: string;
  sampleId: string;
  rows: number[];
}

function cell(source: InputSource, r: number, c: number): number | null {
  const v = source.x[r]?.[c];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (source.valid_mask && source.valid_mask[r]?.[c] === false) return null;
  return v;
}

const TECHNICAL = new Set(["rescan", "repositioning", "repreparation"]);

/** Aggregated groups of one partition, in the engine's key order. */
function groups(source: InputSource, samples: Map<string, InputSample>, partition: "development" | "retained_test"): { groups: Group[]; spectra: Map<string, number[]> } {
  const byKey = new Map<string, Group>();
  source.sample_ids.forEach((id, r) => {
    const s = samples.get(id);
    if (!s || (s.partition ?? "development") !== partition || s.augmentation_parent_id) return;
    const physical = s.physical_sample_id ?? s.sample_id;
    const key = [physical, s.instrument ?? "", s.campaign ?? ""].join("\u0000");
    const g = byKey.get(key) ?? { key, physical, sampleId: id, rows: [] };
    g.rows.push(r);
    byKey.set(key, g);
  });
  const contexts = new Map<string, number>();
  for (const g of byKey.values()) contexts.set(g.physical, (contexts.get(g.physical) ?? 0) + 1);
  const p = source.axis.length;
  const kept: Group[] = [];
  const spectra = new Map<string, number[]>();
  for (const g of [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (contexts.get(g.physical)! > 1) continue;
    if (new Set(g.rows.map((r) => source.sample_ids[r])).size > 1) continue;
    if (g.rows.length > 1 && !g.rows.every((r) => TECHNICAL.has(source.repetition_types?.[r] ?? ""))) continue;
    const mean = new Array<number>(p);
    let ok = true;
    for (let c = 0; c < p && ok; c++) {
      let sum = 0;
      for (const r of g.rows) {
        const v = cell(source, r, c);
        if (v === null) { ok = false; break; }
        sum += v;
      }
      mean[c] = sum / g.rows.length;
    }
    if (!ok) continue;
    kept.push(g);
    spectra.set(g.key, mean);
  }
  return { groups: kept, spectra };
}

/** Groups merged into units (declared group, else one unit per group), units ordered by their first group. */
function units(gs: Group[], spectra: Map<string, number[]>, samples: Map<string, InputSample>, byGroup: boolean): Unit[] {
  const order: string[] = [];
  const members = new Map<string, Group[]>();
  for (const g of gs) {
    const k = byGroup ? (samples.get(g.sampleId)?.independence_group ?? `\u0001${g.key}`) : g.key;
    if (!members.has(k)) { order.push(k); members.set(k, []); }
    members.get(k)!.push(g);
  }
  return order.map((k) => {
    const list = members.get(k)!;
    const p = spectra.get(list[0]!.key)!.length;
    const spectrum = new Array<number>(p).fill(0);
    for (const g of list) spectra.get(g.key)!.forEach((v, c) => (spectrum[c]! += v / list.length));
    return { key: k, members: list.map((g) => g.sampleId), rows: list.reduce((a, g) => a + g.rows.length, 0), spectrum };
  });
}

/** Declared level of a sample for a domain factor (instrument, campaign or a categorical metadata column). */
export function levelOf(input: EngineInput, sample: InputSample, factor: string): string | null {
  if (factor === "instrument") return sample.instrument ?? null;
  if (factor === "campaign") return sample.campaign ?? null;
  const v = input.metadata?.values[sample.sample_id]?.[factor];
  return typeof v === "string" ? v : null;
}

export interface DomainPopulations {
  /** Every development unit (the engine fits its label-free leading PCA space on them). */
  development: Unit[];
  reference: Unit[];
  compared: Unit[];
  axis: number[];
}

export function domainPopulations(input: EngineInput, sourceId: string, c: Pick<ComparisonModel, "audit" | "factor" | "referenceLevels" | "comparedLevel">): DomainPopulations | null {
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (!source || !source.axis.length) return null;
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const byGroup = input.options.independence_unit === "group";
  const dev = groups(source, samples, "development");
  const development = units(dev.groups, dev.spectra, samples, byGroup);
  if (c.audit) {
    const test = groups(source, samples, "retained_test");
    return { development, reference: development, compared: units(test.groups, test.spectra, samples, byGroup), axis: source.axis };
  }
  const level = (u: Unit): string | null => {
    const ls = new Set(u.members.map((id) => levelOf(input, samples.get(id)!, c.factor)));
    return ls.size === 1 ? [...ls][0]! : null;
  };
  const refs = new Set(c.referenceLevels);
  return {
    development,
    reference: development.filter((u) => { const l = level(u); return l !== null && refs.has(l); }),
    compared: development.filter((u) => level(u) === c.comparedLevel),
    axis: source.axis,
  };
}
