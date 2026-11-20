// Labelled rows of segmented colour strips over one spectral axis (image (15) quality map), with a shared
// hover cursor, drag / click range selection, zoom / pan on the band window and a grey hatch for
// non-evaluable bands. Each row carries its own compact legend (class label + share of bands, always over
// the whole axis), so colour is never the only carrier of meaning.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { EmptyState, Responsive } from "./frame";
import { defaultFmt, linear, niceTicks, textWidth, type Fmt } from "./scale";

export interface StripClass {
  id: string;
  label: string;
  /** CSS colour (a `var(--cz-…)` token preferably). */
  color: string;
}

export interface StripRow {
  id: string;
  label: string;
  /** Class id per band (source-axis order); null = not evaluable (hatched). */
  values: readonly (string | null)[];
  /** Per-band class ids for the legend shares when `values` is coarsened for drawing (defaults to `values`). */
  bandValues?: readonly (string | null)[] | undefined;
  classes: readonly StripClass[];
  /** Optional hover text per band (value + class). */
  describe?: (index: number) => string | undefined;
  /** Short note under the legend (e.g. provenance). */
  note?: ReactNode | undefined;
}

export interface StripRange {
  i0: number;
  i1: number;
}

/** Zoom window in band indices; `null` = the whole axis. */
export type StripView = StripRange | null;

/** Smallest window (bands) a zoom can reach. */
const MIN_SPAN = 4;

/**
 * Zoomed window around `center` (band index) by factor `k` (< 1 zooms in), clamped to [0, n − 1]; null when
 * the window covers the whole axis again.
 */
export function zoomView(view: StripView, n: number, center: number, k: number): StripView {
  const a = view ? Math.min(view.i0, view.i1) : 0;
  const b = view ? Math.max(view.i0, view.i1) : n - 1;
  const span = b - a + 1;
  const next = Math.max(Math.min(MIN_SPAN, n), Math.round(span * k));
  if (next >= n) return null;
  const c = Math.min(b, Math.max(a, center));
  const left = (c - a) / Math.max(1, span - 1);
  let i0 = Math.round(c - left * (next - 1));
  i0 = Math.max(0, Math.min(n - next, i0));
  return { i0, i1: i0 + next - 1 };
}

/** Window shifted by `delta` bands, clamped to the axis. */
export function panView(view: StripView, n: number, delta: number): StripView {
  if (!view) return null;
  const a = Math.min(view.i0, view.i1);
  const span = Math.max(view.i0, view.i1) - a + 1;
  const i0 = Math.max(0, Math.min(n - span, a + Math.round(delta)));
  return { i0, i1: i0 + span - 1 };
}

/** Runs of identical consecutive classes: [start, end] inclusive. */
export function classRuns(values: readonly (string | null)[]): { start: number; end: number; id: string | null }[] {
  const out: { start: number; end: number; id: string | null }[] = [];
  for (let i = 0; i < values.length; i++) {
    const id = values[i] ?? null;
    const last = out[out.length - 1];
    if (last && last.id === id) last.end = i;
    else out.push({ start: i, end: i, id });
  }
  return out;
}

