// Count histogram with P50/P95-style markers, selectable and highlighted bins, and a compact zero state.
import type { KeyboardEvent, ReactNode } from "react";
import { EmptyState, Responsive, toneClass, type Tone } from "./frame";
import { binValues, defaultFmt, linear, niceTicks, type Fmt } from "./scale";

export interface HistBin {
  lo: number;
  hi: number;
  count: number;
  /** Optional payload (e.g. observation ids) kept for the caller. */
  ids?: readonly string[] | undefined;
}

export interface HistMarker {
  value: number;
  label: string;
  tone?: Tone | undefined;
}

const onKeys = (handler: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handler();
  }
};

export function Histogram({ width: fixedWidth, f, bins, values, binCount = 24, markers = [], selected = null, onSelect, highlighted, xLabel, yLabel = "spectra", title, emptyMessage, fmt = defaultFmt, height = 180, integer = false, tone = "muted", highlightTone = "copper" }: {
  /** Fixed pixel width (default: container width). */
  width?: number | undefined;
  /** Alias of `fmt`. */
  f?: Fmt | undefined;
  bins?: readonly HistBin[] | undefined;
  /** Raw values, binned into `binCount` equal intervals when `bins` is not given. */
  values?: readonly (number | null | undefined)[];
  binCount?: number | undefined;
  markers?: readonly HistMarker[] | undefined;
  selected?: number | null | undefined;
  onSelect?: (index: number | null) => void | undefined;
  /** Indices of bins drawn in the highlight tone (e.g. bins with at least one event). */
  highlighted?: readonly number[] | ((bin: HistBin, index: number) => boolean) | undefined;
  xLabel: string;
  yLabel?: string | undefined;
  /** Accessible title. */
  title: string;
  /** Shown instead of the chart when there is no value or every count is 0. */
  emptyMessage?: ReactNode | undefined;
  fmt?: Fmt | undefined;
  height?: number | undefined;
  /** Integer x values (one bin per count): ticks are drawn at bin centres. */
  integer?: boolean | undefined;
  tone?: Tone | undefined;
  highlightTone?: Tone | undefined;
}) {
  if (f) fmt = f;
  const data: readonly HistBin[] = bins ?? (values ? binValues(values, binCount) : []);
  const total = data.reduce((a, b) => a + b.count, 0);
  if (!data.length || total === 0) return <EmptyState>{emptyMessage ?? "No value to show."}</EmptyState>;
  const isHi = (b: HistBin, i: number) => (typeof highlighted === "function" ? highlighted(b, i) : highlighted?.includes(i) ?? false);
  const lo = data[0]!.lo;
  const hiRaw = data[data.length - 1]!.hi;
  const hi = integer ? hiRaw + 1 : hiRaw > lo ? hiRaw : lo + 1;
  const ymax = Math.max(...data.map((b) => b.count));
  const yt = niceTicks(0, ymax, 3).filter((t) => Number.isInteger(t));
  const ytop = Math.max(ymax, yt[yt.length - 1] ?? ymax);
  return (
    <Responsive min={240} {...(fixedWidth ? { fixed: fixedWidth } : {})}>
      {(width) => {
        const pad = { l: 40, r: 10, t: markers.length ? 18 : 8, b: 36 };
        const x = linear(lo, hi, pad.l, width - pad.r);
        const y = linear(0, ytop, height - pad.b, pad.t);
        const xt = integer ? (data.length <= 16 ? data.map((b) => b.lo) : niceTicks(lo, hiRaw, 6).filter(Number.isInteger)) : niceTicks(lo, hi, Math.max(3, Math.floor(width / 90)));
        return (
          <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${title}: ${total} ${yLabel}${markers.length ? `; ${markers.map((m) => `${m.label} ${fmt(m.value)}`).join(", ")}` : ""}`}>
            <title>{title}</title>
            {yt.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" />
                <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{t}</text>
              </g>
            ))}
            {data.map((b, i) => {
              const x0 = x(b.lo);
              const x1 = integer ? x(b.lo + 1) : x(b.hi);
              const bw = Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1.5 : 0));
              const sel = selected === i;
              const label = `${integer ? fmt(b.lo) : `${fmt(b.lo)} – ${fmt(b.hi)}`}: ${b.count} ${yLabel}`;
              return (
                <g key={i} className={`${toneClass(isHi(b, i) || sel ? highlightTone : tone)}${onSelect && b.count > 0 ? " cz-focusable" : ""}`}
                  {...(onSelect && b.count > 0 ? { role: "button", tabIndex: 0, "aria-pressed": sel, "aria-label": label, onClick: () => onSelect(sel ? null : i), onKeyDown: onKeys(() => onSelect(sel ? null : i)) } : {})}>
                  <title>{label}</title>
                  {onSelect ? <rect x={x0} y={pad.t} width={Math.max(1, x1 - x0)} height={height - pad.b - pad.t} fill="transparent" /> : null}
                  {b.count > 0 ? <rect x={x0} y={y(b.count)} width={bw} height={Math.max(1, y(0) - y(b.count))} rx={1.5} className="cz-fill" style={sel ? { stroke: "var(--cz-ink)", strokeWidth: 1.5 } : undefined} /> : null}
                </g>
              );
            })}
            <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} className="cz-axis-line" />
            {xt.map((t) => <text key={t} x={integer ? x(t + 0.5) : x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{fmt(t, 4)}</text>)}
            <text x={(pad.l + width - pad.r) / 2} y={height - 4} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{xLabel}</text>
            <text transform={`translate(11,${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-axis">{yLabel}</text>
            {markers.map((m, i) => {
              const mx = x(integer ? m.value + 0.5 : m.value);
              if (!(mx >= pad.l - 1 && mx <= width - pad.r + 1)) return null;
              return (
                <g key={m.label} className={toneClass(m.tone, "teal")}>
                  <line x1={mx} x2={mx} y1={pad.t - 4} y2={y(0)} className="cz-stroke" strokeWidth={1.4} strokeDasharray="4 3" />
                  <text x={mx + (i % 2 ? -4 : 4)} y={pad.t - 6} textAnchor={i % 2 ? "end" : "start"} className="cz-t-strong" style={{ fontSize: 11 }}>{m.label} {fmt(m.value)}</text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </Responsive>
  );
}
