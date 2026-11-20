// Small SVG charts for the integrity / SNR / diversity panels (interim: nirs4all-ui debt).
// Presentation only: every plotted value is passed in; information is always also given as text.
import { useState, type KeyboardEvent } from "react";
import { SNR_BANDS } from "../shared/derive";
import type { HistogramBin } from "./model";
import { referenceDb, type InstrumentReference } from "./instruments";

export type Fmt = (v: number, digits?: number) => string;

const PAD = { l: 48, r: 14, t: 14, b: 40 };
const ticks = (lo: number, hi: number, n = 5) => {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
};
const onKeys = (handler: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handler();
  }
};

/** Horizontal stacked proportion bar; every segment is labelled with count and percentage. */
export function ProportionBar({ segments, total, title, f }: { segments: { label: string; count: number; className: string }[]; total: number; title: string; f: Fmt }) {
  return (
    <div className="ig-prop" role="img" aria-label={`${title}: ${segments.map((s) => `${s.label} ${s.count}/${total}`).join(", ")}`}>
      <div className="ig-prop-bar">
        {segments.map((s) => (total > 0 && s.count > 0 ? <span key={s.label} className={`ig-seg ${s.className}`} style={{ width: `${(100 * s.count) / total}%` }} /> : null))}
      </div>
      <ul className="ig-prop-legend">
        {segments.map((s) => <li key={s.label}><span className={`ig-key ${s.className}`} aria-hidden="true" />{s.label}: {s.count}/{total}{total > 0 ? ` (${f((100 * s.count) / total, 3)}%)` : ""}</li>)}
      </ul>
    </div>
  );
}

