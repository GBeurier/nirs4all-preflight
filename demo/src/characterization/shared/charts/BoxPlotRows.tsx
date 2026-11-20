// Horizontal box-plot rows on one shared axis (chat §4 "Empirical NIR spectral noise benchmark"):
// whiskers lo–hi (e.g. P5–P95), interquartile box, median bar, row count, and an optional dashed
// reference line (e.g. the analysed dataset). Values are drawn as given; nothing is estimated here.
import type { ReactNode } from "react";
import { EmptyState, Legend, Responsive } from "./frame";
import { defaultFmt, extent, linear, niceTicks, textWidth, type Fmt } from "./scale";

export interface BoxStats {
  /** Lower whisker (e.g. P5 or min). */
  lo: number;
  q1: number;
  median: number;
  q3: number;
  /** Upper whisker (e.g. P95 or max). */
  hi: number;
}

export interface BoxRow {
  label: string;
  /** Second label line (e.g. instrument or matrix). */
  sub?: string | undefined;
  stats: BoxStats;
  /** Number of values summarised by the box. */
  n?: number | undefined;
  emphasis?: boolean | undefined;
}

export const boxStatsValid = (b: BoxStats) => [b.lo, b.q1, b.median, b.q3, b.hi].every(Number.isFinite) && b.lo <= b.q1 && b.q1 <= b.median && b.median <= b.q3 && b.q3 <= b.hi;

