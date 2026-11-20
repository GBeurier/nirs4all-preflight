// INTERIM local port of Methods `diagnostics.spectral_population_events_qc`
// (nirs4all-methods v1.5.0/v1.5.1, cpp/src/core/estimator/intrinsic_diagnostics.cpp:
// `run_spectral_population_events_qc`, `DeclaredAxis`, `quantile`), mirrored operation by operation
// so that per-spectrum and per-band counts equal the engine's. The owner kernel reports counts only;
// this port additionally keeps the flagged positions (row, band, type, score) that the demo needs
// for the event map and markers. Debt: docs/implementation/debt/characterization-integrity.md.
// Validated against the engine in populationEvents.engine.test.ts.

export type EventKind = "spike" | "jump";

/** Methods status codes (`OK`, `TOO_FEW`, `UNDEFINED`). */
export const STATUS = { OK: 0, TOO_FEW: 1, UNDEFINED: 4 } as const;

/** Fewest spectra defining a band position (engine constant `EVENT_MIN_SPECTRA`). */
export const ENGINE_MIN_SPECTRA = 5;

export interface EventsMatrix {
  /** spectra (rows) and bands (columns) */
  n: number;
  p: number;
  /** row-major values; masked cells hold any finite value (the engine sends 0) */
  x: Float64Array;
  /** 1 = valid cell; null = every cell valid */
  mask: Uint8Array | null;
  /** `axis_basis = physical`: derivatives divide by the declared axis gaps */
  physical: boolean;
  axis: readonly number[] | null;
}

/** Threshold-independent part of one derivative order: per-position population centre/scale and |v − c|. */
export interface PreparedKind {
  kind: EventKind;
  /** 1 (pairs j, j+1: jumps) or 2 (triples j..j+2: spikes); position k is attributed to band k + 1 */
  order: 1 | 2;
  positions: number;
  /** |v − centre| per (row, position); NaN when the derivative is undefined there */
  absdev: Float64Array;
  /** max(scale, floor) per position; 0 when the position is not evaluated */
  effScale: Float64Array;
  evaluated: Uint8Array;
  /** median of the evaluated position scales (Methods `<kind>_scale_floor`) */
  floor: number;
  /** OK, TOO_FEW (no evaluated position) or UNDEFINED (floor not > 0) */
  status: number;
  /** positions evaluated for each row (Methods `<kind>_eligible_counts`) */
  eligible: Int32Array;
  positionsEvaluated: number;
}

export interface PreparedEvents {
  n: number;
  p: number;
  spike: PreparedKind;
  jump: PreparedKind;
}

