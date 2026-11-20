// Small SVG charts of the joint module (interim demo components; nirs4all-ui debt). Values are drawn as given:
// nothing is estimated here except display quantiles and the optional least-squares trend line.
import { useState, type ReactNode } from "react";
import { EmptyState, Legend, Responsive, defaultFmt, extent, linear, niceTicks, textWidth, type Fmt } from "../shared/charts";

/** Categorical palette (CSS tokens in joint.css, light and dark); a shape always doubles the colour. */
export const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--jt-c${i + 1})`);
export const SHAPES = ["circle", "square", "diamond", "triangle"] as const;
export type Shape = (typeof SHAPES)[number];

export function Mark({ shape, x, y, r = 4, fill, stroke, dash, strokeWidth = 1.2 }: { shape: Shape | "cross"; x: number; y: number; r?: number; fill: string; stroke?: string; dash?: string | undefined; strokeWidth?: number }) {
  const common = { style: { fill, stroke: stroke ?? fill }, strokeWidth, strokeDasharray: dash };
  if (shape === "square") return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} {...common} />;
  if (shape === "diamond") return <path d={`M${x},${y - r * 1.3}L${x + r * 1.3},${y}L${x},${y + r * 1.3}L${x - r * 1.3},${y}Z`} {...common} />;
  if (shape === "triangle") return <path d={`M${x},${y - r * 1.25}L${x + r * 1.2},${y + r}L${x - r * 1.2},${y + r}Z`} {...common} />;
  if (shape === "cross") return <path d={`M${x - r},${y - r}L${x + r},${y + r}M${x - r},${y + r}L${x + r},${y - r}`} style={{ stroke: stroke ?? fill, fill: "none" }} strokeWidth={2} />;
  return <circle cx={x} cy={y} r={r} {...common} />;
}

// --- effect-size bars ------------------------------------------------------------------------------------------

export interface EffectRow {
  id: string;
  label: string;
  sub?: string | undefined;
  value: number | null;
  /** Shown instead of a bar when the value is not available (never a zero-length bar). */
  missing?: string | undefined;
  tooltip: string;
  selected?: boolean | undefined;
  /** Second, hatched bar (e.g. the other response space), with its own label. */
  compare?: { value: number | null; missing?: string | undefined; tooltip: string } | undefined;
}

/** Horizontal bars on a fixed domain (0–1 for shares, −1–1 for signed coefficients) with direct value labels. */
export function EffectBars({ rows, domain, fmt, landmarks, axisLabel, title, onSelect, labels }: {
  rows: readonly EffectRow[];
  domain: [number, number];
  fmt: (v: number) => string;
  landmarks?: readonly number[] | undefined;
  axisLabel: string;
  title: string;
  onSelect?: ((id: string) => void) | undefined;
  /** Legend of the two bars when rows carry `compare`. */
  labels?: [string, string] | undefined;
}) {
  if (!rows.length) return null;
  const paired = rows.some((r) => r.compare);
  const labelW = Math.min(220, Math.max(...rows.map((r) => Math.max(textWidth(r.label, 12.5), r.sub ? textWidth(r.sub, 10.5) : 0))) + 12);
  const rowH = paired ? 46 : 30;
  return (
    <div>
      <Responsive min={320}>
        {(width) => {
          const pad = { l: labelW, r: 96, t: 6, b: 34 };
          const h = pad.t + rows.length * rowH + pad.b;
          const x = linear(domain[0], domain[1], pad.l, width - pad.r);
          const zero = x(Math.max(domain[0], Math.min(domain[1], 0)));
          const ticks = niceTicks(domain[0], domain[1], 5);
          const bar = (v: number | null, missing: string | undefined, y: number, hb: number, cls: string, tip: string) =>
            v === null ? (
              <text x={zero + 4} y={y + hb / 2 + 4} className="jt-missing">{missing ?? "—"}<title>{tip}</title></text>
            ) : (
              <g>
                <rect x={Math.min(zero, x(v))} y={y} width={Math.max(1.5, Math.abs(x(v) - zero))} height={hb} className={cls}><title>{tip}</title></rect>
                <text x={(v >= 0 ? Math.max(zero, x(v)) + 5 : Math.min(zero, x(v)) - 5)} y={y + hb / 2 + 4} textAnchor={v >= 0 ? "start" : "end"} className="jt-value">{fmt(v)}</text>
              </g>
            );
          return (
            <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${title}: ${rows.map((r) => `${r.label} ${r.value === null ? (r.missing ?? "—") : fmt(r.value)}`).join("; ")}`}>
              <title>{title}</title>
              {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={pad.t} y2={h - pad.b} className="cz-grid" /><text x={x(t)} y={h - pad.b + 14} textAnchor="middle" className="cz-t-axis">{defaultFmt(t)}</text></g>)}
              {(landmarks ?? []).map((l) => <g key={`lm${l}`}><line x1={x(l)} x2={x(l)} y1={pad.t} y2={h - pad.b} className="jt-landmark" /><text x={x(l)} y={pad.t + 9} dx={3} className="jt-landmark-t">{defaultFmt(l)}</text></g>)}
              <line x1={zero} x2={zero} y1={pad.t} y2={h - pad.b} className="jt-zero" />
              {rows.map((r, i) => {
                const y = pad.t + i * rowH;
                const hb = paired ? 15 : 16;
                return (
                  <g key={r.id} className={`jt-row${r.selected ? " jt-row-sel" : ""}${onSelect ? " jt-clickable" : ""}`} onClick={onSelect ? () => onSelect(r.id) : undefined} tabIndex={onSelect ? 0 : undefined} role={onSelect ? "button" : undefined} aria-pressed={onSelect ? !!r.selected : undefined} onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.id); } } : undefined}>
                    <rect x={0} y={y} width={width} height={rowH} className="jt-row-bg" />
                    <text x={pad.l - 8} y={y + (r.sub ? 13 : rowH / 2 + 4)} textAnchor="end" className="jt-label">{r.label}</text>
                    {r.sub ? <text x={pad.l - 8} y={y + 26} textAnchor="end" className="jt-sub">{r.sub}</text> : null}
                    {bar(r.value, r.missing, y + 6, hb, "jt-bar", r.tooltip)}
                    {r.compare ? bar(r.compare.value, r.compare.missing, y + 6 + hb + 3, hb, "jt-bar jt-bar-b", r.compare.tooltip) : null}
                  </g>
                );
              })}
              <text x={(pad.l + width - pad.r) / 2} y={h - 4} textAnchor="middle" className="cz-t-axis">{axisLabel}</text>
            </svg>
          );
        }}
      </Responsive>
      {paired && labels ? <Legend items={[{ label: labels[0], color: "var(--jt-bar-a)" }, { label: labels[1], color: "var(--jt-bar-b)" }]} /> : null}
    </div>
  );
}

