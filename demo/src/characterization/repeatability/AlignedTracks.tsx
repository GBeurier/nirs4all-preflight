/**
 * AlignedTracks — N vertically stacked SVG tracks sharing one spectral x-axis.
 *
 * Interim demo component (nirs4all-ui debt, see docs/implementation/debt/characterization-repeatability.md).
 *
 * API
 * - `axis`: the source's spectral axis values, one per band (wavelength, wavenumber or band index).
 *   Any direction and irregular spacing: x positions come from the actual values (axis[0] is drawn
 *   on the left; pass a reversed copy of every array to flip). No fixed NIR range is assumed.
 * - `axisLabel`: x-axis label including its unit, e.g. "Wavelength (nm)".
 * - `tracks`: one entry per stacked panel, each with its own y-scale and legend:
 *   - `series[]`: `{ id, label, values, color?, dash?, kind? }` — `kind` "line" (default, null → gap),
 *     "bars" (one bar per band, null → no bar) or "points".
 *   - `envelopes[]`: shaded `{ id, label, lower, upper, color? }` areas (e.g. P5–P95).
 *   - `strip`: a one-row band strip `{ label, values, color(v) → css | null, describe?(v) }`
 *     (categorical or sequential heat track); a null colour draws the non-evaluable hatch.
 *   - `refBands[]`: horizontal reference bands `{ from, to, label, fill? }` in y units (labelled,
 *     e.g. indicative Koo & Li ICC bands); `refLines[]`: `{ y, label }` dashed lines.
 *   - `nonEvaluable`: boolean per band; true bands are greyed/hatched behind the plot.
 *   - `yDomain`: fixed [min, max]; otherwise auto from finite values (`includeZero` adds 0).
 *   - `format(v)`: tooltip/tick formatter; `height`: panel height in px (default 110).
 * - `width`: total width in px (use `Measured`).
 * - Interaction (all synchronized across tracks):
 *   - hover: shared vertical cursor + tooltip listing every track's local values;
 *   - drag: brush-selects a band range; click: selects one band; `onSelect({ i0, i1, from, to } | null)`;
 *   - Ctrl/⌘ + wheel: zoom around the cursor; Shift + drag: pan; double-click or "Reset zoom": full range;
 *   - keyboard (focus the chart): ←/→ move the cursor, Enter selects the cursor band, Esc clears.
 *   `domain`/`onDomainChange` and `cursor`/`onCursor` may be controlled to sync several instances.
 * - `selection`: controlled selected band range `{ i0, i1 }` (indices, inclusive) or null.
 * - `markRegions[]`: labelled vertical regions `{ i0, i1, label }` (e.g. filter edge effects).
 * Information is never carried by colour alone: series carry dash patterns and labelled legends,
 * reference bands carry text labels and non-evaluable bands a hatch pattern.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import "../shared/charts/charts.css";
import "./aligned-tracks.css";

export type Values = readonly (number | null)[];

export interface TrackSeries {
  id: string;
  label: string;
  values: Values;
  color?: string | undefined;
  /** SVG stroke-dasharray, e.g. "4 3"; differentiates series without colour. */
  dash?: string | undefined;
  kind?: "line" | "bars" | "points" | undefined;
}

export interface TrackEnvelope {
  id: string;
  label: string;
  lower: Values;
  upper: Values;
  color?: string | undefined;
}

export interface TrackStrip {
  label: string;
  values: Values;
  color: (v: number) => string | null;
  describe?: ((v: number) => string) | undefined;
}

export interface TrackRefBand {
  from: number;
  to: number;
  label: string;
  fill?: string | undefined;
}

export interface Track {
  id: string;
  title: string;
  unit?: string | undefined;
  height?: number | undefined;
  series?: TrackSeries[] | undefined;
  envelopes?: TrackEnvelope[] | undefined;
  strip?: TrackStrip | undefined;
  refBands?: TrackRefBand[] | undefined;
  refLines?: { y: number; label: string }[] | undefined;
  nonEvaluable?: readonly boolean[] | undefined;
  yDomain?: [number, number] | undefined;
  includeZero?: boolean | undefined;
  format?: ((v: number) => string) | undefined;
}

export interface BandRange {
  i0: number;
  i1: number;
}

export interface BandSelection extends BandRange {
  from: number;
  to: number;
}

