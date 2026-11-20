// Interactive spectral preprocessing explorer (request §8). Methods kernels run in a dedicated
// worker; this component holds the pipeline, debounces recomputation and renders the views,
// grouped by rubric: controls → one synchronized per-band stack → per-spectrum distributions →
// one impact table → benchmark → collapsed reference material.
import { scanLabel } from "../integrity/IntegrityPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartDataTable } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { AlignedTracks, type BandSelection, type Track } from "../repeatability";
import { ChartCard, EmptyState, Legend, ParetoScatter, PrincipleIllustration, Responsive, type ScatterPoint } from "../shared/charts";
import {
  STEP_KINDS,
  STEP_SPECS,
  coerceParam,
  newStep,
  pipelineLabel,
  stepIssue,
  stripIds,
  type ParamSpec,
  type PipelineStep,
  type StepKind,
} from "./catalog";
import { EXPLORER_SPECTRA_CAP, diagnosticSettings, prepareExplorerData } from "./data";
import { benchmarkGrid, recipeKey, sweepOf, sweepTrajectory, sweeps, type BenchmarkPoint, type Diagnostics, type Evaluation, type EvaluationInput } from "./evaluate";
import { impactRows, type ImpactRow } from "./impact";
import { bandDescriptor, medianOf, paretoFront, row, type BandDescriptor, type Matrix } from "./metrics";
import { CancelledError, StaleError, createExplorerHost, spawnExplorerWorker, type ExplorerHost } from "./protocol";
import { PairedDistribution } from "./charts";
import { ChemometricPanel } from "./ChemometricPanel";
import { bandDiagnostics, publishDistortionProfile } from "./distortion";
import { DEFINITIONS, PRECAUTIONS, S, WORKFLOW } from "./strings";
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

const RAW = "var(--cz-raw)";
const PROC = "var(--cz-processed)";
const RESIDUAL = "var(--cz-copper)";

/** Three significant digits, tabular-friendly; "—" for missing values. */
export const num = (v: number | null | undefined, digits = 3): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2).replace("-", "−");
  return Number(v.toPrecision(digits)).toLocaleString("en", { maximumFractionDigits: 12 }).replace("-", "−");
};
const withUnit = (v: number | null | undefined, unit: string, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : unit === "×" ? `${num(v, digits)}×` : `${num(v, digits)} ${unit}`);
const signed = (v: number | null, unit: string) => {
  if (v === null || !Number.isFinite(v)) return "—";
  const s = `${v > 0 ? "+" : ""}${num(v)}`;
  return unit === "×" ? `${s}×` : unit === "%" ? `${s} pp` : `${s} ${unit}`;
};
const med = (xs: readonly (number | null)[] | undefined | null) => (xs ? medianOf(xs.filter((v): v is number => v !== null)) : null);
const sum = (xs: readonly (number | null)[] | undefined) => (xs ? xs.reduce<number>((s, v) => s + (v ?? 0), 0) : null);
const pick = (m: Matrix, idx: number[]) => idx.map((i) => Array.from(row(m, i)));
const anyPositive = (xs: readonly number[] | undefined) => !!xs?.some((v) => v > 0);