/** Methods `quantile` (Hyndman–Fan type 7) on an already sorted array; same arithmetic order. */
function sortedQuantile(x: Float64Array, q: number): number {
  const at = (x.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return x[lo]! * (1.0 - (at - lo)) + x[hi]! * (at - lo);
}

/** Same validation as `DeclaredAxis`: a physical axis must have p finite, strictly monotonic values. */
function checkAxis(m: EventsMatrix): readonly number[] | null {
  if (!m.physical) return null;
  const axis = m.axis;
  if (!axis || axis.length !== m.p) throw new Error("physical axis needs p values");
  let direction = 0;
  for (let j = 1; j < m.p; j++) {
    const delta = axis[j]! - axis[j - 1]!;
    if (!Number.isFinite(delta) || delta === 0) throw new Error("axis must be finite and strictly monotonic");
    const sign = delta > 0 ? 1 : -1;
    if (direction && direction !== sign) throw new Error("axis must be strictly monotonic");
    direction = sign;
  }
  return axis;
}

function prepareKind(m: EventsMatrix, axis: readonly number[] | null, order: 1 | 2, minSpectra: number): PreparedKind {
  const { n, p, x, mask } = m;
  const positions = p > order ? p - order : 0;
  // DeclaredAxis::first / ::second, same operation order.
  const first = (row: number, j: number) => (x[row + j + 1]! - x[row + j]!) / (axis ? axis[j + 1]! - axis[j]! : 1.0);
  const second = (row: number, j: number) => {
    const slope = first(row, j);
    const next = first(row, j + 1);
    return axis ? (2 * (next - slope)) / (axis[j + 2]! - axis[j]!) : next - slope;
  };
  const absdev = new Float64Array(n * positions).fill(NaN);
  const value = new Float64Array(n);
  const defined = new Uint8Array(n);
  const effScale = new Float64Array(positions);
  const scale = new Float64Array(positions);
  const center = new Float64Array(positions);
  const evaluated = new Uint8Array(positions);
  const scales: number[] = [];
  const column = new Float64Array(n);
  for (let k = 0; k < positions; k++) {
    let size = 0;
    let finite = true;
    for (let i = 0; i < n; i++) {
      defined[i] = 0;
      const row = i * p;
      let valid = true;
      if (mask) for (let o = 0; o <= order && valid; o++) valid = mask[row + k + o] !== 0;
      if (!valid) continue;
      const v = order === 1 ? first(row, k) : second(row, k);
      value[i] = v;
      defined[i] = 1;
      column[size++] = v;
      if (!Number.isFinite(v)) finite = false;
    }
    if (size < minSpectra || !finite) {
      // Not evaluated: the defined derivatives still exist but are never compared.
      continue;
    }
    const col = column.slice(0, size).sort();
    const c = sortedQuantile(col, 0.5);
    for (let t = 0; t < size; t++) col[t] = Math.abs(col[t]! - c);
    col.sort();
    const sc = 1.4826 * sortedQuantile(col, 0.5);
    if (!Number.isFinite(sc)) continue;
    center[k] = c;
    scale[k] = sc;
    evaluated[k] = 1;
    scales.push(sc);
    for (let i = 0; i < n; i++) if (defined[i]) absdev[i * positions + k] = Math.abs(value[i]! - c);
  }
  const floor = scales.length ? sortedQuantile(Float64Array.from(scales).sort(), 0.5) : 0;
  const status = !scales.length ? STATUS.TOO_FEW : !(floor > 0) || !Number.isFinite(floor) ? STATUS.UNDEFINED : STATUS.OK;
  for (let k = 0; k < positions; k++) if (evaluated[k]) effScale[k] = Math.max(scale[k]!, floor);
  // Eligible positions per row: evaluated positions where the row's derivative is defined.
  const eligible = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let k = 0; k < positions; k++) if (evaluated[k] && !Number.isNaN(absdev[i * positions + k]!)) e++;
    eligible[i] = e;
  }
  return { kind: order === 1 ? "jump" : "spike", order, positions, absdev, effScale, evaluated, floor, status, eligible, positionsEvaluated: scales.length };
}

/** Derivatives and population statistics of both orders (independent of the threshold). */
export function preparePopulationEvents(m: EventsMatrix, minSpectra = ENGINE_MIN_SPECTRA): PreparedEvents {
  if (m.n < 1 || m.p < 1 || m.x.length !== m.n * m.p) throw new Error("diagnostic dimensions are inconsistent");
  if (m.mask && m.mask.length !== m.n * m.p) throw new Error("valid_mask must have n*p values");
  for (let t = 0; t < m.x.length; t++) if (!Number.isFinite(m.x[t]!)) throw new Error("X must be finite; use zero-fill and explicit valid_mask");
  const axis = checkAxis(m);
  return { n: m.n, p: m.p, jump: prepareKind(m, axis, 1, minSpectra), spike: prepareKind(m, axis, 2, minSpectra) };
}