export function BoxPlotRows({ rows, reference, axisLabel, domain, fmt = defaultFmt, digits = 3, reversed = false, ends, title, emptyMessage, whiskerLabel = "P5–P95", referenceLegend }: {
  rows: readonly BoxRow[];
  /** Vertical dashed line with a bold label under the axis. */
  reference?: { value: number; label: string } | null | undefined;
  axisLabel?: string | undefined;
  domain?: [number, number] | undefined;
  fmt?: Fmt | undefined;
  digits?: number | undefined;
  /** Draw the largest value on the left. */
  reversed?: boolean | undefined;
  /** Direction caption under the axis. */
  ends?: { left: string; right: string } | undefined;
  title: string;
  emptyMessage?: ReactNode | undefined;
  /** Legend text of the whiskers. */
  whiskerLabel?: string | undefined;
  /** Legend text of the reference line (default: its label). */
  referenceLegend?: string | undefined;
}) {
  const valid = rows.filter((r) => boxStatsValid(r.stats));
  if (!valid.length) return <EmptyState>{emptyMessage ?? "No distribution to show."}</EmptyState>;
  const ref = reference && Number.isFinite(reference.value) ? reference : null;
  const ext = domain ?? extent([...valid.flatMap((r) => [r.stats.lo, r.stats.hi]), ...(ref ? [ref.value] : [])], 0.06)!;
  const ticks = niceTicks(ext[0], ext[1], 6);
  const d0 = Math.min(ext[0], ticks[0] ?? ext[0]);
  const d1 = Math.max(ext[1], ticks[ticks.length - 1] ?? ext[1]);
  const labelW = Math.min(240, Math.max(...valid.map((r) => Math.max(textWidth(r.label, 12.5), r.sub || r.n !== undefined ? textWidth(`${r.sub ? `${r.sub} · ` : ""}n = ${r.n ?? ""}`, 10.5) : 0))) + 14);
  const rowH = 38;
  return (
    <div className="cz-boxplot">
      <Responsive min={320}>
        {(width) => {
          const r0 = labelW + 8;
          const r1 = width - 16;
          const x = reversed ? linear(d0, d1, r1, r0) : linear(d0, d1, r0, r1);
          const top = 6;
          const plotH = valid.length * rowH;
          const axisY = top + plotH;
          const h = axisY + 18 + (ref ? 18 : 0) + (axisLabel ? 16 : 0) + (ends ? 18 : 0);
          let y = axisY + 18;
          const refY = ref ? (y += 18) - 4 : 0;
          const labelY = axisLabel ? (y += 16) - 4 : 0;
          const endsY = ends ? (y += 18) - 4 : 0;
          return (
            <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${title}: ${valid.map((r) => `${r.label}${r.n !== undefined ? ` (n = ${r.n})` : ""} median ${fmt(r.stats.median, digits)}, interquartile ${fmt(r.stats.q1, digits)}–${fmt(r.stats.q3, digits)}, ${whiskerLabel} ${fmt(r.stats.lo, digits)}–${fmt(r.stats.hi, digits)}`).join("; ")}${ref ? `; ${ref.label}` : ""}`}>
              {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={top} y2={axisY} className="cz-grid" />)}
              {valid.map((r, i) => {
                const cy = top + i * rowH + rowH / 2;
                const s = r.stats;
                const [xl, xh] = [x(s.lo), x(s.hi)].sort((a, b) => a - b) as [number, number];
                const [xq1, xq3] = [x(s.q1), x(s.q3)].sort((a, b) => a - b) as [number, number];
                return (
                  <g key={r.label + i}>
                    <title>{`${r.label}${r.sub ? ` — ${r.sub}` : ""}${r.n !== undefined ? ` (n = ${r.n})` : ""}: median ${fmt(s.median, digits)}; P25–P75 ${fmt(s.q1, digits)}–${fmt(s.q3, digits)}; ${whiskerLabel} ${fmt(s.lo, digits)}–${fmt(s.hi, digits)}`}</title>
                    <text x={labelW} y={r.sub || r.n !== undefined ? cy - 2 : cy + 4} textAnchor="end" className={r.emphasis ? "cz-t-strong" : "cz-t-label"} style={{ fontSize: 12.5 }}>{r.label.length > 34 ? `${r.label.slice(0, 32)}…` : r.label}</text>
                    {r.sub || r.n !== undefined ? <text x={labelW} y={cy + 11} textAnchor="end" className="cz-t-axis" style={{ fontSize: 10.5 }}>{`${r.sub ? `${r.sub} · ` : ""}${r.n !== undefined ? `n = ${r.n}` : ""}`}</text> : null}
                    <line x1={xl} x2={xh} y1={cy} y2={cy} className="cz-box-whisker" />
                    <line x1={xl} x2={xl} y1={cy - 6} y2={cy + 6} className="cz-box-whisker" />
                    <line x1={xh} x2={xh} y1={cy - 6} y2={cy + 6} className="cz-box-whisker" />
                    <rect x={xq1} y={cy - 10} width={Math.max(1, xq3 - xq1)} height={20} rx={2} className="cz-box-iqr" />
                    <line x1={x(s.median)} x2={x(s.median)} y1={cy - 10} y2={cy + 10} className="cz-box-median" />
                  </g>
                );
              })}
              <line x1={r0} x2={r1} y1={axisY} y2={axisY} className="cz-axis-line" />
              {ticks.map((t) => <text key={t} x={x(t)} y={axisY + 14} textAnchor="middle" className="cz-t-axis">{fmt(t, 4)}</text>)}
              {ref ? (
                <g>
                  <line x1={x(ref.value)} x2={x(ref.value)} y1={top - 4} y2={axisY + 2} className="cz-box-ref" />
                  <text x={Math.min(r1 - 20, Math.max(r0 + 20, x(ref.value)))} y={refY} textAnchor="middle" className="cz-t-strong cz-box-ref-label" style={{ fontSize: 12 }}>{ref.label}</text>
                </g>
              ) : null}
              {axisLabel ? <text x={r1} y={labelY} textAnchor="end" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{axisLabel}</text> : null}
              {ends ? (
                <g className="cz-ends">
                  <text x={r0} y={endsY} className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>← {ends.left}</text>
                  <text x={r1} y={endsY} textAnchor="end" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{ends.right} →</text>
                </g>
              ) : null}
            </svg>
          );
        }}
      </Responsive>
      <Legend items={[
        { label: "Interquartile range (P25–P75), bar = median", color: "var(--cz-box)" },
        { label: `Whiskers: ${whiskerLabel}`, color: "var(--cz-box-line)", kind: "line" },
        ...(ref ? [{ label: referenceLegend ?? ref.label, color: "var(--cz-ref)", kind: "line" as const }] : []),
      ]} />
    </div>
  );
}