export function PreprocessingExplorer({ scope }: { scope: Scope }) {
  const { input, sourceId, targetId, locale } = scope;
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
  const [showOtherFront, setShowOtherFront] = useState(false);
  const [sweepKey, setSweepKey] = useState<string>("savgol:2");
  const autoBench = useRef<EvaluationInput | null>(null);

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
    if (!data || !evaluation || !before) {
      publishDistortionProfile(null);
      return;
    }
    const n = data.counts.used;
    publishDistortionProfile({
      sourceId: data.sourceId,
      axis: data.axis,
      values: evaluation.distortion,
      label: result!.label,
      n,
      fineScaleReductionPercent: evaluation.metrics.fineScaleReduction.value,
      bands: { raw: bandDiagnostics(before, n), processed: bandDiagnostics(evaluation.after, n), preservesUnits: evaluation.preservesUnits, comparability: evaluation.comparability },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation, data, before]);
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

  const nominal = steps.length === 1 && STEP_SPECS[steps[0]!.kind].comparability === "comparable" ? recipeKey(recipe) : null;
  const grid = useMemo(() => (data ? benchmarkGrid(data.matrix.cols) : []), [data]);
  const benchConfigs = () => (nominal && !grid.some((g) => recipeKey(g.steps) === nominal) ? [...grid, { label: `Current: ${currentLabel}`, steps: recipe }] : grid);
  const runBenchmark = () => {
    const configs = benchConfigs();
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
  // The trade-off chart is evaluated automatically once per loaded subset (it is cheap: transform + noise only).
  useEffect(() => {
    if (!before || !evalInput || autoBench.current === evalInput) return;
    autoBench.current = evalInput;
    runBenchmark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [before, evalInput]);
  const cancelBenchmark = () => {
    hostRef.current!.cancel();
    setBusy(false);
    // The worker restarts on the next call; recompute the current pipeline.
    if (evalInput) hostRef.current!.init(evalInput).then(setBefore, () => undefined);
  };

  if (!data || !evalInput) {
    return (
      <section className="pp-explorer">
        <EmptyState>{S.noData}</EmptyState>
      </section>
    );
  }

  const axisLabel = data.axisUnit ? `Spectral axis (${data.axisUnit})` : "Spectral axis";
  const unit = data.signalUnit || "signal unit";
  const procUnit = evaluation?.preservesUnits ? unit : "processed units";
  const sameScale = evaluation?.preservesUnits ?? true;
  const comparability = evaluation?.comparability ?? "comparable";
  const deltaOff = comparability === "not_comparable";
  const after = evaluation?.after;
  const n = data.counts.used;

  // --- 2. one synchronized per-band stack ------------------------------------------------------
  const tracks: Track[] = [];
  const zeroEvents: string[] = [];
  if (before) {
    const rawRows = pick(data.matrix, shownIdx);
    const names = shownIdx.map((i) => scanLabel(data.observationIds[i]!));
    const rawSeries = rawRows.map((v, i) => ({ id: `r${i}`, label: `${names[i]} · raw`, values: v, color: RAW }));
    const procSeries = evaluation ? pick(evaluation.processed, shownIdx).map((v, i) => ({ id: `p${i}`, label: `${names[i]} · processed`, values: v, color: PROC })) : [];
    if (sameScale) {
      tracks.push({ id: "overlay", title: `Raw and processed spectra (${shownIdx.length} of ${n} drawn)`, unit, height: 230, series: [...rawSeries, ...procSeries] });
    } else {
      tracks.push({ id: "overlay-raw", title: `Raw spectra (${shownIdx.length} of ${n} drawn)`, unit, height: 170, series: rawSeries });
      tracks.push({ id: "overlay-proc", title: "Processed spectra (different scale)", unit: procUnit, height: 170, series: procSeries });
    }
    const rawEnv = { id: "er", label: "Raw P5–P95", lower: before.envelope.p5, upper: before.envelope.p95, color: RAW };
    const rawMed = { id: "mr", label: "Raw median", values: before.envelope.median, color: RAW };
    if (procEnvelope && sameScale) {
      tracks.push({ id: "env", title: "Median spectrum and P5–P95 envelope", unit, envelopes: [rawEnv, { id: "ep", label: "Processed P5–P95", lower: procEnvelope.p5, upper: procEnvelope.p95, color: PROC }], series: [rawMed, { id: "mp", label: "Processed median", values: procEnvelope.median, color: PROC }] });
    } else {
      tracks.push({ id: "env-raw", title: "Raw median spectrum and P5–P95 envelope", unit, envelopes: [rawEnv], series: [rawMed] });
      if (procEnvelope) tracks.push({ id: "env-proc", title: "Processed median and P5–P95 envelope", unit: procUnit, envelopes: [{ id: "ep", label: "Processed P5–P95", lower: procEnvelope.p5, upper: procEnvelope.p95, color: PROC }], series: [{ id: "mp", label: "Processed median", values: procEnvelope.median, color: PROC }] });
    }
    if (evaluation?.residual) {
      tracks.push({ id: "res", title: "Residual r = raw − processed (median, P5–P95)", unit, includeZero: true, series: [{ id: "r", label: "Residual median", values: evaluation.residual.median, color: RESIDUAL }], envelopes: [{ id: "re", label: "Residual P5–P95", lower: evaluation.residual.p5, upper: evaluation.residual.p95, color: RESIDUAL }], refLines: [{ y: 0, label: "0" }] });
    }
    const pair = (id: string, title: string, a: readonly (number | null)[] | undefined, b: readonly (number | null)[] | undefined, extra: Partial<Track> = {}) => {
      if (!a) return;
      if (sameScale || !b) {
        tracks.push({ id, title, unit, includeZero: true, ...extra, series: [{ id: "a", label: `${title} · raw`, values: a, color: RAW }, ...(b ? [{ id: "b", label: `${title} · processed`, values: b, color: PROC }] : [])] });
      } else {
        tracks.push({ id: `${id}-a`, title: `${title} — raw`, unit, includeZero: true, ...extra, series: [{ id: "a", label: `${title} · raw`, values: a, color: RAW }] });
        tracks.push({ id: `${id}-b`, title: `${title} — processed (different scale)`, unit: procUnit, includeZero: true, ...extra, series: [{ id: "b", label: `${title} · processed`, values: b, color: PROC }] });
      }
    };
    pair("noise", "Local noise proxy", before.profile?.band, after?.profile?.band);
    pair("div", "Between-spectrum SD", before.diversity, after?.diversity);
    if (before.repeat) {
      pair("rep", "Repeatability SD", before.repeat.sd, after?.repeat?.sd);
      tracks.push({ id: "icc", title: "ICC(1,1) per band", unit: "ratio", includeZero: true, series: [{ id: "a", label: "ICC · raw", values: before.repeat.icc, color: RAW }, ...(after?.repeat ? [{ id: "b", label: "ICC · processed", values: after.repeat.icc, color: PROC }] : [])] });
    }
    if (before.events) {
      const ev = (key: "spikeBands" | "jumpBands", title: string, noun: string) => {
        const a = before.events![key], b = after?.events?.[key];
        if (!anyPositive(a) && !anyPositive(b)) {
          zeroEvents.push(`No ${noun} flagged in ${n} spectra${after?.events ? ", before or after preprocessing" : ""}.`);
          return;
        }
        tracks.push({ id: key, title, unit: "spectra", includeZero: true, series: [{ id: "a", label: `${title} · raw`, values: a, color: RAW, kind: "bars" }, ...(b ? [{ id: "b", label: `${title} · processed`, values: b, color: PROC }] : [])] });
      };
      ev("spikeBands", "Isolated peaks per band", "isolated peak");
      ev("jumpBands", "Abrupt changes per band", "abrupt change");
    }
  }

  // --- 4. one impact table ------------------------------------------------------------------------
  const primary = before ? impactRows(before, evaluation, n) : [];
  const m = evaluation?.metrics;
  type Cell = string;
  type TableRow = { label: string; raw: Cell; proc: Cell; delta: Cell; note?: string | null };
  const metricCell = (v: { value: number | null; disabled: string | null } | undefined, u: string) => (v?.disabled ? "withheld" : withUnit(v?.value, u));
  const comparison: TableRow[] = m
    ? [
        { label: "SNR gain (paired median)", raw: "", proc: "", delta: m.snrGainDb.disabled ? "withheld" : signed(m.snrGainDb.value, "dB"), note: m.snrGainDb.disabled },
        { label: "Fine-scale variation reduction", raw: "", proc: "", delta: metricCell(m.fineScaleReduction, "%"), note: m.fineScaleReduction.disabled },
        { label: "Relative spectral RMSE", raw: "Ref.", proc: metricCell(m.relativeRmse, "%"), delta: "", note: m.relativeRmse.disabled },
        { label: "Spectral angle", raw: "Ref.", proc: metricCell(m.spectralAngle, "°"), delta: "", note: m.spectralAngle.disabled },
        { label: "Between-sample diversity retention", raw: "100 %", proc: metricCell(m.diversityRetention, "%"), delta: "", note: m.diversityRetention.disabled },
      ]
    : [];
  const otherDelta = (a: number | null, b: number | null, kind: "unit" | "count" | "ratio") => {
    if (a === null || b === null) return "—";
    if (deltaOff || (kind === "unit" && !sameScale)) return "not comparable";
    return signed(b - a, "");
  };
  const otherRow = (labelText: string, a: number | null, b: number | null, kind: "unit" | "count" | "ratio"): TableRow => ({ label: labelText, raw: num(a), proc: num(b), delta: otherDelta(a, b, kind).trim() });
  const other: TableRow[] = before
    ? [
        otherRow(`Median noise σ (${unit})`, med(before.noise?.sigma), med(after?.noise?.sigma), "unit"),
        otherRow("Isolated peaks (events)", sum(before.events?.spikes), sum(after?.events?.spikes), "count"),
        otherRow("Abrupt changes (events)", sum(before.events?.jumps), sum(after?.events?.jumps), "count"),
        otherRow(`Median between-spectrum SD (${unit})`, med(before.diversity), med(after?.diversity), "unit"),
        otherRow(`Pooled noise proxy (${unit})`, before.profile?.pooled ?? null, after?.profile?.pooled ?? null, "unit"),
        ...(before.repeat
          ? [otherRow(`Median repeatability SD (${unit})`, med(before.repeat.sd), med(after?.repeat?.sd), "unit"), otherRow("Median ICC(1,1) over bands", med(before.repeat.icc), med(after?.repeat?.icc), "ratio")]
          : []),
      ]
    : [];

  // --- 5. benchmark -------------------------------------------------------------------------------
  const front = paretoFront(points.map((p) => ({ x: p.distortion, y: p.reduction })));
  const sweepList = sweeps(points);
  const activeSweep = sweepList.some((s) => s.key === sweepKey) ? sweepKey : (sweepList[0]?.key ?? sweepKey);
  const trajectory = sweepTrajectory(points, activeSweep);
  const scatterPoints: ScatterPoint[] = points.length
    ? [
        { id: "raw", x: 0, y: 0, label: "Raw" },
        // The active sweep, plus (on request) the non-dominated settings of the other sweeps.
        ...points.flatMap((p, i) =>
          trajectory.includes(i) || (showFront && showOtherFront && front.has(i) && p.distortion !== null && p.reduction !== null)
            ? [{ id: p.key, x: p.distortion!, y: p.reduction!, label: sweepOf(p.steps)?.short ?? p.label, nominal: p.key === nominal, pareto: showFront && front.has(i) }]
            : [],
        ),
      ]
    : [];
  const frontInSweep = trajectory.filter((i) => front.has(i)).length;

  const setStep = (i: number, s: PipelineStep) => setSteps((prev) => prev.map((x, k) => (k === i ? s : x)));
  const move = (i: number, d: -1 | 1) => setSteps((prev) => {
    const next = [...prev];
    const j = i + d;
    if (j < 0 || j >= next.length) return prev;
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });
  const setParam = (i: number, s: PipelineStep, ps: ParamSpec, v: string) => setStep(i, { ...s, params: { ...s.params, [ps.name]: coerceParam(ps, v) } });

  return (
    <section className="pp-explorer" aria-busy={busy}>
      <header className="pp-head">
        <p className="pp-lead">{S.lead}</p>
        <p className="pp-meta">{S.denominators(n, data.counts.complete, data.counts.total, EXPLORER_SPECTRA_CAP)}</p>
        {data.irregularAxis ? <p className="pp-meta pp-warn">{S.irregularAxis}</p> : null}
        <ol className="pp-flow" aria-label={S.workflowLabel}>
          {WORKFLOW.map((w) => (
            <li key={w.n} className={w.href ? "" : "pp-flow-off"}>
              {w.href ? <a href={w.href}><b>{w.n}. {w.title}</b><span>{w.caption}</span></a> : <span className="pp-flow-static"><b>{w.n}. {w.title}</b><span>{w.caption}</span></span>}
            </li>
          ))}
        </ol>
      </header>

      <div className="pp-top">
        {/* 1. Controls and pipeline (image6 control card) */}
        <aside className="pp-controls cz-card" id="pp-controls" aria-label={S.controls}>
          <div className="pp-controls-main">
          <p className="pp-caption">{S.controls}</p>
          {steps.length === 0 ? <p className="pp-meta">{S.emptyPipeline}</p> : null}
          <ol className="pp-steps">
            {steps.map((s, i) => {
              const spec = STEP_SPECS[s.kind];
              return (
                <li key={s.id} className="pp-step">
                  <div className="pp-step-head">
                    <select className="pp-method" aria-label={`Step ${i + 1} method`} value={s.kind} onChange={(e) => setStep(i, { ...newStep(e.target.value as StepKind), id: s.id })}>
                      {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_SPECS[k].label}</option>)}
                    </select>
                    {steps.length > 1 ? (
                      <span className="pp-step-tools">
                        <button className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`${S.up}: step ${i + 1}`}>↑</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`${S.down}: step ${i + 1}`}>↓</button>
                      </span>
                    ) : null}
                    <button className="btn btn-ghost btn-sm" onClick={() => setSteps((prev) => prev.filter((_, k) => k !== i))} aria-label={`${S.remove} step ${i + 1}`}>✕</button>
                  </div>
                  <span className={`pp-tag pp-tag-${spec.comparability}`}>{S.comparabilityTitle[spec.comparability]}</span>
                  {spec.params.map((ps) =>
                    ps.type === "choice" ? (
                      <label key={ps.name} className="pp-param">
                        <span className="pp-param-row"><span>{ps.label}</span></span>
                        <select value={String(s.params[ps.name])} onChange={(e) => setParam(i, s, ps, e.target.value)}>
                          {ps.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </label>
                    ) : (
                      <label key={ps.name} className="pp-param">
                        <span className="pp-param-row"><span>{ps.label}</span><b>{`${s.params[ps.name]}${ps.unit ? ` ${ps.unit}` : ""}`}</b></span>
                        <input type="range" min={ps.min} max={Math.min(ps.max, ps.name === "window" ? data.matrix.cols : ps.max)} step={ps.type === "int" ? (ps.step ?? 1) : ps.step} value={Number(s.params[ps.name])} onChange={(e) => setParam(i, s, ps, e.target.value)} />
                        <span className="pp-param-range" aria-hidden="true"><span>{ps.min}</span><span>{Math.min(ps.max, ps.name === "window" ? data.matrix.cols : ps.max)}</span></span>
                      </label>
                    ),
                  )}
                  <p className="pp-note">{spec.note}</p>
                  {issues[i] ? <p className="pp-warn" role="alert">{issues[i]}</p> : null}
                </li>
              );
            })}
          </ol>
          </div>
          <div className="pp-controls-side">
          <label className="pp-param">
            <span className="pp-param-row"><span>{S.addStep}</span></span>
            <select value="" onChange={(e) => e.target.value && setSteps((prev) => [...prev, newStep(e.target.value as StepKind)])}>
              <option value="">Choose a method…</option>
              {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_SPECS[k].label}</option>)}
            </select>
          </label>
          <p className="pp-note">{S.localSteps}</p>
          <label className="pp-param">
            <span className="pp-param-row"><span>{S.shownSpectra}</span><b>{Math.min(shown, n)}</b></span>
            <input type="range" min={1} max={Math.min(32, n)} value={Math.min(shown, n)} onChange={(e) => setShown(Number(e.target.value))} />
          </label>
          <div className={`pp-banner pp-banner-${comparability}`} role="note">
            <strong>{S.comparabilityTitle[comparability]}.</strong> {S.comparability[comparability]}
          </div>
          {error ? <p className="pp-warn" role="alert">{error}</p> : null}
          <p className="pp-meta" aria-live="polite">{busy || !before ? S.computing : `Showing: ${label}`}</p>
          </div>
        </aside>

        {/* 2. Single synchronized per-band stack */}
        <ChartCard className="pp-tracks" title={S.tracksTitle} subtitle={S.tracksSub}>
          {tracks.length ? (
            <>
              <Legend
                items={[
                  { label: "Raw", color: RAW, kind: "line" },
                  ...(evaluation ? [{ label: "Processed", color: PROC, kind: "line" as const }] : []),
                  ...(evaluation?.residual ? [{ label: "Residual raw − processed", color: RESIDUAL, kind: "line" as const }] : []),
                  { label: "Shaded: P5–P95 across spectra", color: "var(--cz-track)" },
                ]}
              />
              <Responsive>
                {(w) => <AlignedTracks axis={data.axis} axisLabel={axisLabel} tracks={tracks} width={w} title={`Preprocessing explorer — ${label}`} selection={band} onSelect={setBand} legend={false} />}
              </Responsive>
            </>
          ) : (
            <EmptyState>{S.computing}</EmptyState>
          )}
          {zeroEvents.map((z) => <EmptyState key={z}>{z}</EmptyState>)}
          <h5 className="pp-sub">{S.bandTitle}</h5>
          {descriptors ? <BandTable d={descriptors} unit={unit} axisUnit={data.axisUnit} amplitudeComparable={sameScale} /> : <p className="pp-meta">{comparability === "not_comparable" ? S.bandDisabled : S.bandHint}</p>}
        </ChartCard>
      </div>

      {/* 3. Per-spectrum distributions, side by side */}
      <ChartCard title={S.distributionsTitle} subtitle={S.distributionsSub} id="pp-impact">
        <div className="pp-dists">
          <PairedDistribution
            title="SNR per spectrum"
            unit="dB"
            raw={before?.noise?.snrDb ?? null}
            processed={after && !deltaOff ? (after.noise?.snrDb ?? null) : null}
            withheld={deltaOff ? "Processed SNR is not on the raw scale (derivative)." : null}
          />
          <PairedDistribution
            title="RMS distance to the mean spectrum"
            unit={unit}
            raw={before?.reference ?? null}
            processed={after?.reference ?? null}
            separateScales={!sameScale}
            withheld={null}
          />
        </div>
      </ChartCard>

      {/* 4. One impact table */}
      <ChartCard title={S.impactTitle} subtitle={S.impactSub(n)} footnote={S.neverImprovement}>
        <table className="pp-table">
          <thead><tr><th scope="col">Metric</th><th scope="col">Raw</th><th scope="col">Processed</th><th scope="col">Delta</th></tr></thead>
          <tbody>
            {primary.length ? <tr className="pp-group"><th scope="rowgroup" colSpan={4}>{S.impactPrimary}</th></tr> : <tr><td colSpan={4} className="pp-withheld">{S.computing}</td></tr>}
            {primary.map((r) => <ImpactTr key={r.key} r={r} />)}
            {comparison.length ? <tr className="pp-group"><th scope="rowgroup" colSpan={4}>{S.impactComparison}</th></tr> : null}
            {comparison.map((r) => <PlainTr key={r.label} r={r} />)}
            {other.length ? <tr className="pp-group"><th scope="rowgroup" colSpan={4}>{S.impactOther}</th></tr> : null}
            {other.map((r) => <PlainTr key={r.label} r={r} />)}
          </tbody>
        </table>
        {!before?.repeat ? <p className="pp-meta">Repeatability SD and ICC need at least two samples with replicate spectra in the subset; not available here.</p> : null}
      </ChartCard>

      {/* 5. Benchmark */}
      <ChartCard
        id="pp-bench"
        title={S.benchmark}
        subtitle={S.benchmarkSub}
        footnote={S.benchmarkFoot}
        actions={
          benchProgress ? (
            <>
              <span className="pp-meta" aria-live="polite">{`${benchProgress.done} / ${benchProgress.total}`}</span>
              <button className="btn btn-sm" onClick={cancelBenchmark}>{S.cancel}</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={runBenchmark} disabled={!before}>{S.runBenchmark(benchConfigs().length)}</button>
          )
        }
      >
        <div className="pp-bench-bar">
          {sweepList.length ? (
            <label>
              Sweep{" "}
              <select value={activeSweep} onChange={(e) => setSweepKey(e.target.value)}>
                {sweepList.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          ) : null}
          <label><input type="checkbox" checked={showFront} onChange={(e) => setShowFront(e.target.checked)} /> {S.pareto}</label>
          {showFront ? <label><input type="checkbox" checked={showOtherFront} onChange={(e) => setShowOtherFront(e.target.checked)} /> {S.otherFront}</label> : null}
        </div>
        {showFront && points.length ? (
          <p className="pp-meta">{`Non-dominated (ringed; lower distortion and higher reduction than any other setting): ${front.size} of ${points.length} settings, ${frontInSweep} in this sweep — ${[...front].map((i) => sweepOf(points[i]!.steps)?.short ?? points[i]!.label).join(", ")}.`}</p>
        ) : null}
        <ParetoScatter
          title="Fine-scale variation reduction versus spectral distortion"
          points={scatterPoints}
          trajectory={["raw", ...trajectory.map((i) => points[i]!.key)]}
          xLabel="Spectral distortion: median relative RMSE (%)"
          yLabel="Fine-scale variation reduction (%)"
          selectedId={recipeKey(recipe)}
          onSelect={(id) => {
            if (id === "raw") return setSteps([]);
            const p = points.find((q) => q.key === id);
            if (p) setSteps(p.steps.map((s) => newStep(s.kind, s.params)));
          }}
          height={320}
          emptyMessage={benchProgress ? "Evaluating configurations…" : "No configuration evaluated yet."}
        />
        {points.length ? (
          <details className="pp-details">
            <summary>{`${S.benchmarkTable} (${points.length} settings)`}</summary>
            <ChartDataTable
              caption="Benchmark configurations (same spectra, fixed diagnostics)"
              columns={["Configuration", "Relative RMSE (%)", "Fine-scale reduction (%)", "SNR gain (dB)", "Non-dominated", "Error"]}
              rows={points.map((p, i) => [p.label, num(p.distortion), num(p.reduction), num(p.snrGainDb), front.has(i) ? "yes" : "no", p.error ?? ""])}
              locale={locale}
            />
          </details>
        ) : null}
      </ChartCard>

      {/* 6. Optional chemometric validation (explicit opt-in) */}
      <ChemometricPanel input={input} sourceId={sourceId} targetId={targetId} host={hostRef.current!} steps={recipe} label={currentLabel} onCancel={cancelBenchmark} locale={locale} />

      {/* 7. Reference material, collapsed */}
      <div className="pp-refs">
        <details className="pp-details">
          <summary>{S.precautions}</summary>
          <table className="pp-table pp-precautions">
            <thead><tr><th scope="col">Preprocessing family</th><th scope="col">Before/after SNR comparison</th></tr></thead>
            <tbody>
              {PRECAUTIONS.map((p) => <tr key={p.family}><th scope="row">{p.family}</th><td><span className={`pp-tag pp-tag-${p.level}`}>{p.snr}</span></td></tr>)}
            </tbody>
          </table>
          <p className="pp-meta">The original metrics are kept as an immutable reference; the source dataset is never modified.</p>
        </details>
        <details className="pp-details">
          <summary>{S.principle}</summary>
          <PrincipleIllustration caption={S.principleCaption} />
        </details>
        <details className="pp-details">
          <summary>{S.definitions}</summary>
          <p className="pp-meta">{S.fixedDiagnostics(settings.eventThreshold, settings.noiseWindow, settings.noisePolyorder)}</p>
          <dl className="pp-defs">{DEFINITIONS.map((d) => <div key={d.term}><dt>{d.term}</dt><dd>{d.text}</dd></div>)}</dl>
        </details>
        <details className="pp-details">
          <summary>Synthetic noise scenarios</summary>
          <p className="pp-meta">{S.syntheticNote}</p>
        </details>
      </div>
    </section>
  );
}

