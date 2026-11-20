// §5 Distance from the mean spectrum (spectral diversity; never coloured good/bad).
import { useMemo, useState } from "react";
import { ChartDataTable, SpectraExplorer } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { Histogram, PairBars, PairScatter } from "./charts";
import { makeFmt } from "./format";
import { SERIES_COLORS, scanLabel } from "./IntegrityPanel";
import { bandEnvelope, completeMatrix, rowsFor, topKOverlap, valueHistogram } from "./model";
import { Metric, PanelFrame } from "./PanelFrame";
import { runSnvComparison } from "./snv-client";
import { S } from "./strings";
import { diversityData } from "./summaries";

type SnvResult = { status: "idle" } | { status: "running" } | { status: "error"; message: string } | { status: "done"; ids: string[]; raw: (number | null)[]; snv: (number | null)[] };
/** A result belongs to the source (and input) it was computed on; a switch shows "idle" again. */
type SnvState = SnvResult & { of?: object };
const IDLE: SnvResult = { status: "idle" };

export function DiversityPanel(scope: Scope) {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const source = input.sources.find((s) => s.source_id === sourceId);
  const [snvState, setSnv] = useState<SnvState>(IDLE);
  const snv: SnvResult = snvState.of === source ? snvState : IDLE;
  const overlap = useMemo(() => (snv.status === "done" ? topKOverlap(snv.ids, snv.raw, snv.snv, 10) : null), [snv]);
  const data = useMemo(() => diversityData({ view, input, sourceId, locale }, overlap), [view, input, sourceId, locale, overlap]);
  const bins = useMemo(() => (data ? valueHistogram(data.stats.entries, 24) : []), [data]);
  const [bin, setBin] = useState<number | null>(null);
  // Mean spectrum and robust envelope over the spectra the engine evaluated (display aggregates).
  const envelope = useMemo(() => {
    if (!data || !source) return null;
    return bandEnvelope(source, rowsFor(source, data.stats.entries.map((e) => e.id)).map((r) => r.row));
  }, [data, source]);
  const overlay = useMemo(() => {
    if (!data || !source || !envelope) return null;
    const ids = bin !== null ? (bins[bin]?.ids ?? []) : [...data.stats.entries].sort((a, b) => b.value - a.value).slice(0, 5).map((e) => e.id);
    const rows = rowsFor(source, ids).slice(0, 10);
    return {
      total: ids.length,
      series: [
        { id: "__mean", label: "Mean spectrum", color: "#334155", values: envelope.mean },
        { id: "__p5", label: "P5 envelope", color: "#94a3b8", values: envelope.p5 },
        { id: "__p95", label: "P95 envelope", color: "#94a3b8", values: envelope.p95 },
        ...rows.map(({ id, row }, i) => ({ id, label: scanLabel(id), color: SERIES_COLORS[(i + 2) % SERIES_COLORS.length]!, values: source.x[row] ?? [] })),
      ],
    };
  }, [data, source, envelope, bin, bins]);
  if (!data || !source) return null;
  const { stats, unit } = data;
  const rel = (r: number | null) => (r === null ? "N/A" : `${f(r, 3)}× (${f(100 * r, 3)}% of the typical level)`);
  const runSnv = () => {
    const m = completeMatrix(source, rowsFor(source, stats.entries.map((e) => e.id)));
    if (m.rows < 3) {
      setSnv({ status: "error", message: "Fewer than 3 complete spectra: the comparison needs complete spectra.", of: source });
      return;
    }
    const ids = m.ids;
    setSnv({ status: "running", of: source });
    runSnvComparison(m).then((r) => setSnv({ status: "done", ids, raw: r.raw, snv: r.snv, of: source }), (e: Error) => setSnv({ status: "error", message: e.message, of: source }));
  };
  return (
    <PanelFrame
      id="ig-diversity"
      title={S.diversityTitle}
      lead={S.diversityLead}
      comments={data.comments}
      warning={S.diversityWarning}
      limits={S.diversityLimits}
      investigate={S.diversityInvestigate}
      metrics={
        <>
          <Metric label="Median distance" value={`${f(stats.median)} ${unit}`} detail={`over ${stats.n} spectra`} />
          <Metric label="95th percentile distance" value={`${f(stats.p95)} ${unit}`} detail={`relative: ${rel(stats.relativeP95)}`} />
          <Metric label="Maximum distance" value={`${f(stats.max)} ${unit}`} detail={`${scanLabel(stats.maxId)} · relative: ${rel(stats.relativeMax)}`} />
          <Metric label="Typical absolute signal level" value={stats.typicalLevel === null ? "not available" : `${f(stats.typicalLevel)} ${unit}`} detail="median over spectra of the mean absolute signal" />
        </>
      }
    >
      <div className="ig-grid-2">
        <div className="ig-block">
          <h4>Distribution of distances</h4>
          <Measured>{(w) => <Histogram bins={bins} width={w} height={190} title="Distance from the mean spectrum" xLabel={`RMS distance (${unit})`} markers={[{ value: stats.median, label: "P50" }, { value: stats.p95, label: "P95" }]} selected={bin} onSelect={setBin} f={f} />}</Measured>
          <p className="hint">Click a bar to overlay those spectra on the mean spectrum; by default the five most distant spectra are shown.</p>
          <ChartDataTable locale={locale} caption="Distance from the mean spectrum by spectrum" columns={["Sample", "Scan", `Distance (${unit})`]} rows={[...stats.entries].sort((a, b) => b.value - a.value).slice(0, 50).map((e) => [e.sampleId, scanLabel(e.id), e.value])} />
        </div>
        <div className="ig-block">
          <h4>P95 distance vs typical signal level</h4>
          {stats.typicalLevel !== null ? (
            <Measured>{(w) => <PairBars width={w} unit={unit} f={f} title="P95 distance and typical absolute signal level" rows={[{ label: "P95 distance", value: stats.p95 }, { label: "Typical signal level", value: Math.abs(stats.typicalLevel!) }]} />}</Measured>
          ) : <p className="note">The typical signal level is not available (noise family not computed).</p>}
          <p className="hint">Relative P95 distance: {rel(stats.relativeP95)}. This is a scale indication, not an error rate.</p>
        </div>
      </div>
      {overlay ? (
        <div className="ig-block">
          <h4>{bin !== null ? "Selected spectra vs mean spectrum and P5–P95 envelope" : "Most distant spectra vs mean spectrum and P5–P95 envelope"}</h4>
          <Measured>{(w) => <SpectraExplorer axis={source.axis} axisUnit={source.axis_unit ?? ""} yLabel={source.signal_unit ?? "signal"} series={overlay.series} title="Mean spectrum, robust envelope and selected spectra" locale={locale} width={w} height={260} />}</Measured>
          <p className="hint">Mean and band-wise P5/P95 are display aggregates over the evaluated spectra (grey lines: envelope; dark line: mean).{overlay.total > overlay.series.length - 3 ? ` Showing ${overlay.series.length - 3} of ${overlay.total} selected spectra.` : ""}</p>
        </div>
      ) : null}
      <div className="ig-block">
        <h4>Raw vs SNV distances</h4>
        <p className="hint">SNV removes each spectrum's offset and scale. Comparing which spectra stay far from the mean after SNV shows whether the dispersion comes from overall level or from spectral shape. Computed on demand with the Methods kernels (SNV, then the same distance kernel as the engine) on complete spectra only.</p>
        {snv.status === "idle" ? <button type="button" className="btn btn-ghost btn-sm" onClick={runSnv}>Compare with SNV distances</button> : null}
        {snv.status === "running" ? <p className="note" role="status">Computing SNV distances…</p> : null}
        {snv.status === "error" ? <p className="note" role="status">SNV comparison unavailable: {snv.message}</p> : null}
        {snv.status === "done" ? (
          <>
            <Measured>{(w) => <PairScatter width={w} title="Raw vs SNV distance from the mean spectrum" xLabel={`raw distance (${unit})`} yLabel="SNV distance (SNV units)" f={f} points={snv.ids.flatMap((id, i) => (snv.raw[i] != null && snv.snv[i] != null ? [{ id: scanLabel(id), x: snv.raw[i]!, y: snv.snv[i]! }] : []))} />}</Measured>
            {overlap ? <p className="hint">{overlap.kept} of the {overlap.k} spectra farthest from the mean in raw units remain among the {overlap.k} farthest after SNV (ranks only: the two distances have different units).</p> : null}
          </>
        ) : null}
      </div>
    </PanelFrame>
  );
}
