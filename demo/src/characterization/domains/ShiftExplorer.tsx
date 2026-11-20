// §13 interactive domain-shift explorer: effect of a preprocessing pipeline (agent C's fitted pipeline API)
// on the shift metrics of one comparison. Learned parameters and the reference PCA are fitted on the
// reference (calibration / development) domain only and applied unchanged to the compared domain. Defaults to a
// development-domain comparison; the retained-test audit is a read-only X-only view. Nothing is optimized and
// no target value is read.
import { useEffect, useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { STEP_KINDS, STEP_SPECS, coerceParam, newStep, pipelineLabel, stepIssue, stripIds, type PipelineStep, type StepKind } from "../preprocessing/catalog";
import { ChartCard, EmptyState } from "../shared/charts";
import { defaultFmt as f } from "../shared/charts/scale";
import { DomainLegend, PcaOverlap } from "./charts";
import { domainTask } from "./host";
import { MAX_PAIRWISE_UNITS } from "./kernels";
import type { ComparisonModel, FactorModel } from "./model";
import { domainPopulations, unitDescriber, unitLabel } from "./populations";
import type { ExploreRequest, ExploreResult, ShiftSide } from "./shiftExplorer";
import { DOMAINS } from "./strings";

const nf = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : f(v, d));
const pc = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${f(100 * v, 3)} %`);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** Request of one comparison: the rows of its units (compact matrix) and their unit/group structure. */
export function exploreRequest(scope: Scope, c: ComparisonModel, steps: PipelineStep[]): ExploreRequest | { error: string } {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const pop = scope.sourceId ? domainPopulations(scope.input, scope.sourceId, c) : null;
  if (!source || !pop) return { error: "Spectra of the two domains could not be rebuilt." };
  if (pop.reference.length < 3 || !pop.compared.length) return { error: "At least three reference units and one compared unit are needed." };
  if (pop.reference.length + pop.compared.length > MAX_PAIRWISE_UNITS) return { error: `${pop.reference.length + pop.compared.length} units exceed the in-browser budget (${MAX_PAIRWISE_UNITS}).` };
  const map = new Map<number, number>();
  const remap = (units: typeof pop.reference) => units.map((u) => (u.groupRows ?? []).map((g) => g.map((r) => {
    if (!map.has(r)) map.set(r, map.size);
    return map.get(r)!;
  })));
  const reference = remap(pop.reference);
  const compared = remap(pop.compared);
  const p = source.axis.length;
  const data = new Float64Array(map.size * p);
  for (const [r, i] of map) for (let c2 = 0; c2 < p; c2++) data[i * p + c2] = source.x[r]![c2]!;
  const steps2 = source.axis.slice(1).map((v, i) => v - source.axis[i]!);
  return { X: { data, rows: map.size, cols: p }, reference, compared, steps: stripIds(steps), axisStep: median(steps2) };
}

function MetricsTable({ r }: { r: ExploreResult }) {
  const rows: { label: string; get: (s: ShiftSide) => string }[] = [
    { label: "Relative centre shift", get: (s) => nf(s.relativeCentre) },
    { label: "Dispersion ratio (compared ÷ reference)", get: (s) => nf(s.dispersionRatio, 4) },
    { label: "Relative energy distance", get: (s) => nf(s.relativeEnergy) },
    { label: "Compared units beyond T²", get: (s) => pc(s.beyondT2) },
    { label: "Compared units beyond Q", get: (s) => pc(s.beyondQ) },
    { label: "Compared units beyond either limit", get: (s) => pc(s.beyondEither) },
    { label: "Reference PCA components (monitor)", get: (s) => nf(s.components, 3) },
  ];
  return (
    <table className="dm-table">
      <thead><tr><th>Metric (normalized, complete spectra)</th><th className="num">Raw</th><th className="num">Preprocessed</th></tr></thead>
      <tbody>{rows.map((x) => <tr key={x.label}><th>{x.label}</th><td className="num">{x.get(r.raw)}</td><td className="num">{x.get(r.processed)}</td></tr>)}</tbody>
    </table>
  );
}

function StepEditor({ steps, onChange, bands }: { steps: PipelineStep[]; onChange: (s: PipelineStep[]) => void; bands: number }) {
  return (
    <div className="dm-steps">
      {steps.map((s, i) => {
        const spec = STEP_SPECS[s.kind];
        const issue = stepIssue(s, bands);
        return (
          <div key={s.id} className="dm-step">
            <strong>{i + 1}. {spec.label}</strong>
            {spec.params.map((p) => (
              <label key={p.name} className="dm-param">{p.label}
                {p.type === "choice"
                  ? <select value={String(s.params[p.name])} onChange={(e) => onChange(steps.map((x) => (x.id === s.id ? { ...x, params: { ...x.params, [p.name]: coerceParam(p, e.target.value) } } : x)))}>{p.choices.map((c) => <option key={c}>{c}</option>)}</select>
                  : <input type="number" min={p.min} max={p.max} step={p.type === "float" ? p.step : (p.step ?? 1)} value={Number(s.params[p.name])} onChange={(e) => onChange(steps.map((x) => (x.id === s.id ? { ...x, params: { ...x.params, [p.name]: coerceParam(p, e.target.value) } } : x)))} />}
              </label>
            ))}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onChange(steps.filter((x) => x.id !== s.id))} aria-label={`Remove ${spec.label}`}>Remove</button>
            {issue ? <span className="dm-note" role="alert">{issue}</span> : null}
          </div>
        );
      })}
      <label className="dm-param">Add a step
        <select value="" onChange={(e) => e.target.value && onChange([...steps, newStep(e.target.value as StepKind)])}>
          <option value="">Choose…</option>
          {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_SPECS[k].label}</option>)}
        </select>
      </label>
    </div>
  );
}

export function ShiftExplorer({ scope, factors }: { scope: Scope; factors: FactorModel[] }) {
  // Development-domain comparisons first (factors precede the audit in the model order).
  const options = useMemo(() => factors.flatMap((fm) => fm.comparisons.map((c) => ({ c, audit: fm.audit }))), [factors]);
  const [key, setKey] = useState<string | null>(null);
  const [steps, setSteps] = useState<PipelineStep[]>(() => [newStep("snv")]);
  const [state, setState] = useState<{ result: ExploreResult | null; error: string | null; busy: boolean }>({ result: null, error: null, busy: false });
  const chosen = options.find((o) => o.c.key === key) ?? options[0] ?? null;
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const bands = source?.axis.length ?? 0;
  const blocked = steps.some((s) => stepIssue(s, bands) !== null);
  const req = useMemo(() => (chosen && !blocked ? exploreRequest(scope, chosen.c, steps) : null), [chosen, scope.input, scope.sourceId, steps, blocked]);
  const pop = useMemo(() => (chosen && scope.sourceId ? domainPopulations(scope.input, scope.sourceId, chosen.c) : null), [chosen, scope.input, scope.sourceId]);
  const describe = useMemo(() => unitDescriber(scope.input), [scope.input]);
  useEffect(() => {
    if (!req || "error" in req) return;
    let live = true;
    setState((s) => ({ ...s, busy: true, error: null }));
    const timer = setTimeout(() => {
      domainTask({ op: "explore", req })
        .then((result) => live && setState({ result, error: null, busy: false }))
        .catch((e: unknown) => live && setState({ result: null, error: e instanceof Error ? e.message : String(e), busy: false }));
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [req]);
  if (!chosen) return null;
  const r = state.result;
  const label = steps.length ? pipelineLabel(steps) : "No preprocessing";
  const refInfo = pop?.reference.map(describe);
  const cmpInfo = pop?.compared.map(describe);
  const refIds = pop?.reference.map(unitLabel) ?? [];
  const cmpIds = pop?.compared.map(unitLabel) ?? [];
  return (
    <div className="dm-explorer">
      <h4 className="dm-h">{DOMAINS.explorerTitle}</h4>
      <p className="dm-note">{DOMAINS.explorerLead}</p>
      <div className="dm-controls">
        <label className="dm-param">Comparison
          <select value={chosen.c.key} onChange={(e) => setKey(e.target.value)}>
            {options.map((o) => <option key={o.c.key} value={o.c.key}>{o.c.comparedName} vs {o.c.referenceName}{o.audit ? " (retained test, X-only read-only audit)" : ""}</option>)}
          </select>
        </label>
      </div>
      <StepEditor steps={steps} onChange={setSteps} bands={bands} />
      <div className={chosen.audit ? "dm-alert dm-protect" : "dm-alert"} role="note">
        <p><strong>Fitted on the reference only.</strong> {DOMAINS.explorerFit}</p>
        {chosen.audit ? <p><strong>Read-only audit.</strong> {DOMAINS.explorerAudit}</p> : null}
        <p>{DOMAINS.explorerNotPerformance}</p>
      </div>
      {req && "error" in req ? <EmptyState>{req.error}</EmptyState> : null}
      {state.error ? <EmptyState>Explorer unavailable: {state.error}</EmptyState> : null}
      {state.busy && !r ? <p className="dm-note" role="status">Computing in the worker…</p> : null}
      {r ? (
        <div className="dm-grid">
          <ChartCard className="dm-full" title={`Shift metrics · ${label}`} subtitle={`${chosen.c.comparedName} (compared) vs ${chosen.c.referenceName} (reference) · ${r.raw.nCompared} / ${r.raw.nReference} units${state.busy ? " · updating…" : ""}`} footnote={`${DOMAINS.explorerMetrics} ${DOMAINS.explorerProvenance}`}>
            <MetricsTable r={r} />
          </ChartCard>
          {(["raw", "processed"] as const).map((side) => (
            <ChartCard key={side} title={side === "raw" ? "PCA overlap · raw" : `PCA overlap · ${label}`} subtitle="Reference-fitted PCA (complete spectra); compared units projected." footnote={DOMAINS.twoPcNote}>
              <DomainLegend reference={chosen.c.referenceName} compared={chosen.c.comparedName} />
              {r[side].overlap ? <PcaOverlap reference={r[side].overlap!.reference} compared={r[side].overlap!.compared} explained={r[side].overlap!.explained} referenceIds={refIds} comparedIds={cmpIds} referenceInfo={refInfo} comparedInfo={cmpInfo} height={260} /> : <EmptyState>Fewer than two resolved reference components.</EmptyState>}
            </ChartCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}
