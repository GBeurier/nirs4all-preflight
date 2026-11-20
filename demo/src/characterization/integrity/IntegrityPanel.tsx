// §3 Spectra with isolated peaks and abrupt changes.
import { useMemo, useState } from "react";
import { ChartDataTable, SpectraExplorer } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { BandProfile, Histogram, ProportionBar } from "./charts";
import { makeFmt } from "./format";
import { Metric, PanelFrame } from "./PanelFrame";
import { rowsFor, type EventStats } from "./model";
import { S } from "./strings";
import { integrityData } from "./summaries";

export const SERIES_COLORS = ["#0f766e", "#b45309", "#4338ca", "#be123c", "#0369a1", "#4d7c0f", "#7c3aed", "#a16207", "#0e7490", "#9d174d", "#15803d", "#1d4ed8"];
const MAX_DRAWN = 12;

/** Label of a demo observation id `[source, partition, row, declared id]`. */
export function scanLabel(observationId: string): string {
  try {
    const [, part, row, declared] = JSON.parse(observationId) as [number, string, number, string | null];
    return declared ?? `${part} #${row + 1}`;
  } catch {
    return observationId;
  }
}

const NAMES = { spike: "Isolated peaks", jump: "Abrupt changes" } as const;

export function IntegrityPanel(scope: Scope) {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const data = useMemo(() => integrityData({ view, input, sourceId, locale }), [view, input, sourceId, locale]);
  const source = input.sources.find((s) => s.source_id === sourceId);
  const [band, setBand] = useState<number | null>(null);
  const [bin, setBin] = useState<{ type: "spike" | "jump"; index: number } | null>(null);
  const [halfWindow, setHalfWindow] = useState(25);

  // Spectra to inspect: a histogram bin, or (for a picked band) the flagged spectra ranked by count.
  const inspected = useMemo(() => {
    if (!data || !source) return null;
    if (bin) {
      const stats = bin.type === "spike" ? data.spikes : data.jumps;
      const ids = stats?.histogram[bin.index]?.ids ?? [];
      return { ids, caption: `${NAMES[bin.type]}: spectra with ${stats?.histogram[bin.index]?.lo ?? ""} event(s) per spectrum` };
    }
    if (band !== null) {
      const ranked = [...(data.spikes?.ranked ?? []), ...(data.jumps?.ranked ?? [])];
      const total = new Map<string, number>();
      for (const r of ranked) total.set(r.observationId, (total.get(r.observationId) ?? 0) + r.count);
      const ids = [...total.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      return { ids, caption: `Flagged spectra (any event type, most events first), zoomed on ${f(source.axis[band]!)} ${source.axis_unit ?? ""}` };
    }
    return null;
  }, [data, source, bin, band, f]);

  const explorer = useMemo(() => {
    if (!inspected || !source) return null;
    const rows = rowsFor(source, inspected.ids).slice(0, MAX_DRAWN);
    const [lo, hi] = band !== null && !bin ? [Math.max(0, band - halfWindow), Math.min(source.axis.length - 1, band + halfWindow)] : [0, source.axis.length - 1];
    return {
      axis: source.axis.slice(lo, hi + 1),
      series: rows.map(({ id, row }, i) => ({ id, label: scanLabel(id), color: SERIES_COLORS[i % SERIES_COLORS.length]!, values: (source.x[row] ?? []).slice(lo, hi + 1) })),
      total: inspected.ids.length,
    };
  }, [inspected, source, band, bin, halfWindow]);

  if (!data || !source) return null;
  const { spikes, jumps, overlap, spikeBands, jumpBands, threshold } = data;
  const axis = spikeBands?.axis ?? jumpBands?.axis ?? null;
  const metric = (s: EventStats | null) =>
    s ? (
      <Metric
        key={s.type}
        label={NAMES[s.type]}
        value={`${s.affected}/${s.evaluated} spectra — ${s.affectedRatio === null ? "—" : `${f(100 * s.affectedRatio, 3)}%`}`}
        detail={`${f(s.events)} events${s.perAffected !== null ? ` — ${f(s.perAffected, 3)} events per affected spectrum` : ""} · ${s.unaffected} without any flag (${s.unaffectedRatio === null ? "—" : `${f(100 * s.unaffectedRatio, 3)}%`}) · max ${s.maxPerSpectrum} per spectrum`}
      />
    ) : null;
  return (
    <PanelFrame
      id="ig-events"
      title={S.eventsTitle}
      lead={S.eventsLead}
      comments={data.comments}
      warning={S.eventsWarning}
      limits={S.eventsLimits}
      investigate={S.eventsInvestigate}
      metrics={
        <>
          {metric(spikes)}
          {metric(jumps)}
          {overlap ? <Metric label="Both / either type (by observation id)" value={`${overlap.both} / ${overlap.either} of ${overlap.total}`} detail={`${overlap.bothRatio === null ? "—" : f(100 * overlap.bothRatio, 3)}% carry both; ${overlap.eitherRatio === null ? "—" : f(100 * overlap.eitherRatio, 3)}% at least one (rates are not added)`} /> : null}
          <Metric label="Detection threshold" value={`${f(threshold)} robust deviations`} detail="Population-relative: each derivative is compared with the other spectra at the same band (engine option intrinsic_qc.outlier_threshold)." />
        </>
      }
    >
      <div className="ig-grid-2">
        {[spikes, jumps].map((s) => (s ? (
          <div key={s.type} className="ig-block">
            <h4>{NAMES[s.type]}: flagged vs not flagged</h4>
            <ProportionBar title={NAMES[s.type]} total={s.evaluated} f={f} segments={[{ label: "Flagged", count: s.affected, className: "seg-flagged" }, { label: "No flag", count: s.unaffected, className: "seg-clear" }]} />
            <Measured>{(w) => (
              <Histogram
                bins={s.histogram}
                width={w}
                height={180}
                integer
                title={`${NAMES[s.type]}: events per spectrum`}
                xLabel="events per spectrum"
                selected={bin?.type === s.type ? bin.index : null}
                onSelect={(i) => { setBand(null); setBin(i === null ? null : { type: s.type, index: i }); }}
                f={f}
              />
            )}</Measured>
            <ChartDataTable locale={locale} caption={`${NAMES[s.type]}: events per spectrum`} columns={["Events per spectrum", "Spectra"]} rows={s.histogram.map((b) => [b.hi - b.lo === 1 ? b.lo : `${b.lo}–${b.hi - 1}`, b.count])} />
          </div>
        ) : null))}
      </div>
      {axis ? (
        <div className="ig-block">
          <h4>Where events occur (frequency by band)</h4>
          <p className="hint">Number of spectra with an event at each band, atypical relative to the other spectra at the same band. Click a band (or use the arrow keys) to inspect the flagged spectra around it.</p>
          <Measured>{(w) => (
            <BandProfile
              axis={axis}
              width={w}
              height={210}
              title="Spike and jump counts by band"
              axisUnit={source.axis_unit ?? ""}
              yLabel="spectra flagged"
              selected={band}
              onSelect={(i) => { setBin(null); setBand(i); }}
              f={f}
              series={[
                ...(spikeBands ? [{ id: "spike", label: "peaks", values: spikeBands.counts, className: "ln-spike" }] : []),
                ...(jumpBands ? [{ id: "jump", label: "changes", values: jumpBands.counts, className: "ln-jump" }] : []),
              ]}
            />
          )}</Measured>
          <ul className="n4q-legend">
            {spikeBands ? <li><span className="ig-key ln-spike" aria-hidden="true" />Isolated peaks (solid line; a spike also counts on its two neighbouring bands)</li> : null}
            {jumpBands ? <li><span className="ig-key ln-jump" aria-hidden="true" />Abrupt changes (dashed line)</li> : null}
          </ul>
          <ChartDataTable locale={locale} caption="Spike and jump counts by band" columns={["Band", "Isolated peaks", "Abrupt changes", "Spectra evaluated"]} rows={axis.map((x, i) => [x, spikeBands?.counts[i] ?? null, jumpBands?.counts[i] ?? null, spikeBands?.evaluated[i] ?? jumpBands?.evaluated[i] ?? null])} />
        </div>
      ) : null}
      {explorer && inspected ? (
        <div className="ig-block">
          <h4>{inspected.caption}</h4>
          {band !== null && !bin ? (
            <label className="ig-inline">
              Zoom (± bands around the selected band): <input type="range" min={3} max={Math.max(3, Math.ceil(source.axis.length / 2))} value={halfWindow} onChange={(e) => setHalfWindow(Number(e.target.value))} aria-label="Zoom window half-width in bands" /> ±{halfWindow}
            </label>
          ) : null}
          {explorer.series.length ? (
            <Measured>{(w) => <SpectraExplorer axis={explorer.axis} axisUnit={source.axis_unit ?? ""} yLabel={source.signal_unit ?? "signal"} series={explorer.series} title={inspected.caption} locale={locale} width={w} height={260} />}</Measured>
          ) : <p className="note">No spectrum to show.</p>}
          <p className="hint">{explorer.total > MAX_DRAWN ? `Showing ${MAX_DRAWN} of ${explorer.total} spectra. ` : ""}Exact event positions within each spectrum are not reported, so no marker can be placed on the anomalies themselves; the view is centered on the selected band.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setBand(null); setBin(null); }}>Clear selection</button>
        </div>
      ) : null}
      <p className="note ig-unavailable" role="status">{S.heatmapUnavailable}</p>
    </PanelFrame>
  );
}
