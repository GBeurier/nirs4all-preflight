// Banded linear gauge with two tick scales (docx image3: dB on top of the ticks, % relative noise below).
// `reversed` draws `max` on the left (e.g. high dB = less noise on the left); `ends` adds a direction caption.
import { Responsive, toneClass, type Tone } from "./frame";
import { clamp, linear } from "./scale";

export interface GaugeBand {
  from: number;
  to: number;
  label?: string | undefined;
  tone?: Tone | undefined;
  /** Explicit CSS colour (overrides tone). */
  color?: string | undefined;
}

export interface GaugeTick {
  value: number;
  /** First tick line (e.g. "40" or "40 dB"). */
  top: string;
  /** Second tick line (e.g. "1 %"). */
  bottom?: string | undefined;
}

const DEFAULT_TONES: Tone[] = ["copper", "copper-2", "grey", "teal-2", "teal"];

/** Gauge: coloured bands, a marker with a bold label, and dual tick labels. Bands carry text labels (never colour alone). */
export function DualScaleGauge({ value, min, max, bands, ticks, markerLabel, ariaLabel, showBandLabels = true, height, range, reversed = false, ends }: {
  value: number | null;
  /** Optional thin bar under the scale, e.g. the per-spectrum P5–P95 interval. */
  range?: { from: number; to: number; label?: string } | null;
  min: number;
  max: number;
  bands: readonly GaugeBand[];
  ticks: readonly GaugeTick[];
  markerLabel?: string | undefined;
  ariaLabel: string;
  showBandLabels?: boolean | undefined;
  height?: number | undefined;
  /** Draw `max` on the left and `min` on the right. */
  reversed?: boolean | undefined;
  /** Direction caption under the scale, e.g. { left: "Less noise", right: "More noise" }. */
  ends?: { left: string; right: string } | undefined;
}) {
  return (
    <Responsive min={280}>
      {(width) => {
        const pad = 30;
        const x = reversed ? linear(min, max, width - pad, pad) : linear(min, max, pad, width - pad);
        const top = markerLabel ? 34 : 10;
        const barY = top + 12;
        const barH = 18;
        const bandLabelY = barY + barH + 14;
        const rangeH = range ? 12 : 0;
        const tickY = barY + barH + (showBandLabels ? 32 : 16) + rangeH;
        const hasBottom = ticks.some((t) => t.bottom);
        const endsY = tickY + (hasBottom ? 34 : 18);
        const h = height ?? (ends ? endsY + 8 : tickY + (hasBottom ? 30 : 14));
        const v = value === null || !Number.isFinite(value) ? null : value;
        const mx = v === null ? null : x(clamp(v, min, max));
        const outside = v !== null && (v < min || v > max);
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={ariaLabel}>
            {bands.map((b, i) => {
              const xa = x(Math.max(min, b.from));
              const xb = x(Math.min(max, b.to));
              const x0 = Math.min(xa, xb);
              const x1 = Math.max(xa, xb);
              return (
                <g key={i} className={toneClass(b.tone ?? DEFAULT_TONES[i % DEFAULT_TONES.length])}>
                  <title>{`${b.label ?? ""} ${b.from}–${b.to}`.trim()}</title>
                  <rect x={x0} y={barY} width={Math.max(0, x1 - x0 - 1)} height={barH} className="cz-fill" rx={i === 0 || i === bands.length - 1 ? 3 : 0} style={b.color ? { fill: b.color } : undefined} />
                  {showBandLabels && b.label && x1 - x0 > b.label.length * 5.6 + 6 ? <text x={(x0 + x1) / 2} y={bandLabelY} textAnchor="middle" className="cz-t-axis" style={{ fontSize: 10.5 }}>{b.label}</text> : null}
                </g>
              );
            })}
            {range && Number.isFinite(range.from) && Number.isFinite(range.to) ? (() => {
              const ra = x(clamp(range.from, min, max));
              const rb = x(clamp(range.to, min, max));
              const ry = barY + barH + (showBandLabels ? 22 : 8);
              return (
                <g>
                  <title>{range.label ?? `${range.from}–${range.to}`}</title>
                  <line x1={Math.min(ra, rb)} x2={Math.max(ra, rb)} y1={ry} y2={ry} style={{ stroke: "var(--cz-ink-2)", strokeWidth: 3, strokeLinecap: "round" }} />
                  {range.label ? <text x={Math.max(ra, rb) + 6} y={ry + 4} className="cz-t-axis" style={{ fontSize: 10.5 }}>{range.label}</text> : null}
                </g>
              );
            })() : null}
            {ticks.map((t) => (
              <g key={t.value}>
                <line x1={x(t.value)} x2={x(t.value)} y1={barY + barH} y2={barY + barH + 4} className="cz-axis-line" />
                <text x={x(t.value)} y={tickY} textAnchor="middle" className="cz-t-axis">{t.top}</text>
                {t.bottom ? <text x={x(t.value)} y={tickY + 15} textAnchor="middle" className="cz-t-axis">{t.bottom}</text> : null}
              </g>
            ))}
            {mx !== null ? (
              <g>
                <path d={`M${mx - 6},${barY - 10} L${mx + 6},${barY - 10} L${mx},${barY - 2} Z`} style={{ fill: "var(--cz-cursor)" }} />
                <line x1={mx} x2={mx} y1={barY - 4} y2={barY + barH + 4} style={{ stroke: "var(--cz-cursor)", strokeWidth: 2.5 }} />
                {markerLabel ? <text x={clamp(mx, pad + 60, width - pad - 60)} y={top - 4} textAnchor="middle" className="cz-t-strong" style={{ fontSize: 15 }}>{markerLabel}{outside ? ((v! < min) !== reversed ? " ◂" : " ▸") : ""}</text> : null}
              </g>
            ) : null}
            {ends ? (
              <g className="cz-ends">
                <text x={pad} y={endsY} className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>← {ends.left}</text>
                <text x={width - pad} y={endsY} textAnchor="end" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{ends.right} →</text>
              </g>
            ) : null}
          </svg>
        );
      }}
    </Responsive>
  );
}
