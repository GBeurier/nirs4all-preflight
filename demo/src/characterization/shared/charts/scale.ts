// Scale and formatting helpers of the characterization chart kit (pure, unit-tested).
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export type Fmt = (v: number, digits?: number) => string;

/** Default number format: English locale, `digits` significant digits (default 3), no exponent for usual ranges. */
export const defaultFmt: Fmt = (v, digits = 3) => {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(Math.max(0, digits - 1));
  return Number(v.toPrecision(digits)).toLocaleString("en", { maximumFractionDigits: 12 });
};

/** Percentage of `part` over `total` (null when total is 0). */
export const share = (part: number, total: number): number | null => (total > 0 ? (100 * part) / total : null);

/** "Nice" ticks covering [lo, hi] (about `n` intervals). */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  // Integer tick indices: a span tiny relative to the magnitude can make `v += step` stall in floating point.
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 1000) return [lo, hi];
  const out: number[] = [];
  for (let k = first; k <= last; k += 1) out.push(+(k * step).toPrecision(12));
  return out.length ? out : [lo, hi];
}

/** Domain [lo, hi] of finite values, padded by `pad` × span; a constant series gets a unit-wide domain. */
export function extent(values: readonly (number | null | undefined)[], pad = 0): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) return null;
  if (lo === hi) return [lo - (Math.abs(lo) || 1) * 0.5, hi + (Math.abs(hi) || 1) * 0.5];
  const span = hi - lo;
  return [lo - span * pad, hi + span * pad];
}

/** Linear map from a domain to a pixel range. */
export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Equal-width histogram of finite values (`bins` intervals; the last one is closed). */
export function binValues(values: readonly (number | null | undefined)[], bins = 20): { lo: number; hi: number; count: number }[] {
  const finite = values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (!finite.length) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of finite) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return [{ lo, hi, count: finite.length }];
  const n = Math.max(1, Math.round(bins));
  const w = (hi - lo) / n;
  const out = Array.from({ length: n }, (_, i) => ({ lo: lo + i * w, hi: i === n - 1 ? hi : lo + (i + 1) * w, count: 0 }));
  for (const v of finite) out[Math.min(n - 1, Math.floor((v - lo) / w))]!.count++;
  return out;
}

/** Width of an element, tracked with a ResizeObserver (0 before the first layout). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Approximate rendered width of a 12 px label (for label gutters). */
export const textWidth = (s: string, px = 12) => Math.ceil(s.length * px * 0.56);
