// Rubric building blocks (wave 2): each hook returns the typed pieces the page composes per rubric
// (KPI strip → headline visual → interpretation → per-spectrum distributions → aligned per-band
// tracks → spectra inspection → collapsed details). Selection state lives in the hook, so a
// histogram bin or a band range picked in the page's AlignedTracks drives the inspection view.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChartDataTable, ScoreMap, SpectraExplorer, extractIntrinsic, reasonLabel, type IntrinsicSignatures, type ScorePoint } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { atypicalSpectra } from "../../views";
import { SNR_BANDS, dbToLinear, dbToRelativeNoisePercent, quantile, snrBand } from "../shared/derive";
import { BoxPlotRows, ChartCard, DotPlot, DualScaleGauge, EmptyState, Histogram, KpiStrip, ProportionBars, Responsive, ValueBars, type BoxRow, type DotRow, type KpiItem } from "../shared/charts";
import { commentOf, type RubricBlock, type RubricBlocks, type RubricComment } from "../shared/blocks";
import { AlignedTracks, type BandSelection, type Track } from "../repeatability/AlignedTracks";
import { makeFmt } from "./format";
import { NOISE_BENCHMARK } from "./noiseBenchmark";
import { INSTRUMENT_DISCLAIMER, INSTRUMENT_REFERENCES, NON_CONVERTIBLE_REFERENCES, referenceDb } from "./instruments";
import { addIllustrativeNoise, bandEnvelope, countHistogram, completeMatrix, gaussianSequence, medianSnrSpectrum, rowsFor, topKOverlap, valueHistogram, type EventStats, type HistogramBin } from "./model";
import { runSnvComparison, type PcaProjection } from "./snv-client";
import "./integrity.css";
import { S } from "./strings";
import { diversityData, integrityData, snrData } from "./summaries";

/** K's rubric contract plus A's band-selection hook-up and a title/lead for the standalone panels. */
export type ABlocks = RubricBlocks & { title: string; lead: string; comments: RubricComment[]; inspection: RubricBlock[]; details: RubricBlock[] };

const comment = (prefix: string, tone: RubricComment["tone"]) => (text: string, i: number): RubricComment => ({ id: `${prefix}-${i}`, text, tone });

export const SERIES_COLORS = ["#0f766e", "#b45309", "#4338ca", "#be123c", "#0369a1", "#4d7c0f", "#7c3aed", "#a16207", "#0e7490", "#9d174d", "#15803d", "#1d4ed8"];
const MAX_DRAWN = 12;

/** Label of a demo observation id `[source, partition, row, declared id]`: declared id, else "partition #row". */
export function scanLabel(observationId: string): string {
  try {
    const [, part, row, declared] = JSON.parse(observationId) as [number, string, number, string | null];
    return declared ?? `${part} #${row + 1}`;
  } catch {
    return observationId;
  }
}

const NAMES = { spike: "Isolated peaks", jump: "Abrupt changes" } as const;
const SINGULAR = { spike: "isolated peak", jump: "abrupt change" } as const;

function Collapsible({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="ig-details" open={open}>
      <summary>{title}</summary>
      <div className="ig-visual">{children}</div>
    </details>
  );
}

function DetailLists({ title, methodology, limits, investigate, warning }: { title: string; methodology: readonly ReactNode[]; limits: readonly string[]; investigate: readonly string[]; warning?: string }) {
  return (
    <div className="ig-visual">
      <h5 className="ig-sub">{title}</h5>
      {warning ? <p className="ig-warning" role="note">{warning}</p> : null}
      <Collapsible title="Methodology"><ul>{methodology.map((m, i) => <li key={i}>{m}</li>)}</ul></Collapsible>
      <Collapsible title="Methodological limitations"><ul>{limits.map((l) => <li key={l}>{l}</li>)}</ul></Collapsible>
      <Collapsible title="Suggested investigation"><ul>{investigate.map((l) => <li key={l}>{l}</li>)}</ul></Collapsible>
    </div>
  );
}

const uniqueLabel = (label: string, i: number, all: readonly string[]) => (all.indexOf(label) === i ? label : `${label} (${i + 1})`);

/** Overlay of picked spectra (labels never show raw JSON ids). */
function SpectraView({ scope, title, ids, extra = [], range, hint }: {
  scope: Scope;
  title: string;
  ids: readonly string[];
  extra?: { id: string; label: string; color: string; values: readonly (number | null)[] }[];
  range?: [number, number] | null;
  hint?: string;
}) {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  if (!source) return null;
  const rows = rowsFor(source, ids).slice(0, MAX_DRAWN);
  const [lo, hi] = range ?? [0, source.axis.length - 1];
  const series = [
    ...extra.map((e) => ({ ...e, values: e.values.slice(lo, hi + 1) })),
    // Series ids show in the explorer's data table: use readable scan labels (unique), never raw JSON ids.
    ...rows.map(({ id, row }, i) => ({ id: uniqueLabel(scanLabel(id), i, rows.map((r) => scanLabel(r.id))), label: scanLabel(id), color: SERIES_COLORS[i % SERIES_COLORS.length]!, values: (source.x[row] ?? []).slice(lo, hi + 1) })),
  ];
  if (!series.length) return <EmptyState>No spectrum to show.</EmptyState>;
  return (
    <ChartCard title={title} subtitle={`${ids.length > rows.length ? `Showing ${rows.length} of ${ids.length} spectra. ` : ""}${hint ?? ""}`}>
      <Responsive>{(w) => <SpectraExplorer axis={source.axis.slice(lo, hi + 1)} axisUnit={source.axis_unit ?? ""} yLabel={source.signal_unit ?? "signal"} series={series} title={title} locale={scope.locale} width={w} height={260} />}</Responsive>
    </ChartCard>
  );
}

// --- spectral integrity: isolated peaks and abrupt changes -------------------------------------

const SIGNAL_NAMES: Record<string, string> = {
  "events.declared_clip_count": "Declared clipping (count)",
  "events.declared_clip_fraction": "Declared clipping (fraction)",
  "events.spike_count": "Isolated peaks",
  "events.jump_count": "Abrupt changes",
  "noise.signal_noise_db": "Estimated SNR",
  "reference.rms": "Distance from the mean spectrum",
  "pca.pca_t2": "T²",
  "pca.pca_q": "Q",
};

