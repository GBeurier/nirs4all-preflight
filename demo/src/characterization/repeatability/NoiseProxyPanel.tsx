// Per-band noise proxy (request §7): pooled/relative values, aligned profiles, noise-to-diversity ratio
// and the Savitzky–Golay residual heatmap (Methods WASM kernel, computed lazily on demand).
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartDataTable, MeasureBars, StatTile, formatEngineNumber } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { dbToRelativeNoisePercent, finite } from "../shared/derive";
import { AlignedTracks, type Track } from "./AlignedTracks";
import { fmt, noiseComments, noiseStats } from "./comments";
import { bandEnvelope, noiseProfiles, topRegions, typicalSignalLevel, type NoiseProfile } from "./profiles";
import { capRows, computeResiduals, type ResidualResult } from "./residuals";
import { medianSnrDb } from "./summary";
import { DiagnosticBlock, HATCH, StackedShareBar, histogramBins } from "./ui";

export const NOISE_LEAD = "Estimate local fine-scale spectral fluctuations using Savitzky–Golay smoothing residuals. This diagnostic identifies spectral regions with substantial high-frequency variation when technical replicates are unavailable. Real narrow spectral features and systematic artifacts may also contribute to the residuals.";

/** Exploratory noise-to-diversity bands (not metrologically validated). */
export const RATIO_BANDS = [
  { id: "low", label: "Low (< 0.10)", from: 0, to: 0.1, color: "#e0f2fe" },
  { id: "moderate", label: "Moderate (0.10–0.30)", from: 0.1, to: 0.3, color: "#bae6fd" },
  { id: "substantial", label: "Substantial (0.30–1.00)", from: 0.3, to: 1, color: "#fcd34d" },
  { id: "exceeds", label: "Exceeds diversity (≥ 1.00)", from: 1, to: Infinity, color: "#fb923c" },
] as const;

export const MAX_HEATMAP_SPECTRA = 300;
const PICK_COLORS = ["#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be185d"];

/** Diverging blue–white–red colour for a residual, symmetric around 0 at ±`lim`. */
export function divergingColor(v: number, lim: number): [number, number, number] {
  const t = lim > 0 ? Math.max(-1, Math.min(1, v / lim)) : 0;
  const white = [248, 250, 252];
  const end = t < 0 ? [37, 99, 235] : [220, 38, 38];
  const a = Math.abs(t);
  return [0, 1, 2].map((k) => Math.round(white[k]! + (end[k]! - white[k]!) * a)) as [number, number, number];
}

