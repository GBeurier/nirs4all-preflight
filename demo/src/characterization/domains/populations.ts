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
  /** Source row indices of each aggregated group (the unit spectrum is the equal-weight mean of the group means). */
  groupRows?: number[][];
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
    return { key: k, members: list.map((g) => g.sampleId), rows: list.reduce((a, g) => a + g.rows.length, 0), spectrum, groupRows: list.map((g) => [...g.rows]) };
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

/**
 * Rows of the engine's energy permutation test of one factor, in the engine order: the development units whose
 * samples share one level (`analyzed`), coded by the index of their level in the sorted level names; for the
 * audit, development units then retained-test units (codes 0 / 1).
 */
export interface TestPopulation {
  units: Unit[];
  codes: number[];
  levels: string[];
  /** Index of each unit in `development` (factor tests; the leading PCA space is fitted on every development unit). */
  developmentIndex: number[] | null;
  development: Unit[];
}

export function testPopulation(input: EngineInput, sourceId: string, factor: string, audit: boolean): TestPopulation | null {
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (!source || !source.axis.length) return null;
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const byGroup = input.options.independence_unit === "group";
  const dev = groups(source, samples, "development");
  const development = units(dev.groups, dev.spectra, samples, byGroup);
  if (audit) {
    const test = groups(source, samples, "retained_test");
    const retained = units(test.groups, test.spectra, samples, byGroup);
    return { units: [...development, ...retained], codes: [...development.map(() => 0), ...retained.map(() => 1)], levels: ["development", "retained_test"], developmentIndex: null, development };
  }
  const levelOfUnit = development.map((u) => {
    const ls = new Set(u.members.map((id) => levelOf(input, samples.get(id)!, factor)));
    return ls.size === 1 && !ls.has(null) ? [...ls][0]! : null;
  });
  const index = development.map((_, i) => i).filter((i) => levelOfUnit[i] !== null);
  // Engine: BTreeSet of level names (byte order; equal to code-unit order for these ASCII/BMP names).
  const levels = [...new Set(index.map((i) => levelOfUnit[i]!))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { units: index.map((i) => development[i]!), codes: index.map((i) => levels.indexOf(levelOfUnit[i]!)), levels, developmentIndex: index, development };
}

/**
 * Tooltip text of units: member samples, physical samples, instrument, campaign, declared metadata and the
 * number of spectra. Sample metadata only; target values are never read.
 */
export function unitDescriber(input: EngineInput): (u: Unit) => string {
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const columns = input.metadata?.columns.map((c) => c.name) ?? [];
  const shared = (vals: (string | number | null | undefined)[]) => {
    const set = new Set(vals.map((v) => (v === null || v === undefined ? "—" : String(v))));
    return set.size === 1 ? [...set][0]! : "varies";
  };
  return (u) => {
    const ss = u.members.map((id) => samples.get(id)).filter((s): s is InputSample => !!s);
    const parts = [
      `Samples: ${u.members.slice(0, 4).map(sampleLabel).join(", ")}${u.members.length > 4 ? ` +${u.members.length - 4}` : ""}`,
      `Physical sample: ${shared(ss.map((s) => s.physical_sample_id ?? s.sample_id))}`,
    ];
    if (ss.some((s) => s.instrument)) parts.push(`Instrument: ${shared(ss.map((s) => s.instrument))}`);
    if (ss.some((s) => s.campaign)) parts.push(`Campaign: ${shared(ss.map((s) => s.campaign))}`);
    for (const c of columns.slice(0, 8)) parts.push(`${c}: ${shared(ss.map((s) => input.metadata?.values[s.sample_id]?.[c]))}`);
    parts.push(`Spectra: ${u.rows}`);
    return parts.join("\n");
  };
}

/** Readable sample id: JSON-array ids of the demo import (e.g. ["test", 1]) read as "test #1". */
export function sampleLabel(id: string): string {
  if (!id.startsWith("[")) return id;
  try {
    const v = JSON.parse(id) as unknown;
    if (!Array.isArray(v)) return id;
    if (v.length === 2 && typeof v[1] === "number") return `${String(v[0])} #${v[1]}`;
    return v.map(String).join(" · ");
  } catch {
    return id;
  }
}

/** Readable label of a unit: its member samples. */
export const unitLabel = (u: Unit) => u.members.map(sampleLabel).join(", ");