/** Result of one event type at one threshold: the Methods outputs plus the flagged positions. */
export interface KindEvents {
  kind: EventKind;
  status: number;
  /** per row: event count (null when the row status is not OK, as in the engine signal) */
  counts: (number | null)[];
  eligible: Int32Array;
  /** per band (length p): events attributed to the band, rows evaluated at the band */
  bandCounts: Int32Array;
  bandEvaluated: Int32Array;
  floor: number;
  positionsEvaluated: number;
  globalCount: number;
  globalEligible: number;
  /** flagged positions: row index, attributed band index, score = |v − c| / max(scale, floor) */
  rows: Int32Array;
  bands: Int32Array;
  scores: Float64Array;
}

export function applyThreshold(prepared: PreparedKind, n: number, p: number, threshold: number): KindEvents {
  if (!(threshold > 0)) throw new Error("threshold must be positive");
  const { positions, absdev, effScale, evaluated, eligible, status } = prepared;
  const counts: (number | null)[] = new Array(n).fill(null);
  const bandCounts = new Int32Array(p);
  const bandEvaluated = new Int32Array(p);
  const rows: number[] = [];
  const bands: number[] = [];
  const scores: number[] = [];
  let total = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    let events = 0;
    if (status === STATUS.OK) {
      for (let k = 0; k < positions; k++) {
        if (!evaluated[k]) continue;
        const d = absdev[i * positions + k]!;
        if (Number.isNaN(d)) continue;
        bandEvaluated[k + 1]! += 1;
        // Same comparison as the owner: |v − c| > threshold · max(scale, floor).
        if (d > threshold * effScale[k]!) {
          ++events;
          bandCounts[k + 1]! += 1;
          rows.push(i);
          bands.push(k + 1);
          scores.push(d / effScale[k]!);
        }
      }
    }
    if (!eligible[i]) continue;
    if (status === STATUS.OK) {
      counts[i] = events;
      total += events;
      denominator += eligible[i]!;
    }
  }
  return {
    kind: prepared.kind,
    status,
    counts,
    eligible,
    bandCounts,
    bandEvaluated,
    floor: prepared.floor,
    positionsEvaluated: prepared.positionsEvaluated,
    globalCount: total,
    globalEligible: denominator,
    rows: Int32Array.from(rows),
    bands: Int32Array.from(bands),
    scores: Float64Array.from(scores),
  };
}

/** Both event types at one threshold. */
export function populationEvents(m: EventsMatrix, threshold: number, minSpectra = ENGINE_MIN_SPECTRA): { spike: KindEvents; jump: KindEvents } {
  const prepared = preparePopulationEvents(m, minSpectra);
  return { spike: applyThreshold(prepared.spike, m.n, m.p, threshold), jump: applyThreshold(prepared.jump, m.n, m.p, threshold) };
}

// --- input assembly (same population and masking as the engine) --------------------------------

export interface EngineSourceLike {
  axis: readonly number[];
  x: readonly (readonly (number | null)[])[];
  observation_ids: readonly string[];
  valid_mask?: readonly (readonly boolean[])[] | null | undefined;
}

/**
 * The matrix the engine sends to Methods for `source`: the rows of `observationIds` (the engine's
 * development real observations, in report order), a cell valid when it is a non-null value not
 * masked by `valid_mask` (engine `valid_cell`), masked cells zero-filled.
 */
export function engineMatrix(source: EngineSourceLike, observationIds: readonly string[], options: { physical: boolean }): { matrix: EventsMatrix; missing: string[] } {
  const rowOf = new Map(source.observation_ids.map((id, i) => [id, i]));
  const p = source.axis.length;
  const missing: string[] = [];
  const rows: number[] = [];
  for (const id of observationIds) {
    const r = rowOf.get(id);
    if (r === undefined) missing.push(id);
    else rows.push(r);
  }
  const n = rows.length;
  const x = new Float64Array(n * p);
  const mask = new Uint8Array(n * p);
  let masked = false;
  rows.forEach((r, i) => {
    const values = source.x[r] ?? [];
    const valid = source.valid_mask?.[r];
    for (let j = 0; j < p; j++) {
      const v = values[j];
      if (v === null || v === undefined || (valid && valid[j] === false)) {
        masked = true;
        continue;
      }
      x[i * p + j] = v;
      mask[i * p + j] = 1;
    }
  });
  return { matrix: { n, p, x, mask: masked ? mask : null, physical: options.physical, axis: options.physical ? source.axis : null }, missing };
}

