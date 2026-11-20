// Presentation helpers shared by the repeatability and noise-proxy blocks (interim; nirs4all-ui debt).
// Everything is styled with the chart-kit tokens (--cz-*), light and dark.
import { useState, type ReactNode } from "react";
import { KpiStrip, StackedShareBar, type ShareSegment } from "../shared/charts";
import { quantile } from "../shared/derive";
import { Measured } from "../../Measured";
import { AlignedTracks, type BandSelection, type Track } from "./AlignedTracks";
import type { BBlocks } from "./blocks";
import { fmt } from "./comments";
import "./repeatability.css";

/** Headline share + kit stacked bar (chat mockup "82 % Good to excellent"). */
export function ShareSummary({ headline, headlineLabel, headlineSub, segments, total, label }: {
  headline: string | null;
  headlineLabel: string;
  headlineSub?: string;
  segments: readonly ShareSegment[];
  total: number;
  label: string;
}) {
  return (
    <div className="rp-share">
      {headline !== null ? (
        <p className="rp-share-head"><span className="rp-share-value">{headline}</span><span>{headlineLabel}{headlineSub ? <small>{headlineSub}</small> : null}</span></p>
      ) : null}
      <StackedShareBar segments={segments} total={total} label={label} fmt={(v, d) => fmt(v, d ?? 3)} />
    </div>
  );
}

/** Small titled card for the distributions row. */
export function MiniCard({ title, sub, children, foot, full }: { title: string; sub?: string | undefined; children: ReactNode; foot?: ReactNode; full?: boolean }) {
  return (
    <section className={`cz-card rp-mini${full ? " rp-span-full" : ""}`}>
      <h4 className="cz-card-title">{title}</h4>
      {sub ? <p className="cz-card-sub">{sub}</p> : null}
      <div className="rp-mini-body">{children}</div>
      {foot ? <p className="cz-card-foot">{foot}</p> : null}
    </section>
  );
}

/**
 * Standalone renderer of B's blocks (until K's rubric section takes over): KPI strip, interpretation,
 * distributions side by side, one synchronized AlignedTracks stack, inspection, collapsed details.
 */
export function RubricPanel({ blocks, spectrum, axis, axisLabel, title, header }: {
  blocks: readonly BBlocks[];
  spectrum: Track | null;
  axis: readonly number[];
  axisLabel: string;
  title: string;
  header?: ReactNode;
}) {
  const [selection, setSelection] = useState<BandSelection | null>(null);
  const tracks = [...(spectrum ? [spectrum] : []), ...blocks.flatMap((b) => b.bandTracks)];
  const kpis = blocks.flatMap((b) => b.kpis);
  const comments = blocks.flatMap((b) => b.comments);
  const distributions = blocks.flatMap((b) => b.distributions);
  return (
    <div className="card rp-block">
      {header}
      {blocks.map((b) => <p key={b.id} className="rp-lead">{b.lead}</p>)}
      {kpis.length ? <KpiStrip items={kpis} label={`${title}: key metrics`} /> : null}
      {comments.length ? (
        <div className="rp-interpretation">
          <h4>Interpretation</h4>
          <ul>{comments.map((c) => <li key={c.id} className={`rp-c-${c.tone ?? "info"}`}>{c.text}</li>)}</ul>
        </div>
      ) : null}
      {blocks.map((b) => (b.actions ? <div key={b.id}>{b.actions}</div> : null))}
      {distributions.length ? (
        <div className="rp-dist">
          {distributions.map((d) => (d.title ? <MiniCard key={d.id} title={d.title} sub={d.subtitle} full={d.span === "full"}>{d.node}</MiniCard> : <div key={d.id} className={d.span === "full" ? "rp-span-full" : undefined}>{d.node}</div>))}
        </div>
      ) : null}
      {tracks.length > (spectrum ? 1 : 0) ? (
        <Measured>{(w) => (
          <AlignedTracks axis={axis} axisLabel={axisLabel} tracks={tracks} width={w} title={title} selection={selection} onSelect={setSelection} markRegions={blocks.flatMap((b) => b.markRegions)} />
        )}</Measured>
      ) : null}
      {blocks.map((b) => {
        const node = b.inspection({ selection });
        return node ? <div key={b.id} className="rp-inspection">{node}</div> : null;
      })}
      {blocks.filter((b) => b.status === "computed").map((b) => (
        <div key={b.id} className="rp-details">
          {b.details.tables}
          <details className="rp-limits">
            <summary><strong>Method and limitations{blocks.length > 1 ? ` — ${b.title}` : ""}.</strong> {b.details.limitations}</summary>
            {b.details.methodology}
          </details>
          {b.details.investigate.length ? (
            <details className="rp-limits">
              <summary><strong>Suggested investigation</strong></summary>
              <ul>{b.details.investigate.map((c) => <li key={c}>{c}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Median of finite values (display helper). */
export const median = (v: readonly (number | null)[]) => quantile(v, 0.5);
