// Spectral quality map (request §9): local diagnostics as horizontal tracks on one spectral axis,
// each with its own scale and legend. Exploration tool: nothing here rejects a band or a spectrum.
// Interim demo component (nirs4all-ui debt, see docs/implementation/debt/characterization-overview.md).
import { useMemo, useRef, type MouseEvent } from "react";
import { ChartDataTable, formatEngineNumber } from "nirs4all-ui/qualification";
import { Measured } from "../../Measured";
import { Section, type Scope } from "../../Sections";
import { downloadText } from "../../download";
import { useDistortionProfile } from "../preprocessing/distortion";
import { AlignedTracks, type Track } from "../repeatability/AlignedTracks";
import { qualityMapInputs } from "./mapInputs";
import { regionsExport, useCharacterizationSelection } from "./selection";
import { MAP } from "./strings";
import { NON_EVALUABLE_COLOR, buildTracks, categoryOf, categoryShares, colorOf, summarizeInterval, type QualityTrack, type TrackId, type TrackInputs, type TrackSummary } from "./tracks";
import "./overview.css";

/** Strip labels are drawn in the 64 px axis gutter of the aligned tracks: keep them short. */
const SHORT: Record<TrackId, string> = { repeatability_sd: "SD", icc: "ICC", noise_proxy: "Noise", noise_to_diversity: "N / D", spike_frequency: "Peaks", jump_frequency: "Jumps", distortion: "Distort.", diversity: "Diversity" };

const fmtNumber = (v: number, digits = 3) => formatEngineNumber(v, "en", digits) ?? String(v);

/** Tooltip text of one band value: the number, plus its class for categorical tracks (never colour alone). */
export function describeValue(track: QualityTrack, v: number): string {
  const category = categoryOf(track, v);
  const unit = track.unit ? ` ${track.unit}` : "";
  return category ? `${fmtNumber(v)} · ${category.label} (${category.range})` : `${fmtNumber(v)}${unit}`;
}

/** One aligned strip per drawable track. */
export function alignedTracks(tracks: readonly QualityTrack[]): Track[] {
  return tracks.filter((t) => !t.unavailable).map((t) => ({
    id: t.id,
    title: t.label,
    ...(t.unit ? { unit: t.unit } : {}),
    height: 24,
    nonEvaluable: t.values.map((v) => v === null),
    strip: { label: SHORT[t.id], values: t.values, color: (v: number) => colorOf(t, v), describe: (v: number) => describeValue(t, v) },
  }));
}

function Legend({ track }: { track: QualityTrack }) {
  const shares = track.kind === "categorical" ? categoryShares(track) : [];
  const total = track.values.length;
  return (
    <div className="qm-legend card">
      <h4>{track.label}{track.unit ? <span className="unit"> ({track.unit})</span> : null}</h4>
      {track.unavailable ? (
        <p className="qm-unavailable">{track.unavailable}</p>
      ) : track.kind === "sequential" ? (
        <>
          <div className="qm-ramp" role="img" aria-label={`${track.label}: ${track.domain ? `${fmtNumber(track.domain[0])} to ${fmtNumber(track.domain[1])}` : "no evaluable value"}`} style={{ background: `linear-gradient(90deg, ${track.ramp.join(", ")})` }} />
          <div className="qm-ramp-ends"><span>{track.domain ? fmtNumber(track.domain[0]) : "—"}</span><span>{track.domain ? fmtNumber(track.domain[1]) : "—"}</span></div>
          {track.domain && track.domain[0] === track.domain[1] ? <p className="hint">Same value at every evaluable band ({fmtNumber(track.domain[0])}): the colour does not discriminate between bands.</p> : null}
          <p className="hint"><span className="qm-swatch qm-swatch-na" aria-hidden="true" /> {MAP.nonEvaluable}: {track.values.filter((v) => v === null).length} of {total} bands.</p>
        </>
      ) : (
        <>
          <ul className="qm-classes">
            {shares.map(({ category, count }) => (
              <li key={category?.id ?? "na"}>
                <span className={`qm-swatch${category ? "" : " qm-swatch-na"}`} style={category ? { background: category.color } : undefined} aria-hidden="true" />
                <span>{category ? `${category.label} (${category.range})` : MAP.nonEvaluable}</span>
                <strong>{count}</strong>
                <span className="qm-pct">{total ? `${fmtNumber((100 * count) / total, 3)}%` : "—"}</span>
              </li>
            ))}
          </ul>
          <div className="qm-stack" role="img" aria-label={`${track.label}: ${shares.map((s) => `${s.category?.label ?? "not evaluable"} ${s.count}`).join(", ")} of ${total} bands`}>
            {shares.filter((s) => s.count > 0).map((s) => <span key={s.category?.id ?? "na"} style={{ flex: s.count, background: s.category?.color ?? NON_EVALUABLE_COLOR }} title={`${s.category?.label ?? MAP.nonEvaluable}: ${s.count}`} />)}
          </div>
        </>
      )}
      <p className="hint">{track.provenance || MAP.originLabel[track.origin]}</p>
    </div>
  );
}