// --- physical events: merging contiguous flags --------------------------------------------------

/**
 * Two flags of the same spectrum belong to one physical event when their attributed bands are at
 * most `MERGE_GAP` bands apart (transitively). A second-difference flag at band b uses bands
 * b − 1…b + 1 and a first-difference flag uses b − 1…b, so flags ≤ 2 bands apart share a band of
 * the spectrum: one narrow spike typically raises up to three peak flags and two jump flags.
 */
export const MERGE_GAP = 2;

export interface PhysicalEvent {
  row: number;
  /** first and last attributed band (inclusive) */
  start: number;
  end: number;
  spikeFlags: number;
  jumpFlags: number;
  /** highest score among its flags, with its band and type */
  maxScore: number;
  maxBand: number;
  maxKind: EventKind;
}

export function mergeEvents(spike: Pick<KindEvents, "rows" | "bands" | "scores">, jump: Pick<KindEvents, "rows" | "bands" | "scores">, gap = MERGE_GAP): PhysicalEvent[] {
  const flags: { row: number; band: number; score: number; kind: EventKind }[] = [];
  for (const [e, kind] of [[spike, "spike"], [jump, "jump"]] as const) for (let t = 0; t < e.rows.length; t++) flags.push({ row: e.rows[t]!, band: e.bands[t]!, score: e.scores[t]!, kind });
  flags.sort((a, b) => a.row - b.row || a.band - b.band);
  const out: PhysicalEvent[] = [];
  let cur: PhysicalEvent | null = null;
  for (const f of flags) {
    if (!cur || cur.row !== f.row || f.band - cur.end > gap) {
      cur = { row: f.row, start: f.band, end: f.band, spikeFlags: 0, jumpFlags: 0, maxScore: -Infinity, maxBand: f.band, maxKind: f.kind };
      out.push(cur);
    }
    cur.end = Math.max(cur.end, f.band);
    if (f.kind === "spike") cur.spikeFlags++;
    else cur.jumpFlags++;
    if (f.score > cur.maxScore) {
      cur.maxScore = f.score;
      cur.maxBand = f.band;
      cur.maxKind = f.kind;
    }
  }
  return out;
}

export interface SpectrumEvents {
  row: number;
  spikes: number;
  jumps: number;
  physical: number;
  maxScore: number;
  maxBand: number;
  maxKind: EventKind;
  /** physical events of the spectrum, highest score first */
  events: PhysicalEvent[];
}

/** Per spectrum with at least one flag: flag counts, physical events and the maximum score (highest first). */
export function perSpectrum(events: readonly PhysicalEvent[]): SpectrumEvents[] {
  const by = new Map<number, SpectrumEvents>();
  for (const e of events) {
    let s = by.get(e.row);
    if (!s) {
      s = { row: e.row, spikes: 0, jumps: 0, physical: 0, maxScore: -Infinity, maxBand: e.maxBand, maxKind: e.maxKind, events: [] };
      by.set(e.row, s);
    }
    s.spikes += e.spikeFlags;
    s.jumps += e.jumpFlags;
    s.physical++;
    s.events.push(e);
    if (e.maxScore > s.maxScore) {
      s.maxScore = e.maxScore;
      s.maxBand = e.maxBand;
      s.maxKind = e.maxKind;
    }
  }
  const list = [...by.values()];
  for (const s of list) s.events.sort((a, b) => b.maxScore - a.maxScore);
  return list.sort((a, b) => b.maxScore - a.maxScore || a.row - b.row);
}
