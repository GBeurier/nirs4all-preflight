// Trade-off scatter (docx image8): labelled points, optional dashed trajectory, optional shaded target zone.
import type { KeyboardEvent, ReactNode } from "react";
import { EmptyState, Responsive } from "./frame";
import { defaultFmt, extent, linear, niceTicks, type Fmt } from "./scale";

export interface ScatterPoint {
  id: string;
  x: number;
  y: number;
  label: string;
  /** Current / nominal configuration: drawn larger, in the accent tone. */
  nominal?: boolean | undefined;
  /** On the Pareto front: ring marker. */
  pareto?: boolean | undefined;
}

export interface ScatterZone {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  label?: string | undefined;
}

export function ParetoScatter({ points, xLabel, yLabel, trajectory, zone, selectedId = null, onSelect, fmt = defaultFmt, height = 300, title, emptyMessage, includeZero = true }: {
  points: readonly ScatterPoint[];
  xLabel: string;
  yLabel: string;
  /** Point ids joined in order by a dashed curve (e.g. Raw → SG 5 → SG 11 …). `true` joins all points in the given order. */
  trajectory?: readonly string[] | boolean | undefined;
  zone?: ScatterZone | null | undefined;
  selectedId?: string | null | undefined;
  onSelect?: (id: string) => void | undefined;
  fmt?: Fmt | undefined;
  height?: number | undefined;
  title: string;
  emptyMessage?: ReactNode | undefined;
  includeZero?: boolean | undefined;
}) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return <EmptyState>{emptyMessage ?? "No configuration evaluated yet."}</EmptyState>;
  const xs = [...pts.map((p) => p.x), ...(includeZero ? [0] : []), ...(zone ? [zone.x0, zone.x1] : [])];
  const ys = [...pts.map((p) => p.y), ...(includeZero ? [0] : []), ...(zone ? [zone.y0, zone.y1] : [])];
  const [xa, xb] = extent(xs, 0.06)!;
  const [ya, yb] = extent(ys, 0.08)!;
  const order = trajectory === true ? pts : Array.isArray(trajectory) ? trajectory.map((id) => pts.find((p) => p.id === id)).filter((p): p is ScatterPoint => !!p) : [];
  return (
    <Responsive min={300}>
      {(width) => {
        const pad = { l: 52, r: 56, t: 12, b: 42 };
        const x = linear(xa, xb, pad.l, width - pad.r);
        const y = linear(ya, yb, height - pad.b, pad.t);
        const xt = niceTicks(xa, xb, Math.max(3, Math.floor(width / 110)));
        const yt = niceTicks(ya, yb, 4);
        const key = (p: ScatterPoint) => (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.(p.id);
          }
        };
        return (
          <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${title}: ${pts.map((p) => `${p.label} (${fmt(p.x)}, ${fmt(p.y)})`).join("; ")}`}>
            <title>{title}</title>
            {zone ? (
              <g>
                <rect x={x(Math.min(zone.x0, zone.x1))} y={y(Math.max(zone.y0, zone.y1))} width={Math.abs(x(zone.x1) - x(zone.x0))} height={Math.abs(y(zone.y0) - y(zone.y1))} style={{ fill: "var(--cz-zone)" }} rx={4} />
                {zone.label ? <text x={x(Math.min(zone.x0, zone.x1)) + 8} y={y(Math.max(zone.y0, zone.y1)) + 16} style={{ fill: "var(--cz-accent)", fontSize: 12 }}>{zone.label}</text> : null}
              </g>
            ) : null}
            {yt.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" />
                <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{fmt(t, 3)}</text>
              </g>
            ))}
            <line x1={pad.l} x2={width - pad.r} y1={height - pad.b} y2={height - pad.b} className="cz-axis-line" />
            <line x1={pad.l} x2={pad.l} y1={pad.t} y2={height - pad.b} className="cz-axis-line" />
            {xt.map((t) => <text key={t} x={x(t)} y={height - pad.b + 15} textAnchor="middle" className="cz-t-axis">{fmt(t, 3)}</text>)}
            <text x={(pad.l + width - pad.r) / 2} y={height - 6} textAnchor="middle" className="cz-t-label">{xLabel} →</text>
            <text transform={`translate(13,${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-label">{yLabel} →</text>
            {order.length > 1 ? <polyline points={order.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")} fill="none" style={{ stroke: "var(--cz-grey)", strokeWidth: 1.8, strokeDasharray: "5 4" }} /> : null}
            {pts.map((p) => {
              const sel = selectedId === p.id;
              const r = p.nominal || sel ? 7.5 : 6;
              return (
                <g key={p.id} {...(onSelect ? { className: "cz-focusable", role: "button", tabIndex: 0, "aria-pressed": sel, "aria-label": `${p.label}: ${xLabel} ${fmt(p.x)}, ${yLabel} ${fmt(p.y)}`, onClick: () => onSelect(p.id), onKeyDown: key(p) } : {})}>
                  <title>{`${p.label}${p.nominal ? " (current)" : ""}${p.pareto ? " · Pareto front" : ""}: ${xLabel} ${fmt(p.x)}, ${yLabel} ${fmt(p.y)}`}</title>
                  <circle cx={x(p.x)} cy={y(p.y)} r={r} style={{ fill: p.nominal ? "var(--cz-accent)" : "var(--cz-blue)", stroke: sel ? "var(--cz-ink)" : p.pareto ? "var(--cz-accent)" : "none", strokeWidth: sel ? 2 : 1.6 }} />
                  <text x={x(p.x) + 10} y={y(p.y) + 16} className={p.nominal ? "cz-t-strong" : "cz-t-label"} style={{ fontSize: 12 }}>{p.label}</text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </Responsive>
  );
}