// --- per-unit strip with box ------------------------------------------------------------------------------------

export interface GroupPoints {
  id: string;
  label: string;
  values: readonly number[];
  /** Tooltip per value (same order). */
  tips?: readonly string[] | undefined;
}

const q = (sorted: readonly number[], p: number) => {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo]! + (sorted[Math.min(sorted.length - 1, lo + 1)]! - sorted[lo]!) * (h - lo);
};

/** Horizontal box (quartiles, min–max whiskers) per group with every unit drawn as a jittered point. */
export function GroupStrip({ groups, axisLabel, title, fmt = defaultFmt }: { groups: readonly GroupPoints[]; axisLabel: string; title: string; fmt?: Fmt }) {
  const used = groups.filter((g) => g.values.length);
  if (!used.length) return <EmptyState>—</EmptyState>;
  const ext = extent(used.flatMap((g) => g.values), 0.05)!;
  const labelW = Math.min(200, Math.max(...used.map((g) => textWidth(`${g.label}`, 12.5)), textWidth("n = 0000", 10.5)) + 12);
  const rowH = 40;
  return (
    <Responsive min={300}>
      {(width) => {
        const pad = { l: labelW, r: 14, t: 6, b: 34 };
        const h = pad.t + used.length * rowH + pad.b;
        const x = linear(ext[0], ext[1], pad.l, width - pad.r);
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${title}: ${used.map((g) => `${g.label} n = ${g.values.length}`).join(", ")}`}>
            <title>{title}</title>
            {niceTicks(ext[0], ext[1], 6).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={pad.t} y2={h - pad.b} className="cz-grid" /><text x={x(t)} y={h - pad.b + 14} textAnchor="middle" className="cz-t-axis">{fmt(t)}</text></g>)}
            {used.map((g, i) => {
              const s = [...g.values].sort((a, b) => a - b);
              const y = pad.t + i * rowH + rowH / 2;
              const [q1, med, q3] = [q(s, 0.25), q(s, 0.5), q(s, 0.75)];
              const color = PALETTE[i % PALETTE.length]!;
              return (
                <g key={g.id}>
                  <text x={pad.l - 8} y={y - 2} textAnchor="end" className="jt-label">{g.label}</text>
                  <text x={pad.l - 8} y={y + 11} textAnchor="end" className="jt-sub">n = {g.values.length}</text>
                  <line x1={x(s[0]!)} x2={x(s[s.length - 1]!)} y1={y} y2={y} className="jt-whisker" />
                  <rect x={x(q1)} y={y - 9} width={Math.max(1, x(q3) - x(q1))} height={18} className="jt-box"><title>{`${g.label}: min ${fmt(s[0]!)}, Q1 ${fmt(q1)}, median ${fmt(med)}, Q3 ${fmt(q3)}, max ${fmt(s[s.length - 1]!)} (n = ${s.length})`}</title></rect>
                  <line x1={x(med)} x2={x(med)} y1={y - 9} y2={y + 9} className="jt-median" />
                  {g.values.map((v, k) => {
                    const jitter = (((k * 7919) % 13) / 12 - 0.5) * 14;
                    return <circle key={k} cx={x(v)} cy={y + jitter} r={2.6} style={{ fill: color }} className="jt-point"><title>{g.tips?.[k] ?? fmt(v)}</title></circle>;
                  })}
                </g>
              );
            })}
            <text x={(pad.l + width - pad.r) / 2} y={h - 4} textAnchor="middle" className="cz-t-axis">{axisLabel}</text>
          </svg>
        );
      }}
    </Responsive>
  );
}

// --- ECDF per group ----------------------------------------------------------------------------------------------

export function GroupEcdf({ groups, axisLabel, title, fmt = defaultFmt }: { groups: readonly GroupPoints[]; axisLabel: string; title: string; fmt?: Fmt }) {
  const used = groups.filter((g) => g.values.length);
  if (!used.length) return null;
  const ext = extent(used.flatMap((g) => g.values), 0.04)!;
  const dashes = [undefined, "6 3", "2 3", "8 3 2 3"];
  return (
    <div>
      <Responsive min={280}>
        {(width) => {
          const height = 220;
          const pad = { l: 44, r: 12, t: 10, b: 40 };
          const x = linear(ext[0], ext[1], pad.l, width - pad.r);
          const y = linear(0, 1, height - pad.b, pad.t);
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${title}: ${used.map((g) => `${g.label} (n = ${g.values.length})`).join(", ")}`}>
              <title>{title}</title>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" /><text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{t * 100} %</text></g>)}
              {niceTicks(ext[0], ext[1], 5).map((t) => <text key={t} x={x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{fmt(t)}</text>)}
              {used.map((g, i) => {
                const s = [...g.values].sort((a, b) => a - b);
                let d = `M${x(ext[0])},${y(0)}`;
                s.forEach((v, k) => (d += `H${x(v)}V${y((k + 1) / s.length)}`));
                d += `H${width - pad.r}`;
                return <path key={g.id} d={d} fill="none" style={{ stroke: PALETTE[i % PALETTE.length] }} strokeWidth={2} strokeDasharray={dashes[i % dashes.length]}><title>{`${g.label} (n = ${s.length})`}</title></path>;
              })}
              <text x={(pad.l + width - pad.r) / 2} y={height - 4} textAnchor="middle" className="cz-t-axis">{axisLabel}</text>
            </svg>
          );
        }}
      </Responsive>
      <Legend items={used.map((g, i) => ({ label: `${g.label} (n = ${g.values.length})`, color: PALETTE[i % PALETTE.length], kind: "line" as const }))} />
    </div>
  );
}

