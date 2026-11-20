// Interactive spectral preprocessing explorer (request §8). Methods kernels run in a dedicated
// worker; this component holds the pipeline, debounces recomputation and renders the views.
import { scanLabel } from "../integrity/IntegrityPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartDataTable, StatTile, formatEngineNumber } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { AlignedTracks, type BandSelection, type Track } from "../repeatability";
import {
  STEP_KINDS,
  STEP_SPECS,
  UNAVAILABLE_STEPS,
  coerceParam,
  newStep,
  pipelineLabel,
  stepIssue,
  stripIds,
  type PipelineStep,
  type StepKind,
} from "./catalog";
import { EXPLORER_SPECTRA_CAP, diagnosticSettings, prepareExplorerData } from "./data";
import { benchmarkGrid, recipeKey, type BenchmarkPoint, type Diagnostics, type Evaluation, type EvaluationInput, type MetricValue } from "./evaluate";
import { bandDescriptor, medianOf, paretoFront, row, sharedHistogram, type BandDescriptor, type Matrix } from "./metrics";
import { CancelledError, StaleError, createExplorerHost, spawnExplorerWorker, type ExplorerHost } from "./protocol";
import { BenchmarkScatter, PairedHistogram } from "./charts";
import { publishDistortionProfile } from "./distortion";
import { DEFINITIONS, S } from "./strings";
import "./preprocessing.css";

const DEBOUNCE_MS = 300;

