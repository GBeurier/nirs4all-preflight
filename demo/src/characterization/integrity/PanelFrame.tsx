// Homogeneous panel structure (request §2): header, key metrics, interpretation,
// visualization, collapsible methodological limitations, suggested investigation.
import type { ReactNode } from "react";
import "./integrity.css";

export function PanelFrame({ id, title, lead, metrics, comments, warning, limits, investigate, children }: {
  id: string;
  title: string;
  lead: string;
  metrics: ReactNode;
  comments: readonly string[];
  warning?: string;
  limits: readonly string[];
  investigate: readonly string[];
  children: ReactNode;
}) {
  return (
    <section className="ig-panel card" id={id} aria-labelledby={`${id}-h`}>
      <h3 className="ig-title" id={`${id}-h`}>{title}</h3>
      <p className="ig-lead">{lead}</p>
      <div className="ig-metrics">{metrics}</div>
      {comments.length ? (
        <div className="ig-interpretation" aria-label="Interpretation">
          <span className="ig-eyebrow">Interpretation</span>
          <ul>{comments.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      ) : null}
      <div className="ig-visual">{children}</div>
      {warning ? <p className="ig-warning" role="note">{warning}</p> : null}
      <details className="ig-details">
        <summary>Methodological limitations</summary>
        <ul>{limits.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
      <details className="ig-details">
        <summary>Suggested investigation</summary>
        <ul>{investigate.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </section>
  );
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="ig-metric">
      <span className="ig-metric-label">{label}</span>
      <span className="ig-metric-value">{value}</span>
      {detail ? <span className="ig-metric-detail">{detail}</span> : null}
    </div>
  );
}
