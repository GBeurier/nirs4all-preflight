// Labelled rows of segmented colour strips over one spectral axis (image (15) quality map), with a shared
// hover cursor, drag / click range selection and a grey hatch for non-evaluable bands. Each row carries
// its own compact legend (class label + share of bands), so colour is never the only carrier of meaning.
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
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

export function SegmentStrip({ axis, axisLabel, rows, cursor: cursorProp, onCursor, selection = null, onSelect, onRowClick, marks = [], fmt = defaultFmt, rowHeight = 18, title, showLegends = true }: {
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
}) {
  const [ownCursor, setOwnCursor] = useState<number | null>(null);
  const cursor = cursorProp !== undefined ? cursorProp : ownCursor;
  const setCursor = (i: number | null) => {
    if (cursorProp === undefined) setOwnCursor(i);
    onCursor?.(i);
  };
  const drag = useRef<{ start: number; moved: boolean } | null>(null);
  const hatchId = `cz-hatch-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const n = axis.length;
  if (!n || !rows.length) return <EmptyState>No band-wise diagnostic to map.</EmptyState>;
  const labelW = Math.min(150, Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 14);
  const legendH = showLegends ? 16 : 0;
  const rowGap = 8;
  const rowBlock = rowHeight + legendH + rowGap;
  return (
    <Responsive min={360}>
      {(width) => {
        const x0 = labelW;
        const x1 = width - 6;
        // Bands are drawn by index (equal width) so irregular axes stay readable; ticks show axis values.
        const bx = linear(0, n, x0, x1);
        const top = 4;
        const plotH = rows.length * rowBlock;
        const h = top + plotH + 30;
        const indexAt = (clientX: number, svg: SVGSVGElement) => {
          const r = svg.getBoundingClientRect();
          const px = clientX - r.left;
          return Math.max(0, Math.min(n - 1, Math.floor(((px - x0) / (x1 - x0)) * n)));
        };
        const lo = Math.min(axis[0]!, axis[n - 1]!);
        const hi = Math.max(axis[0]!, axis[n - 1]!);
        const ticks = niceTicks(lo, hi, Math.max(3, Math.floor((x1 - x0) / 90)));
        const asc = axis[n - 1]! >= axis[0]!;
        const tickX = (v: number) => {
          // nearest band of an axis value (monotone axis assumed for tick placement only)
          let best = 0;
          let bd = Infinity;
          for (let i = 0; i < n; i++) {
            const d = Math.abs(axis[i]! - v);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
          return bd <= Math.abs(hi - lo) / Math.max(1, n - 1) ? bx(best + 0.5) : null;
        };
        const sel = selection ? { a: Math.min(selection.i0, selection.i1), b: Math.max(selection.i0, selection.i1) } : null;
        const onDown = (e: PointerEvent<SVGSVGElement>) => {
          if (!onSelect) return;
          const i = indexAt(e.clientX, e.currentTarget);
          drag.current = { start: i, moved: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        };
        const onMove = (e: PointerEvent<SVGSVGElement>) => {
          const i = indexAt(e.clientX, e.currentTarget);
          setCursor(i);
          if (drag.current && onSelect && i !== drag.current.start) {
            drag.current.moved = true;
            onSelect({ i0: drag.current.start, i1: i });
          }
        };
        const onUp = (e: PointerEvent<SVGSVGElement>) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved) return;
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
            setCursor(Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? step : -step))));
          } else if ((e.key === "Enter" || e.key === " ") && onSelect) {
            e.preventDefault();
            onSelect({ i0: cur, i1: cur });
          } else if (e.key === "Escape" && onSelect) onSelect(null);
        };
        return (
          <svg className="cz-svg cz-strip" width={width} height={h} role="application" tabIndex={0} aria-label={`${title}. ${rows.length} rows over ${n} bands. Arrow keys move the cursor, Enter selects the band, Escape clears.`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)} onKeyDown={onKey} style={{ touchAction: "none", cursor: onSelect ? "crosshair" : "default" }}>
            <title>{title}</title>
            <defs>
              <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" style={{ fill: "var(--cz-na)" }} />
                <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: "var(--cz-na-line)", strokeWidth: 1.6 }} />
              </pattern>
            </defs>
            {rows.map((row, ri) => {
              const y = top + ri * rowBlock;
              const cls = new Map(row.classes.map((c) => [c.id, c]));
              const runs = classRuns(row.values);
              const counts = new Map<string | null, number>();
              for (const v of row.bandValues ?? row.values) counts.set(v ?? null, (counts.get(v ?? null) ?? 0) + 1);
              let lx = x0;
              return (
                <g key={row.id}>
                  <text x={x0 - 8} y={y + rowHeight / 2 + 4} textAnchor="end" className="cz-t-label" style={{ fill: "var(--cz-ink)" }}>{row.label}</text>
                  <rect x={x0} y={y} width={x1 - x0} height={rowHeight} rx={4} style={{ fill: "var(--cz-track)" }} />
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
            {marks.map((m, i) => {
              const a = Math.min(m.i0, m.i1);
              const b = Math.max(m.i0, m.i1);
              return <rect key={i} x={bx(a)} y={top - 2} width={Math.max(2, bx(b + 1) - bx(a))} height={plotH - rowGap + 2} rx={3} style={{ fill: "none", stroke: "var(--cz-copper)", strokeWidth: 1.5, strokeDasharray: "3 2" }}><title>{m.label}</title></rect>;
            })}
            {sel ? <rect x={bx(sel.a)} y={top - 2} width={Math.max(2, bx(sel.b + 1) - bx(sel.a))} height={plotH - rowGap + 2} className="cz-sel" style={{ stroke: "var(--cz-ink-2)", strokeWidth: 1 }} /> : null}
            {cursor !== null && cursor >= 0 && cursor < n ? (
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
  );
}
