// Horizontal bar charts of the kit: proportion bars (docx image1), value bars (image2), stacked share bar.
import type { ReactNode } from "react";
import { EmptyState, Legend, Responsive, toneClass, type Tone } from "./frame";
import { defaultFmt, niceTicks, share, textWidth, type Fmt } from "./scale";

export type GlyphKind = "peak" | "jump";

/** Illustrative (simulated) anomaly shape: a smooth baseline with an isolated peak or an abrupt level change. */
export function AnomalyGlyph({ kind, width = 64, height = 22, tone }: { kind: GlyphKind; width?: number; height?: number; tone?: Tone }) {
  const n = 40;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let y = 0.55 - 0.18 * Math.sin(t * Math.PI * 1.6);
    if (kind === "jump" && t > 0.52) y -= 0.32;
    pts.push(`${(t * width).toFixed(1)},${(y * height).toFixed(1)}`);
    if (kind === "peak" && i === Math.round(n * 0.5)) pts.push(`${(t * width + 0.8).toFixed(1)},${(0.04 * height).toFixed(1)}`, `${(t * width + 1.6).toFixed(1)},${(y * height).toFixed(1)}`);
  }
  return (
    <svg className={`cz-svg ${toneClass(tone, kind === "peak" ? "copper" : "teal")}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={kind === "peak" ? "Illustrative isolated peak shape (simulated)" : "Illustrative abrupt jump shape (simulated)"}>
      <polyline points={pts.join(" ")} className="cz-stroke" strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}

/** Small "Illustrative shapes (simulated)" panel showing the peak and the jump side by side. */
export function AnomalyShapes({ kinds = ["peak", "jump"], width = 150 }: { kinds?: readonly GlyphKind[]; width?: number }) {
  return (
    <figure className="cz-shapes" style={{ margin: 0 }}>
      <figcaption className="cz-card-foot" style={{ marginTop: 0 }}>Illustrative shapes (simulated)</figcaption>
      {kinds.map((k) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--cz-ink-2)", minWidth: 40 }}>{k === "peak" ? "Peak" : "Jump"}</span>
          <AnomalyGlyph kind={k} width={width} height={26} />
        </div>
      ))}
    </figure>
  );
}

export interface ProportionRow {
  label: string;
  count: number;
  glyph?: GlyphKind | undefined;
  tone?: Tone | undefined;
}

/** Share of a total per row: filled bar with a direct % label over a light 0–100 % track (docx image1). */
export function ProportionBars({ title, total, rows, fmt = defaultFmt, unitLabel = "spectra", emptyMessage, showAxis = true }: {
  title?: ReactNode | undefined;
  total: number;
  rows: readonly ProportionRow[];
  fmt?: Fmt | undefined;
  /** Noun of the total, used in labels ("spectra"). */
  unitLabel?: string | undefined;
  /** Shown instead of the chart when the total is 0. */
  emptyMessage?: ReactNode | undefined;
  showAxis?: boolean | undefined;
}) {
  if (!(total > 0) || !rows.length) return <EmptyState>{emptyMessage ?? `No ${unitLabel} to count.`}</EmptyState>;
  const hasGlyph = rows.some((r) => r.glyph);
  const labelW = Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 12 + (hasGlyph ? 44 : 0);
  const rowH = 30;
  const top = title ? 26 : 4;
  const axisH = showAxis ? 22 : 4;
  return (
    <Responsive min={260}>
      {(width) => {
        const x0 = labelW;
        const x1 = width - 8;
        const iw = Math.max(40, x1 - x0);
        const h = top + rows.length * rowH + axisH;
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${typeof title === "string" ? `${title}: ` : ""}${rows.map((r) => `${r.label} ${r.count} of ${total} (${fmt(share(r.count, total) ?? 0)} %)`).join(", ")}`}>
            {title ? <text x={x0} y={16} className="cz-t-strong" style={{ fontSize: 13.5 }}>{title}</text> : null}
            {rows.map((r, i) => {
              const y = top + i * rowH;
              const p = share(r.count, total) ?? 0;
              const fw = (iw * Math.min(100, p)) / 100;
              const label = `${fmt(p, 3)} %`;
              const inside = fw > textWidth(label, 12.5) + 12 && fw > iw * 0.6;
              return (
                <g key={r.label} className={toneClass(r.tone)}>
                  <title>{`${r.label}: ${r.count} of ${total} ${unitLabel} (${fmt(p, 3)} %)`}</title>
                  <text x={x0 - 8 - (r.glyph ? 44 : 0)} y={y + rowH / 2 + 4} textAnchor="end" className="cz-t-label">{r.label}</text>
                  {r.glyph ? <g transform={`translate(${x0 - 46},${y + 6})`}><AnomalyGlyphInline kind={r.glyph} /></g> : null}
                  <rect x={x0} y={y + 6} width={iw} height={rowH - 12} rx={3} className="cz-track" />
                  {fw > 0 ? <rect x={x0} y={y + 6} width={Math.max(2, fw)} height={rowH - 12} rx={3} className="cz-fill" /> : null}
                  <text x={inside ? x0 + fw - 6 : x0 + fw + 6} y={y + rowH / 2 + 4} textAnchor={inside ? "end" : "start"} className="cz-t-strong" style={{ fontSize: 12.5, fill: inside ? "#fff" : undefined }}>{label}</text>
                  <text x={x1} y={y + rowH / 2 + 4} textAnchor="end" className="cz-t-axis">{r.count}/{total}</text>
                </g>
              );
            })}
            {showAxis ? [0, 25, 50, 75, 100].map((t) => (
              <text key={t} x={x0 + (iw * t) / 100} y={h - 6} textAnchor={t === 0 ? "start" : t === 100 ? "end" : "middle"} className="cz-t-axis">{t} %</text>
            )) : null}
          </svg>
        );
      }}
    </Responsive>
  );
}

