// Small presentation helpers shared by the repeatability and noise-proxy panels (interim; nirs4all-ui debt).
import type { ReactNode } from "react";
import "./repeatability.css";

/** Homogeneous test layout (request §2): lead, key metrics, interpretation, visualization, limitations, investigation. */
export function DiagnosticBlock({ title, lead, metrics, comments, children, limitations, details, investigate }: {
  title: string;
  lead: string;
  metrics?: ReactNode;
  comments?: readonly string[];
  children?: ReactNode;
  limitations: string;
  details?: ReactNode;
  investigate?: readonly string[];
}) {
  return (
    <div className="card rp-block">
      <h3 className="card-title">{title}</h3>
      <p className="rp-lead">{lead}</p>
      {metrics ? <div className="stats">{metrics}</div> : null}
      {comments?.length ? (
        <div className="rp-interpretation">
          <h4>Interpretation</h4>
          <ul>{comments.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      ) : null}
      {children}
      <details className="rp-limits">
        <summary><strong>Methodological limitations.</strong> {limitations}</summary>
        {details}
      </details>
      {investigate?.length ? (
        <div className="rp-investigate">
          <h4>Suggested investigation</h4>
          <ul>{investigate.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

export interface ShareSegment {
  id: string;
  label: string;
  count: number;
  color: string;
  /** CSS background for a non-colour cue (e.g. a hatch) */
  pattern?: string;
}

/** Labelled stacked bar of band shares (percentages written in the legend, never colour alone). */
export function StackedShareBar({ segments, total, caption }: { segments: readonly ShareSegment[]; total: number; caption: string }) {
  if (total <= 0) return null;
  return (
    <figure className="rp-stack">
      <figcaption>{caption}</figcaption>
      <div className="rp-stack-bar" role="img" aria-label={`${caption}: ${segments.map((s) => `${s.label} ${((100 * s.count) / total).toFixed(1)}%`).join(", ")}`}>
        {segments.filter((s) => s.count > 0).map((s) => (
          <span key={s.id} style={{ width: `${(100 * s.count) / total}%`, background: s.pattern ?? s.color }} title={`${s.label}: ${s.count} bands`} />
        ))}
      </div>
      <ul className="rp-stack-legend">
        {segments.map((s) => (
          <li key={s.id}><span className="rp-swatch" style={{ background: s.pattern ?? s.color }} aria-hidden="true" />{s.label}: {s.count} ({((100 * s.count) / total).toFixed(1)}%)</li>
        ))}
      </ul>
    </figure>
  );
}

export const HATCH = "repeating-linear-gradient(45deg, #cbd5e1 0 3px, #f1f5f9 3px 6px)";

/** Histogram bins of finite values (equal width), for MeasureBars rows. */
export function histogramBins(values: readonly (number | null)[], bins = 12, format: (v: number) => string = (v) => String(v)) {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!xs.length) return [];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const k = hi > lo ? bins : 1;
  const w = (hi - lo) / k || 1;
  const counts = new Array(k).fill(0);
  for (const v of xs) counts[Math.min(k - 1, Math.floor((v - lo) / w))]++;
  return counts.map((c, i) => ({ id: String(i), label: `${format(lo + i * w)} – ${format(k === 1 ? hi : lo + (i + 1) * w)}`, value: c }));
}