/** Readable "name: reason" lines for the intrinsic signals the engine did not compute (never raw metric ids). */
export function unavailableSignals(intrinsic: IntrinsicSignatures | null): string[] {
  if (!intrinsic) return [];
  return Object.values(intrinsic.signals)
    .filter((s) => s.state.status !== "computed" && /^(pca|events|noise|reference)\./.test(s.id))
    .map((s) => `${SIGNAL_NAMES[s.id] ?? s.id.replace(/^[a-z]+\./, "").replace(/_/g, " ")}: ${s.state.reasonCode ? reasonLabel(s.state.reasonCode) : s.state.status.replace(/_/g, " ")}`);
}

/** Histogram of flagged spectra only (≥ 1 event): spectra without event are stated in text instead. */
export const flaggedBins = (s: EventStats): HistogramBin[] =>
  countHistogram(s.ranked.map((r) => ({ id: r.observationId, value: r.count }))).filter((b) => b.hi > 1).map((b) => (b.lo === 0 ? { ...b, lo: 1 } : b));

export function useIntegrityBlocks(scope: Scope): ABlocks | null {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const data = useMemo(() => integrityData({ view, input, sourceId, locale }), [view, input, sourceId, locale]);
  const [bin, setBin] = useState<{ type: "spike" | "jump"; index: number } | null>(null);
  const [band, setBand] = useState<BandSelection | null>(null);
  const onBandSelect = useCallback((sel: BandSelection | null) => { setBin(null); setBand(sel); }, []);
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (!data || !source) return null;
  const { spikes, jumps, overlap, spikeBands, jumpBands, threshold } = data;
  const types = [spikes, jumps].filter((s): s is EventStats => s !== null);
  const evaluated = Math.max(0, ...types.map((s) => s.evaluated));
  const anyFlag = types.some((s) => s.affected > 0);
  const pctOf = (s: EventStats) => (s.affectedRatio === null ? null : 100 * s.affectedRatio);

  const kpis: KpiItem[] = types.map((s) => ({
    label: NAMES[s.type],
    value: pctOf(s) === null ? "—" : f(pctOf(s)!, 3),
    unit: " %",
    bar: pctOf(s),
    tone: s.type === "spike" ? "copper" : "teal",
    sub: s.affected ? `${s.affected}/${s.evaluated} spectra · ${f(s.events)} events · ${f(s.perAffected!, 3)} per flagged spectrum` : `none of ${s.evaluated} spectra`,
  }));
  if (overlap && anyFlag) kpis.push({ label: "Both types", value: overlap.both, unit: ` / ${overlap.total}`, tone: "grey", sub: `${overlap.either} with at least one type (${overlap.eitherRatio === null ? "—" : f(100 * overlap.eitherRatio, 3)} %)` });

  const distributions: RubricBlock[] = [];
  // Zero events: the interpretation bullets already say so; no chart and no duplicate message.
  if (types.length && anyFlag) {
    distributions.push({
      id: "events-share",
      span: "full",
      node: anyFlag ? (
        <ChartCard title={`Flagged spectra / ${evaluated}`} subtitle={`Share of spectra with at least one event (threshold ${f(threshold)} robust deviations). Shapes are illustrative.`}>
          <ProportionBars
            total={evaluated}
            fmt={f}
            rows={[
              ...types.map((s) => ({ label: NAMES[s.type], count: s.affected, glyph: s.type === "spike" ? ("peak" as const) : ("jump" as const), tone: s.type === "spike" ? ("copper" as const) : ("teal" as const) })),
              ...(overlap ? [{ label: "Either type", count: overlap.either, tone: "grey" as const }] : []),
            ]}
          />
        </ChartCard>
      ) : (
        <EmptyState>No isolated peak or abrupt change flagged in {evaluated} spectra (threshold {f(threshold)} robust deviations).</EmptyState>
      ),
    });
  }
  if (anyFlag) {
    for (const s of types) {
      distributions.push({
        id: `events-${s.type}`,
        node: s.affected ? (
          <ChartCard title={`${NAMES[s.type]}: events per flagged spectrum`} subtitle={`${s.affected} flagged spectra (${s.unaffected} without event not drawn). Click a bar to inspect.`}>
            <Histogram
              bins={flaggedBins(s)}
              height={170}
              integer
              tone={s.type === "spike" ? "copper" : "teal"}
              title={`${NAMES[s.type]}: events per flagged spectrum`}
              xLabel="events per spectrum"
              selected={bin?.type === s.type ? bin.index : null}
              onSelect={(i) => { setBand(null); setBin(i === null ? null : { type: s.type, index: i }); }}
              fmt={f}
            />
          </ChartCard>
        ) : <EmptyState>No {SINGULAR[s.type]} flagged in {s.evaluated} spectra.</EmptyState>,
      });
    }
  }

  const bandTracks: Track[] = [];
  for (const [b, type] of [[spikeBands, "spike"], [jumpBands, "jump"]] as const) {
    if (!b || !b.counts.some((c) => c > 0)) continue;
    bandTracks.push({
      id: `events-${type}-bands`,
      title: `${NAMES[type]}: spectra flagged per band`,
      unit: "spectra",
      height: 80,
      includeZero: true,
      nonEvaluable: b.evaluated.map((e) => e === 0),
      series: [{ id: type, label: NAMES[type], values: b.counts, kind: "bars", color: type === "spike" ? "var(--cz-copper)" : "var(--cz-teal)" }],
    });
  }

  // Inspection: a histogram bin, a band range (zoomed), else the spectra with the most events.
  const ranked = new Map<string, number>();
  for (const s of types) for (const r of s.ranked) ranked.set(r.observationId, (ranked.get(r.observationId) ?? 0) + r.count);
  const byCount = [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  let view0: ReactNode = null;
  if (bin) {
    const s = bin.type === "spike" ? spikes : jumps;
    const b = s ? flaggedBins(s)[bin.index] : undefined;
    if (b) view0 = <SpectraView scope={scope} title={`${NAMES[bin.type]}: spectra with ${b.hi - b.lo === 1 ? b.lo : `${b.lo}–${b.hi - 1}`} event(s)`} ids={b.ids} />;
  } else if (band && byCount.length) {
    const margin = Math.max(3, Math.round((band.i1 - band.i0) / 2));
    const range: [number, number] = [Math.max(0, band.i0 - margin), Math.min(source.axis.length - 1, band.i1 + margin)];
    view0 = <SpectraView scope={scope} title={`Flagged spectra around ${f(band.from)}–${f(band.to)} ${source.axis_unit ?? ""}`} ids={byCount} range={range} hint="Most events first. Exact event positions are not reported, so the view is centred on the selected bands." />;
  } else if (byCount.length) {
    view0 = <SpectraView scope={scope} title="Spectra with the most flagged events" ids={byCount.slice(0, 6)} hint="Click a histogram bar or select bands in the profile to change the selection." />;
  }

  const missing = unavailableSignals(sourceId ? extractIntrinsic(view, sourceId) : null);
  const details: RubricBlock[] = [
    ...(missing.length ? [{ id: "events-unavailable", node: <p className="ig-caption">Not evaluated: {missing.join(" · ")}.</p> }] : []),
    {
      id: "events-method",
      node: (
        <DetailLists
          title={S.eventsTitle}
          warning={S.eventsWarning}
          methodology={[
            `Threshold: ${f(threshold)} robust deviations (engine option intrinsic_qc.outlier_threshold). Each derivative is compared with the other spectra at the same band.`,
            "In the band profile a spike also counts on its two neighbouring bands; band counts are therefore not event counts.",
            S.heatmapUnavailable,
          ]}
          limits={S.eventsLimits}
          investigate={S.eventsInvestigate}
        />
      ),
    },
    {
      id: "events-tables",
      node: (
        <Collapsible title="Isolated peaks and abrupt changes: data tables">
          {types.map((s) => <ChartDataTable key={s.type} locale={locale} caption={`${NAMES[s.type]}: events per spectrum`} columns={["Events per spectrum", "Spectra"]} rows={s.histogram.map((b) => [b.hi - b.lo === 1 ? b.lo : `${b.lo}–${b.hi - 1}`, b.count])} />)}
          {spikeBands || jumpBands ? <ChartDataTable locale={locale} caption="Spike and jump counts by band" columns={["Band", "Isolated peaks", "Abrupt changes", "Spectra evaluated"]} rows={(spikeBands ?? jumpBands)!.axis.map((x, i) => [x, spikeBands?.counts[i] ?? null, jumpBands?.counts[i] ?? null, spikeBands?.evaluated[i] ?? jumpBands?.evaluated[i] ?? null])} /> : null}
          {byCount.length ? <ChartDataTable locale={locale} caption="Flagged spectra (most events first)" columns={["Scan", "Isolated peaks", "Abrupt changes"]} rows={byCount.slice(0, 50).map((id) => [scanLabel(id), spikes?.ranked.find((r) => r.observationId === id)?.count ?? 0, jumps?.ranked.find((r) => r.observationId === id)?.count ?? 0])} /> : null}
        </Collapsible>
      ),
    },
  ];
  return {
    id: "integrity",
    title: S.eventsTitle,
    lead: S.eventsLead,
    kpis,
    comments: data.comments.map(comment("integrity", anyFlag ? "attention" : "neutral")),
    distributions,
    bandTracks,
    onBandSelect,
    inspection: view0 ? [{ id: "events-spectra", node: view0 }] : [],
    details,
  };
}

// --- spectral integrity: in-sample T² / Q atypical spectra ------------------------------------

const ATYPICAL_MAX = 20;

/** T²/Q atypical spectra (moved from Blocks.tsx SpectralQualitySection); merged into the integrity rubric. */
export function useAtypicalBlocks(scope: Scope): ABlocks | null {
  const { t, locale, view, sourceId } = scope;
  const intrinsic = useMemo(() => (sourceId ? extractIntrinsic(view, sourceId) : null), [view, sourceId]);
  const f = useMemo(() => makeFmt(locale), [locale]);
  const t2 = intrinsic?.signals["pca.pca_t2"];
  const q = intrinsic?.signals["pca.pca_q"];
  const ready = t2?.state.status === "computed" && q?.state.status === "computed";
  const atypical = useMemo(() => (ready ? atypicalSpectra(t2!, q!) : []), [ready, t2, q]);
  if (!ready || !t2 || !q) return null;
  const flagged = new Set(atypical.map((a) => a.observationId));
  const typical = t("qualityTypical");
  const beyond = t("qualityAtypical");
  const points: ScorePoint[] = t2.values.flatMap((value, i) => {
    const residual = q.values[i];
    if (value === null || residual === null || residual === undefined) return [];
    const id = t2.observationIds[i] ?? "";
    return [{ id: scanLabel(id), details: [t2.sampleIds[i] ?? ""], x: value, y: residual, group: flagged.has(id) ? beyond : typical }];
  });
  const n = points.length;
  const kpis: KpiItem[] = [{ label: "Atypical spectra (T² or Q)", value: atypical.length, unit: ` / ${n}`, bar: n ? (100 * atypical.length) / n : null, tone: "copper", sub: `T² > ${f(t2.p95 ?? NaN)} or Q > ${f(q.p95 ?? NaN)} (95th percentiles)` }];
  const map = (
    <ChartCard title={t("qualityMap")} subtitle={t("qualityMapHint")}>
      <Responsive>{(w) => (
        <ScoreMap
          width={w}
          height={Math.min(360, Math.max(260, w * 0.62))}
          points={points}
          colorBy="group"
          groupColors={{ [typical]: "#3f7f84", [beyond]: "#b46a2e" }}
          xLabel="T²"
          yLabel="Q"
          xReference={t2.p95 === null ? null : { value: t2.p95, label: "T² 95th percentile" }}
          yReference={q.p95 === null ? null : { value: q.p95, label: "Q 95th percentile" }}
          colorLabel={t("qualityMap")}
          title={t("qualityMap")}
          locale={locale}
        />
      )}</Responsive>
    </ChartCard>
  );
  const list = atypical.length ? (
    <>
      <SpectraView scope={scope} title={t("qualityList")} ids={atypical.slice(0, 6).map((a) => a.observationId)} hint="The most atypical first (largest excess over a 95th percentile)." />
      <ChartDataTable
        locale={locale}
        caption={`${t("qualityList")}${atypical.length > ATYPICAL_MAX ? ` — first ${ATYPICAL_MAX} of ${atypical.length}` : ""}`}
        columns={[t("sampleCol"), t("scanCol"), "T²", "Q"]}
        rows={atypical.slice(0, ATYPICAL_MAX).map((a) => [a.sampleId, scanLabel(a.observationId), a.t2, a.q])}
      />
    </>
  ) : <EmptyState>{t("qualityNone")}</EmptyState>;
  return {
    id: "atypical",
    title: t("qualityTitle"),
    lead: t("qualityLead"),
    kpis,
    comments: atypical.length ? [comment("atypical", "info")(`${atypical.length} of ${n} spectra (${f((100 * atypical.length) / n, 3)} %) exceed the in-sample 95th percentile of T² or Q; by construction about 5 % exceed each one.`, 0)] : [],
    distributions: [],
    bandTracks: [],
    inspection: [{ id: "atypical-map", span: "half", node: map }, { id: "atypical-list", span: "half", node: list }],
    details: [{ id: "atypical-method", node: <DetailLists title="Atypical spectra (T² / Q)" methodology={["T² measures distance within the PCA space; Q measures what the components do not explain. Limits are the in-sample 95th percentiles of each statistic, not calibrated control limits."]} limits={["About 5 % of spectra exceed each in-sample 95th percentile by construction; exceeding it is an inspection prompt, not a defect."]} investigate={["Overlay the atypical spectra on typical ones and check their acquisition metadata."]} /> }],
  };
}

// --- spectral noise: estimated SNR -----------------------------------------------------------

/** Seven indicative bands (derive.ts SNR_BANDS, low dB first): copper-red = more estimated noise → green = less. */
const GAUGE_COLORS = SNR_BANDS.map((_, i) => `var(--ig-noise-${i})`);
/** Every SNR (dB) axis of this section reads left = less noise (high dB), right = more noise. */
const NOISE_ENDS = { left: "Less noise", right: "More noise" };

function SnrGaugeCard({ db, p5, p95, f }: { db: number; p5: number; p95: number; f: (v: number, d?: number) => string }) {
  const bands = SNR_BANDS.map((b, i) => ({ from: i === 0 ? 0 : SNR_BANDS[i - 1]!.maxDb, to: Number.isFinite(b.maxDb) ? b.maxDb : 100, label: b.label, color: GAUGE_COLORS[i]! }));
  const ticks = [0, 20, 40, 60, 80, 100].map((v) => ({ value: v, top: v === 100 ? "100 dB" : String(v), bottom: `${f(dbToRelativeNoisePercent(v), 3)} %` }));
  return (
    <ChartCard title="Relative fine-scale noise — indicative scale" subtitle={`Median: ${snrBand(db).toLowerCase()} relative noise; thin bar: P5–P95 of spectra (${f(p5, 3)}–${f(p95, 3)} dB). Top: SNR in dB; bottom: relative noise in % of the mean absolute signal. Band names describe estimated relative noise; heuristic, not validated quality thresholds, independent of instrument references.`}>
      <DualScaleGauge reversed ends={NOISE_ENDS} value={db} min={0} max={100} bands={bands} ticks={ticks} range={{ from: p5, to: p95, label: "P5–P95" }} markerLabel={`${f(db, 3)} dB | ${f(dbToRelativeNoisePercent(db), 3)} %`} ariaLabel={`Median estimated SNR ${f(db, 3)} dB, relative noise ${f(dbToRelativeNoisePercent(db), 3)} %, indicative band: ${snrBand(db).toLowerCase()} relative noise. Scale from less noise (left, high dB) to more noise (right, low dB).`} />
    </ChartCard>
  );
}

/** Position of a value against a reference P5–P95 interval, in words. */
export const benchmarkPosition = (db: number, r: { p5: number; p95: number }) => (db > r.p95 ? "above its P95 (less noise)" : db < r.p5 ? "below its P5 (more noise)" : "within its P5–P95");

/** Chat §4: this dataset against the same engine estimator computed on bundled public datasets (noiseBenchmark.ts). */
export function NoiseBenchmarkCard({ medianDb, p, n, f, locale }: { medianDb: number; p: { p5: number; p25: number; p50: number; p75: number; p95: number }; n: number; f: (v: number, d?: number) => string; locale: Scope["locale"] }) {
  const refs = NOISE_BENCHMARK.rows;
  if (!refs.length) return <EmptyState>No public reference dataset has been computed with this estimator yet.</EmptyState>;
  // The analysed dataset may itself be a bundled reference (same count and median): mark it instead of duplicating.
  const self = refs.find((r) => r.n === n && Math.abs(r.p50 - medianDb) < 0.01);
  const undocumented = refs.filter((r) => !r.instrument).length;
  const rows: BoxRow[] = [
    ...(self ? [] : [{ label: "This dataset", sub: "analysed now", n, emphasis: true, stats: { lo: p.p5, q1: p.p25, median: p.p50, q3: p.p75, hi: p.p95 } }]),
    ...refs.map((r) => ({
      label: r.instrument ?? r.dataset,
      sub: `${r === self ? "this dataset · " : ""}${r.instrument ? r.dataset : "instrument not documented"}`,
      n: r.n,
      emphasis: r === self,
      stats: { lo: r.p5, q1: r.p25, median: r.p50, q3: r.p75, hi: r.p95 },
    })),
  ];
  const coverage = `${refs.length} public reference dataset${refs.length === 1 ? "" : "s"} (those bundled with this demo)${undocumented ? `; instrument not documented for ${undocumented === refs.length ? "any of them" : undocumented}` : ""}. Not a representative instrument benchmark; no percentile is reported.`;
  return (
    <ChartCard title="Empirical noise benchmark (public datasets)" subtitle="The same engine estimator (per-spectrum SNR) on documented public NIR datasets. Box: P25–P75 with the median bar; whiskers: P5–P95; dashed line: median of this dataset." footnote={`Computed ${NOISE_BENCHMARK.generated} with Preflight engine ${NOISE_BENCHMARK.engine} and Methods ${NOISE_BENCHMARK.methods} (demo/scripts/noise-benchmark.test.ts). Differences also reflect matrix, spectral range, resolution and signal representation, not only the instrument.`}>
      <p className="ig-bench-coverage" role="note">{coverage}</p>
      <BoxPlotRows rows={rows} reference={{ value: medianDb, label: `${f(medianDb, 3)} dB` }} referenceLegend="This dataset (median)" axisLabel="SNR (dB)" reversed ends={NOISE_ENDS} fmt={f} title="Per-spectrum estimated SNR: this dataset and public reference datasets" />
      <Collapsible title="Reference datasets: provenance and values">
        <ChartDataTable
          locale={locale}
          caption="Empirical noise references (per-spectrum engine SNR, dB)"
          columns={["Dataset", "Instrument", "Matrix", "Measurement", "Spectral axis", "Bands", "Spectra analysed", "Min", "P5", "P25", "Median", "P75", "P95", "Max", "This dataset's median", "Source"]}
          rows={refs.map((r) => [r.dataset, r.instrument ?? "not documented", r.matrix, r.measurement, r.axis, r.bands, `${r.n} of ${r.spectra}${r.n === r.developmentSpectra ? " (development partition)" : ""}`, r.min, r.p5, r.p25, r.p50, r.p75, r.p95, r.max, r === self ? "this dataset" : benchmarkPosition(medianDb, r), r.source])}
        />
      </Collapsible>
    </ChartCard>
  );
}

const SIM_PRESETS = [10, 20, 30, 40, 60, 80];

/** Chat §5: what a given SNR looks like, on a real spectrum of the dataset plus known simulated noise. */
function NoiseIllustration({ scope, spectrumId, datasetDb, f }: { scope: Scope; spectrumId: string; datasetDb: number; f: (v: number, d?: number) => string }) {
  const [db, setDb] = useState(() => Math.round(datasetDb * 10) / 10);
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const row = source ? rowsFor(source, [spectrumId])[0] : undefined;
  const base = row && source ? source.x[row.row] ?? [] : [];
  const draws = useMemo(() => gaussianSequence(Math.max(1, base.length)), [base.length]);
  const noisy = useMemo(() => addIllustrativeNoise(base, db, draws), [base, db, draws]);
  if (!source || !row || !noisy) return <EmptyState>No complete reference spectrum for the illustration.</EmptyState>;
  return (
    <ChartCard title="What does a given SNR look like?" subtitle={`Illustration: spectrum ${scanLabel(spectrumId)} (median SNR of the dataset) plus simulated Gaussian noise of known σ = mean|x| × 10^(−SNR/20). The original spectrum already contains its own noise.`}>
      <div className="ig-sim-controls">
        <label htmlFor="ig-sim-db">Simulated SNR</label>
        <input id="ig-sim-db" type="range" min={5} max={80} step={0.5} value={db} onChange={(e) => setDb(Number(e.target.value))} />
        <strong className="cz-t-num">{f(db, 3)} dB · {f(dbToRelativeNoisePercent(db), 3)} %</strong>
      </div>
      <div className="ig-presets" role="group" aria-label="Preset SNR values">
        {[...SIM_PRESETS, Math.round(datasetDb * 10) / 10].sort((a, b) => a - b).map((v) => (
          <button key={v} type="button" className="btn btn-ghost btn-sm" aria-pressed={db === v} onClick={() => setDb(v)}>{v === Math.round(datasetDb * 10) / 10 ? `${f(v, 3)} dB (dataset)` : `${v} dB`}</button>
        ))}
      </div>
      <Responsive>{(w) => (
        <SpectraExplorer
          axis={source.axis}
          axisUnit={source.axis_unit ?? ""}
          yLabel={source.signal_unit ?? "signal"}
          series={[
            { id: "__noisy", label: `With simulated noise (${f(db, 3)} dB)`, color: "#18807a", values: noisy.values },
            { id: "__ref", label: "Reference spectrum", color: "#9aa5b1", values: base },
          ]}
          title="Simulated noise on a dataset spectrum"
          locale={scope.locale}
          width={w}
          height={240}
        />
      )}</Responsive>
    </ChartCard>
  );
}

export function useSnrBlocks(scope: Scope): ABlocks | null {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const data = useMemo(() => snrData({ view, input, sourceId, locale }), [view, input, sourceId, locale]);
  const bins = useMemo(() => (data ? valueHistogram(data.stats.entries, 24) : []), [data]);
  const contrastBins = useMemo(() => (data?.contrast?.length ? valueHistogram(data.contrast, 24) : []), [data]);
  const [bin, setBin] = useState<number | null>(null);
  if (!data) return null;
  const { stats } = data;
  const p = stats.p;
  const kpis: KpiItem[] = [
    { label: "Estimated SNR", value: f(stats.medianDb, 3), unit: " dB", tone: "teal", sub: `median of ${stats.n} spectra · P5–P95 ${f(p.p5, 3)}–${f(p.p95, 3)} dB` },
    { label: "Signal-to-noise ratio", value: `${f(stats.linear, 3)}:1`, tone: "teal", sub: "linear, 10^(SNR/20)" },
    { label: "Estimated relative noise", value: f(stats.relativeNoisePercent, 3), unit: " %", tone: "teal", sub: "of the mean absolute signal" },
  ];
  if (data.contrastMedianDb !== null) kpis.push({ label: "Contrast-based SNR (interim)", value: f(data.contrastMedianDb, 3), unit: " dB", tone: "grey", sub: `(Q95 − Q5)/σ, median of ${data.contrast?.length ?? 0} spectra` });
  const distributions: RubricBlock[] = [
    { id: "snr-gauge", span: "full", node: <SnrGaugeCard db={stats.medianDb} p5={p.p5} p95={p.p95} f={f} /> },
    {
      id: "snr-histogram",
      node: (
        <ChartCard title="Per-spectrum estimated SNR" subtitle={`P5 ${f(p.p5, 3)} · P25 ${f(p.p25, 3)} · P50 ${f(p.p50, 3)} · P75 ${f(p.p75, 3)} · P95 ${f(p.p95, 3)} dB. Click a bar to inspect.`}>
          <Histogram bins={bins} height={170} tone="teal" title="Per-spectrum estimated SNR (dB)" xLabel="SNR (dB)" markers={[{ value: p.p5, label: "P5" }, { value: p.p50, label: "P50" }, { value: p.p95, label: "P95" }]} selected={bin} onSelect={setBin} fmt={f} />
        </ChartCard>
      ),
    },
  ];
  if (contrastBins.length) {
    const med = quantile(data.contrast!.map((c) => c.value), 0.5)!;
    distributions.push({
      id: "snr-contrast",
      node: (
        <ChartCard title="Contrast-based SNR (interim)" subtitle="20·log10((Q95 − Q5)/σ) per spectrum: less sensitive to a constant offset than mean|x|.">
          <Histogram bins={contrastBins} height={170} tone="blue" title="Per-spectrum contrast-based SNR (dB)" xLabel="contrast SNR (dB)" markers={[{ value: med, label: "P50" }]} fmt={f} />
        </ChartCard>
      ),
    });
  }
  const selectedIds = bin !== null ? (bins[bin]?.ids ?? []) : stats.noisiest.slice(0, 6).map((n) => n.observationId);
  const inspection = (
    <SpectraView scope={scope} title={bin !== null ? `Spectra with SNR ${f(bins[bin]?.lo ?? NaN, 3)}–${f(bins[bin]?.hi ?? NaN, 3)} dB` : "Lowest-SNR spectra"} ids={selectedIds} hint={bin === null ? "Click a histogram bar to change the selection." : ""} />
  );
  const refRows: DotRow[] = [
    { label: "This dataset (median)", emphasis: true, points: [{ value: stats.medianDb, shape: "diamond", tone: "copper" }] },
    ...INSTRUMENT_REFERENCES.filter((r) => referenceDb(r) !== null).reduce<DotRow[]>((acc, r) => {
      const label = `${r.manufacturer.replace(/ \(.*\)$/, "").replace("Malvern Panalytical", "ASD")} ${r.model}${r.kind === "study" ? " (Unity 2014)" : ""}`.replace(/ \((VNIR|SWIR 1|SWIR 2)\)/, "");
      const point = { value: referenceDb(r)!, shape: r.kind === "study" ? ("square" as const) : ("circle" as const), label: `${f(referenceDb(r)!, 3)}${r.condition && /nm$/.test(r.condition) && r.kind === "manufacturer" ? ` (${r.condition.replace("at ", "")})` : ""}` };
      const existing = acc.find((x) => x.label === label);
      // Same published value at several wavelengths: one point, conditions joined ("79.1 (700, 1400 nm)").
      const twin = existing?.points.find((q) => q.value === point.value) as typeof point | undefined;
      if (twin) twin.label = twin.label.replace(/ nm\)$/, `, ${r.condition?.replace("at ", "").replace(" nm", "")} nm)`);
      else if (existing) (existing.points as typeof point[]).push(point);
      else acc.push({ label, points: [point], range: true });
      return acc;
    }, []),
  ];
  distributions.push({ id: "snr-benchmark", span: "full", node: <NoiseBenchmarkCard medianDb={stats.medianDb} p={p} n={stats.n} f={f} locale={locale} /> });
  distributions.push({
    id: "snr-instruments",
    span: "full",
    node: (
      <ChartCard title={S.instrumentsTitle} subtitle="Diamond: this dataset (estimator on real samples). Circles: manufacturer specifications. Squares: Unity Scientific study (2014 data).">
        <p className="ig-warning" role="note">{INSTRUMENT_DISCLAIMER}</p>
        <DotPlot reversed ends={NOISE_ENDS} rows={refRows} axisLabel="dB (indicative documentary conversion 20·log10(S/N))" fmt={f} legend={[{ shape: "diamond", label: "this dataset" }, { shape: "circle", label: "manufacturer specification" }, { shape: "square", label: "Unity Scientific study (2014 data)" }]} title="Published SNR figures and this dataset" />
        <p className="ig-caption">Protocols, integration times and noise definitions are not harmonised; these references do not define the gauge bands. Bruker MPA and ASD FieldSpec 4: no verified S/N figure (not plotted).</p>
        <Collapsible title="Sources, protocols and comparison limits">
        <ChartDataTable
          locale={locale}
          caption="Instrument references (published figures)"
          columns={["Manufacturer", "Model", "Published S/N", "Indicative dB", "Condition", "Spectral range", "Protocol", "Status", "Source", "Comparison limits"]}
          rows={INSTRUMENT_REFERENCES.map((r) => [r.manufacturer, r.model, r.snr === null ? null : `${r.snr.toLocaleString("en")} (${r.unit})`, referenceDb(r), r.condition, r.spectralRange, r.protocol, r.verified ? "verified" : "not verified", r.source.url ? `${r.source.title} — ${r.source.url}` : r.source.title, r.limits])}
        />
        <ul className="ig-plain">
          {NON_CONVERTIBLE_REFERENCES.map((r) => <li key={r.id}><strong>{r.manufacturer} {r.model}</strong> (not convertible to an SNR): {r.published} {r.limits} Source: <a href={r.source.url} target="_blank" rel="noreferrer">{r.source.title}</a>.</li>)}
        </ul>
        </Collapsible>
      </ChartCard>
    ),
  });
  const typicalId = medianSnrSpectrum(stats);
  const details: RubricBlock[] = [
    ...(typicalId ? [{ id: "snr-simulation", node: <Collapsible title="What does a given SNR look like? (simulation)"><NoiseIllustration scope={scope} spectrumId={typicalId} datasetDb={stats.medianDb} f={f} /></Collapsible> }] : []),
    {
      id: "snr-method",
      node: (
      <DetailLists
        title={S.snrTitle}
        methodology={[
          S.snrDefinition,
          <>Indicative bands: {SNR_BANDS.map((b, i) => `${i === 0 ? "< 20" : Number.isFinite(b.maxDb) ? `${SNR_BANDS[i - 1]!.maxDb}–${b.maxDb}` : "> 80"} dB ${b.label.toLowerCase()}`).join(" · ")}. {S.snrBandsNote}</>,
          S.contrastNote,
          "Empirical benchmark: the same estimator computed on the public datasets bundled with the demo only. A percentile among comparable instruments needs a curated catalogue of documented public datasets per instrument, stratified by matrix, range, resolution and preprocessing.",
          S.snrCompare,
        ]}
        limits={S.snrLimits}
        investigate={S.snrInvestigate}
      />
      ),
    },
    {
      id: "snr-tables",
      node: (
        <Collapsible title="Estimated SNR: data tables">
          <ChartDataTable locale={locale} caption="Spectra with the lowest estimated SNR" columns={["Sample", "Scan", "SNR (dB)", "Linear SNR", "Relative noise (%)"]} rows={stats.noisiest.map((n) => [n.sampleId, scanLabel(n.observationId), n.db, dbToLinear(n.db), dbToRelativeNoisePercent(n.db)])} />
        </Collapsible>
      ),
    },
  ];
  return { id: "snr", title: S.snrTitle, lead: S.snrLead, kpis, comments: data.comments.map(comment("snr", "info")), distributions, bandTracks: [], inspection: [{ id: "snr-spectra", node: inspection }], details };
}