function IntervalSummary({ tracks, summaries }: { tracks: readonly QualityTrack[]; summaries: readonly TrackSummary[] }) {
  return (
    <ul className="qm-summary">
      {summaries.map((s) => {
        const track = tracks.find((t) => t.id === s.id)!;
        const range = s.min === null || s.max === null ? "no evaluable band" : s.min === s.max ? fmtNumber(s.min) : `${fmtNumber(s.min)} – ${fmtNumber(s.max)}`;
        return (
          <li key={s.id}>
            <span>{track.label}</span>
            <strong>{range}{s.min !== null && track.unit ? ` ${track.unit}` : ""}</strong>
            <span className="qm-pct">{s.evaluable}/{s.bands} bands evaluable{s.classes.length ? ` · ${s.classes.map((c) => `${c.label} ${c.count}`).join(", ")}` : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** True when the source has at least one drawable local diagnostic (the section is hidden otherwise). */
export function hasQualityMap(scope: Pick<Scope, "view" | "input" | "sourceId">): boolean {
  const inputs = qualityMapInputs(scope);
  return inputs !== null && buildTracks(inputs).some((t) => !t.unavailable);
}

export function SpectralQualityMap(props: Scope) {
  const { view, input, sourceId } = props;
  const source = input.sources.find((s) => s.source_id === sourceId);
  const chart = useRef<HTMLDivElement>(null);
  const shared = useCharacterizationSelection();
  // Per-band distortion of the configuration currently loaded in the preprocessing explorer, if any.
  const profile = useDistortionProfile(sourceId);
  const distortion = useMemo<TrackInputs["distortion"]>(
    () => (profile ? { axis: profile.axis, values: profile.values, unit: "fraction of mean |raw|", provenance: `Pipeline "${profile.label}" evaluated on ${profile.n} spectra in the preprocessing explorer: |mean residual| ÷ mean |raw| per band (interim explorer metric; raw − processed on one scale).` } : null),
    [profile],
  );
  const tracks = useMemo(() => {
    const inputs = qualityMapInputs({ view, input, sourceId }, distortion);
    return inputs ? buildTracks(inputs) : [];
  }, [view, input, sourceId, distortion]);
  const drawnTracks = useMemo(() => tracks.filter((t) => !t.unavailable), [tracks]);
  const drawn = useMemo(() => alignedTracks(tracks), [tracks]);
  const ownSelection = shared.selection && shared.selection.sourceId === sourceId ? shared.selection : null;
  const regions = shared.regions.filter((r) => r.sourceId === sourceId);
  const summaries = useMemo(() => (ownSelection ? summarizeInterval(tracks, ownSelection.i0, ownSelection.i1) : []), [tracks, ownSelection]);
  if (!source || !sourceId || !drawnTracks.length) return null;
  const axisLabel = `${source.axis_unit ? `Spectral axis (${source.axis_unit})` : "Band index / spectral axis"}`;
  const rows = source.axis.map((x, i) => [x, ...drawnTracks.flatMap((t) => [t.values[i] ?? null, ...(t.kind === "categorical" ? [categoryOf(t, t.values[i] ?? null)?.label ?? null] : [])])]);
  const columns = [axisLabel, ...drawnTracks.flatMap((t) => [`${t.label}${t.unit ? ` (${t.unit})` : ""}`, ...(t.kind === "categorical" ? [`${t.label} — class`] : [])])];
  // A click (not a drag) on a strip opens the detailed panel of that track: find the strip under the pointer.
  const onChartClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!ownSelection || ownSelection.i0 !== ownSelection.i1 || !(e.target as Element).closest("svg")) return;
    const groups = [...(chart.current?.querySelectorAll<SVGGElement>("g.at-track") ?? [])];
    const hit = groups.findIndex((g) => { const r = g.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
    const track = hit >= 0 ? drawnTracks[hit] : undefined;
    if (track) shared.openPanel(track.panel);
  };
  const panels = [...new Set(drawnTracks.map((t) => t.panel))];
  const interval = ownSelection ? { sourceId, i0: ownSelection.i0, i1: ownSelection.i1, from: ownSelection.from, to: ownSelection.to } : null;
  const span = ownSelection ? `${fmtNumber(Math.min(ownSelection.from, ownSelection.to), 6)}${ownSelection.i0 === ownSelection.i1 ? "" : `–${fmtNumber(Math.max(ownSelection.from, ownSelection.to), 6)}`}${source.axis_unit ? ` ${source.axis_unit}` : ""}` : "";
  return (
    <Section id="s-quality-map" icon="composition" accent="indigo" title={MAP.title} lead={MAP.lead}>
      <p className="note">{MAP.warning}</p>
      <div className="card qm-card" ref={chart} onClick={onChartClick}>
        <Measured min={420}>
          {(w) => (
            <AlignedTracks
              axis={source.axis}
              axisLabel={axisLabel}
              tracks={drawn}
              width={w}
              title={`${MAP.title} — ${sourceId}`}
              selection={ownSelection ? { i0: ownSelection.i0, i1: ownSelection.i1 } : null}
              onSelect={(sel) => shared.select(sel ? { sourceId, ...sel } : null)}
              markRegions={regions.map((r) => ({ i0: Math.min(r.i0, r.i1), i1: Math.max(r.i0, r.i1), label: `To investigate${r.note ? `: ${r.note}` : ""}` }))}
            />
          )}
        </Measured>
        <p className="hint">{MAP.interaction}</p>
      </div>
      {ownSelection ? (
        <div className="card qm-selection" role="region" aria-label={MAP.selected}>
          <h3 className="card-title">{MAP.selected}: {span} <span className="unit">· {Math.abs(ownSelection.i1 - ownSelection.i0) + 1} band(s)</span></h3>
          <IntervalSummary tracks={tracks} summaries={summaries} />
          <div className="qm-actions">
            <span className="qm-open">{MAP.openIn}</span>
            {panels.map((p) => <button key={p} type="button" className="btn btn-outline btn-sm" onClick={() => shared.openPanel(p)}>{MAP.panels[p]}</button>)}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => interval && shared.addRegion(interval)}>{MAP.mark}</button>
          </div>
          <p className="hint">{MAP.markHint}</p>
        </div>
      ) : null}
      <div className="card qm-regions">
        <h3 className="card-title">{MAP.regionsTitle} <span className="count">{regions.length}</span></h3>
        {regions.length ? (
          <ul className="qm-region-list">
            {regions.map((r) => (
              <li key={r.id}>
                <span>{fmtNumber(Math.min(r.from, r.to), 6)}{r.i0 === r.i1 ? "" : `–${fmtNumber(Math.max(r.from, r.to), 6)}`}{source.axis_unit ? ` ${source.axis_unit}` : ""} <span className="qm-pct">({Math.abs(r.i1 - r.i0) + 1} band(s))</span></span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => shared.removeRegion(r.id)} aria-label={`Remove region ${fmtNumber(Math.min(r.from, r.to), 6)}`}>Remove</button>
              </li>
            ))}
          </ul>
        ) : <p className="note">{MAP.regionsNone}</p>}
        <div className="qm-actions">
          <button type="button" className="btn btn-outline btn-sm" disabled={!regions.length} onClick={() => downloadText(`${sourceId}-regions-to-investigate.json`, "application/json", JSON.stringify(regionsExport(regions, sourceId, source.axis_unit ?? ""), null, 2))}>{MAP.regionsExport}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!regions.length} onClick={shared.clearRegions}>{MAP.regionsClear}</button>
        </div>
      </div>
      <h3 className="qm-subtitle">{MAP.legendsTitle}</h3>
      <p className="hint">{MAP.scaleNote}</p>
      <div className="qm-legends">{drawnTracks.map((t) => <Legend key={t.id} track={t} />)}</div>
      {tracks.some((t) => t.unavailable) ? (
        <div className="card">
          <h3 className="card-title">{MAP.notDrawn}</h3>
          <ul className="plain small unavailable">{tracks.filter((t) => t.unavailable).map((t) => <li key={t.id}><strong>{t.label}</strong> — {t.unavailable}</li>)}</ul>
        </div>
      ) : null}
      <ChartDataTable caption={`${MAP.tableCaption} — ${sourceId}`} columns={columns} rows={rows} locale="en" />
    </Section>
  );
}
