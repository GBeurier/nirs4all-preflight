// Full pairwise matrix of normalized metrics between all levels of one factor (§15), computed locally in the
// worker (pairwise.ts). Rows = reference level, columns = compared level: the direction is explicit and the
// matrix is not symmetric. Shading is a neutral intensity of the distance from "no change" (never green/red).
import { useEffect, useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { ChartCard, EmptyState } from "../shared/charts";
import { defaultFmt as f } from "../shared/charts/scale";
import { domainTask } from "./host";
import { MAX_PAIRWISE_UNITS } from "./kernels";
import type { FactorModel } from "./model";
import type { PairCell, PairwiseResult } from "./pairwise";
import { testPopulation } from "./populations";

type MetricKey = "relativeCentre" | "dispersionRatio" | "relativeEnergy";
const METRICS: { key: MetricKey; label: string; neutral: number; log: boolean; note: string }[] = [
  { key: "relativeCentre", label: "Relative centre shift", neutral: 0, log: false, note: "‖mean(compared) − mean(reference)‖ ÷ √(trace of the reference covariance): 1 = the typical reference spread." },
  { key: "dispersionRatio", label: "Dispersion ratio", neutral: 1, log: true, note: "Total variance of the compared level ÷ total variance of the reference level (each about its own centre, ddof 1); 1 = equal diversity." },
  { key: "relativeEnergy", label: "Relative energy distance", neutral: 0, log: false, note: "Energy distance ÷ mean pairwise distance within the reference level (V-statistic, self-pairs included); no universal 0–1 scale." },
];

export function PairwiseMatrix({ scope, factor }: { scope: Scope; factor: FactorModel }) {
  const [metric, setMetric] = useState<MetricKey>("relativeCentre");
  const [state, setState] = useState<{ data: PairwiseResult | null; error: string | null }>({ data: null, error: null });
  const opts = scope.input.options.domain_shift ?? {};
  const pop = useMemo(() => (scope.sourceId ? testPopulation(scope.input, scope.sourceId, factor.factor, false) : null), [scope.input, scope.sourceId, factor.factor]);
  const tooMany = !!pop && pop.units.length > MAX_PAIRWISE_UNITS;
  useEffect(() => {
    if (!pop || pop.levels.length < 2 || tooMany) return;
    let live = true;
    domainTask({ op: "pairwise", req: { development: pop.development.map((u) => u.spectrum), index: pop.developmentIndex!, codes: pop.codes, levels: pop.levels, energyOnSpectra: Boolean(opts.energy_on_spectra), monitorOnSpectra: Boolean(opts.monitor_on_spectra) } })
      .then((data) => live && setState({ data, error: null }))
      .catch((e: unknown) => live && setState({ data: null, error: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [pop, tooMany, opts.energy_on_spectra, opts.monitor_on_spectra]);
  if (factor.audit || !pop || pop.levels.length < 2) return null;
  const spec = METRICS.find((m) => m.key === metric)!;
  const d = state.data;
  const cell = (r: number, c: number): PairCell | undefined => d?.cells.find((x) => x.reference === r && x.compared === c);
  const values = d ? d.cells.map((x) => x[metric]).filter((v): v is number => v !== null) : [];
  const dev = (v: number) => (spec.log ? Math.abs(Math.log(Math.max(v, 1e-12))) : Math.abs(v - spec.neutral));
  const maxDev = Math.max(1e-12, ...values.map(dev));
  return (
    <ChartCard title={`Pairwise matrix of normalized metrics · ${factor.factor}`} subtitle="Every ordered pair of levels: row = reference level, column = compared level (read from row to column)." footnote={`${spec.note} Computed locally in the demo (interim) on the engine's independence units and spaces (centre and dispersion: ${d?.monitorSpace === "leading_pca" ? "leading PCA scores" : "complete spectra"}; energy: ${d?.energySpace === "leading_pca" ? "leading PCA scores" : "complete spectra"}). Shading = distance from "no change" (${spec.neutral}), never a quality judgement. The engine's level-vs-rest table above remains the published reference.`}>
      <div className="dm-seg" role="group" aria-label="Metric">
        {METRICS.map((m) => <button key={m.key} type="button" aria-pressed={m.key === metric} onClick={() => setMetric(m.key)}>{m.label}</button>)}
      </div>
      {tooMany ? <EmptyState>{pop.units.length} units exceed the in-browser pairwise-distance budget ({MAX_PAIRWISE_UNITS}).</EmptyState>
        : state.error ? <EmptyState>Pairwise matrix unavailable: {state.error}</EmptyState>
        : !d ? <p className="dm-note" role="status">Computing the pairwise matrix…</p>
        : (
          <div className="dm-matrix-wrap">
            <table className="dm-table dm-matrix">
              <thead><tr><th scope="col">Reference ↓ · compared →</th>{d.levels.map((l, c) => <th key={l} scope="col" className="num">{l} <span className="dm-counts">({d.sizes[c]})</span></th>)}</tr></thead>
              <tbody>{d.levels.map((l, r) => (
                <tr key={l}>
                  <th scope="row">{l} <span className="dm-counts">({d.sizes[r]})</span></th>
                  {d.levels.map((m, c) => {
                    if (r === c) return <td key={m} className="num dm-diag">—</td>;
                    const v = cell(r, c)?.[metric] ?? null;
                    const a = v === null ? 0 : Math.min(1, dev(v) / maxDev);
                    return <td key={m} className="num" style={{ background: v === null ? undefined : `color-mix(in srgb, var(--dm-ref) ${Math.round(8 + 42 * a)}%, transparent)` }} title={`${spec.label}, reference ${l} → compared ${m}: ${v === null ? "not evaluable" : f(v, 4)}`}>{v === null ? "n/a" : f(v, 3)}</td>;
                  })}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
    </ChartCard>
  );
}
