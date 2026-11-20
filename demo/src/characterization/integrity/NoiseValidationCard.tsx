// Estimator validation by synthetic noise injection (optional tool, run on demand): injected vs
// recovered relative noise with the engine's estimator (Methods spectral_noise_proxy). Not a dataset result.
import { useState } from "react";
import { ChartDataTable, extractIntrinsic } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { ChartCard, EmptyState, Responsive } from "../shared/charts";
import { validateNoise } from "./inspection-client";
import { DEFAULT_SEED, type NoiseValidation } from "./noiseValidation";
import { engineMatrix } from "./populationEvents";

const PAD = { left: 58, right: 16, top: 12, bottom: 40 };

function LogLogPlot({ width, result, f }: { width: number; result: NoiseValidation; f: (v: number, d?: number) => string }) {
  const height = 280;
  const pts = result.levels;
  const all = pts.flatMap((l) => [l.injected, l.recovered.p5, l.recovered.p95, l.excess.p5 || l.injected, l.excess.p95, result.baseline.p50]).filter((v) => v > 0).map((v) => 100 * v);
  const lo = Math.floor(Math.log10(Math.min(...all)));
  const hi = Math.ceil(Math.log10(Math.max(...all)));
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (pct: number) => PAD.left + ((Math.log10(pct) - lo) / (hi - lo)) * plotW;
  const y = (pct: number) => PAD.top + (1 - (Math.log10(pct) - lo) / (hi - lo)) * plotH;
  const decades = Array.from({ length: hi - lo + 1 }, (_, k) => 10 ** (lo + k));
  const curve = (pick: (l: NoiseValidation["levels"][number]) => number) => pts.filter((l) => pick(l) > 0).map((l, i) => `${i ? "L" : "M"}${x(100 * l.injected).toFixed(1)} ${y(100 * pick(l)).toFixed(1)}`).join("");
  const b = 100 * result.baseline.p50;
  return (
    <svg className="cz-svg" width={width} height={height} role="img" aria-label="Injected versus recovered relative noise, logarithmic axes, with the identity line.">
      {decades.map((d) => (
        <g key={d}>
          <line className="cz-grid" x1={x(d)} x2={x(d)} y1={PAD.top} y2={PAD.top + plotH} />
          <line className="cz-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(d)} y2={y(d)} />
          <text className="cz-t-axis" x={x(d)} y={PAD.top + plotH + 14} textAnchor="middle">{f(d, 2)}</text>
          <text className="cz-t-axis" x={PAD.left - 6} y={y(d) + 4} textAnchor="end">{f(d, 2)}</text>
        </g>
      ))}
      <text className="cz-t-label" x={PAD.left + plotW / 2} y={height - 6} textAnchor="middle">Injected relative noise (% of mean |x|)</text>
      <text className="cz-t-label" transform={`translate(12 ${PAD.top + plotH / 2}) rotate(-90)`} textAnchor="middle">Recovered (%)</text>
      <line x1={x(10 ** lo)} y1={y(10 ** lo)} x2={x(10 ** hi)} y2={y(10 ** hi)} stroke="var(--cz-ink-3)" strokeDasharray="4 3"><title>Identity: recovered = injected</title></line>
      <line x1={PAD.left} x2={PAD.left + plotW} y1={y(b)} y2={y(b)} stroke="var(--cz-ink-3)" strokeDasharray="1 3"><title>{`Own relative noise of the loaded spectra (median ${f(b, 3)} %)`}</title></line>
      <text className="cz-t-axis" x={PAD.left + plotW - 4} y={y(b) + 13} textAnchor="end">dataset's own noise {f(b, 3)} %</text>
      <path d={curve((l) => l.expected)} fill="none" stroke="var(--cz-ink-2)" strokeDasharray="6 3" />
      <path d={curve((l) => l.recovered.p50)} fill="none" stroke="var(--cz-teal)" strokeWidth={1.5} />
      {pts.map((l) => (
        <g key={l.injected}>
          <line x1={x(100 * l.injected)} x2={x(100 * l.injected)} y1={y(100 * l.recovered.p5)} y2={y(100 * l.recovered.p95)} stroke="var(--cz-teal)" />
          <circle cx={x(100 * l.injected)} cy={y(100 * l.recovered.p50)} r={4} fill="var(--cz-teal)"><title>{`Injected ${f(100 * l.injected, 3)} %: recovered median ${f(100 * l.recovered.p50, 3)} % (P5–P95 ${f(100 * l.recovered.p5, 3)}–${f(100 * l.recovered.p95, 3)} %)`}</title></circle>
          {l.excess.p50 > 0 ? <rect x={x(100 * l.injected) - 3.5} y={y(100 * l.excess.p50) - 3.5} width={7} height={7} fill="none" stroke="var(--cz-copper)" strokeWidth={1.5}><title>{`Injected ${f(100 * l.injected, 3)} %: injected part re-estimated √(σ̂² − σ₀²) median ${f(100 * l.excess.p50, 3)} %`}</title></rect> : null}
        </g>
      ))}
    </svg>
  );
}