export interface AlignedTracksProps {
  axis: readonly number[];
  axisLabel: string;
  tracks: readonly Track[];
  width: number;
  title: string;
  selection?: BandRange | null | undefined;
  onSelect?: ((selection: BandSelection | null) => void) | undefined;
  domain?: [number, number] | null | undefined;
  onDomainChange?: ((domain: [number, number] | null) => void) | undefined;
  cursor?: number | null | undefined;
  onCursor?: ((index: number | null) => void) | undefined;
  markRegions?: readonly { i0: number; i1: number; label: string }[] | undefined;
  className?: string | undefined;
  /** HTML legend under the chart (unique series/envelope labels with line swatches); default true. */
  legend?: boolean | undefined;
}

interface LegendItem {
  key: string;
  label: string;
  color: string;
  dash?: string | undefined;
  area?: boolean | undefined;
}

const MAX_LEGEND = 10;

/** Unique legend entries over all tracks (series as lines, envelopes as areas), capped. */
export function legendItems(tracks: readonly Track[]): LegendItem[] {
  const out = new Map<string, LegendItem>();
  tracks.forEach((t) => {
    t.envelopes?.forEach((e, i) => out.has(`e${e.label}`) || out.set(`e${e.label}`, { key: `e${e.label}`, label: e.label, color: e.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]!, area: true }));
    t.series?.forEach((s, i) => out.has(`s${s.label}`) || out.set(`s${s.label}`, { key: `s${s.label}`, label: s.label, color: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]!, dash: s.dash }));
  });
  return [...out.values()].slice(0, MAX_LEGEND);
}

const PAD = { left: 60, right: 14, top: 24, gap: 34, bottom: 40 };
/** Horizontal plot padding, exported so band-indexed companions (e.g. a heatmap) can align with the tracks. */
export const TRACK_PAD = { left: PAD.left, right: PAD.right } as const;
/** Kit tokens (see shared/charts/charts.css); a series colour may be any CSS colour or `var(--cz-*)`. */
const DEFAULT_COLORS = ["var(--cz-blue)", "var(--cz-copper)", "var(--cz-teal)", "var(--cz-ink-2)", "var(--cz-copper-2)"];
/** Half-width (px) of the shaded band drawn around the shared cursor. */
const CURSOR_HALF = 7;

const defaultFormat = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e4 || a < 1e-3) return v.toExponential(2);
  return Number(v.toPrecision(3)).toString();
};

/** Nice tick values over [a, b] (either order). */
export function niceTicks(a: number, b: number, count = 5): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(Number((k * step).toFixed(decimals)));
  return out;
}

/** Index of the band whose axis value is closest to `x` (linear scan; axis may be irregular). */
export function nearestBand(axis: readonly number[], x: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i]! - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Contiguous runs [i0, i1] of `true` in a mask. */
export function runs(mask: readonly boolean[]): BandRange[] {
  const out: BandRange[] = [];
  let start = -1;
  mask.forEach((m, i) => {
    if (m && start < 0) start = i;
    if (!m && start >= 0) {
      out.push({ i0: start, i1: i - 1 });
      start = -1;
    }
  });
  if (start >= 0) out.push({ i0: start, i1: mask.length - 1 });
  return out;
}