function ImpactTr({ r }: { r: ImpactRow }) {
  return (
    <tr>
      <th scope="row">{r.label}</th>
      <td>{r.rawReference ? "Ref." : withUnit(r.raw, r.unit)}</td>
      <td>{r.withheld && r.key === "distortion" ? <span className="pp-withheld">withheld</span> : withUnit(r.processed, r.unit)}</td>
      <td>{r.withheld ? <span className="pp-withheld" title={r.withheld}>{r.withheld}</span> : r.rawReference ? "" : signed(r.delta, r.unit)}</td>
    </tr>
  );
}

function PlainTr({ r }: { r: { label: string; raw: string; proc: string; delta: string; note?: string | null } }) {
  const cell = (v: string) => (v === "withheld" || v === "not comparable" ? <span className="pp-withheld" title={r.note ?? undefined}>{v}</span> : v);
  return (
    <tr>
      <th scope="row">{r.label}</th>
      <td>{cell(r.raw)}</td>
      <td>{cell(r.proc)}</td>
      <td>{cell(r.delta)}</td>
    </tr>
  );
}

function BandTable({ d, unit, axisUnit, amplitudeComparable }: { d: { raw: BandDescriptor | null; proc: BandDescriptor | null; lo: number; hi: number }; unit: string; axisUnit: string; amplitudeComparable: boolean }) {
  const delta = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? "—" : signed(b - a, ""));
  const rows: [string, number | null | undefined, number | null | undefined, string][] = [
    [`Position (${axisUnit || "axis"})`, d.raw?.position, d.proc?.position, delta(d.raw?.position, d.proc?.position)],
    [`Height above local baseline (${unit})`, d.raw?.height, d.proc?.height, amplitudeComparable ? delta(d.raw?.height, d.proc?.height) : "not comparable"],
    [`Full width at half height (${axisUnit || "axis"})`, d.raw?.width, d.proc?.width, delta(d.raw?.width, d.proc?.width)],
  ];
  return (
    <table className="pp-table">
      <caption>{`Band in [${num(d.lo)}, ${num(d.hi)}] ${axisUnit}`}</caption>
      <thead><tr><th scope="col">Descriptor</th><th scope="col">Raw</th><th scope="col">Processed</th><th scope="col">Delta</th></tr></thead>
      <tbody>
        {rows.map(([l, a, b, dd]) => (
          <tr key={l}><th scope="row">{l}</th><td>{num(a)}</td><td>{num(b)}</td><td>{dd.trim()}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