function Heatmap({ result, height, onPick }: { result: ResidualResult; height: number; onPick: (rowIndex: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lim = useMemo(() => {
    const abs = finite(result.residual.flat()).map(Math.abs).sort((a, b) => a - b);
    return abs.length ? abs[Math.floor(0.98 * (abs.length - 1))]! : 0;
  }, [result]);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const img = ctx.createImageData(result.axisLength, result.rows.length);
    result.residual.forEach((row, k) => row.forEach((v, j) => {
      const o = (k * result.axisLength + j) * 4;
      const [r, g, b] = v === null ? [203, 213, 225] : divergingColor(v, lim);
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }));
    ctx.putImageData(img, 0, 0);
  }, [result, lim]);
  return (
    <div className="rp-heat">
      <canvas
        ref={ref}
        width={result.axisLength}
        height={result.rows.length}
        style={{ height }}
        role="img"
        aria-label={`Signed smoothing residuals, ${result.rows.length} spectra × ${result.axisLength} bands; diverging scale centred on 0, clipped at ±${fmt(lim)}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onPick(Math.min(result.rows.length - 1, Math.floor(((e.clientY - rect.top) / rect.height) * result.rows.length)));
        }}
      />
      <div className="rp-scale"><span>−{fmt(lim)}</span><span className="rp-scale-bar" aria-hidden="true" /><span>+{fmt(lim)}</span><span className="hint">blue = raw below smoothed · red = above · grey = not evaluable (masked/missing window)</span></div>
    </div>
  );
}

export function NoiseProxyPanel(props: Scope & { onOpenSettings?: () => void }) {
  const { view, input, sourceId, locale } = props;
  const source = input.sources.find((s) => s.source_id === sourceId);
  const profiles = useMemo(() => (sourceId ? noiseProfiles(view, input, sourceId) : []), [view, input, sourceId]);
  const level = useMemo(() => (sourceId ? typicalSignalLevel(view, sourceId) : null), [view, sourceId]);
  const snrDb = useMemo(() => medianSnrDb({ view, input, sourceId }), [view, input, sourceId]);
  const [ctxIndex, setCtxIndex] = useState(0);
  const [relative, setRelative] = useState(false);
  const [residual, setResidual] = useState<{ state: "idle" | "running" | "error"; result: ResidualResult | null; error?: string }>({ state: "idle", result: null });
  const [picked, setPicked] = useState<number[]>([]);
  const [sortByRms, setSortByRms] = useState(false);
  const p: NoiseProfile | undefined = profiles[Math.min(ctxIndex, profiles.length - 1)];
  const envelope = useMemo(() => (source && p ? bandEnvelope(source, p.rows) : null), [source, p]);
  const n = (v: number | null, d = 3) => (v === null || !Number.isFinite(v) ? "—" : (formatEngineNumber(v, locale, d) ?? fmt(v, d)));
  // Context of the residual computation in flight: a result of a previous context is dropped.
  const current = useRef<{ p: NoiseProfile | undefined; source: typeof source }>({ p, source });
  current.current = { p, source };
  useEffect(() => {
    setResidual({ state: "idle", result: null });
    setPicked([]);
  }, [p]);

  if (!source || !p) return null;
  const unit = p.unit ?? source.signal_unit ?? "";
  const axisUnit = source.axis_unit ?? "";
  const axisLabel = axisUnit ? `Spectral axis (${axisUnit})` : "Band";
  const s = noiseStats(p, level);
  const rel = relative && level !== null && level > 0;
  const shown = rel ? p.values.map((v) => (v === null ? null : (100 * v) / level!)) : p.values;
  const denom = p.diversityKind === "between-sample" ? "between-sample SD" : "between-spectrum SD";
  const regions = topRegions(source.axis, p.values);
  const ratioCounts = RATIO_BANDS.map((b) => ({ ...b, count: p.ratioBands.filter((x) => x === b.id).length }));
  const ratioNone = p.ratio.filter((v) => v === null).length;
  const h = p.windowBands !== null ? Math.floor(p.windowBands / 2) : 0;
  const edges = h > 0 ? [{ i0: 0, i1: h - 1, label: "Window edge: not evaluated by the engine" }, { i0: source.axis.length - h, i1: source.axis.length - 1, label: "Window edge: not evaluated by the engine" }] : [];
  const tracks: Track[] = [
    {
      id: "spectrum",
      title: "Median spectrum and P5–P95 envelope",
      unit,
      series: envelope ? [{ id: "median", label: "Median", values: envelope.median, color: "#334155" }] : [],
      envelopes: envelope ? [{ id: "env", label: "P5–P95", lower: envelope.p5, upper: envelope.p95, color: "#64748b" }] : [],
    },
    {
      id: "noise",
      title: rel ? "Per-band noise proxy relative to the typical signal level" : "Per-band noise proxy",
      unit: rel ? "%" : unit,
      includeZero: true,
      series: [{ id: "noise", label: "Noise proxy", values: shown, color: "#b45309" }],
      nonEvaluable: p.nonEvaluable,
    },
    {
      id: "ratio",
      title: `Noise-to-diversity ratio (noise proxy / ${denom})`,
      includeZero: true,
      height: 120,
      series: [{ id: "ratio", label: "Ratio", values: p.ratio, color: "#7c2d12" }],
      refBands: RATIO_BANDS.map((b) => ({ from: b.from, to: Math.min(b.to, 1e6), label: `${b.label} — exploratory`, fill: `${b.color}66` })),
      nonEvaluable: p.ratio.map((v) => v === null),
      format: (v) => fmt(v, 3),
    },
  ];

  const run = async () => {
    if (p.windowBands === null || p.polyorder === null) return;
    setResidual({ state: "running", result: null });
    const stale = () => current.current.p !== p || current.current.source !== source;
    try {
      const result = await computeResiduals(source, capRows(p.rows, MAX_HEATMAP_SPECTRA), p.windowBands, p.polyorder);
      if (!stale()) setResidual({ state: "idle", result });
    } catch (e) {
      if (!stale()) setResidual({ state: "error", result: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const res = residual.result;
  const order = res ? (sortByRms ? res.rows.map((_, k) => k).sort((a, b) => (res.rowRms[b] ?? -1) - (res.rowRms[a] ?? -1)) : res.rows.map((_, k) => k)) : [];
  const ordered: ResidualResult | null = res ? { ...res, residual: order.map((k) => res.residual[k]!), rows: order.map((k) => res.rows[k]!) } : null;
  const pickedTracks: Track[] = res && picked.length ? [
    {
      id: "raw",
      title: "Raw and smoothed spectra",
      unit,
      height: 150,
      series: picked.flatMap((k, i) => [
        { id: `raw${k}`, label: `${source.observation_ids[res.rows[k]!] ?? `row ${res.rows[k]! + 1}`} raw`, values: res.raw[k]!, color: PICK_COLORS[i % PICK_COLORS.length] },
        { id: `sm${k}`, label: `${source.observation_ids[res.rows[k]!] ?? `row ${res.rows[k]! + 1}`} smoothed`, values: res.smoothed[k]!, color: PICK_COLORS[i % PICK_COLORS.length], dash: "4 3" },
      ]),
    },
    {
      id: "res",
      title: "Signed residual (raw − smoothed)",
      unit,
      height: 120,
      refLines: [{ y: 0, label: "0" }],
      series: picked.map((k, i) => ({ id: `r${k}`, label: source.observation_ids[res.rows[k]!] ?? `row ${res.rows[k]! + 1}`, values: res.residual[k]!, color: PICK_COLORS[i % PICK_COLORS.length] })),
    },
  ] : [];

  return (
    <DiagnosticBlock
      title="Per-band noise proxy"
      lead={NOISE_LEAD}
      metrics={<>
        <StatTile label={`Pooled noise proxy${p.id.replace(/[·\s]/g, "") ? ` · ${p.id}` : ""}`} value={n(p.pooled)} suffix={unit || undefined} hint={`Window ${p.windowBands ?? "—"} bands, polynomial order ${p.polyorder ?? "—"}, ${p.nEvaluableBands ?? "—"} / ${p.values.length} evaluable bands`} />
        <StatTile label="Relative pooled noise proxy" value={s.relativePooledPercent === null ? "—" : `${n(s.relativePooledPercent)} %`} hint={level !== null ? `Pooled proxy / typical absolute signal level ${n(level)}${unit ? ` ${unit}` : ""} (median over spectra of mean |x|)` : "Typical absolute signal level not computed"} />
        <StatTile label="Median per-band noise proxy" value={n(s.median)} suffix={unit || undefined} />
        <StatTile label="P95 per-band noise proxy" value={n(s.p95)} suffix={unit || undefined} />
        <StatTile label="SNR-derived relative noise" value={snrDb === null ? "—" : `${n(dbToRelativeNoisePercent(snrDb))} %`} hint={snrDb === null ? "Intrinsic SNR not computed" : `From the median estimated SNR ${n(snrDb)} dB; a different estimator`} />
      </>}
      comments={noiseComments([p], level, snrDb, source.axis, axisUnit, unit)}
      limitations="An exploratory roughness proxy, not an instrumental noise measurement: real narrow features, curvature and systematic artifacts also enter the residuals."
      details={<>
        <p>Engine definition: per band, the RMS over spectra of the Savitzky–Golay smoothing residual (window {p.windowBands ?? "—"}, polynomial order {p.polyorder ?? "—"}), divided by the white-noise residual gain so that pure white noise of SD σ gives σ. Only interior bands whose whole window is valid are evaluated (no padding at the edges); a uniform axis is required.</p>
        <p>Relative pooled noise proxy = 100 × pooled proxy / typical absolute signal level, where the typical level is the median over spectra of the intrinsic mean absolute value (noise.signal_mean_abs).</p>
        <p>Why it can differ from the SNR-derived relative noise (100 × 10^(−SNR/20)): the SNR uses a robust second-difference estimate per spectrum and takes the median across spectra, while this proxy pools squared residuals over spectra and bands (so outlying spectra and anomalies weigh more) and keeps any residual curvature the polynomial cannot follow.</p>
        <p>Noise-to-diversity ratio = per-band noise proxy / {denom}{p.diversityKind === "between-sample" ? ` (derived from the repeatability context ${p.diversityContext})` : " (SD across the spectra of this context; no replicate groups are declared for it)"}. It is null where the denominator is zero or negligible (≤ 10⁻⁹ × the typical signal level), never infinite. The ratio bands are exploratory, not metrologically validated; the ratio is neither an ICC nor a share of variance due to instrumental noise.</p>
      </>}
      investigate={[
        "Open the residual heatmap to separate random fluctuations, vertical structures shared by all spectra and isolated anomalies.",
        "Check whether high-proxy regions match known narrow absorption features before treating them as noise.",
        "Declare technical replicates to measure repeatability directly.",
      ]}
    >
      {profiles.length > 1 ? (
        <div className="seg" role="group" aria-label="Measurement context">
          {profiles.map((q, i) => <button key={q.id} type="button" aria-pressed={i === ctxIndex} onClick={() => setCtxIndex(i)}>{q.id}</button>)}
        </div>
      ) : null}
      <div className="rp-row">
        <label><input type="checkbox" checked={relative} disabled={level === null || level <= 0} onChange={(e) => setRelative(e.target.checked)} /> Show the noise proxy in % of the typical absolute signal level</label>
      </div>
      <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={tracks} width={w} title={`Per-band noise proxy — ${source.source_id} — ${p.id}`} markRegions={edges} />}</Measured>
      <StackedShareBar
        caption={`Share of bands per exploratory noise-to-diversity category (denominator: ${denom})`}
        total={p.values.length}
        segments={[...ratioCounts.map((b) => ({ id: b.id, label: b.label, count: b.count, color: b.color })), { id: "none", label: "Not evaluable", count: ratioNone, color: "#e2e8f0", pattern: HATCH }]}
      />
      {regions.length ? (
        <div>
          <h4>Highest-value regions (top 10% of bands, ≥ 3 contiguous)</h4>
          <ul>{regions.map((r) => <li key={r.i0}>{fmt(r.from, 5)}–{fmt(r.to, 5)}{axisUnit ? ` ${axisUnit}` : ""}: peak {n(r.peak)}{unit ? ` ${unit}` : ""}</li>)}</ul>
        </div>
      ) : null}
      <Measured>{(w) => <MeasureBars width={w} title="Distribution of per-band noise proxy estimates" valueLabel="Bands" format="number" locale={locale} rows={histogramBins(p.values, 12, (v) => fmt(v, 3))} />}</Measured>
      <div className="rp-residuals">
        <h4>Smoothing residual heatmap</h4>
        <p className="hint">Residual = raw spectrum − Savitzky–Golay smoothed spectrum (Methods kernel, window {p.windowBands ?? "—"}, order {p.polyorder ?? "—"}, same as the engine proxy), in signal units without gain normalisation; at most {MAX_HEATMAP_SPECTRA} spectra (evenly sampled). Structured residuals are not automatically noise: they may carry real spectral information or systematic artifacts.</p>
        {!res ? (
          <button type="button" className="btn btn-outline btn-sm" disabled={residual.state === "running" || p.windowBands === null || p.polyorder === null} onClick={() => void run()}>
            {residual.state === "running" ? "Computing residuals…" : `Compute residuals (${Math.min(p.rows.length, MAX_HEATMAP_SPECTRA)} of ${p.rows.length} spectra)`}
          </button>
        ) : null}
        {residual.state === "error" ? <p className="alert alert-warning" role="alert">Residuals unavailable: the Methods Savitzky–Golay kernel could not run ({residual.error}).</p> : null}
        {res && ordered ? (
          <>
            <div className="rp-row">
              <label><input type="checkbox" checked={sortByRms} onChange={(e) => setSortByRms(e.target.checked)} /> Sort rows by residual RMS (largest first)</label>
              <span className="hint">{res.rows.length} spectra × {res.axisLength} bands · {res.backend} · click a row to compare raw, smoothed and residual spectra (up to {PICK_COLORS.length})</span>
            </div>
            <Heatmap result={ordered} height={Math.min(420, Math.max(160, res.rows.length * 2))} onPick={(k) => {
              const original = order[k]!;
              setPicked((cur) => (cur.includes(original) ? cur.filter((x) => x !== original) : [...cur, original].slice(-PICK_COLORS.length)));
            }} />
            <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} width={w} title="Median signed residual and robust spread per band" markRegions={res.edge.map((r) => ({ ...r, label: "Edge effect: smoothing window truncated (interp mode)" }))} tracks={[
              { id: "med", title: "Median signed residual", unit, refLines: [{ y: 0, label: "0" }], series: [{ id: "m", label: "Median residual", values: res.medianResidual, color: "#1d4ed8" }] },
              { id: "spread", title: "Robust residual spread (1.4826 × MAD)", unit, includeZero: true, series: [{ id: "s", label: "Robust spread", values: res.spreadResidual, color: "#b45309" }] },
            ]} />}</Measured>
            <p className="hint">Hatched-outline regions at both ends: within half a window of the edge, where the smoothing window is truncated (edge effects); the engine proxy does not evaluate these bands.</p>
            {pickedTracks.length ? <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={pickedTracks} width={w} title="Raw, smoothed and residual spectra of the selected rows" markRegions={res.edge.map((r) => ({ ...r, label: "Edge effect" }))} />}</Measured> : null}
          </>
        ) : null}
      </div>
      <ChartDataTable
        locale={locale}
        caption={`Per-band noise proxy — ${p.id}`}
        columns={["Band", `Noise proxy${unit ? ` (${unit})` : ""}`, `${denom[0]!.toUpperCase()}${denom.slice(1)}${unit ? ` (${unit})` : ""}`, "Noise-to-diversity ratio"]}
        rows={source.axis.map((x, i) => [x, p.values[i] ?? null, p.diversity[i] ?? null, p.ratio[i] ?? null])}
      />
    </DiagnosticBlock>
  );
}
