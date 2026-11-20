// Savitzky–Golay smoothing residuals for the residual heatmap: residual = raw − smoothed, with the
// smoothing done by the Methods WASM kernel (`preprocessing.derivatives.savitzky_golay`, deriv 0)
// using the window/polyorder the engine reports for the noise proxy. Loaded lazily on demand.
// Note: the engine proxy divides the RMS residual by the white-noise residual gain; the heatmap
// shows the raw signed residual in signal units (no gain normalisation).
import { finite, quantile } from "../shared/derive";
import { cell } from "./profiles";
import type { InputSource } from "../../input";

export interface ResidualResult {
  rows: number[];
  axisLength: number;
  window: number;
  polyorder: number;
  raw: (number | null)[][];
  smoothed: (number | null)[][];
  residual: (number | null)[][];
  /** Median signed residual per band and robust spread (1.4826 × MAD) per band. */
  medianResidual: (number | null)[];
  spreadResidual: (number | null)[];
  /** Bands within half a window of either end: computed by the kernel's edge mode ("interp"), excluded from the engine proxy. */
  edge: { i0: number; i1: number }[];
  /** RMS residual per row (to rank spectra with strong residual variation). */
  rowRms: (number | null)[];
  backend: string;
}

type MethodsModule = typeof import("@nirs4all/methods");
let methods: Promise<MethodsModule> | null = null;

/** Lazily imports and initialises `@nirs4all/methods` (WASM) once. */
export function loadMethods(): Promise<MethodsModule> {
  methods ??= import("@nirs4all/methods").then(async (m) => {
    await m.loadModule();
    return m;
  }).catch((e) => {
    methods = null;
    throw e;
  });
  return methods;
}

/** Evenly spaced subset of at most `cap` rows (keeps order). */
export function capRows(rows: readonly number[], cap: number): number[] {
  if (rows.length <= cap) return [...rows];
  const out: number[] = [];
  for (let k = 0; k < cap; k++) out.push(rows[Math.floor((k * rows.length) / cap)]!);
  return out;
}

/**
 * Computes the residuals of `rows` with the Methods SG kernel. Invalid cells are filled with 0 only to
 * call the kernel; every band whose smoothing window touches an invalid cell is reported as null.
 * The input source is never modified.
 */
export async function computeResiduals(source: InputSource, rows: readonly number[], window: number, polyorder: number): Promise<ResidualResult> {
  const m = await loadMethods();
  const p = source.axis.length;
  const h = Math.floor(window / 2);
  const n = rows.length;
  const data = new Float64Array(n * p);
  const invalid: boolean[][] = rows.map((r, k) => source.axis.map((_, c) => {
    const v = cell(source, r, c);
    if (v !== null) data[k * p + c] = v;
    return v === null;
  }));
  const sg = new m.SavitzkyGolay({ window_length: window, polyorder, deriv: 0, mode: "interp" });
  let out: Float64Array;
  try {
    const X = { data, rows: n, cols: p };
    sg.fit(X);
    out = sg.transform(X).data;
  } finally {
    sg.dispose();
  }
  const raw: (number | null)[][] = [];
  const smoothed: (number | null)[][] = [];
  const residual: (number | null)[][] = [];
  for (let k = 0; k < n; k++) {
    const bad = invalid[k]!;
    // prefix count of invalid cells, to test each band's window in O(1)
    const pre = new Int32Array(p + 1);
    for (let c = 0; c < p; c++) pre[c + 1] = pre[c]! + (bad[c] ? 1 : 0);
    const rr: (number | null)[] = [];
    const ss: (number | null)[] = [];
    const ee: (number | null)[] = [];
    for (let c = 0; c < p; c++) {
      const lo = Math.max(0, Math.min(c - h, p - window));
      const hi = Math.min(p - 1, Math.max(c + h, window - 1));
      const ok = pre[hi + 1]! - pre[lo]! === 0;
      const x = bad[c] ? null : data[k * p + c]!;
      rr.push(x);
      ss.push(ok ? out[k * p + c]! : null);
      ee.push(ok && x !== null ? x - out[k * p + c]! : null);
    }
    raw.push(rr);
    smoothed.push(ss);
    residual.push(ee);
  }
  const medianResidual: (number | null)[] = [];
  const spreadResidual: (number | null)[] = [];
  for (let c = 0; c < p; c++) {
    const col = finite(residual.map((r) => r[c]));
    const med = quantile(col, 0.5);
    medianResidual.push(med);
    spreadResidual.push(med === null ? null : 1.4826 * quantile(col.map((v) => Math.abs(v - med)), 0.5)!);
  }
  const rowRms = residual.map((r) => {
    const v = finite(r);
    return v.length ? Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : null;
  });
  const edge = h > 0 && p > 0 ? [{ i0: 0, i1: Math.min(p - 1, h - 1) }, { i0: Math.max(0, p - h), i1: p - 1 }] : [];
  return { rows: [...rows], axisLength: p, window, polyorder, raw, smoothed, residual, medianResidual, spreadResidual, edge, rowRms, backend: `@nirs4all/methods ${m.version()}` };
}