export function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const fmt = (v: number | null | undefined, locale: Locale, digits = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : Number.isInteger(v) ? v.toLocaleString(locale) : (formatEngineNumber(v, locale, digits) ?? "—");
const med = (xs: readonly (number | null)[] | undefined) => (xs ? medianOf(xs.filter((v): v is number => v !== null)) : null);
const sum = (xs: readonly (number | null)[] | undefined) => (xs ? xs.reduce<number>((s, v) => s + (v ?? 0), 0) : null);
const affected = (xs: readonly (number | null)[] | undefined) => (xs ? xs.filter((v) => (v ?? 0) > 0).length : null);
const pick = (m: Matrix, idx: number[]) => idx.map((i) => Array.from(row(m, i)));

export function PreprocessingExplorer({ scope }: { scope: Scope }) {
  const { input, sourceId, locale } = scope;
  const data = useMemo(() => prepareExplorerData(input, sourceId), [input, sourceId]);
  const settings = useMemo(() => diagnosticSettings(input), [input]);
  const evalInput = useMemo<EvaluationInput | null>(
    () => (data ? { matrix: data.matrix, step: data.step, groups: data.groups, replicatedSamples: data.replicatedSamples, settings } : null),
    [data, settings],
  );
  const hostRef = useRef<ExplorerHost | null>(null);
  hostRef.current ??= createExplorerHost(spawnExplorerWorker);
  useEffect(() => () => hostRef.current?.dispose(), []);

  const [before, setBefore] = useState<Diagnostics | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>(() => [newStep("savgol")]);
  // The evaluation is stored with the label of the recipe it was computed for, so results are never
  // attributed to a newer (debounce-pending or blocked) pipeline.
  const [result, setResult] = useState<{ evaluation: Evaluation; label: string } | null>(null);
  const evaluation = result?.evaluation ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(8);
  const [band, setBand] = useState<BandSelection | null>(null);
  const [points, setPoints] = useState<BenchmarkPoint[]>([]);
  const [benchProgress, setBenchProgress] = useState<{ done: number; total: number } | null>(null);
  const [showFront, setShowFront] = useState(true);

  useEffect(() => {
    setBefore(null);
    setResult(null);
    setPoints([]);
    if (!evalInput) return;
    hostRef.current!.init(evalInput).then(setBefore, (e: unknown) => {
      if (!(e instanceof CancelledError)) setError(e instanceof Error ? e.message : String(e));
    });
  }, [evalInput]);

  const recipe = useMemo(() => stripIds(steps), [steps]);
  const debounced = useDebounced(recipe);
  const issues = steps.map((s) => (data ? stepIssue(s, data.matrix.cols) : null));

  useEffect(() => {
    if (!before || !data) return;
    if (debounced.some((s) => stepIssue({ id: "", ...s }, data.matrix.cols))) {
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    const evaluatedLabel = pipelineLabel(debounced.map((s) => ({ id: "", ...s })));
    hostRef.current!.evaluate(debounced).then(
      (ev) => {
        if (!live) return;
        setResult({ evaluation: ev, label: evaluatedLabel });
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (e instanceof StaleError || e instanceof CancelledError || !live) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
    // `data` changes only together with `before` (re-initialisation); the debounced recipe drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [before, debounced]);

  const currentLabel = pipelineLabel(steps);
  const label = result?.label ?? currentLabel;
  useEffect(() => {
    if (!data || !evaluation?.distortion) {
      publishDistortionProfile(null);
      return;
    }
    publishDistortionProfile({ sourceId: data.sourceId, axis: data.axis, values: evaluation.distortion, label: result!.label, n: data.counts.used, fineScaleReductionPercent: evaluation.metrics.fineScaleReduction.value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation, data]);
  useEffect(() => () => publishDistortionProfile(null), []);

  // Drawn spectra: evenly spaced rows of the subset (deterministic).
  const shownIdx = useMemo(() => {
    if (!data) return [];
    const n = data.counts.used, k = Math.min(shown, n);
    return Array.from({ length: k }, (_, i) => Math.floor((i * n) / k));
  }, [data, shown]);
  const rawEnvelope = before?.envelope;
  const procEnvelope = evaluation?.after.envelope;

  const descriptors = useMemo(() => {
    if (!band || !data || !rawEnvelope || !procEnvelope || !evaluation || evaluation.comparability === "not_comparable") return null;
    const lo = data.axis[band.i0]!, hi = data.axis[band.i1]!;
    return { raw: bandDescriptor(data.axis, rawEnvelope.median, lo, hi), proc: bandDescriptor(data.axis, procEnvelope.median, lo, hi), lo, hi };
  }, [band, data, rawEnvelope, procEnvelope, evaluation]);

  if (!data || !evalInput) {
    return (
      <section className="pp-explorer card">
        <h3>{S.title}</h3>
        <p className="hint">{S.noData}</p>
      </section>
    );
  }

  const axisLabel = data.axisUnit ? `Spectral axis (${data.axisUnit})` : "Spectral axis";
  const unit = data.signalUnit || "signal unit";
  const procUnit = evaluation?.preservesUnits ? unit : "processed units";
  const sameScale = evaluation?.preservesUnits ?? true;

  const tracks: Track[] = [];
  if (before) {
    const rawRows = pick(data.matrix, shownIdx);
    tracks.push({ id: "raw", title: `Raw spectra (${shownIdx.length} of ${data.counts.used} drawn)`, unit, series: rawRows.map((v, i) => ({ id: `r${i}`, label: scanLabel(data.observationIds[shownIdx[i]!]!), values: v })) });
    if (evaluation) {
      tracks.push({ id: "proc", title: `Processed spectra — ${label}`, unit: procUnit, series: pick(evaluation.processed, shownIdx).map((v, i) => ({ id: `p${i}`, label: scanLabel(data.observationIds[shownIdx[i]!]!), values: v, dash: "4 2" })) });
    }
    tracks.push({ id: "env-raw", title: "Raw: median spectrum and P5–P95 envelope", unit, series: [{ id: "m", label: "Raw median", values: before.envelope.median }], envelopes: [{ id: "e", label: "Raw P5–P95", lower: before.envelope.p5, upper: before.envelope.p95 }] });
    if (evaluation && procEnvelope) {
      tracks.push({ id: "env-proc", title: "Processed: median spectrum and P5–P95 envelope", unit: procUnit, series: [{ id: "m", label: "Processed median", values: procEnvelope.median, dash: "4 2", color: "#7c3aed" }], envelopes: [{ id: "e", label: "Processed P5–P95", lower: procEnvelope.p5, upper: procEnvelope.p95, color: "#7c3aed" }] });
    }
    if (evaluation?.residual) {
      tracks.push({ id: "res", title: "Transformation residual r = raw − processed (median, P5–P95)", unit, includeZero: true, series: [{ id: "r", label: "Residual median", values: evaluation.residual.median, color: "#b45309" }], envelopes: [{ id: "re", label: "Residual P5–P95", lower: evaluation.residual.p5, upper: evaluation.residual.p95, color: "#b45309" }], refLines: [{ y: 0, label: "0" }] });
    }
    const pair = (id: string, title: string, a: readonly (number | null)[] | undefined, b: readonly (number | null)[] | undefined, u: string, kind?: "bars") => {
      if (!a) return;
      if (sameScale || !b) {
        tracks.push({ id, title, unit: u, includeZero: true, series: [{ id: "a", label: "Raw", values: a, ...(kind ? { kind } : {}) }, ...(b ? [{ id: "b", label: "Processed", values: b, dash: "4 2", color: "#7c3aed" }] : [])] });
      } else {
        tracks.push({ id: `${id}-a`, title: `${title} — raw`, unit: u, includeZero: true, series: [{ id: "a", label: "Raw", values: a }] });
        tracks.push({ id: `${id}-b`, title: `${title} — processed (different scale)`, unit: "processed units", includeZero: true, series: [{ id: "b", label: "Processed", values: b, dash: "4 2", color: "#7c3aed" }] });
      }
    };
    pair("noise", "Local noise proxy (SG residual RMS per band)", before.profile?.band, evaluation?.after.profile?.band, unit);
    pair("div", "Between-spectrum SD per band", before.diversity, evaluation?.after.diversity, unit);
    if (before.repeat) pair("rep", "Repeatability SD per band (pooled within replicated samples)", before.repeat.sd, evaluation?.after.repeat?.sd, unit);
    if (before.events) {
      tracks.push({ id: "ev", title: "Isolated peaks per band (count of spectra; raw solid, processed dashed)", unit: "count", includeZero: true, series: [{ id: "a", label: "Raw", values: before.events.spikeBands }, ...(evaluation?.after.events ? [{ id: "b", label: "Processed", values: evaluation.after.events.spikeBands, dash: "4 2", color: "#7c3aed" }] : [])] });
      tracks.push({ id: "jv", title: "Abrupt changes per band (count of spectra)", unit: "count", includeZero: true, series: [{ id: "a", label: "Raw", values: before.events.jumpBands }, ...(evaluation?.after.events ? [{ id: "b", label: "Processed", values: evaluation.after.events.jumpBands, dash: "4 2", color: "#7c3aed" }] : [])] });
    }
  }

  const m = evaluation?.metrics;
  const tile = (title: string, v: MetricValue | undefined, suffix: string, digits = 3) => (
    <StatTile key={title} label={title} value={v?.disabled ? "disabled" : fmt(v?.value, locale, digits)} suffix={v?.disabled ? undefined : suffix} hint={v?.disabled ?? (v ? `n = ${v.n}` : "—")} />
  );

  const comparability = evaluation?.comparability ?? "comparable";
  const deltaOff = comparability === "not_comparable";
  const after = evaluation?.after;
  type Row = [string, number | null, number | null, "unit" | "count" | "ratio"];
  const tableRows: Row[] = [
    ["Median SNR (dB)", med(before?.noise?.snrDb), med(after?.noise?.snrDb), "ratio"],
    [`Median noise σ (${unit})`, med(before?.noise?.sigma), med(after?.noise?.sigma), "unit"],
    ["Isolated peaks (total)", sum(before?.events?.spikes), sum(after?.events?.spikes), "count"],
    ["Spectra with isolated peaks", affected(before?.events?.spikes), affected(after?.events?.spikes), "count"],
    ["Abrupt changes (total)", sum(before?.events?.jumps), sum(after?.events?.jumps), "count"],
    ["Spectra with abrupt changes", affected(before?.events?.jumps), affected(after?.events?.jumps), "count"],
    [`Median between-spectrum SD (${unit})`, med(before?.diversity), med(after?.diversity), "unit"],
    [`Pooled noise proxy (${unit})`, before?.profile?.pooled ?? null, after?.profile?.pooled ?? null, "unit"],
    ...(before?.repeat
      ? ([
          [`Median repeatability SD (${unit})`, med(before.repeat.sd), med(after?.repeat?.sd), "unit"],
          ["Median ICC(1,1) over bands", med(before.repeat.icc), med(after?.repeat?.icc), "ratio"],
        ] as Row[])
      : []),
  ];
  const deltaCell = (r: Row) => {
    const [, a, b, kind] = r;
    if (a === null || b === null) return "—";
    if (deltaOff || (kind === "unit" && !sameScale)) return "not comparable";
    return fmt(b - a, locale);
  };

  const snrHist = before?.noise && after?.noise && !deltaOff ? sharedHistogram([before.noise.snrDb, after.noise.snrDb], 24) : null;

  const nominal = steps.length === 1 && STEP_SPECS[steps[0]!.kind].comparability === "comparable" ? recipeKey(recipe) : null;
  const front = paretoFront(points.map((p) => ({ x: p.distortion, y: p.reduction })));
  const grid = benchmarkGrid(data.matrix.cols);
  const runBenchmark = () => {
    const configs = nominal && !grid.some((g) => recipeKey(g.steps) === nominal) ? [...grid, { label: `Nominal: ${currentLabel}`, steps: recipe }] : grid;
    setPoints([]);
    setBenchProgress({ done: 0, total: configs.length });
    hostRef.current!.benchmark(configs, (p, done, total) => {
      setPoints((prev) => [...prev, p]);
      setBenchProgress({ done, total });
    }).then(
      () => setBenchProgress(null),
      (e: unknown) => {
        setBenchProgress(null);
        if (!(e instanceof CancelledError)) setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const cancelBenchmark = () => {
    hostRef.current!.cancel();
    setBusy(false);
    // The worker restarts on the next call; recompute the current pipeline.
    if (evalInput) hostRef.current!.init(evalInput).then(setBefore, () => undefined);
  };

  const setStep = (i: number, s: PipelineStep) => setSteps((prev) => prev.map((x, k) => (k === i ? s : x)));
  const move = (i: number, d: -1 | 1) => setSteps((prev) => {
    const next = [...prev];
    const j = i + d;
    if (j < 0 || j >= next.length) return prev;
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  return (
    <section className="pp-explorer card" aria-busy={busy}>
      <h3>{S.title}</h3>
      <p className="lead">{S.lead}</p>
      <p className="hint">{S.denominators(data.counts.used, data.counts.complete, data.counts.total, EXPLORER_SPECTRA_CAP)}</p>
      <p className="hint">{S.fixedDiagnostics(settings.eventThreshold, settings.noiseWindow, settings.noisePolyorder)}</p>
      {data.irregularAxis ? <p className="hint pp-warn">{S.irregularAxis}</p> : null}

      <div className="pp-layout">
        <div className="pp-pipeline" aria-label={S.pipeline}>
          <h4>{S.pipeline}</h4>
          {steps.length === 0 ? <p className="hint">{S.emptyPipeline}</p> : null}
          <ol>
            {steps.map((s, i) => {
              const spec = STEP_SPECS[s.kind];
              return (
                <li key={s.id} className="pp-step">
                  <div className="pp-step-head">
                    <select aria-label={`Step ${i + 1} method`} value={s.kind} onChange={(e) => setStep(i, { ...newStep(e.target.value as StepKind), id: s.id })}>
                      {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_SPECS[k].label}</option>)}
                    </select>
                    <span className={`pp-tag pp-tag-${spec.comparability}`}>{spec.comparability === "comparable" ? "comparable" : spec.comparability === "caution" ? "caution" : "not comparable"}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={S.up}>↑</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={S.down}>↓</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSteps((prev) => prev.filter((_, k) => k !== i))} aria-label={`${S.remove} step ${i + 1}`}>✕</button>
                  </div>
                  {spec.params.map((ps) => (
                    <label key={ps.name} className="pp-param">
                      <span>{ps.label}</span>
                      {ps.type === "choice" ? (
                        <select value={String(s.params[ps.name])} onChange={(e) => setStep(i, { ...s, params: { ...s.params, [ps.name]: coerceParam(ps, e.target.value) } })}>
                          {ps.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <>
                          <input type="range" min={ps.min} max={ps.max} step={ps.type === "int" ? (ps.step ?? 1) : ps.step} value={Number(s.params[ps.name])} onChange={(e) => setStep(i, { ...s, params: { ...s.params, [ps.name]: coerceParam(ps, e.target.value) } })} />
                          <input type="number" min={ps.min} max={ps.max} step={ps.type === "int" ? (ps.step ?? 1) : ps.step} value={Number(s.params[ps.name])} onChange={(e) => setStep(i, { ...s, params: { ...s.params, [ps.name]: coerceParam(ps, e.target.value) } })} />
                        </>
                      )}
                    </label>
                  ))}
                  <p className="hint">{spec.note}</p>
                  {issues[i] ? <p className="pp-warn" role="alert">{issues[i]}</p> : null}
                </li>
              );
            })}
          </ol>
          <label className="pp-param">
            <span>{S.addStep}</span>
            <select value="" onChange={(e) => e.target.value && setSteps((prev) => [...prev, newStep(e.target.value as StepKind)])}>
              <option value="">…</option>
              {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_SPECS[k].label}</option>)}
              {UNAVAILABLE_STEPS.map((u) => <option key={u.kind} value="" disabled>{`${u.label} — ${S.unavailable}`}</option>)}
            </select>
          </label>
          <ul className="hint pp-unavailable">{UNAVAILABLE_STEPS.map((u) => <li key={u.kind}>{u.label}: {u.reason}</li>)}</ul>
          <label className="pp-param">
            <span>{S.shownSpectra}</span>
            <input type="number" min={1} max={Math.min(40, data.counts.used)} value={shown} onChange={(e) => setShown(Math.max(1, Math.min(40, Math.round(Number(e.target.value) || 1))))} />
          </label>
        </div>

        <div className="pp-results">
          <div className={`pp-banner pp-banner-${comparability}`} role="note">
            <strong>{comparability === "comparable" ? "Comparable scale" : comparability === "caution" ? "Interpret with caution" : "Not directly comparable"}</strong> — {S.comparability[comparability]}
          </div>
          <p className="hint">{S.neverImprovement}</p>
          {error ? <p className="pp-warn" role="alert">{error}</p> : null}
          {busy || !before ? <p className="hint" aria-live="polite">{S.computing}</p> : null}
          <h4>{S.metrics} — {label}</h4>
          <div className="pp-tiles">
            {tile("SNR gain", m?.snrGainDb, "dB")}
            {tile("Fine-scale variation reduction", m?.fineScaleReduction, "%")}
            {tile("Relative spectral RMSE", m?.relativeRmse, "%")}
            {tile("Spectral angle", m?.spectralAngle, "°")}
            {tile("Diversity retention", m?.diversityRetention, "%")}
          </div>
          <details className="pp-defs">
            <summary>{S.definitions}</summary>
            <dl>{DEFINITIONS.map((d) => <div key={d.term}><dt>{d.term}</dt><dd>{d.text}</dd></div>)}</dl>
          </details>
        </div>
      </div>

      {tracks.length ? (
        <Measured>
          {(w) => <AlignedTracks axis={data.axis} axisLabel={axisLabel} tracks={tracks} width={w} title={`Preprocessing explorer tracks — ${label}`} selection={band} onSelect={setBand} />}
        </Measured>
      ) : null}

      <h4>{S.bandWindow}</h4>
      {descriptors ? <BandTable d={descriptors} unit={unit} axisUnit={data.axisUnit} amplitudeComparable={sameScale} locale={locale} /> : <p className="hint">{comparability === "not_comparable" ? "Band descriptors are disabled for derivatives (the band shape changes by construction)." : S.bandHint}</p>}

      <h4>SNR distributions before / after</h4>
      {snrHist ? (
        <Measured>{(w) => <PairedHistogram title="Per-spectrum SNR before and after preprocessing" xLabel="SNR (dB)" edges={snrHist.edges} counts={snrHist.counts} labels={["Raw (solid)", "Processed (hatched, dashed)"]} width={w} />}</Measured>
      ) : (
        <p className="hint">{deltaOff ? S.comparability.not_comparable : "Not available."}</p>
      )}

      <h4>{S.table}</h4>
      <table className="pp-table">
        <thead><tr><th scope="col">Indicator (same spectra, fixed diagnostics)</th><th scope="col">Raw</th><th scope="col">Preprocessed</th><th scope="col">Delta</th></tr></thead>
        <tbody>
          {tableRows.map((r) => (
            <tr key={r[0]}><th scope="row">{r[0]}</th><td>{fmt(r[1], locale)}</td><td>{fmt(r[2], locale)}</td><td>{deltaCell(r)}</td></tr>
          ))}
        </tbody>
      </table>
      {!before?.repeat ? <p className="hint">Repeatability SD and ICC need at least two samples with replicate spectra in the subset; not available here.</p> : null}

      <h4>{S.benchmark}</h4>
      <p className="hint">{S.benchmarkLead}</p>
      <div className="pp-bench-bar">
        {benchProgress ? (
          <>
            <span aria-live="polite">{`${benchProgress.done} / ${benchProgress.total} configurations`}</span>
            <button className="btn btn-sm" onClick={cancelBenchmark}>{S.cancel}</button>
          </>
        ) : (
          <button className="btn btn-sm" onClick={runBenchmark} disabled={!before}>{S.runBenchmark(grid.length + (nominal && !grid.some((g) => recipeKey(g.steps) === nominal) ? 1 : 0))}</button>
        )}
        <label><input type="checkbox" checked={showFront} onChange={(e) => setShowFront(e.target.checked)} /> {S.pareto}</label>
      </div>
      <p className="hint">{S.nominalNote}</p>
      {points.length ? (
        <>
          <Measured>
            {(w) => <BenchmarkScatter points={points} nominalKey={nominal} front={front} showFront={showFront} selectedKey={recipeKey(recipe)} width={w} onPick={(p) => setSteps(p.steps.map((s) => newStep(s.kind, s.params)))} />}
          </Measured>
          <ChartDataTable
            caption="Benchmark configurations (same spectra, fixed diagnostics)"
            columns={["Configuration", "Relative RMSE (%)", "Fine-scale reduction (%)", "SNR gain (dB)", "Non-dominated", "Error"]}
            rows={points.map((p, i) => [p.label, p.distortion, p.reduction, p.snrGainDb, showFront && front.has(i) ? "yes" : "no", p.error ?? ""])}
            locale={locale}
          />
        </>
      ) : null}

      <h4>{S.chemometric}</h4>
      <p className="hint pp-disabled" aria-disabled="true">{S.chemometricNote}</p>
      <p className="hint">{S.syntheticNote}</p>
    </section>
  );
}

function BandTable({ d, unit, axisUnit, amplitudeComparable, locale }: { d: { raw: BandDescriptor | null; proc: BandDescriptor | null; lo: number; hi: number }; unit: string; axisUnit: string; amplitudeComparable: boolean; locale: Locale }) {
  const delta = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? "—" : fmt(b - a, locale));
  return (
    <table className="pp-table">
      <caption>{`Median-spectrum band in [${fmt(d.lo, locale)}, ${fmt(d.hi, locale)}] ${axisUnit}`}</caption>
      <thead><tr><th scope="col">Descriptor</th><th scope="col">Raw</th><th scope="col">Preprocessed</th><th scope="col">Delta</th></tr></thead>
      <tbody>
        <tr><th scope="row">{`Position (${axisUnit || "axis"})`}</th><td>{fmt(d.raw?.position, locale)}</td><td>{fmt(d.proc?.position, locale)}</td><td>{delta(d.raw?.position, d.proc?.position)}</td></tr>
        <tr><th scope="row">{`Height above local baseline (${unit})`}</th><td>{fmt(d.raw?.height, locale)}</td><td>{fmt(d.proc?.height, locale)}</td><td>{amplitudeComparable ? delta(d.raw?.height, d.proc?.height) : "not comparable"}</td></tr>
        <tr><th scope="row">{`Full width at half height (${axisUnit || "axis"})`}</th><td>{fmt(d.raw?.width, locale)}</td><td>{fmt(d.proc?.width, locale)}</td><td>{delta(d.raw?.width, d.proc?.width)}</td></tr>
      </tbody>
    </table>
  );
}