export function SegmentStrip({ axis, axisLabel, rows, cursor: cursorProp, onCursor, selection = null, onSelect, onRowClick, marks = [], fmt = defaultFmt, rowHeight = 18, title, showLegends = true, view: viewProp, onView }: {
  axis: readonly number[];
  axisLabel: string;
  rows: readonly StripRow[];
  /** Controlled hover cursor (band index); uncontrolled when omitted. */
  cursor?: number | null | undefined;
  onCursor?: (index: number | null) => void | undefined;
  selection?: StripRange | null | undefined;
  onSelect?: (range: StripRange | null) => void | undefined;
  onRowClick?: (rowId: string, index: number) => void | undefined;
  /** Marked intervals (e.g. regions to investigate), drawn as outlined bands. */
  marks?: readonly (StripRange & { label: string })[];
  fmt?: Fmt | undefined;
  rowHeight?: number | undefined;
  title: string;
  showLegends?: boolean | undefined;
  /** Controlled zoom window (band indices) or null for the whole axis; uncontrolled when omitted. */
  view?: StripView | undefined;
  onView?: ((view: StripView) => void) | undefined;
}) {
  const [ownCursor, setOwnCursor] = useState<number | null>(null);
  const cursor = cursorProp !== undefined ? cursorProp : ownCursor;
  const setCursor = (i: number | null) => {
    if (cursorProp === undefined) setOwnCursor(i);
    onCursor?.(i);
  };
  const [ownView, setOwnView] = useState<StripView>(null);
  const view = viewProp !== undefined ? viewProp : ownView;
  const setView = (v: StripView) => {
    if (viewProp === undefined) setOwnView(v);
    onView?.(v);
  };
  const drag = useRef<{ start: number; moved: boolean; pan?: { x: number; view: StripView; bandPx: number } } | null>(null);
  const hatchId = `cz-hatch-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const clipId = `${hatchId}-clip`;
  const n = axis.length;
  // Ctrl/⌘ + wheel zoom needs a non-passive native listener (React's wheel handler cannot prevent scrolling).
  const wheel = useRef<{ x0: number; x1: number; view: StripView; setView: (v: StripView) => void; n: number }>({ x0: 0, x1: 1, view, setView, n });
  wheel.current = { ...wheel.current, view, setView, n };
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const svgRef = useCallback((el: SVGSVGElement | null) => setSvg(el), []);
  useEffect(() => {
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const w = wheel.current;
      const r = svg.getBoundingClientRect();
      const a = w.view ? Math.min(w.view.i0, w.view.i1) : 0;
      const b = w.view ? Math.max(w.view.i0, w.view.i1) : w.n - 1;
      const center = a + Math.floor(((e.clientX - r.left - w.x0) / Math.max(1, w.x1 - w.x0)) * (b - a + 1));
      w.setView(zoomView(w.view, w.n, center, e.deltaY > 0 ? 1.25 : 0.8));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [svg]);
  if (!n || !rows.length) return <EmptyState>No band-wise diagnostic to map.</EmptyState>;
  const v0 = view ? Math.max(0, Math.min(view.i0, view.i1)) : 0;
  const v1 = view ? Math.min(n - 1, Math.max(view.i0, view.i1)) : n - 1;
  const zoomed = v0 > 0 || v1 < n - 1;
  const selA = selection ? Math.min(selection.i0, selection.i1) : null;
  const selB = selection ? Math.max(selection.i0, selection.i1) : null;
  const toolbar = (
    <div className="cz-strip-toolbar">
      <span className="cz-hint">Drag to select · Ctrl/⌘ + wheel to zoom · Shift + drag to pan · double-click to reset</span>
      <button type="button" className="btn btn-ghost btn-sm" aria-label="Zoom in" onClick={() => setView(zoomView(view, n, cursor ?? Math.round((v0 + v1) / 2), 0.5))}>Zoom in</button>
      <button type="button" className="btn btn-ghost btn-sm" aria-label="Zoom out" disabled={!zoomed} onClick={() => setView(zoomView(view, n, Math.round((v0 + v1) / 2), 2))}>Zoom out</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={selA === null || selA === selB} onClick={() => selA !== null && selB !== null && setView(selB - selA + 1 >= n ? null : { i0: selA, i1: selB })}>Zoom to selection</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!zoomed} onClick={() => setView(null)}>Reset zoom</button>
      {zoomed ? <span className="cz-hint" role="status">Bands {v0 + 1}–{v1 + 1} of {n} ({fmt(axis[v0]!, 6)}–{fmt(axis[v1]!, 6)}); band-level classes</span> : null}
    </div>
  );
  const labelW = Math.min(150, Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 14);
  const legendH = showLegends ? 16 : 0;
  const rowGap = 8;
  const rowBlock = rowHeight + legendH + rowGap;
  return (
    <>
    {toolbar}
    <Responsive min={360}>
      {(width) => {
        const x0 = labelW;
        const x1 = width - 6;
        wheel.current.x0 = x0;
        wheel.current.x1 = x1;
        // Bands are drawn by index (equal width) so irregular axes stay readable; ticks show axis values.
        const bx = linear(v0, v1 + 1, x0, x1);
        const span = v1 - v0 + 1;
        const top = 4;
        const plotH = rows.length * rowBlock;
        const h = top + plotH + 30;
        const indexAt = (clientX: number, el: SVGSVGElement) => {
          const r = el.getBoundingClientRect();
          const px = clientX - r.left;
          return Math.max(v0, Math.min(v1, v0 + Math.floor(((px - x0) / (x1 - x0)) * span)));
        };
        const lo = Math.min(axis[v0]!, axis[v1]!);
        const hi = Math.max(axis[v0]!, axis[v1]!);
        const ticks = niceTicks(lo, hi, Math.max(3, Math.floor((x1 - x0) / 90)));
        const asc = axis[n - 1]! >= axis[0]!;
        const tickX = (v: number) => {
          // nearest band of an axis value (monotone axis assumed for tick placement only)
          let best = v0;
          let bd = Infinity;
          for (let i = v0; i <= v1; i++) {
            const d = Math.abs(axis[i]! - v);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
          return bd <= Math.abs(hi - lo) / Math.max(1, span - 1) ? bx(best + 0.5) : null;
        };
        const sel = selection ? { a: Math.min(selection.i0, selection.i1), b: Math.max(selection.i0, selection.i1) } : null;
        const onDown = (e: PointerEvent<SVGSVGElement>) => {
          if (e.button !== 0) return;
          const i = indexAt(e.clientX, e.currentTarget);
          if (e.shiftKey && zoomed) {
            drag.current = { start: i, moved: false, pan: { x: e.clientX, view, bandPx: (x1 - x0) / span } };
            e.currentTarget.setPointerCapture?.(e.pointerId);
            return;
          }
          if (!onSelect) return;
          drag.current = { start: i, moved: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        };
        const onMove = (e: PointerEvent<SVGSVGElement>) => {
          const i = indexAt(e.clientX, e.currentTarget);
          setCursor(i);
          const pan = drag.current?.pan;
          if (pan) {
            drag.current!.moved = true;
            setView(panView(pan.view, n, -(e.clientX - pan.x) / pan.bandPx));
            return;
          }
          if (drag.current && onSelect && i !== drag.current.start) {
            drag.current.moved = true;
            onSelect({ i0: drag.current.start, i1: i });
          }
        };
        const onUp = (e: PointerEvent<SVGSVGElement>) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved || d.pan) return;
          const i = indexAt(e.clientX, e.currentTarget);
          const r = e.currentTarget.getBoundingClientRect();
          const row = Math.floor((e.clientY - r.top - top) / rowBlock);
          if (sel && sel.a === sel.b && sel.a === i) onSelect?.(null);
          else onSelect?.({ i0: i, i1: i });
          const hit = rows[row];
          if (hit && onRowClick) onRowClick(hit.id, i);
        };
        const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
          const cur = cursor ?? (sel ? sel.a : 0);
          const step = e.shiftKey ? Math.max(1, Math.round(n / 20)) : 1;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const next = Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? step : -step)));
            setCursor(next);
            // Keep the cursor inside the zoom window.
            if (zoomed && (next < v0 || next > v1)) setView(panView(view, n, next < v0 ? next - v0 : next - v1));
          } else if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            setView(zoomView(view, n, cur, 0.5));
          } else if (e.key === "-") {
            e.preventDefault();
            setView(zoomView(view, n, cur, 2));
          } else if ((e.key === "Enter" || e.key === " ") && onSelect) {
            e.preventDefault();
            onSelect({ i0: cur, i1: cur });
          } else if (e.key === "Escape" && onSelect) onSelect(null);
        };
        return (
          <svg ref={svgRef} className="cz-svg cz-strip" width={width} height={h} role="application" tabIndex={0} aria-label={`${title}. ${rows.length} rows over ${n} bands${zoomed ? `, zoomed on bands ${v0 + 1} to ${v1 + 1}` : ""}. Arrow keys move the cursor, + and − zoom, Enter selects the band, Escape clears.`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)} onKeyDown={onKey} onDoubleClick={() => setView(null)} style={{ touchAction: "none", cursor: onSelect ? "crosshair" : "default" }}>
            <title>{title}</title>
            <defs>
              <clipPath id={clipId}><rect x={x0} y={0} width={x1 - x0} height={h} /></clipPath>
              <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" style={{ fill: "var(--cz-na)" }} />
                <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: "var(--cz-na-line)", strokeWidth: 1.6 }} />
              </pattern>
            </defs>
            {rows.map((row, ri) => {
              const y = top + ri * rowBlock;
              const cls = new Map(row.classes.map((c) => [c.id, c]));
              // Zoomed in, every band shows its own class (the coarse windows would hide the detail).
              const drawn = zoomed ? (row.bandValues ?? row.values) : row.values;
              const runs = classRuns(drawn.slice(v0, v1 + 1)).map((r) => ({ ...r, start: r.start + v0, end: r.end + v0 }));
              const counts = new Map<string | null, number>();
              for (const v of row.bandValues ?? row.values) counts.set(v ?? null, (counts.get(v ?? null) ?? 0) + 1);
              let lx = x0;
              return (
                <g key={row.id}>
                  <text x={x0 - 8} y={y + rowHeight / 2 + 4} textAnchor="end" className="cz-t-label" style={{ fill: "var(--cz-ink)" }}>{row.label}</text>
                  <rect x={x0} y={y} width={x1 - x0} height={rowHeight} rx={4} style={{ fill: "var(--cz-track)" }} />
                  <g clipPath={`url(#${clipId})`}>
                  {runs.map((r) => {
                    const c = r.id === null ? null : cls.get(r.id);
                    const xa = bx(r.start);
                    const xb = bx(r.end + 1);
                    return (
                      <rect key={r.start} x={xa} y={y} width={Math.max(0.6, xb - xa - (xb - xa > 3 ? 1 : 0))} height={rowHeight} rx={0} style={{ fill: c ? c.color : `url(#${hatchId})` }}>
                        <title>{`${row.label}: ${c ? c.label : "not evaluable"} · ${fmt(axis[r.start]!, 6)}${r.end > r.start ? `–${fmt(axis[r.end]!, 6)}` : ""} (${r.end - r.start + 1} band${r.end > r.start ? "s" : ""})`}</title>
                      </rect>
                    );
                  })}
                  </g>
                  {showLegends ? (
                    <g transform={`translate(0,${y + rowHeight + 12})`}>
                      {[...row.classes.map((c) => ({ id: c.id as string | null, label: c.label, color: c.color })), { id: null, label: "not evaluable", color: `url(#${hatchId})` }].filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => {
                        const txt = `${c.label} ${fmt((100 * (counts.get(c.id) ?? 0)) / n, 2)} %`;
                        const g = (
                          <g key={c.id ?? "na"} transform={`translate(${lx},0)`}>
                            <rect x={0} y={-8} width={9} height={9} rx={2} style={{ fill: c.color }} />
                            <text x={13} y={0} className="cz-t-axis" style={{ fontSize: 10.5 }}>{txt}</text>
                          </g>
                        );
                        lx += textWidth(txt, 10.5) + 26;
                        return lx > x1 + 40 ? null : g;
                      })}
                    </g>
                  ) : null}
                </g>
              );
            })}
            <g clipPath={`url(#${clipId})`}>
            {marks.map((m, i) => {
              const a = Math.max(v0, Math.min(m.i0, m.i1));
              const b = Math.min(v1, Math.max(m.i0, m.i1));
              if (b < a) return null;
              return <rect key={i} x={bx(a)} y={top - 2} width={Math.max(2, bx(b + 1) - bx(a))} height={plotH - rowGap + 2} rx={3} style={{ fill: "none", stroke: "var(--cz-copper)", strokeWidth: 1.5, strokeDasharray: "3 2" }}><title>{m.label}</title></rect>;
            })}
            {sel && sel.b >= v0 && sel.a <= v1 ? <rect x={bx(Math.max(v0, sel.a))} y={top - 2} width={Math.max(2, bx(Math.min(v1, sel.b) + 1) - bx(Math.max(v0, sel.a)))} height={plotH - rowGap + 2} className="cz-sel" style={{ stroke: "var(--cz-ink-2)", strokeWidth: 1 }} /> : null}
            </g>
            {cursor !== null && cursor >= v0 && cursor <= v1 ? (
              <g pointerEvents="none">
                <line x1={bx(cursor + 0.5)} x2={bx(cursor + 0.5)} y1={top - 2} y2={top + plotH - rowGap} className="cz-cursor" />
                <text x={Math.min(x1 - 4, Math.max(x0 + 4, bx(cursor + 0.5)))} y={h - 2} textAnchor="middle" className="cz-t-strong" style={{ fontSize: 11 }}>{fmt(axis[cursor]!, 6)}</text>
              </g>
            ) : null}
            <line x1={x0} x2={x1} y1={top + plotH - rowGap + 4} y2={top + plotH - rowGap + 4} className="cz-axis-line" />
            {ticks.map((t) => {
              const tx = tickX(t);
              return tx === null ? null : <text key={t} x={tx} y={top + plotH - rowGap + 18} textAnchor="middle" className="cz-t-axis">{fmt(t, 5)}</text>;
            })}
            {cursor === null ? <text x={(x0 + x1) / 2} y={h - 2} textAnchor="middle" className="cz-t-axis">{axisLabel}{asc ? "" : " (decreasing)"}</text> : null}
          </svg>
        );
      }}
    </Responsive>
    </>
  );
}