// --- spectral diversity: distance from the mean spectrum --------------------------------------

type SnvResult = { status: "idle" } | { status: "running" } | { status: "error"; message: string } | { status: "done"; ids: string[]; raw: (number | null)[]; snv: (number | null)[]; pca: PcaProjection };
type SnvState = SnvResult & { of?: object };
const IDLE: SnvResult = { status: "idle" };

export function useDiversityBlocks(scope: Scope): ABlocks | null {
  const { locale, view, input, sourceId } = scope;
  const f = useMemo(() => makeFmt(locale), [locale]);
  const source = input.sources.find((s) => s.source_id === sourceId);
  const [snvState, setSnv] = useState<SnvState>(IDLE);
  const snv: SnvResult = snvState.of === source ? snvState : IDLE;
  const overlap = useMemo(() => (snv.status === "done" ? topKOverlap(snv.ids, snv.raw, snv.snv, 10) : null), [snv]);
  const data = useMemo(() => diversityData({ view, input, sourceId, locale }, overlap), [view, input, sourceId, locale, overlap]);
  const bins = useMemo(() => (data ? valueHistogram(data.stats.entries, 24) : []), [data]);
  const [bin, setBin] = useState<number | null>(null);
  const [band, setBand] = useState<BandSelection | null>(null);
  const onBandSelect = useCallback((sel: BandSelection | null) => setBand(sel), []);
  const envelope = useMemo(() => (data && source ? bandEnvelope(source, rowsFor(source, data.stats.entries.map((e) => e.id)).map((r) => r.row)) : null), [data, source]);
  if (!data || !source) return null;
  const { stats, unit } = data;
  const rel = stats.relativeP95;
  const kpis: KpiItem[] = [
    rel === null
      ? { label: "Relative P95 distance", value: "N/A", tone: "teal", sub: "typical signal level not available" }
      : rel >= 1
        ? { label: "Relative P95 distance", value: `${f(rel, 3)}×`, tone: "teal", sub: `${f(100 * rel, 3)} % of the typical signal level (not an error rate)` }
        : { label: "Relative P95 distance", value: f(100 * rel, 3), unit: " %", tone: "teal", sub: `${f(rel, 3)}× the typical signal level (not an error rate)` },
    { label: "P95 distance", value: f(stats.p95), unit: ` ${unit}`, tone: "teal", sub: `median ${f(stats.median)} over ${stats.n} spectra` },
    { label: "Maximum distance", value: f(stats.max), unit: ` ${unit}`, tone: "grey", sub: scanLabel(stats.maxId) },
    { label: "Typical signal level", value: stats.typicalLevel === null ? "N/A" : f(stats.typicalLevel), unit: stats.typicalLevel === null ? "" : ` ${unit}`, tone: "blue", sub: "median over spectra of mean|x|" },
  ];
  const runSnv = () => {
    const m = completeMatrix(source, rowsFor(source, stats.entries.map((e) => e.id)));
    if (m.rows < 3) return setSnv({ status: "error", message: "fewer than 3 complete spectra.", of: source });
    const ids = m.ids;
    setSnv({ status: "running", of: source });
    runSnvComparison(m).then((r) => setSnv({ status: "done", ids, raw: r.raw, snv: r.snv, pca: r.pca, of: source }), (e: Error) => setSnv({ status: "error", message: e.message, of: source }));
  };
  const distanceById = new Map(stats.entries.map((e) => [e.id, e.value]));
  const pcaPoints: ScorePoint[] = snv.status === "done" && snv.pca.pc1 && snv.pca.pc2 ? snv.ids.flatMap((id, i) => {
    const d = distanceById.get(id);
    return d === undefined ? [] : [{ id: scanLabel(id), x: snv.pca.pc1![i]!, y: snv.pca.pc2![i]!, value: d, details: [`distance ${f(d)} ${unit}`] }];
  }) : [];
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "" : ` (${f(100 * v, 3)} %)`);
  const distributions: RubricBlock[] = [
    {
      id: "diversity-p95-vs-level",
      span: "full",
      node: (
        <ChartCard title="P95 distance vs typical signal level" subtitle={rel === null ? "The typical signal level is not available." : `The P95 RMS distance is ${rel >= 1 ? `${f(rel, 3)}×` : `${f(100 * rel, 3)} % of`} the typical absolute signal level (median of mean|x|): a scale indication, not an error rate.`}>
          <ValueBars fmt={f} digits={3} unit={unit.length > 4 ? "" : unit} axisLabel={unit === "signal units" ? "Signal units" : `Signal units (${unit})`} rows={[{ label: "P95 RMS distance", value: stats.p95, tone: "teal" }, { label: "Typical signal", value: stats.typicalLevel === null ? null : Math.abs(stats.typicalLevel), tone: "blue", note: "median of mean|x|" }]} />
        </ChartCard>
      ),
    },
    {
      id: "diversity-histogram",
      node: (
        <ChartCard title="Distance from the mean spectrum" subtitle={`P50 ${f(stats.median)} · P95 ${f(stats.p95)} ${unit} over ${stats.n} spectra. Click a bar to overlay those spectra.`}>
          <Histogram bins={bins} height={170} tone="teal" title="Distance from the mean spectrum" xLabel={`RMS distance (${unit})`} markers={[{ value: stats.median, label: "P50" }, { value: stats.p95, label: "P95" }]} selected={bin} onSelect={setBin} fmt={f} />
        </ChartCard>
      ),
    },
    {
      id: "diversity-level-shape",
      node: (
        <ChartCard
          title="Level or shape? Raw vs SNV, PCA"
          subtitle="SNV removes each spectrum's offset and scale; PCA locates sub-groups. Computed on demand by Methods kernels on complete spectra."
          actions={snv.status === "idle" || snv.status === "error" ? <button type="button" className="btn btn-ghost btn-sm" onClick={runSnv}>Compute</button> : null}
        >
          {snv.status === "idle" ? <EmptyState>Not computed yet: press Compute.</EmptyState> : null}
          {snv.status === "running" ? <EmptyState>Computing SNV distances and PCA…</EmptyState> : null}
          {snv.status === "error" ? <EmptyState>Comparison unavailable: {snv.message}</EmptyState> : null}
          {snv.status === "done" ? (
            <>
              <Responsive>{(w) => <ScoreMap width={w} height={220} colorBy="none" title="Raw vs SNV distance from the mean spectrum" xLabel={`Raw distance (${unit})`} yLabel="SNV distance (SNV units)" locale={locale} points={snv.ids.flatMap((id, i) => (snv.raw[i] != null && snv.snv[i] != null ? [{ id: scanLabel(id), x: snv.raw[i]!, y: snv.snv[i]! }] : []))} />}</Responsive>
              {overlap ? <p className="cz-card-foot">{overlap.kept} of the {overlap.k} spectra farthest from the mean in raw units stay among the {overlap.k} farthest after SNV (ranks only: units differ).</p> : null}
              {pcaPoints.length ? (
                <Responsive>{(w) => <ScoreMap width={w} height={240} points={pcaPoints} colorBy="value" colorLabel={`Distance (${unit})`} xLabel={`PC1${pct(snv.pca.explained[0])}`} yLabel={`PC2${pct(snv.pca.explained[1])}`} title="PCA scores coloured by distance from the mean spectrum" locale={locale} />}</Responsive>
              ) : <EmptyState>PCA projection unavailable (fewer than two resolved components).</EmptyState>}
            </>
          ) : null}
        </ChartCard>
      ),
    },
  ];
  // Where along the axis the spectra spread: width of the band-wise P5–P95 envelope (display aggregate).
  const bandTracks: Track[] = envelope ? [{
    id: "diversity-spread",
    title: "Spread of spectra by band (P95 − P5)",
    unit,
    height: 100,
    includeZero: true,
    series: [{ id: "spread", label: "P95 − P5 across spectra", values: envelope.p95.map((hi, i) => (hi === null || envelope.p5[i] === null ? null : hi - envelope.p5[i]!)), color: "var(--cz-teal)" }],
  }] : [];
  const ids = bin !== null ? (bins[bin]?.ids ?? []) : [...stats.entries].sort((a, b) => b.value - a.value).slice(0, 5).map((e) => e.id);
  const range: [number, number] | null = band ? [band.i0, band.i1] : null;
  const inspection: RubricBlock[] = envelope ? [{
    id: "diversity-spectra",
    node: (
      <SpectraView
        scope={scope}
        title={bin !== null ? "Selected spectra vs mean spectrum and P5–P95 envelope" : "Most distant spectra vs mean spectrum and P5–P95 envelope"}
        ids={ids}
        range={range}
        extra={[
          { id: "__mean", label: "Mean spectrum", color: "#334155", values: envelope.mean },
          { id: "__p5", label: "P5 envelope", color: "#a3acb3", values: envelope.p5 },
          { id: "__p95", label: "P95 envelope", color: "#a3acb3", values: envelope.p95 },
        ]}
        hint="Mean and band-wise P5/P95 over the evaluated spectra."
      />
    ),
  }] : [];
  const details: RubricBlock[] = [
    { id: "diversity-method", node: <DetailLists title={S.diversityTitle} warning={S.diversityWarning} methodology={S.diversityLimits.slice(0, 2)} limits={S.diversityLimits.slice(2)} investigate={S.diversityInvestigate} /> },
    {
      id: "diversity-tables",
      node: (
        <Collapsible title="Distance from the mean spectrum: data table">
          <ChartDataTable locale={locale} caption="Distance from the mean spectrum by spectrum" columns={["Sample", "Scan", `Distance (${unit})`]} rows={[...stats.entries].sort((a, b) => b.value - a.value).slice(0, 50).map((e) => [e.sampleId, scanLabel(e.id), e.value])} />
        </Collapsible>
      ),
    },
  ];
  return { id: "diversity", title: S.diversityTitle, lead: S.diversityLead, kpis, comments: data.comments.map(comment("diversity", "info")), distributions, bandTracks, onBandSelect, inspection, details };
}