/** Glyph drawn inside an SVG (no nested <svg> role). */
function AnomalyGlyphInline({ kind }: { kind: GlyphKind }) {
  const w = 38;
  const h = 18;
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    let y = 0.6 - 0.18 * Math.sin(t * Math.PI * 1.6);
    if (kind === "jump" && t > 0.52) y -= 0.36;
    pts.push(`${(t * w).toFixed(1)},${(y * h).toFixed(1)}`);
    if (kind === "peak" && i === 12) pts.push(`${(t * w + 0.7).toFixed(1)},0`, `${(t * w + 1.4).toFixed(1)},${(y * h).toFixed(1)}`);
  }
  return <polyline points={pts.join(" ")} className={`cz-stroke ${toneClass(undefined, kind === "peak" ? "copper" : "teal")}`} strokeWidth={1.6} aria-hidden="true" />;
}

export interface ValueRow {
  label: string;
  value: number | null;
  tone?: Tone | undefined;
  /** Optional text after the value (e.g. "median over spectra"). */
  note?: string | undefined;
}

/** Horizontal value bars on one shared scale from 0 with direct value labels and a unit (docx image2). */
export function ValueBars({ rows, unit = "", axisLabel, fmt = defaultFmt, digits = 4, title, emptyMessage }: {
  rows: readonly ValueRow[];
  unit?: string | undefined;
  axisLabel?: string | undefined;
  fmt?: Fmt | undefined;
  digits?: number | undefined;
  title?: ReactNode | undefined;
  emptyMessage?: ReactNode | undefined;
}) {
  const finite = rows.filter((r) => r.value !== null && Number.isFinite(r.value));
  if (!finite.length) return <EmptyState>{emptyMessage ?? "No value available."}</EmptyState>;
  const max = Math.max(...finite.map((r) => Math.abs(r.value!)), 1e-300);
  const ticks = niceTicks(0, max, 4);
  const hi = Math.max(max, ticks[ticks.length - 1] ?? max);
  const labelW = Math.max(...rows.map((r) => textWidth(r.label, 12.5))) + 12;
  const rowH = 32;
  const top = title ? 26 : 4;
  const axisH = axisLabel ? 38 : 22;
  return (
    <Responsive min={260}>
      {(width) => {
        const x0 = labelW;
        // Room for the longest direct label, e.g. "3.018 signal units".
        const valueW = Math.max(96, ...rows.map((r) => (r.value === null ? 0 : textWidth(`${fmt(r.value, digits)} ${unit}`, 12.5) + 14)));
        const iw = Math.max(40, width - x0 - valueW);
        const h = top + rows.length * rowH + axisH;
        const sx = (v: number) => x0 + (iw * Math.abs(v)) / hi;
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={rows.map((r) => `${r.label}: ${r.value === null ? "not available" : `${fmt(r.value, digits)} ${unit}`}`).join(", ")}>
            {title ? <text x={x0} y={16} className="cz-t-strong" style={{ fontSize: 13.5 }}>{title}</text> : null}
            {ticks.map((t) => <line key={t} x1={sx(t)} x2={sx(t)} y1={top} y2={top + rows.length * rowH} className="cz-grid" />)}
            {rows.map((r, i) => {
              const y = top + i * rowH;
              const v = r.value;
              return (
                <g key={r.label} className={toneClass(r.tone, i === 0 ? "copper" : "muted")}>
                  <title>{`${r.label}: ${v === null ? "not available" : `${fmt(v, digits)} ${unit}`}${r.note ? ` (${r.note})` : ""}`}</title>
                  <text x={x0 - 8} y={y + rowH / 2 + 4} textAnchor="end" className="cz-t-label">{r.label}</text>
                  {v !== null && Number.isFinite(v) ? <rect x={x0} y={y + 7} width={Math.max(2, sx(v) - x0)} height={rowH - 14} rx={3} className="cz-fill" /> : null}
                  <text x={(v !== null && Number.isFinite(v) ? sx(v) : x0) + 6} y={y + rowH / 2 + 4} className="cz-t-strong" style={{ fontSize: 12.5 }}>{v === null || !Number.isFinite(v) ? "n/a" : `${fmt(v, digits)}${unit ? ` ${unit}` : ""}`}</text>
                </g>
              );
            })}
            <line x1={x0} x2={x0 + iw} y1={top + rows.length * rowH} y2={top + rows.length * rowH} className="cz-axis-line" />
            {ticks.map((t) => <text key={t} x={sx(t)} y={top + rows.length * rowH + 15} textAnchor="middle" className="cz-t-axis">{fmt(t, 3)}</text>)}
            {axisLabel ? <text x={x0 + iw / 2} y={h - 4} textAnchor="middle" className="cz-t-axis">{axisLabel}</text> : null}
          </svg>
        );
      }}
    </Responsive>
  );
}

