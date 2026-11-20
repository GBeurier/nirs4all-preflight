// Dataset characterization overview (request §2, §10 and the page mockup): three separate
// dimension cards (integrity, noise and repeatability, diversity), never combined into a score,
// followed by the deterministic comment list. Every number comes from the owner summaries.
// Interim demo component (nirs4all-ui debt, see docs/implementation/debt/characterization-overview.md).
import { useMemo } from "react";
import { Section, type Scope } from "../../Sections";
import { fmt } from "../repeatability/comments";
import { DIMENSION_LABEL, type CharacterizationComment } from "./comments";
import { useDistortionProfile } from "../preprocessing/distortion";
import { overviewModel, withPreprocessing, type OverviewModel } from "./model";
import { useCharacterizationSelection } from "./selection";
import { OVERVIEW } from "./strings";
import "./overview.css";

const pct = (v: number | null | undefined, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${fmt(v, digits)}%`);
const count = (affected: number, total: number) => `${affected} of ${total} spectra`;
const perAffected = (events: number, per: number | null) => `${events} event${events === 1 ? "" : "s"}${per === null ? "" : ` · ${fmt(per, 3)} per affected spectrum`}`;

type Events = NonNullable<NonNullable<OverviewModel["integrity"]>["spikes"]>;

function EventRow({ label, e }: { label: string; e: Events }) {
  return (
    <li>
      <span>{label}</span>
      <strong>{count(e.affected, e.evaluated)} · {pct(e.affectedPercent)}<br /><span className="qm-pct">{perAffected(e.events, e.eventsPerAffected)}</span></strong>
    </li>
  );
}

function IntegrityCard({ model }: { model: OverviewModel }) {
  const d = model.integrity;
  const main = d?.spikes ?? d?.jumps ?? null;
  return (
    <article className="card ov-dimension" aria-labelledby="ov-integrity-h">
      <header><h3 id="ov-integrity-h">{OVERVIEW.integrity.title}</h3><p>{OVERVIEW.integrity.sub}</p></header>
      {d && main ? (
        <>
          <div className="ov-metric">
            <span className="ov-metric-label">{d.spikes ? OVERVIEW.integrity.metric : OVERVIEW.integrity.metricJump}</span>
            <span className="ov-value">{pct(main.affectedPercent, 3)}</span>
            <span className="ov-sub">{count(main.affected, main.evaluated)} · {perAffected(main.events, main.eventsPerAffected)}</span>
          </div>
          <div className="ov-bar" role="img" aria-label={`${count(main.affected, main.evaluated)} flagged, ${pct(main.affectedPercent)}`}><span style={{ width: `${Math.min(100, Math.max(0, main.affectedPercent ?? 0))}%` }} /></div>
          <ul className="ov-rows">
            {d.spikes && d.jumps ? <EventRow label={OVERVIEW.integrity.detail} e={d.jumps} /> : null}
            {d.either ? <li><span>Spectra with no flag of either type</span><strong>{count(d.either.total - d.either.count, d.either.total)} · {pct(d.either.percent === null ? null : 100 - d.either.percent)}</strong></li> : null}
          </ul>
          <p className="hint">{OVERVIEW.integrity.hint} Events are population-relative flags (engine outlier threshold {fmt(d.threshold)}); an event count is not a severity.</p>
        </>
      ) : (
        <p className="ov-state" data-tone="unavailable">{OVERVIEW.integrity.none}</p>
      )}
      <a className="ov-link" href="#s-quality">{OVERVIEW.jump} →</a>
    </article>
  );
}

function NoiseCard({ model, onOpenSettings }: { model: OverviewModel; onOpenSettings?: (() => void) | undefined }) {
  const s = model.snr;
  const repeat = model.repeatability;
  const proxy = model.noiseProxy;
  const relativeProxy = proxy?.metrics.find((m) => m.label === "Relative pooled noise proxy");
  return (
    <article className="card ov-dimension" aria-labelledby="ov-noise-h">
      <header><h3 id="ov-noise-h">{OVERVIEW.noise.title}</h3><p>{OVERVIEW.noise.sub}</p></header>
      {s ? (
        <>
          <div className="ov-metric">
            <span className="ov-metric-label">{OVERVIEW.noise.metric}</span>
            <span className="ov-value">{fmt(s.medianDb, 3)}<small>dB</small></span>
            <span className="ov-sub"><strong>{pct(s.relativeNoisePercent)}</strong> relative noise · about {fmt(s.linear, 3)}:1 · {s.indicativeBand.toLowerCase()} relative noise (indicative)</span>
          </div>
          <ul className="ov-rows">
            <li><span>SNR P5 – P95 across {s.n} spectra</span><strong>{fmt(s.p5Db, 3)} – {fmt(s.p95Db, 3)} dB</strong></li>
            {relativeProxy && relativeProxy.value !== null ? <li><span>Pooled noise proxy, relative to the typical signal</span><strong>{relativeProxy.display}</strong></li> : null}
          </ul>
        </>
      ) : (
        <p className="ov-state" data-tone="unavailable">{OVERVIEW.noise.none}</p>
      )}
      {repeat ? (
        repeat.status === "computed" ? (
          <ul className="ov-rows"><li><span>{OVERVIEW.noise.repeatAvailable}</span><strong>{repeat.headline}</strong></li></ul>
        ) : (
          <div className="ov-state" data-tone="unavailable">
            <p>{OVERVIEW.noise.repeatNone}</p>
            {onOpenSettings ? <button type="button" className="btn btn-outline btn-sm" onClick={onOpenSettings}>{OVERVIEW.noise.repeatSettings}</button> : null}
          </div>
        )
      ) : null}
      <p className="hint">{OVERVIEW.noise.hint}</p>
      <a className="ov-link" href="#s-repeat">{OVERVIEW.jump} →</a>
    </article>
  );
}

function DiversityCard({ model }: { model: OverviewModel }) {
  const d = model.diversity;
  return (
    <article className="card ov-dimension" aria-labelledby="ov-diversity-h">
      <header><h3 id="ov-diversity-h">{OVERVIEW.diversity.title}</h3><p>{OVERVIEW.diversity.sub}</p></header>
      {d ? (
        <>
          <div className="ov-metric">
            <span className="ov-metric-label">{OVERVIEW.diversity.metric}</span>
            <span className="ov-value">{d.relativeP95 === null ? "—" : fmt(d.relativeP95, 3)}{d.relativeP95 === null ? null : <small>×</small>}</span>
            <span className="ov-sub">{d.relativeP95 === null ? "Relative distance not available: the typical signal level is zero, negligible or not computed." : `${pct(100 * d.relativeP95)} of the typical absolute signal level (not an error rate)`}</span>
          </div>
          <ul className="ov-rows">
            <li><span>P95 distance to the mean spectrum</span><strong>{fmt(d.p95, 3)} {d.unit}</strong></li>
            <li><span>Typical absolute signal level (median of mean |x|)</span><strong>{d.typicalLevel === null ? "—" : `${fmt(d.typicalLevel, 3)} ${d.unit}`}</strong></li>
            <li><span>Median · maximum distance ({d.n} spectra)</span><strong>{fmt(d.median, 3)} · {fmt(d.max, 3)} {d.unit}</strong></li>
          </ul>
          <p className="hint">{OVERVIEW.diversity.hint}</p>
        </>
      ) : (
        <p className="ov-state" data-tone="unavailable">{OVERVIEW.diversity.none}</p>
      )}
      <a className="ov-link" href="#s-quality">{OVERVIEW.jump} →</a>
    </article>
  );
}

const VISIBLE_COMMENTS = 8;

function CommentList({ comments }: { comments: readonly CharacterizationComment[] }) {
  if (!comments.length) return <p className="note">{OVERVIEW.commentsNone}</p>;
  const row = (c: CharacterizationComment) => <li key={`${c.id}`}><span className="ov-dim-tag">{DIMENSION_LABEL[c.dimension]}</span><span>{c.text}</span></li>;
  return (
    <>
      <ul className="ov-comment-list">{comments.slice(0, VISIBLE_COMMENTS).map(row)}</ul>
      {comments.length > VISIBLE_COMMENTS ? (
        <details>
          <summary>Show {comments.length - VISIBLE_COMMENTS} more statements</summary>
          <ul className="ov-comment-list">{comments.slice(VISIBLE_COMMENTS).map(row)}</ul>
        </details>
      ) : null}
    </>
  );
}

export interface OverviewProps extends Scope {
  /** Opens the dataset settings (declare physical samples and replicate groups). */
  onOpenSettings?: () => void;
}

/** True when at least one dimension has a result to show (the section is hidden otherwise). */
export const hasOverview = (m: OverviewModel) => Boolean(m.integrity || m.snr || m.diversity || m.repeatability?.status === "computed" || m.noiseProxy?.status === "computed");

export function CharacterizationOverview(props: OverviewProps) {
  const { view, input, sourceId, locale, onOpenSettings } = props;
  const model = useMemo(() => overviewModel({ view, input, sourceId, locale }), [view, input, sourceId, locale]);
  // Preprocessing the reader evaluated in the explorer, and the interval selected on the quality map.
  const distortion = useDistortionProfile(sourceId);
  const { selection } = useCharacterizationSelection();
  const interval = selection && selection.sourceId === sourceId ? { i0: selection.i0, i1: selection.i1 } : null;
  const comments = useMemo(
    () => withPreprocessing(model, distortion ? { label: distortion.label, fineScaleReductionPercent: distortion.fineScaleReductionPercent, distortion: distortion.values, interval } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, distortion, interval?.i0, interval?.i1],
  );
  if (!sourceId) return null;
  return (
    <Section id="s-characterization" index="1 / 4" icon="spectra" accent="teal" title={OVERVIEW.title} lead={OVERVIEW.lead}>
      <div className="ov-dimensions">
        <IntegrityCard model={model} />
        <NoiseCard model={model} onOpenSettings={onOpenSettings} />
        <DiversityCard model={model} />
      </div>
      <div className="card ov-comments">
        <h3 className="card-title">{OVERVIEW.commentsTitle} <span className="count">{comments.length}</span></h3>
        <p className="hint">{OVERVIEW.commentsLead}</p>
        <CommentList comments={comments} />
      </div>
      <p className="hint">{OVERVIEW.denominators}</p>
    </Section>
  );
}