/** Standalone rendering of A's blocks in the rubric order (used by the legacy panels until the page composes rubrics). */
export function RubricView({ scope, blocks }: { scope: Scope; blocks: ABlocks }) {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const [selection, setSelection] = useState<BandSelection | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const onSelect = (sel: BandSelection | null) => { setSelection(sel); blocks.onBandSelect?.(sel); };
  return (
    <section className="ig-panel card" id={`ig-${blocks.id}`} aria-labelledby={`ig-${blocks.id}-h`}>
      <header className="ig-head">
        <h3 className="ig-title" id={`ig-${blocks.id}-h`}>{blocks.title}</h3>
        <p className="ig-lead">{blocks.lead}</p>
      </header>
      {blocks.unavailable ? <EmptyState>{blocks.unavailable}</EmptyState> : null}
      {blocks.kpis.length ? <KpiStrip items={blocks.kpis} label={`${blocks.title}: key metrics`} /> : null}
      {blocks.comments.length ? (
        <div className="ig-interpretation" aria-label="Interpretation">
          <span className="ig-eyebrow">Interpretation</span>
          <ul>{blocks.comments.map(commentOf).map((c) => <li key={c.id}>{c.text}</li>)}</ul>
        </div>
      ) : null}
      {blocks.distributions.length ? <div className="ig-dists">{blocks.distributions.map((d) => <div key={d.id} className={`ig-block${d.span === "full" ? " ig-span-full" : ""}`}>{d.node}</div>)}</div> : null}
      {blocks.bandTracks.length && source ? (
        <Responsive>{(w) => <AlignedTracks axis={source.axis} axisLabel={source.axis_unit ?? "band"} tracks={blocks.bandTracks} width={w} title={`${blocks.title}: per-band profiles`} selection={selection} onSelect={onSelect} cursor={cursor} onCursor={setCursor} />}</Responsive>
      ) : null}
      {blocks.inspection.length ? <div className="ig-dists">{blocks.inspection.map((d) => <div key={d.id} className={`ig-block${d.span === "half" ? "" : " ig-span-full"}`}>{d.node}</div>)}</div> : null}
      {blocks.details.length ? (
        <details className="ig-details ig-more">
          <summary>Tables, method and limitations</summary>
          <div className="ig-visual">{blocks.details.map((d) => <div key={d.id}>{d.node}</div>)}</div>
        </details>
      ) : null}
    </section>
  );
}