export interface ShareSegment {
  label: string;
  value: number;
  tone?: Tone | undefined;
  color?: string | undefined;
  /** Grey hatch, e.g. "not evaluable". */
  hatch?: boolean | undefined;
}

/** One stacked bar of shares with a legend giving count and percentage of every segment. */
export function StackedShareBar({ segments, total, fmt = defaultFmt, label, showLegend = true }: { segments: readonly ShareSegment[]; total?: number; fmt?: Fmt; label?: string; showLegend?: boolean }) {
  const sum = total ?? segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (!(sum > 0)) return <EmptyState>Nothing to show.</EmptyState>;
  const text = segments.map((s) => `${s.label} ${fmt(s.value)} (${fmt(share(s.value, sum) ?? 0, 3)} %)`).join(", ");
  return (
    <div>
      <div className="cz-share" role="img" aria-label={label ? `${label}: ${text}` : text}>
        {segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} className={s.hatch ? "cz-hatch" : toneClass(s.tone, "grey")} style={{ flex: s.value, ...(s.color && !s.hatch ? { background: s.color } : {}) }} title={`${s.label}: ${fmt(s.value)} (${fmt(share(s.value, sum) ?? 0, 3)} %)`} />
        ))}
      </div>
      {showLegend ? <Legend items={segments.map((s) => ({ label: s.label, ...(s.tone ? { tone: s.tone } : {}), ...(s.color ? { color: s.color } : {}), kind: s.hatch ? "hatch" as const : "box" as const, value: `${fmt(s.value)} · ${fmt(share(s.value, sum) ?? 0, 3)} %` }))} /> : null}
    </div>
  );
}
