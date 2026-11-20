// Dataset characterization overview (request §2, §10, image (15) top block): three compact cards
// (Spikes %, SNR dB with % noise, Diversity relative P95 ×), a repeatability state chip and the
// deterministic interpretation list. Never combined into a score; every number comes from the owner summaries.
// Interim demo component (nirs4all-ui debt, see docs/implementation/debt/characterization-overview.md).
import { useMemo } from "react";
import { Section, type Scope } from "../../Sections";
import { fmt } from "../repeatability/comments";
import { DIMENSION_LABEL, type CharacterizationComment } from "./comments";
import { useDistortionProfile } from "../preprocessing/distortion";
import { overviewModel, withPreprocessing, type OverviewModel } from "./model";
import { useCharacterizationSelection } from "./selection";
import { OVERVIEW, PHASES } from "./strings";
import "../shared/charts/charts.css";
import "./overview.css";

const pct = (v: number | null | undefined, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${fmt(v, digits)}%`);

interface CardProps {
  id: string;
  href: string;
  label: string;
  value: string;
  unit?: string;
  sub: string;
  bar?: number | null;
  title: string;
  unavailable?: string;
}

/** Compact dark-on-light KPI card of image (15): label, large value, one-line sub (and a thin bar for shares). */
function OverviewCard({ id, href, label, value, unit, sub, bar, title, unavailable }: CardProps) {
  return (
    <a className="ov-kpi" href={href} id={id} title={title} aria-label={`${label}: ${unavailable ?? `${value}${unit ?? ""}, ${sub}`}. Open the detailed rubric.`}>
      <span className="ov-kpi-label">{label}</span>
      {unavailable ? (
        <span className="ov-kpi-na">{unavailable}</span>
      ) : (
        <>
          <span className="ov-kpi-value">{value}{unit ? <small>{unit}</small> : null}</span>
          {bar !== undefined && bar !== null ? <span className="ov-kpi-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} /></span> : null}
          <span className="ov-kpi-sub">{sub}</span>
        </>
      )}
    </a>
  );
}

function cards(model: OverviewModel): CardProps[] {
  const d = model.integrity;
  const main = d?.spikes ?? d?.jumps ?? null;
  const s = model.snr;
  const v = model.diversity;
  return [
    main && d
      ? { id: "ov-spikes", href: "#s-quality", label: d.spikes ? "Spikes" : "Abrupt changes", value: main.affectedPercent === null ? "—" : fmt(main.affectedPercent, 3), unit: "%", bar: main.affectedPercent, sub: `${main.affected} of ${main.evaluated} spectra flagged${d.spikes && d.jumps ? ` · jumps ${pct(d.jumps.affectedPercent)}` : ""}`, title: `${OVERVIEW.integrity.metric}. ${OVERVIEW.integrity.hint}` }
      : { id: "ov-spikes", href: "#s-quality", label: "Spikes", value: "—", sub: "", title: OVERVIEW.integrity.none, unavailable: "Not computed" },
    s
      ? { id: "ov-snr", href: "#s-repeat", label: "SNR", value: fmt(s.medianDb, 3), unit: "dB", sub: `${pct(s.relativeNoisePercent)} noise · ${fmt(s.linear, 3)}:1`, title: `${OVERVIEW.noise.metric}. ${OVERVIEW.noise.hint} P5–P95 across ${s.n} spectra: ${fmt(s.p5Db, 3)}–${fmt(s.p95Db, 3)} dB.` }
      : { id: "ov-snr", href: "#s-repeat", label: "SNR", value: "—", sub: "", title: OVERVIEW.noise.none, unavailable: "Not computed" },
    v
      ? { id: "ov-diversity", href: "#s-diversity", label: "Diversity", value: v.relativeP95 === null ? "—" : fmt(v.relativeP95, 3), unit: v.relativeP95 === null ? "" : "×", sub: v.relativeP95 === null ? `P95 distance ${fmt(v.p95, 3)} ${v.unit}` : "Relative P95 distance to the mean", title: `${OVERVIEW.diversity.metric}: P95 ${fmt(v.p95, 3)} ${v.unit} over a typical level of ${v.typicalLevel === null ? "—" : `${fmt(v.typicalLevel, 3)} ${v.unit}`} (median of mean |x|, ${v.n} spectra). ${OVERVIEW.diversity.hint}` }
      : { id: "ov-diversity", href: "#s-diversity", label: "Diversity", value: "—", sub: "", title: OVERVIEW.diversity.none, unavailable: "Not computed" },
  ];
}

const VISIBLE_COMMENTS = 5;

function CommentList({ comments }: { comments: readonly CharacterizationComment[] }) {
  if (!comments.length) return <p className="note">{OVERVIEW.commentsNone}</p>;
  const row = (c: CharacterizationComment) => <li key={`${c.id}`}><span className="ov-dim-tag">{DIMENSION_LABEL[c.dimension]}</span><span>{c.text}</span></li>;
  return (
    <>
      <ul className="ov-comment-list">{comments.slice(0, VISIBLE_COMMENTS).map(row)}</ul>
      {comments.length > VISIBLE_COMMENTS ? (
        <details className="ov-more">
          <summary>{comments.length - VISIBLE_COMMENTS} more statements</summary>
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
  const repeat = model.repeatability;
  return (
    <Section id="s-characterization" index="1 / 4" icon="composition" accent="teal" title={PHASES.overviewTitle} lead={PHASES.overviewLead}>
      <div className="ov-kpis">{cards(model).map((c) => <OverviewCard key={c.id} {...c} />)}</div>
      <div className="ov-chips">
        {repeat ? (
          repeat.status === "computed" ? (
            <a className="ov-chip" data-state="computed" href="#s-repeat"><span className="ov-chip-dot" aria-hidden="true" />{OVERVIEW.noise.repeatAvailable}: <strong>{repeat.headline}</strong></a>
          ) : (
            <span className="ov-chip" data-state="unavailable">
              <span className="ov-chip-dot" aria-hidden="true" />{OVERVIEW.noise.repeatNone}
              {onOpenSettings ? <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSettings}>{OVERVIEW.noise.repeatSettings}</button> : null}
            </span>
          )
        ) : null}
      </div>
      <div className="ov-comments">
        <h3 className="ov-comments-title">{OVERVIEW.commentsTitle} <span className="count">{comments.length}</span></h3>
        <CommentList comments={comments} />
      </div>
      <p className="hint">Exploratory indicators, never combined into a score; hover a card for its statistic and denominator.</p>
    </Section>
  );
}
