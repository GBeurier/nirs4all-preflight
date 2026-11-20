// Labelled dot plot on one horizontal axis (docx image5: diamond = dataset, circles = specs, squares = study).
import type { ReactNode } from "react";
import { EmptyState, Responsive, toneClass, type Tone } from "./frame";
import { defaultFmt, extent, linear, niceTicks, textWidth, type Fmt } from "./scale";

export type DotShape = "circle" | "square" | "diamond";

export interface DotPoint {
  value: number;
  shape?: DotShape | undefined;
  /** Text next to the point; defaults to the formatted value. */
  label?: string | undefined;
  tone?: Tone | undefined;
}

export interface DotRow {
  label: string;
  points: readonly DotPoint[];
  /** Draws a line between the smallest and the largest point (a specification range). */
  range?: boolean | undefined;
  /** Bold row label (e.g. the analysed dataset). */
  emphasis?: boolean | undefined;
  note?: string | undefined;
}

const SHAPE_TONE: Record<DotShape, Tone> = { diamond: "copper", circle: "blue", square: "grey" };

export function DotMark({ shape, x, y, r = 6, tone }: { shape: DotShape; x: number; y: number; r?: number; tone?: Tone }) {
  const cls = `cz-fill ${toneClass(tone ?? SHAPE_TONE[shape])}`;
  if (shape === "square") return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} className={cls} />;
  if (shape === "diamond") return <path d={`M${x},${y - r * 1.15} L${x + r * 1.15},${y} L${x},${y + r * 1.15} L${x - r * 1.15},${y} Z`} className={cls} />;
  return <circle cx={x} cy={y} r={r} className={cls} />;
}

export function DotPlot({ rows, axisLabel, domain, fmt = defaultFmt, digits = 3, legend, emptyMessage, title, reversed = false, ends }: {
  rows: readonly DotRow[];
  axisLabel?: string | undefined;
  domain?: [number, number] | undefined;
  fmt?: Fmt | undefined;
  digits?: number | undefined;
  legend?: readonly { shape: DotShape; label: string; tone?: Tone }[];
  emptyMessage?: ReactNode | undefined;
  title?: string | undefined;
  /** Draw the largest value on the left. */
  reversed?: boolean | undefined;
  /** Direction caption under the axis, e.g. { left: "Less noise", right: "More noise" }. */
  ends?: { left: string; right: string } | undefined;
}) {
  const values = rows.flatMap((r) => r.points.map((p) => p.value)).filter(Number.isFinite);
  if (!values.length) return <EmptyState>{emptyMessage ?? "No value to plot."}</EmptyState>;
  const ext = domain ?? extent(values, 0.08)!;
  const ticks = niceTicks(ext[0], ext[1], 6);
  const d0 = Math.min(ext[0], ticks[0] ?? ext[0]);
  const d1 = Math.max(ext[1], ticks[ticks.length - 1] ?? ext[1]);
  const labelW = Math.min(280, Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 14);
  const rowH = 28;
  const legendH = legend?.length ? 22 : 0;
  return (
    <Responsive min={320}>
      {(width) => {
        const x = reversed ? linear(d0, d1, width - 44, labelW + 8) : linear(d0, d1, labelW + 8, width - 44);
        const plotH = rows.length * rowH;
        const h = legendH + plotH + (axisLabel ? 40 : 24) + (ends ? 18 : 0);
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${title ? `${title}: ` : ""}${rows.map((r) => `${r.label} ${r.points.map((p) => fmt(p.value, digits)).join(" to ")}`).join("; ")}`}>
            {legend?.length ? (
              <g>
                {(() => {
                  let cx = labelW + 8;
                  return legend.map((l) => {
                    const g = <g key={l.label}><DotMark shape={l.shape} x={cx + 6} y={9} r={5} {...(l.tone ? { tone: l.tone } : {})} /><text x={cx + 16} y={13} className="cz-t-axis">{l.label}</text></g>;
                    cx += textWidth(l.label, 11) + 34;
                    return g;
                  });
                })()}
              </g>
            ) : null}
            {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={legendH} y2={legendH + plotH} className="cz-grid" />)}
            {rows.map((r, i) => {
              const y = legendH + i * rowH + rowH / 2;
              const vs = r.points.map((p) => p.value).filter(Number.isFinite);
              return (
                <g key={r.label + i}>
                  <title>{`${r.label}: ${r.points.map((p) => p.label ?? fmt(p.value, digits)).join(", ")}${r.note ? ` (${r.note})` : ""}`}</title>
                  <text x={labelW} y={y + 4} textAnchor="end" className={r.emphasis ? "cz-t-strong" : "cz-t-label"} style={{ fontSize: 12.5 }}>{r.label.length > 44 ? `${r.label.slice(0, 42)}…` : r.label}</text>
                  {r.range && vs.length > 1 ? <line x1={x(Math.min(...vs))} x2={x(Math.max(...vs))} y1={y} y2={y} style={{ stroke: "var(--cz-blue)", strokeWidth: 2, opacity: 0.55 }} /> : null}
                  {r.points.map((p, j) => {
                    // Several points on one row: the leftmost label goes on its left so labels never run into the next point.
                    const left = r.points.length > 1 && r.points.every((q) => x(q.value) >= x(p.value));
                    return (
                      <g key={j}>
                        <DotMark shape={p.shape ?? "circle"} x={x(p.value)} y={y} {...(p.tone ? { tone: p.tone } : {})} />
                        <text x={x(p.value) + (left ? -10 : 10)} y={y + 4} textAnchor={left ? "end" : "start"} className="cz-t-num" style={{ fontSize: 12, fill: "var(--cz-ink)" }}>{p.label ?? fmt(p.value, digits)}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {ticks.map((t) => <text key={t} x={x(t)} y={legendH + plotH + 16} textAnchor="middle" className="cz-t-axis">{fmt(t, 4)}</text>)}
            {axisLabel ? <text x={(labelW + width - 44) / 2} y={h - 4 - (ends ? 18 : 0)} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{axisLabel}</text> : null}
            {ends ? (
              <g className="cz-ends">
                <text x={labelW + 8} y={h - 4} className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>← {ends.left}</text>
                <text x={width - 44} y={h - 4} textAnchor="end" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{ends.right} →</text>
              </g>
            ) : null}
          </svg>
        );
      }}
    </Responsive>
  );
}
