// §4 Estimated signal-to-noise ratio, with documentary instrument references.
import { useMemo, useState } from "react";
import { ChartDataTable, SpectraExplorer } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { SNR_BANDS, dbToRelativeNoisePercent, quantile } from "../shared/derive";
import { Histogram, InstrumentPlot, SnrGauge } from "./charts";
import { makeFmt } from "./format";
import { INSTRUMENT_DISCLAIMER, INSTRUMENT_REFERENCES, NON_CONVERTIBLE_REFERENCES, referenceDb } from "./instruments";
import { SERIES_COLORS, scanLabel } from "./IntegrityPanel";
import { rowsFor, valueHistogram } from "./model";
import { Metric, PanelFrame } from "./PanelFrame";
import { S } from "./strings";
import { snrData } from "./summaries";

export function SnrPanel(scope: Scope) {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const data = useMemo(() => snrData({ view, input, sourceId, locale }), [view, input, sourceId, locale]);
  const bins = useMemo(() => (data ? valueHistogram(data.stats.entries, 24) : []), [data]);
  const contrastBins = useMemo(() => (data?.contrast?.length ? valueHistogram(data.contrast, 24) : []), [data]);
  const [bin, setBin] = useState<number | null>(null);
  const source = input.sources.find((s) => s.source_id === sourceId);
  const selected = useMemo(() => {
    if (!source || !data) return null;
    const ids = bin !== null ? (bins[bin]?.ids ?? []) : data.stats.noisiest.slice(0, 6).map((n) => n.observationId);
    const rows = rowsFor(source, ids).slice(0, 12);
    return { total: ids.length, series: rows.map(({ id, row }, i) => ({ id, label: scanLabel(id), color: SERIES_COLORS[i % SERIES_COLORS.length]!, values: source.x[row] ?? [] })) };
  }, [source, data, bin, bins]);
  if (!data || !source) return null;
  const { stats } = data;
  const p = stats.p;
  return (
    <PanelFrame
      id="ig-snr"
      title={S.snrTitle}
      lead={S.snrLead}
      comments={data.comments}
      limits={[S.snrDefinition, ...S.snrLimits, S.contrastNote]}
      investigate={S.snrInvestigate}
      metrics={
        <>
          <Metric label="Estimated SNR (median)" value={`${f(stats.medianDb, 3)} dB`} detail={`median over ${stats.n} spectra`} />
          <Metric label="Linear SNR" value={`≈ ${f(stats.linear, 3)}:1`} detail="10^(SNR/20)" />
          <Metric label="Estimated relative noise" value={`≈ ${f(stats.relativeNoisePercent, 3)}%`} detail="100 × 10^(−SNR/20), of the mean absolute signal" />
          <Metric label="Per-spectrum SNR quantiles (dB)" value={`P5 ${f(p.p5, 3)} · P50 ${f(p.p50, 3)} · P95 ${f(p.p95, 3)}`} detail={`P25 ${f(p.p25, 3)} · P75 ${f(p.p75, 3)}`} />
          {data.contrastMedianDb !== null ? <Metric label="Contrast-based SNR (median, interim)" value={`${f(data.contrastMedianDb, 3)} dB`} detail={`[Q95 − Q5]/σ over ${data.contrast?.length ?? 0} spectra`} /> : null}
        </>
      }
    >
      <div className="ig-block">
        <h4>Relative fine-scale variation — indicative scale</h4>
        <Measured>{(w) => <SnrGauge db={stats.medianDb} p5={p.p5} p95={p.p95} width={w} f={f} />}</Measured>
        <p className="hint">Indicative interpretation of the median: <strong>{stats.band}</strong> relative noise. {S.snrBandsNote} The thin bar under the scale spans the P5–P95 of per-spectrum values. {S.snrCompare}</p>
        <ChartDataTable
          locale={locale}
          caption="Indicative SNR bands (heuristic, not validated thresholds)"
          columns={["SNR (dB)", "Relative noise", "Indicative relative noise"]}
          rows={SNR_BANDS.map((b, i) => {
            const lo = i === 0 ? null : SNR_BANDS[i - 1]!.maxDb;
            const hi = Number.isFinite(b.maxDb) ? b.maxDb : null;
            const pc = (db: number) => `${f(dbToRelativeNoisePercent(db), 3)}%`;
            if (lo === null) return [`< ${hi}`, `> ${pc(hi!)}`, b.label];
            if (hi === null) return [`> ${lo}`, `< ${pc(lo)}`, b.label];
            return [`${lo}–${hi}`, `${pc(hi)}–${pc(lo)}`, b.label];
          })}
        />
      </div>
      <div className="ig-grid-2">
        <div className="ig-block">
          <h4>Distribution of per-spectrum SNR</h4>
          <Measured>{(w) => <Histogram bins={bins} width={w} height={190} title="Per-spectrum estimated SNR (dB)" xLabel="SNR (dB)" markers={[{ value: p.p5, label: "P5" }, { value: p.p50, label: "P50" }, { value: p.p95, label: "P95" }]} selected={bin} onSelect={setBin} f={f} />}</Measured>
          <p className="hint">Click a bar to show those spectra below; by default the lowest-SNR spectra are shown.</p>
        </div>
        <div className="ig-block">
          <h4>Lowest estimated SNR</h4>
          <ChartDataTable locale={locale} open caption="Spectra with the lowest estimated SNR" columns={["Sample", "Scan", "SNR (dB)", "Relative noise (%)"]} rows={stats.noisiest.map((n) => [n.sampleId, scanLabel(n.observationId), n.db, dbToRelativeNoisePercent(n.db)])} />
        </div>
      </div>
      {selected?.series.length ? (
        <div className="ig-block">
          <h4>{bin !== null ? "Spectra in the selected SNR range" : "Lowest-SNR spectra"}</h4>
          <Measured>{(w) => <SpectraExplorer axis={source.axis} axisUnit={source.axis_unit ?? ""} yLabel={source.signal_unit ?? "signal"} series={selected.series} title="Spectra by estimated SNR" locale={locale} width={w} height={240} />}</Measured>
          {selected.total > selected.series.length ? <p className="hint">Showing {selected.series.length} of {selected.total} spectra.</p> : null}
        </div>
      ) : null}
      {contrastBins.length ? (
        <div className="ig-block">
          <h4>Contrast-based SNR (interim)</h4>
          <Measured>{(w) => <Histogram bins={contrastBins} width={w} height={170} title="Per-spectrum contrast-based SNR (dB)" xLabel="contrast SNR (dB)" markers={[{ value: quantile(data.contrast!.map((c) => c.value), 0.5)!, label: "P50" }]} f={f} />}</Measured>
          <p className="hint">{S.contrastNote}</p>
        </div>
      ) : null}
      <details className="ig-details ig-instruments">
        <summary>{S.instrumentsTitle}</summary>
        <p className="ig-warning" role="note">{INSTRUMENT_DISCLAIMER}</p>
        <Measured>{(w) => <InstrumentPlot refs={INSTRUMENT_REFERENCES} datasetDb={stats.medianDb} width={w} f={f} />}</Measured>
        <ul className="n4q-legend">
          <li><span className="ig-key ig-key-diamond" aria-hidden="true" />Diamond: this dataset (estimator on real samples, median)</li>
          <li><span className="ig-key ig-key-circle" aria-hidden="true" />Circle: manufacturer specification</li>
          <li><span className="ig-key ig-key-square" aria-hidden="true" />Square: independent study (Unity Scientific 2014 data)</li>
        </ul>
        <p className="hint">dB values of the references are an indicative documentary conversion 20·log10(S/N), assuming amplitude ratios; protocols, durations and noise definitions are not harmonised. These references do not define the gauge bands above.</p>
        <ChartDataTable
          locale={locale}
          caption="Instrument references (published figures)"
          columns={["Manufacturer", "Model", "Published S/N", "Indicative dB", "Condition", "Spectral range", "Protocol", "Status", "Source", "Comparison limits"]}
          rows={INSTRUMENT_REFERENCES.map((r) => [r.manufacturer, r.model, r.snr === null ? null : `${r.snr.toLocaleString("en")} (${r.unit})`, referenceDb(r), r.condition, r.spectralRange, r.protocol, r.verified ? "verified" : "not verified", r.source.url ? `${r.source.title} — ${r.source.url}` : r.source.title, r.limits])}
        />
        <h4>Not convertible to an SNR</h4>
        <ul className="ig-plain">
          {NON_CONVERTIBLE_REFERENCES.map((r) => <li key={r.id}><strong>{r.manufacturer} {r.model}</strong>: {r.published} {r.limits} Source: <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.title}</a>.</li>)}
        </ul>
      </details>
    </PanelFrame>
  );
}