/** Count histogram with optional vertical markers; bars are selectable (click / Enter). */
export function Histogram({ bins, width, height = 200, title, xLabel, yLabel = "spectra", markers = [], selected = null, onSelect, f, integer = false }: {
  bins: readonly HistogramBin[];
  width: number;
  height?: number;
  title: string;
  xLabel: string;
  yLabel?: string;
  markers?: readonly { value: number; label: string }[];
  selected?: number | null;
  onSelect?: (index: number | null) => void;
  f: Fmt;
  integer?: boolean;
}) {
  if (!bins.length) return null;
  const lo = bins[0]!.lo;
  const hi = Math.max(bins[bins.length - 1]!.hi, lo + 1e-12);
  const ymax = Math.max(1, ...bins.map((b) => b.count));
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (v: number) => PAD.l + ((v - lo) / (hi - lo)) * iw;
  const y = (c: number) => PAD.t + ih - (c / ymax) * ih;
  return (
    <svg className="ig-chart" width={width} height={height} role="group" aria-label={title}>
      <title>{title}</title>
      {ticks(0, ymax, 4).map((t) => <g key={`y${t}`}><line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className="ig-grid" /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="ig-tick">{t}</text></g>)}
      {bins.map((b, i) => {
        const x0 = x(b.lo) + 1;
        const w = Math.max(1, x(b.hi) - x(b.lo) - 2);
        const label = integer && b.hi - b.lo === 1 ? `${b.lo}` : `${f(b.lo)}–${f(b.hi)}`;
        return (
          <rect
            key={i}
            x={x0}
            y={y(b.count)}
            width={w}
            height={Math.max(0, PAD.t + ih - y(b.count))}
            className={`ig-bar${selected === i ? " is-selected" : ""}`}
            tabIndex={onSelect && b.count ? 0 : undefined}
            role={onSelect && b.count ? "button" : undefined}
            aria-label={`${xLabel} ${label}: ${b.count} ${yLabel}`}
            onClick={onSelect && b.count ? () => onSelect(selected === i ? null : i) : undefined}
            onKeyDown={onSelect && b.count ? onKeys(() => onSelect(selected === i ? null : i)) : undefined}
          >
            <title>{`${xLabel} ${label}: ${b.count} ${yLabel}`}</title>
          </rect>
        );
      })}
      {markers.map((m, i) => (Number.isFinite(m.value) && m.value >= lo && m.value <= hi ? (
        <g key={m.label}>
          <line x1={x(m.value)} x2={x(m.value)} y1={PAD.t} y2={PAD.t + ih} className="ig-marker" />
          <text x={x(m.value) + 3} y={PAD.t + 10 + i * 12} className="ig-marker-label">{m.label}</text>
        </g>
      ) : null))}
      <line x1={PAD.l} x2={width - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="ig-axis" />
      {(integer && bins.every((b) => b.hi - b.lo === 1) ? bins.filter((_, i) => bins.length <= 16 || i % Math.ceil(bins.length / 12) === 0).map((b) => b.lo + 0.5) : ticks(lo, hi)).map((t) => (
        <text key={`x${t}`} x={x(t)} y={PAD.t + ih + 14} textAnchor="middle" className="ig-tick">{integer ? Math.floor(t) : f(t)}</text>
      ))}
      <text x={PAD.l + iw / 2} y={height - 6} textAnchor="middle" className="ig-axis-label">{xLabel}</text>
      <text x={12} y={PAD.t + ih / 2} transform={`rotate(-90 12 ${PAD.t + ih / 2})`} textAnchor="middle" className="ig-axis-label">{yLabel}</text>
    </svg>
  );
}

/** Per-band profile (one or two series) over the spectral axis; click / arrow keys pick a band. */
export function BandProfile({ axis, series, width, height = 200, title, axisUnit, yLabel, selected, onSelect, f }: {
  axis: readonly number[];
  series: readonly { id: string; label: string; values: readonly (number | null)[]; className: string }[];
  width: number;
  height?: number;
  title: string;
  axisUnit: string;
  yLabel: string;
  selected: number | null;
  onSelect: (index: number | null) => void;
  f: Fmt;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (axis.length < 2) return null;
  const lo = Math.min(axis[0]!, axis[axis.length - 1]!);
  const hi = Math.max(axis[0]!, axis[axis.length - 1]!);
  const ymax = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (v: number) => PAD.l + ((v - lo) / (hi - lo || 1)) * iw;
  const y = (c: number) => PAD.t + ih - (c / ymax) * ih;
  const nearest = (px: number) => {
    const v = lo + ((px - PAD.l) / iw) * (hi - lo);
    let best = 0;
    for (let i = 1; i < axis.length; i++) if (Math.abs(axis[i]! - v) < Math.abs(axis[best]! - v)) best = i;
    return best;
  };
  const cursor = hover ?? selected;
  const path = (values: readonly (number | null)[]) => {
    let d = "";
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      d += `${d && values[i - 1] !== null ? "L" : "M"}${x(axis[i]!).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };
  const key = (e: KeyboardEvent) => {
    const cur = selected ?? 0;
    if (e.key === "ArrowRight") onSelect(Math.min(axis.length - 1, cur + 1));
    else if (e.key === "ArrowLeft") onSelect(Math.max(0, cur - 1));
    else if (e.key === "Escape") onSelect(null);
    else return;
    e.preventDefault();
  };
  return (
    <svg
      className="ig-chart ig-clickable"
      width={width}
      height={height}
      tabIndex={0}
      role="group"
      aria-label={`${title}. Use the left and right arrow keys to pick a band.`}
      onMouseMove={(e) => setHover(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => onSelect(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
      onKeyDown={key}
    >
      <title>{title}</title>
      {ticks(0, ymax, 4).map((t) => <g key={`y${t}`}><line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className="ig-grid" /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="ig-tick">{f(t)}</text></g>)}
      {series.map((s) => <path key={s.id} d={path(s.values)} className={`ig-line ${s.className}`} />)}
      {cursor !== null ? (
        <g>
          <line x1={x(axis[cursor]!)} x2={x(axis[cursor]!)} y1={PAD.t} y2={PAD.t + ih} className="ig-cursor" />
          <text x={Math.min(width - PAD.r - 150, x(axis[cursor]!) + 4)} y={PAD.t + 10} className="ig-marker-label">
            {`${f(axis[cursor]!)} ${axisUnit} · ${series.map((s) => `${s.label} ${s.values[cursor] ?? "—"}`).join(" · ")}`}
          </text>
        </g>
      ) : null}
      <line x1={PAD.l} x2={width - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="ig-axis" />
      {ticks(lo, hi).map((t) => <text key={`x${t}`} x={x(t)} y={PAD.t + ih + 14} textAnchor="middle" className="ig-tick">{f(t)}</text>)}
      <text x={PAD.l + iw / 2} y={height - 6} textAnchor="middle" className="ig-axis-label">{axisUnit || "band"}</text>
      <text x={12} y={PAD.t + ih / 2} transform={`rotate(-90 12 ${PAD.t + ih / 2})`} textAnchor="middle" className="ig-axis-label">{yLabel}</text>
    </svg>
  );
}

const GAUGE_MAX = 100;
const SNR_BAND_CLASSES = ["b0", "b1", "b2", "b3", "b4", "b5", "b6"];

/**
 * Horizontal dual-scale gauge: SNR in dB (top) and relative noise in % (bottom), with the
 * request's heuristic bands. Bands are indicative relative-amplitude labels, not quality grades.
 */
export function SnrGauge({ db, width, f, p5, p95 }: { db: number; width: number; f: Fmt; p5?: number; p95?: number }) {
  const height = 112;
  const l = 16;
  const r = 16;
  const iw = width - l - r;
  const x = (v: number) => l + (Math.min(GAUGE_MAX, Math.max(0, v)) / GAUGE_MAX) * iw;
  const top = 34;
  const bh = 18;
  let prev = 0;
  return (
    <svg className="ig-chart" width={width} height={height} role="img" aria-label={`Estimated SNR ${f(db, 3)} dB, relative noise ${f(100 * 10 ** (-db / 20), 3)}%`}>
      <title>Estimated SNR gauge (indicative bands)</title>
      {SNR_BANDS.map((b, i) => {
        const from = prev;
        const to = Math.min(GAUGE_MAX, b.maxDb);
        prev = to;
        return to > from ? (
          <g key={b.label}>
            <rect x={x(from)} y={top} width={x(to) - x(from)} height={bh} className={`ig-gauge ${SNR_BAND_CLASSES[i]}`} />
            {x(to) - x(from) > 44 ? <text x={(x(from) + x(to)) / 2} y={top + 13} textAnchor="middle" className="ig-gauge-label">{b.label}</text> : null}
          </g>
        ) : null;
      })}
      {p5 !== undefined && p95 !== undefined ? <rect x={x(p5)} y={top + bh + 2} width={Math.max(2, x(p95) - x(p5))} height={4} className="ig-gauge-range"><title>{`P5–P95 of per-spectrum SNR: ${f(p5, 3)}–${f(p95, 3)} dB`}</title></rect> : null}
      <path d={`M${x(db) - 6},${top - 12} L${x(db) + 6},${top - 12} L${x(db)},${top - 2} Z`} className="ig-gauge-marker" />
      <line x1={x(db)} x2={x(db)} y1={top - 2} y2={top + bh + 8} className="ig-gauge-marker-line" />
      <text x={Math.min(width - r - 120, Math.max(l, x(db) - 60))} y={top - 16} className="ig-gauge-value">{`${f(db, 3)} dB | ${f(100 * 10 ** (-db / 20), 3)}%`}</text>
      {[0, 20, 40, 60, 80, 100].map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top + bh} y2={top + bh + 10} className="ig-axis" />
          <text x={x(t)} y={top + bh + 22} textAnchor="middle" className="ig-tick">{`${t} dB`}</text>
          <text x={x(t)} y={top + bh + 35} textAnchor="middle" className="ig-tick">{`${f(100 * 10 ** (-t / 20), 2)}%`}</text>
        </g>
      ))}
    </svg>
  );
}

/** Documentary dot plot (dB, indicative 20·log10 conversion). Dataset = diamond, specs = circles, study = squares. */
export function InstrumentPlot({ refs, datasetDb, width, f }: { refs: readonly InstrumentReference[]; datasetDb: number | null; width: number; f: Fmt }) {
  const rows = refs.filter((r) => referenceDb(r) !== null);
  const labelW = Math.min(300, width * 0.45);
  const rowH = 22;
  const height = (rows.length + 1) * rowH + 40;
  const values = [...rows.map((r) => referenceDb(r)!), ...(datasetDb !== null ? [datasetDb] : [])];
  const lo = Math.floor(Math.min(40, ...values) / 10) * 10;
  const hi = Math.ceil(Math.max(100, ...values) / 10) * 10;
  const iw = width - labelW - 20;
  const x = (v: number) => labelW + ((v - lo) / (hi - lo)) * iw;
  return (
    <svg className="ig-chart" width={width} height={height} role="img" aria-label="Published instrument S/N figures (documentary) and the dataset estimate">
      <title>Published instrument S/N (documentary, indicative dB conversion)</title>
      {ticks(lo, hi).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={6} y2={height - 30} className="ig-grid" /><text x={x(t)} y={height - 16} textAnchor="middle" className="ig-tick">{t}</text></g>)}
      <text x={labelW + iw / 2} y={height - 2} textAnchor="middle" className="ig-axis-label">dB (indicative documentary conversion 20·log10 S/N)</text>
      {datasetDb !== null ? (
        <g>
          <text x={labelW - 8} y={rowH} textAnchor="end" className="ig-row-label ig-strong">This dataset (estimator on real samples)</text>
          <path d={`M${x(datasetDb)},${rowH - 10} L${x(datasetDb) + 7},${rowH - 3} L${x(datasetDb)},${rowH + 4} L${x(datasetDb) - 7},${rowH - 3} Z`} className="ig-dataset-mark" />
          <text x={x(datasetDb) + 10} y={rowH + 1} className="ig-tick">{f(datasetDb, 3)}</text>
        </g>
      ) : null}
      {rows.map((r, i) => {
        const v = referenceDb(r)!;
        const cy = (i + 2) * rowH - 3;
        return (
          <g key={r.id}>
            <text x={labelW - 8} y={cy + 4} textAnchor="end" className="ig-row-label">{`${r.manufacturer.replace(/ \(.*\)$/, "")} ${r.model}${r.condition ? ` (${r.condition})` : ""}`.slice(0, 60)}</text>
            {r.kind === "study" ? <rect x={x(v) - 5} y={cy - 5} width={10} height={10} className="ig-ref-study" /> : <circle cx={x(v)} cy={cy} r={5} className="ig-ref-spec" />}
            <text x={x(v) + 9} y={cy + 4} className="ig-tick">{f(v, 3)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Two horizontal bars sharing one scale (e.g. P95 distance vs typical signal level). */
export function PairBars({ rows, width, unit, f, title }: { rows: { label: string; value: number }[]; width: number; unit: string; f: Fmt; title: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-300);
  const labelW = Math.min(240, width * 0.4);
  const iw = width - labelW - 90;
  return (
    <svg className="ig-chart" width={width} height={rows.length * 28 + 8} role="img" aria-label={`${title}: ${rows.map((r) => `${r.label} ${f(r.value)} ${unit}`).join(", ")}`}>
      <title>{title}</title>
      {rows.map((r, i) => (
        <g key={r.label}>
          <text x={labelW - 8} y={i * 28 + 18} textAnchor="end" className="ig-row-label">{r.label}</text>
          <rect x={labelW} y={i * 28 + 6} width={Math.max(1, (r.value / max) * iw)} height={16} className={`ig-pair ig-pair-${i}`} />
          <text x={labelW + Math.max(1, (r.value / max) * iw) + 6} y={i * 28 + 18} className="ig-tick">{`${f(r.value)} ${unit}`}</text>
        </g>
      ))}
    </svg>
  );
}

/** Scatter of two per-spectrum values (e.g. raw vs SNV distance), ranks only compared in text. */
export function PairScatter({ points, width, height = 240, xLabel, yLabel, title, f }: { points: { id: string; x: number; y: number }[]; width: number; height?: number; xLabel: string; yLabel: string; title: string; f: Fmt }) {
  if (!points.length) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (v: number) => PAD.l + ((v - x0) / (x1 - x0 || 1)) * iw;
  const y = (v: number) => PAD.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  return (
    <svg className="ig-chart" width={width} height={height} role="img" aria-label={title}>
      <title>{title}</title>
      {ticks(y0, y1, 4).map((t) => <g key={`y${t}`}><line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className="ig-grid" /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="ig-tick">{f(t)}</text></g>)}
      {ticks(x0, x1).map((t) => <text key={`x${t}`} x={x(t)} y={PAD.t + ih + 14} textAnchor="middle" className="ig-tick">{f(t)}</text>)}
      {points.slice(0, 5000).map((p) => <circle key={p.id} cx={x(p.x)} cy={y(p.y)} r={2.5} className="ig-dot"><title>{`${p.id}: ${f(p.x)} / ${f(p.y)}`}</title></circle>)}
      <text x={PAD.l + iw / 2} y={height - 6} textAnchor="middle" className="ig-axis-label">{xLabel}</text>
      <text x={12} y={PAD.t + ih / 2} transform={`rotate(-90 12 ${PAD.t + ih / 2})`} textAnchor="middle" className="ig-axis-label">{yLabel}</text>
    </svg>
  );
}
