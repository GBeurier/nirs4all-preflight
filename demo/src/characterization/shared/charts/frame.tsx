// Card, KPI strip, legend, empty state and responsive wrapper of the chart kit.
import type { CSSProperties, ReactNode } from "react";
import { useWidth } from "./scale";
import { exportSvg, exportTables } from "../../../export";

export type Tone = "copper" | "copper-2" | "grey" | "teal-2" | "teal" | "accent" | "muted" | "blue";
export const toneClass = (tone: Tone | undefined, fallback: Tone = "copper") => `cz-tone-${tone ?? fallback}`;

/** Card with a short title, a one-line subtitle, optional actions (buttons) and a footnote. */
export function ChartCard({ title, subtitle, actions, footnote, children, id, className, headingLevel = 4 }: {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  footnote?: ReactNode | undefined;
  children?: ReactNode | undefined;
  id?: string | undefined;
  className?: string | undefined;
  headingLevel?: 3 | 4 | 5 | undefined;
}) {
  const H = `h${headingLevel}` as "h4";
  return (
    <section className={`cz-card${className ? ` ${className}` : ""}`} id={id}>
      <header className="cz-card-head">
        <div>
          <H className="cz-card-title">{title}</H>
          {subtitle ? <p className="cz-card-sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="cz-card-actions">{actions}</div> : null}
      </header>
      {children}
      {footnote ? <p className="cz-card-foot">{footnote}</p> : null}
    </section>
  );
}

/** Compact empty / zero state, e.g. "No isolated peak flagged in 40 spectra". Never an empty chart. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="cz-empty" role="status">{children}</p>;
}

export interface KpiItem {
  label: string;
  value: string | number;
  unit?: string | undefined;
  sub?: ReactNode | undefined;
  /** Alias of `sub`. */
  caption?: ReactNode | undefined;
  /** Optional thin progress bar (0–100 %), e.g. a share of flagged spectra. */
  bar?: number | null | undefined;
  tone?: Tone | undefined;
}

/** Row of large tabular-number KPIs (docx image4). */
export function KpiStrip({ items, label }: { items: readonly KpiItem[]; label?: string }) {
  return (
    <ul className="cz-kpis" aria-label={label}>
      {items.map((k) => (
        <li key={k.label} className={`cz-kpi ${toneClass(k.tone)}`}>
          <p className="cz-kpi-label">{k.label}</p>
          <p className="cz-kpi-value">{k.value}{k.unit ? <span className="cz-kpi-unit">{k.unit}</span> : null}</p>
          {k.bar !== undefined && k.bar !== null && Number.isFinite(k.bar) ? (
            <div className="cz-kpi-bar" role="img" aria-label={`${k.label}: ${k.value}${k.unit ?? ""}`}><span style={{ width: `${Math.min(100, Math.max(0, k.bar))}%` }} /></div>
          ) : null}
          {k.sub ?? k.caption ? <p className="cz-kpi-sub">{k.sub ?? k.caption}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export interface LegendItem {
  label: ReactNode;
  tone?: Tone | undefined;
  /** Explicit CSS colour (overrides tone). */
  color?: string | undefined;
  kind?: "box" | "line" | "hatch" | undefined;
  value?: ReactNode | undefined;
}

/** Compact inline legend; swatches always come with a text label. */
export function Legend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  return (
    <ul className={`cz-legend${className ? ` ${className}` : ""}`}>
      {items.map((it, i) => {
        const style: CSSProperties | undefined = it.color ? { background: it.color } : undefined;
        const cls = `cz-swatch ${it.kind === "hatch" ? "cz-swatch-na" : toneClass(it.tone, "grey")}${it.kind === "line" ? " cz-swatch-line" : ""}`;
        return <li key={i}><span className={cls} style={style} aria-hidden="true" />{it.label}{it.value !== undefined ? <span className="cz-legend-strong">{it.value}</span> : null}</li>;
      })}
    </ul>
  );
}

/** Renders `children(width)` at the container's pixel width; falls back to `fallback` px before layout (tests, SSR). */
export function Responsive({ children, fallback = 640, min = 240, className, fixed }: { children: (width: number) => ReactNode; fallback?: number; min?: number; className?: string; fixed?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className={className} style={{ width: "100%", minWidth: 0 }}>
      {children(fixed ?? Math.max(min, width || fallback))}
      <ChartExports host={ref} />
    </div>
  );
}

/** Per-chart exports, as on every other demo chart (see Measured): the drawn SVG and the chart's data tables. */
function ChartExports({ host }: { host: { current: HTMLDivElement | null } }) {
  const name = () => host.current?.querySelector("svg title")?.textContent?.replace(/[^a-z0-9]+/gi, "-") ?? "preflight-chart";
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm plot-export" onClick={() => { const svg = host.current?.querySelector("svg"); if (svg) exportSvg(svg, name()); }}>Export plot (SVG)</button>
      <button type="button" className="btn btn-ghost btn-sm plot-export" onClick={() => { if (host.current) exportTables(host.current, name()); }}>Export chart table (CSV)</button>
    </>
  );
}