// --- scatter with optional trend line ---------------------------------------------------------------------------

export interface ScatterDatum {
  x: number;
  y: number;
  group: string | null;
  tip: string;
}

/** Least-squares line y = a + b·x (descriptive only); null when x is constant or fewer than two points. */
export function leastSquares(points: readonly { x: number; y: number }[]): { a: number; b: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

export function TrendScatter({ points, xLabel, yLabel, title, trend, fmt = defaultFmt }: { points: readonly ScatterDatum[]; xLabel: string; yLabel: string; title: string; trend: boolean; fmt?: Fmt }) {
  if (!points.length) return null;
  const groups = [...new Set(points.map((p) => p.group).filter((g): g is string => g !== null))].sort();
  const gi = (g: string | null) => (g === null ? -1 : groups.indexOf(g));
  const ex = extent(points.map((p) => p.x), 0.05)!;
  const ey = extent(points.map((p) => p.y), 0.08)!;
  const line = trend ? leastSquares(points) : null;
  return (
    <div>
      <Responsive min={280}>
        {(width) => {
          const height = 280;
          const pad = { l: 52, r: 14, t: 10, b: 42 };
          const x = linear(ex[0], ex[1], pad.l, width - pad.r);
          const y = linear(ey[0], ey[1], height - pad.b, pad.t);
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${title}: ${points.length} units`}>
              <title>{title}</title>
              {niceTicks(ey[0], ey[1], 5).map((t) => <g key={`y${t}`}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" /><text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{fmt(t)}</text></g>)}
              {niceTicks(ex[0], ex[1], 6).map((t) => <text key={`x${t}`} x={x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{fmt(t)}</text>)}
              {line ? <line x1={x(ex[0])} x2={x(ex[1])} y1={y(line.a + line.b * ex[0])} y2={y(line.a + line.b * ex[1])} className="jt-trend"><title>{`y = ${fmt(line.a)} + ${fmt(line.b)}·x (least squares, descriptive)`}</title></line> : null}
              {points.map((p, i) => {
                const k = gi(p.group);
                return <g key={i}><Mark shape={k < 0 ? "circle" : SHAPES[k % SHAPES.length]!} x={x(p.x)} y={y(p.y)} r={3.4} fill={k < 0 ? "var(--cz-ink-3)" : PALETTE[k % PALETTE.length]!} /><title>{p.tip}</title></g>;
              })}
              <text x={(pad.l + width - pad.r) / 2} y={height - 4} textAnchor="middle" className="cz-t-axis">{xLabel}</text>
              <text transform={`translate(12 ${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-axis">{yLabel}</text>
            </svg>
          );
        }}
      </Responsive>
      {groups.length ? <ShapeLegend items={groups.map((g, i) => ({ label: g, shape: SHAPES[i % SHAPES.length]!, color: PALETTE[i % PALETTE.length]! }))} /> : null}
    </div>
  );
}

export function ShapeLegend({ items, title }: { items: readonly { label: ReactNode; shape: Shape | "cross"; color: string; dash?: string; hollow?: boolean; ring?: boolean }[]; title?: string }) {
  return (
    <ul className="cz-legend jt-shape-legend" aria-label={title}>
      {title ? <li className="jt-legend-title">{title}</li> : null}
      {items.map((it, i) => (
        <li key={i}>
          <svg width={18} height={18} aria-hidden="true">
            {it.ring ? <circle cx={9} cy={9} r={8} fill="none" style={{ stroke: "var(--cz-ink)" }} strokeWidth={1.4} /> : null}
            <Mark shape={it.shape} x={9} y={9} r={4.5} fill={it.hollow ? "var(--cz-surface)" : it.color} stroke={it.color} dash={it.dash} strokeWidth={1.6} />
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// --- p-value dot plot (log axis) ---------------------------------------------------------------------------------

export interface PRow {
  id: string;
  label: string;
  raw: number | null;
  adjusted: number | null;
  /** Shown instead of a dot when no p-value exists. */
  missing?: string | undefined;
}

export function PValueDots({ rows, alpha, title, labels }: { rows: readonly PRow[]; alpha: number | null; title: string; labels: { raw: string; adjusted: string; axis: string } }) {
  const [adjusted, setAdjusted] = useState(true);
  if (!rows.length) return null;
  const pick = (r: PRow) => (adjusted ? r.adjusted : r.raw);
  const lo = Math.min(1e-3, ...rows.map(pick).filter((v): v is number => v !== null && v > 0));
  const d0 = Math.floor(Math.log10(lo));
  const labelW = Math.min(240, Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 12);
  return (
    <div>
      <div className="jt-toggle" role="group" aria-label={title}>
        <button type="button" className={`btn btn-sm ${adjusted ? "btn-primary" : "btn-ghost"}`} aria-pressed={adjusted} onClick={() => setAdjusted(true)}>{labels.adjusted}</button>
        <button type="button" className={`btn btn-sm ${!adjusted ? "btn-primary" : "btn-ghost"}`} aria-pressed={!adjusted} onClick={() => setAdjusted(false)}>{labels.raw}</button>
      </div>
      <Responsive min={300}>
        {(width) => {
          const rowH = 24;
          const pad = { l: labelW, r: 70, t: 6, b: 34 };
          const h = pad.t + rows.length * rowH + pad.b;
          const x = linear(d0, 0, pad.l, width - pad.r);
          const lx = (p: number) => x(Math.log10(Math.max(p, 10 ** d0)));
          return (
            <svg className="cz-svg" width={width} height={h} role="img" aria-label={title}>
              <title>{title}</title>
              {Array.from({ length: -d0 + 1 }, (_, i) => d0 + i).map((e) => <g key={e}><line x1={x(e)} x2={x(e)} y1={pad.t} y2={h - pad.b} className="cz-grid" /><text x={x(e)} y={h - pad.b + 14} textAnchor="middle" className="cz-t-axis">{defaultFmt(10 ** e)}</text></g>)}
              {alpha !== null ? <g><line x1={lx(alpha)} x2={lx(alpha)} y1={pad.t} y2={h - pad.b} className="jt-alpha" /><text x={lx(alpha) + 4} y={pad.t + 10} className="jt-landmark-t">α = {alpha}</text></g> : null}
              {rows.map((r, i) => {
                const y = pad.t + i * rowH + rowH / 2;
                const v = pick(r);
                return (
                  <g key={r.id}>
                    <text x={pad.l - 8} y={y + 4} textAnchor="end" className="jt-label">{r.label}</text>
                    {v === null ? <text x={pad.l + 4} y={y + 4} className="jt-missing">{r.missing ?? "—"}</text> : (
                      <g>
                        <line x1={pad.l} x2={lx(v)} y1={y} y2={y} className="jt-stem" />
                        <Mark shape={alpha !== null && v <= alpha ? "diamond" : "circle"} x={lx(v)} y={y} r={4.5} fill={alpha !== null && v <= alpha ? "var(--cz-copper)" : "var(--cz-surface)"} stroke="var(--cz-ink-2)" />
                        <text x={lx(v) + 9} y={y + 4} className="jt-value">{defaultFmt(v)}</text>
                        <title>{`${r.label}: ${labels.raw} ${r.raw === null ? "—" : defaultFmt(r.raw)}, ${labels.adjusted} ${r.adjusted === null ? "—" : defaultFmt(r.adjusted)}`}</title>
                      </g>
                    )}
                  </g>
                );
              })}
              <text x={(pad.l + width - pad.r) / 2} y={h - 4} textAnchor="middle" className="cz-t-axis">{labels.axis}</text>
            </svg>
          );
        }}
      </Responsive>
    </div>
  );
}