function trackDomain(track: Track): [number, number] | null {
  if (track.yDomain) return track.yDomain;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (vs: Values) => {
    for (const v of vs) if (v !== null && Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  };
  track.series?.forEach((s) => take(s.values));
  track.envelopes?.forEach((e) => {
    take(e.lower);
    take(e.upper);
  });
  if (track.includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (!Number.isFinite(lo)) return null;
  if (hi === lo) return [lo - (Math.abs(lo) || 1) * 0.5, hi + (Math.abs(hi) || 1) * 0.5];
  const pad = (hi - lo) * 0.05;
  return [track.includeZero && lo === 0 ? 0 : lo - pad, hi + pad];
}

export function AlignedTracks(props: AlignedTracksProps) {
  const { axis, axisLabel, tracks, width, title, onSelect, markRegions, className, legend = true } = props;
  const uid = useId().replace(/:/g, "");
  const n = axis.length;
  const fullDomain = useMemo<[number, number]>(() => (n ? [axis[0]!, axis[n - 1]!] : [0, 1]), [axis, n]);
  const [ownDomain, setOwnDomain] = useState<[number, number] | null>(null);
  const domain = (props.domain !== undefined ? props.domain : ownDomain) ?? fullDomain;
  const setDomain = (d: [number, number] | null) => (props.onDomainChange ? props.onDomainChange(d) : setOwnDomain(d));
  const [ownCursor, setOwnCursor] = useState<number | null>(null);
  const cursor = props.cursor !== undefined ? props.cursor : ownCursor;
  const setCursor = (i: number | null) => (props.onCursor ? props.onCursor(i) : setOwnCursor(i));
  // A controlled cursor may come from another chart (shared hover): the tooltip shows only where the pointer or focus is.
  const [local, setLocal] = useState(false);
  const showTooltip = props.cursor === undefined || local;
  const [ownSelection, setOwnSelection] = useState<BandRange | null>(null);
  const selection = props.selection !== undefined ? props.selection : ownSelection;
  const [brush, setBrush] = useState<{ start: number; end: number; pan?: { x: number; domain: [number, number] } } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const x = (v: number) => PAD.left + ((v - domain[0]) / (domain[1] - domain[0] || 1)) * plotW;
  const xInv = (px: number) => domain[0] + ((px - PAD.left) / plotW) * (domain[1] - domain[0]);
  // Band edges: half-way to each neighbour (irregular axes supported).
  const edges = useMemo(() => axis.map((v, i) => {
    const prev = i > 0 ? axis[i - 1]! : v - (n > 1 ? axis[1]! - axis[0]! : 1);
    const next = i < n - 1 ? axis[i + 1]! : v + (n > 1 ? axis[n - 1]! - axis[n - 2]! : 1);
    return [(prev + v) / 2, (v + next) / 2] as const;
  }), [axis, n]);
  const bandRect = (i0: number, i1: number) => {
    const xs = [x(edges[i0]![0]), x(edges[i0]![1]), x(edges[i1]![0]), x(edges[i1]![1])];
    const l = Math.max(PAD.left, Math.min(...xs));
    const r = Math.min(PAD.left + plotW, Math.max(...xs));
    return { x: l, w: Math.max(0, r - l) };
  };

  const layout = useMemo(() => {
    let top = PAD.top;
    return tracks.map((t) => {
      const h = t.strip ? (t.height ?? 22) : (t.height ?? 110);
      const box = { top, h };
      top += h + PAD.gap;
      return box;
    });
  }, [tracks]);
  const totalH = (layout.length ? layout[layout.length - 1]!.top + layout[layout.length - 1]!.h : PAD.top) + PAD.bottom;
  const domains = useMemo(() => tracks.map(trackDomain), [tracks]);

  // Native non-passive wheel listener so Ctrl+wheel zoom does not scroll the page.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const at = xInv(e.clientX - rect.left);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      let d0 = at + (domain[0] - at) * k;
      let d1 = at + (domain[1] - at) * k;
      const span = Math.abs(fullDomain[1] - fullDomain[0]);
      if (Math.abs(d1 - d0) >= span) {
        setDomain(null);
        return;
      }
      const lo = Math.min(...fullDomain);
      const hi = Math.max(...fullDomain);
      const shift = Math.min(d0, d1) < lo ? lo - Math.min(d0, d1) : Math.max(d0, d1) > hi ? hi - Math.max(d0, d1) : 0;
      d0 += shift;
      d1 += shift;
      setDomain([d0, d1]);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  const pointerBand = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return nearestBand(axis, xInv(e.clientX - rect.left));
  };
  const emit = (range: BandRange | null) => {
    if (props.selection === undefined) setOwnSelection(range);
    onSelect?.(range ? { ...range, from: axis[range.i0]!, to: axis[range.i1]! } : null);
  };

  if (!n || !tracks.length) return null;

  const visible = (i: number) => {
    const v = axis[i]!;
    return v >= Math.min(...domain) && v <= Math.max(...domain);
  };
  const linePath = (vals: Values, y: (v: number) => number) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v === null || v === undefined || !Number.isFinite(v) || !visible(i)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(axis[i]!).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const tick = (v: number, f?: (v: number) => string) => (f ?? defaultFormat)(v);
  const xTicks = niceTicks(domain[0], domain[1], Math.max(2, Math.round(plotW / 90)));
  const sel = brush && !brush.pan ? { i0: Math.min(brush.start, brush.end), i1: Math.max(brush.start, brush.end) } : selection;

  return (
    <div className={`at-wrap ${className ?? ""}`}>
      <div className="at-toolbar">
        <span className="hint">Drag to select a band range · Ctrl/⌘ + wheel to zoom · Shift + drag to pan</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!selection || selection.i0 === selection.i1} onClick={() => selection && setDomain([axis[selection.i0]!, axis[selection.i1]!])}>Zoom to selection</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={domain === fullDomain || (domain[0] === fullDomain[0] && domain[1] === fullDomain[1])} onClick={() => setDomain(null)}>Reset zoom</button>
        {selection ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => emit(null)}>Clear selection</button> : null}
      </div>
      <svg
        ref={svgRef}
        className="at-svg"
        width={width}
        height={totalH}
        viewBox={`0 0 ${width} ${totalH}`}
        role="img"
        aria-label={title}
        tabIndex={0}
        onPointerMove={(e) => {
          const i = pointerBand(e);
          setCursor(i);
          if (brush?.pan) {
            const rect = e.currentTarget.getBoundingClientRect();
            const dx = ((e.clientX - rect.left - brush.pan.x) / plotW) * (brush.pan.domain[1] - brush.pan.domain[0]);
            setDomain([brush.pan.domain[0] - dx, brush.pan.domain[1] - dx]);
          } else if (brush) setBrush({ ...brush, end: i });
        }}
        onPointerEnter={() => setLocal(true)}
        onPointerLeave={() => {
          setLocal(false);
          setCursor(null);
        }}
        onFocus={() => setLocal(true)}
        onBlur={() => setLocal(false)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const i = pointerBand(e);
          const rect = e.currentTarget.getBoundingClientRect();
          setBrush(e.shiftKey ? { start: i, end: i, pan: { x: e.clientX - rect.left, domain } } : { start: i, end: i });
        }}
        onPointerUp={() => {
          if (brush && !brush.pan) emit({ i0: Math.min(brush.start, brush.end), i1: Math.max(brush.start, brush.end) });
          setBrush(null);
        }}
        onDoubleClick={() => setDomain(null)}
        onKeyDown={(e) => {
          const cur = cursor ?? 0;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            setCursor(Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? 1 : -1))));
          } else if (e.key === "Enter" && cursor !== null) emit({ i0: cursor, i1: cursor });
          else if (e.key === "Escape") emit(null);
        }}
      >
        <title>{title}</title>
        <defs>
          <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" style={{ fill: "var(--cz-surface-2, #f5f7f9)" }} />
            <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--cz-na-line, #8d969f)" }} strokeWidth="1.2" />
          </pattern>
          {layout.map((box, ti) => <clipPath key={ti} id={`${uid}-clip${ti}`}><rect x={PAD.left} y={box.top - 1} width={plotW} height={box.h + 2} /></clipPath>)}
        </defs>
        {tracks.map((t, ti) => {
          const box = layout[ti]!;
          const dom = domains[ti];
          const y = (v: number) => (dom ? box.top + box.h - ((v - dom[0]) / (dom[1] - dom[0] || 1)) * box.h : box.top + box.h / 2);
          const yTicks = dom && !t.strip ? niceTicks(dom[0], dom[1], Math.max(2, Math.round(box.h / 40))) : [];
          const colorOf = (i: number, c?: string) => c ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]!;
          return (
            <g key={t.id} className="at-track">
              <text className="at-title" x={PAD.left} y={box.top - 9}>
                {t.title}{t.unit ? <tspan className="at-title-unit">{` (${t.unit})`}</tspan> : null}
              </text>
              {yTicks.map((v) => <line key={`g${v}`} x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} className="at-grid" />)}
              {!t.strip ? <line x1={PAD.left} x2={PAD.left + plotW} y1={box.top + box.h} y2={box.top + box.h} className="at-base" /> : null}
              <g clipPath={`url(#${uid}-clip${ti})`}>
                {t.refBands?.map((b) => {
                  if (!dom) return null;
                  const top = y(Math.min(dom[1], Math.max(b.from, b.to)));
                  const bot = y(Math.max(dom[0], Math.min(b.from, b.to)));
                  if (bot - top <= 0) return null;
                  return (
                    <g key={b.label}>
                      <rect x={PAD.left} y={top} width={plotW} height={bot - top} style={{ fill: b.fill ?? "var(--cz-zone)" }} />
                      <text className="at-band-label" x={PAD.left + plotW - 4} y={top + 10} textAnchor="end">{b.label}</text>
                    </g>
                  );
                })}
                {t.nonEvaluable ? runs(t.nonEvaluable).map((r) => {
                  const rr = bandRect(r.i0, r.i1);
                  return rr.w > 0 ? <rect key={`ne${r.i0}`} x={rr.x} y={box.top} width={rr.w} height={box.h} fill={`url(#${uid}-hatch)`} opacity={0.55}><title>Not evaluable</title></rect> : null;
                }) : null}
                {markRegions?.map((m) => {
                  const rr = bandRect(m.i0, m.i1);
                  return rr.w > 0 ? <rect key={`mk${m.i0}-${m.i1}`} x={rr.x} y={box.top} width={rr.w} height={box.h} className="at-mark"><title>{m.label}</title></rect> : null;
                })}
                {t.refLines?.map((l) => (dom && l.y >= dom[0] && l.y <= dom[1] ? (
                  <g key={`rl${l.y}`}>
                    <line x1={PAD.left} x2={PAD.left + plotW} y1={y(l.y)} y2={y(l.y)} className="at-refline" />
                    <text className="at-band-label" x={PAD.left + 4} y={y(l.y) - 3}>{l.label}</text>
                  </g>
                ) : null))}
                {t.strip ? axis.map((_, i) => {
                  if (!visible(i)) return null;
                  const v = t.strip!.values[i];
                  const c = v === null || v === undefined || !Number.isFinite(v) ? null : t.strip!.color(v);
                  const rr = bandRect(i, i);
                  return <rect key={i} x={rr.x} y={box.top} width={Math.max(0.5, rr.w)} height={box.h} style={{ fill: c ?? `url(#${uid}-hatch)` }} />;
                }) : null}
                {dom ? t.envelopes?.map((e, ei) => {
                  const pts: string[] = [];
                  const segs: string[] = [];
                  const flush = () => {
                    if (pts.length > 1) segs.push(pts.join(" "));
                    pts.length = 0;
                  };
                  const lowers: [number, number][] = [];
                  for (let i = 0; i < n; i++) {
                    const lo = e.lower[i];
                    const hi = e.upper[i];
                    if (lo === null || hi === null || lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi) || !visible(i)) {
                      if (lowers.length) pts.push(...lowers.reverse().map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`));
                      lowers.length = 0;
                      flush();
                      continue;
                    }
                    pts.push(`${x(axis[i]!).toFixed(1)},${y(hi).toFixed(1)}`);
                    lowers.push([x(axis[i]!), y(lo)]);
                  }
                  if (lowers.length) pts.push(...lowers.reverse().map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`));
                  flush();
                  return segs.map((s, si) => <polygon key={`${e.id}${si}`} points={s} style={{ fill: colorOf(ei, e.color) }} opacity={0.16} />);
                }) : null}
                {dom ? t.series?.map((s, si) => {
                  const c = colorOf(si, s.color);
                  if (s.kind === "bars") {
                    const base = y(Math.max(dom[0], Math.min(dom[1], 0)));
                    return <g key={s.id}>{s.values.map((v, i) => {
                      if (v === null || !Number.isFinite(v) || !visible(i)) return null;
                      const rr = bandRect(i, i);
                      const yy = y(v);
                      return <rect key={i} x={rr.x} width={Math.max(0.5, rr.w * 0.9)} y={Math.min(base, yy)} height={Math.abs(base - yy)} style={{ fill: c }} opacity={0.8} />;
                    })}</g>;
                  }
                  if (s.kind === "points") return <g key={s.id}>{s.values.map((v, i) => (v === null || !Number.isFinite(v) || !visible(i) ? null : <circle key={i} cx={x(axis[i]!)} cy={y(v)} r={2} style={{ fill: c }} />))}</g>;
                  const d = linePath(s.values, y);
                  return <path key={s.id} d={d} fill="none" style={{ stroke: c }} strokeWidth={1.4} strokeLinejoin="round" strokeDasharray={s.dash} />;
                }) : null}
              </g>
              {!t.strip && !dom ? <text className="at-empty" x={PAD.left + plotW / 2} y={box.top + box.h / 2} textAnchor="middle">No evaluable value</text> : null}
              {yTicks.map((v) => (
                <g key={v}>
                  <text className="at-tick-label" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">{tick(v, t.format)}</text>
                </g>
              ))}
              {t.strip ? <text className="at-tick-label" x={PAD.left - 6} y={box.top + box.h / 2 + 3} textAnchor="end">{t.strip.label}</text> : null}
            </g>
          );
        })}
        {sel ? (() => {
          const rr = bandRect(sel.i0, sel.i1);
          return <rect className="at-selection" x={rr.x} y={PAD.top} width={Math.max(2, rr.w)} height={totalH - PAD.top - PAD.bottom} />;
        })() : null}
        {cursor !== null && cursor < n && visible(cursor) ? (() => {
          const cx = x(axis[cursor]!);
          const rr = bandRect(cursor, cursor);
          const l = Math.max(PAD.left, Math.min(rr.x, cx - CURSOR_HALF));
          const r = Math.min(PAD.left + plotW, Math.max(rr.x + rr.w, cx + CURSOR_HALF));
          return (
            <g pointerEvents="none">
              <rect className="at-cursor-band" x={l} y={PAD.top - 4} width={Math.max(0, r - l)} height={totalH - PAD.top - PAD.bottom + 4} />
              <line className="at-cursor" x1={cx} x2={cx} y1={PAD.top - 4} y2={totalH - PAD.bottom} />
            </g>
          );
        })() : null}
        <g>
          {xTicks.map((v) => (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1={totalH - PAD.bottom} y2={totalH - PAD.bottom + 4} className="at-tick" />
              <text className="at-tick-label" x={x(v)} y={totalH - PAD.bottom + 17} textAnchor="middle">{defaultFormat(v)}</text>
            </g>
          ))}
          <text className="at-axis-label" x={PAD.left + plotW / 2} y={totalH - 4} textAnchor="middle">{axisLabel}</text>
        </g>
      </svg>
      {legend ? (
        <ul className="at-legend" aria-label="Legend">
          {legendItems(tracks).map((it) => (
            <li key={it.key}>
              <svg width="22" height="10" aria-hidden="true">
                {it.area ? <rect x="0" y="1" width="22" height="8" rx="2" style={{ fill: it.color }} opacity={0.22} /> : <line x1="0" x2="22" y1="5" y2="5" style={{ stroke: it.color }} strokeWidth="2" strokeDasharray={it.dash} />}
              </svg>
              {it.label}
            </li>
          ))}
          {tracks.some((t) => t.nonEvaluable?.some(Boolean)) ? <li><span className="at-legend-na" aria-hidden="true" />Not evaluable</li> : null}
        </ul>
      ) : null}
      {cursor !== null && cursor < n && showTooltip ? (
        <div className="at-tooltip" role="status" style={{ left: Math.min(width - 220, Math.max(0, x(axis[cursor]!) + 12)) }}>
          <strong>{axisLabel}: {defaultFormat(axis[cursor]!)}</strong> <span className="at-dim">(band {cursor + 1})</span>
          {tracks.map((t) => {
            const f = t.format ?? defaultFormat;
            const ne = t.nonEvaluable?.[cursor];
            const rows = [
              ...(t.envelopes ?? []).map((e) => {
                const lo = e.lower[cursor];
                const hi = e.upper[cursor];
                return `${e.label}: ${lo === null || lo === undefined || hi === null || hi === undefined ? "—" : `${f(lo)} – ${f(hi)}`}`;
              }),
              ...(t.series ?? []).map((s) => {
                const v = s.values[cursor];
                return `${s.label}: ${v === null || v === undefined || !Number.isFinite(v) ? "—" : f(v)}`;
              }),
              ...(t.strip ? [(() => {
                const v = t.strip.values[cursor];
                return `${t.strip.label}: ${v === null || v === undefined || !Number.isFinite(v) ? "—" : t.strip.describe ? t.strip.describe(v) : f(v)}`;
              })()] : []),
            ];
            return <div key={t.id}><span className="at-dim">{t.title}{ne ? " — not evaluable" : ""}</span>{rows.map((r) => <div key={r}>{r}</div>)}</div>;
          })}
        </div>
      ) : null}
    </div>
  );
}