export function NoiseValidationCard({ scope, f }: { scope: Scope; f: (v: number, d?: number) => string }) {
  const [state, setState] = useState<{ status: "idle" | "running" | "done" | "error"; result?: NoiseValidation | null; error?: string }>({ status: "idle" });
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const sigma = scope.sourceId ? extractIntrinsic(scope.view, scope.sourceId)?.signals["noise.noise_sigma"] : undefined;
  if (!source || !sigma || sigma.state.status !== "computed") return null;
  const run = () => {
    setState({ status: "running" });
    validateNoise(engineMatrix(source, sigma.observationIds, { physical: false }).matrix, DEFAULT_SEED)
      .then((result) => setState({ status: "done", result }))
      .catch((e: unknown) => setState({ status: "error", error: e instanceof Error ? e.message : String(e) }));
  };
  const r = state.result;
  return (
    <ChartCard
      title="Estimator validation by synthetic noise injection"
      subtitle={`Validation of the estimator, not a result about this dataset: white Gaussian noise of known relative level is added to the ${sigma.observationIds.length} analysed spectra (seed ${DEFAULT_SEED}) and σ is re-estimated with the engine's estimator (Methods spectral_noise_proxy: MAD of second differences × 1.4826/√6).`}
      footnote="Computed locally in the demo (interim): noise injection in this page, σ by the Methods WASM kernel. Recovered noise includes the spectra's own fine-scale variation, so it cannot fall below the dataset's own level; the squares re-estimate the injected part alone, √(σ̂² − σ₀²), assuming independence."
    >
      {state.status === "idle" ? <button type="button" className="btn btn-sm" onClick={run}>Run the validation ({sigma.observationIds.length} spectra × 6 levels)</button> : null}
      {state.status === "running" ? <EmptyState>Injecting noise and re-estimating σ…</EmptyState> : null}
      {state.status === "error" ? <EmptyState>Validation failed: {state.error}</EmptyState> : null}
      {state.status === "done" && !r ? <EmptyState>No spectrum has a finite noise estimate: nothing to validate.</EmptyState> : null}
      {r ? (
        <>
          <Responsive>{(w) => <LogLogPlot width={w} result={r} f={f} />}</Responsive>
          <p className="ig-caption">Teal dots and whiskers: recovered total relative noise σ̂/mean|x̂| (median, P5–P95 of spectra). Copper squares: injected part re-estimated. Dashed diagonal: identity; long dashes: expected total √(injected² + own²); dotted: the spectra's own level.</p>
          <ChartDataTable
            locale={scope.locale}
            caption="Injected versus recovered relative noise (%)"
            columns={["Injected (%)", "Recovered median (%)", "Recovered P5 (%)", "Recovered P95 (%)", "Expected total (%)", "Injected part re-estimated, median (%)", "Re-estimated / injected", "Spectra"]}
            rows={r.levels.map((l) => [100 * l.injected, 100 * l.recovered.p50, 100 * l.recovered.p5, 100 * l.recovered.p95, 100 * l.expected, 100 * l.excess.p50, l.excess.p50 / l.injected, l.n])}
          />
        </>
      ) : null}
    </ChartCard>
  );
}
