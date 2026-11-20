// Optional chemometric validation card of the explorer: explicit opt-in, raw vs current pipeline,
// nested grouped CV of PLS in the explorer worker. Exploratory comparison, not a validated model.
import { useMemo, useState } from "react";
import { ChartDataTable } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";
import type { EngineInput } from "../../input";
import { ChartCard, EmptyState, KpiStrip } from "../shared/charts";
import type { StepRecipe } from "./catalog";
import { LvCurve } from "./charts";
import { CHEMO_INNER_FOLDS, CHEMO_LV_TOLERANCE, CHEMO_MAX_LV, CHEMO_OUTER_FOLDS, CHEMO_ROW_CAP, buildCalibrationPopulation, type ChemoResult } from "./chemometrics";
import { CancelledError, type ExplorerHost } from "./protocol";
import { S } from "./strings";

const fmt = (v: number | null | undefined, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v.toPrecision(digits)).toLocaleString("en", { maximumFractionDigits: 12 }).replace("-", "−"));

export function ChemometricPanel({ input, sourceId, targetId, host, steps, label, onCancel, locale }: {
  input: EngineInput;
  sourceId: string | null;
  targetId: string | null;
  host: ExplorerHost;
  steps: StepRecipe[];
  label: string;
  onCancel: () => void;
  locale: Locale;
}) {
  const pop = useMemo(() => buildCalibrationPopulation(input, sourceId, targetId), [input, sourceId, targetId]);
  const [result, setResult] = useState<{ result: ChemoResult; label: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    if (!pop.ok) return;
    setError(null);
    setProgress({ done: 0, total: 1 });
    const configs = [{ label: "Raw (no preprocessing)", steps: [] as StepRecipe[] }, ...(steps.length ? [{ label, steps }] : [])];
    host.chemometrics(pop.population, configs, (done, total) => setProgress({ done, total })).then(
      (r) => {
        setResult({ result: r, label });
        setProgress(null);
      },
      (e: unknown) => {
        setProgress(null);
        if (!(e instanceof CancelledError)) setError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const r = result?.result;
  const p = pop.ok ? pop.population : null;
  const unit = p?.mode === "binary" ? "0/1 coding" : p?.targetUnit || "target unit";
  const binary = r?.mode === "binary";
  return (
    <ChartCard
      id="pp-chemo"
      title={S.chemoTitle}
      subtitle={S.chemoSub}
      footnote={S.chemoProvenance}
      actions={
        pop.ok ? (
          progress ? (
            <>
              <span className="pp-meta" aria-live="polite">{`${progress.done} / ${progress.total} folds`}</span>
              <button className="btn btn-sm" onClick={onCancel}>{S.cancel}</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={run}>{result ? S.chemoRerun : S.chemoRun}</button>
          )
        ) : null
      }
    >
      {!pop.ok ? (
        <EmptyState>{pop.reason}</EmptyState>
      ) : (
        <>
          <p className="pp-meta">
            {S.chemoPopulation(p!.targetId, p!.mode === "binary" ? `PLS-DA (0/1 coding of ${p!.classes![1]} vs ${p!.classes![0]}, threshold 0.5)` : "PLS regression", p!.counts, p!.unitRule, CHEMO_ROW_CAP)}
          </p>
          <p className="pp-meta">{S.chemoProtocol(CHEMO_OUTER_FOLDS, CHEMO_INNER_FOLDS, CHEMO_MAX_LV, CHEMO_LV_TOLERANCE, p!.seed)}</p>
          <p className="pp-banner pp-banner-caution" role="note"><strong>{S.chemoNotModel}</strong></p>
          {error ? <p className="pp-warn" role="alert">{error}</p> : null}
          {!r ? (
            <EmptyState>{S.chemoIdle}</EmptyState>
          ) : (
            <>
              {result!.label !== label ? <p className="pp-meta pp-warn">{`Computed for “${result!.label}”; the pipeline has changed since. Rerun to compare the current one.`}</p> : null}
              <KpiStrip
                items={r.configs.flatMap((c) =>
                  c.nested
                    ? [
                        { label: `RMSECV · ${c.label === "Raw (no preprocessing)" ? "raw" : "pipeline"}`, value: fmt(c.nested.rmse), unit, sub: `R²CV ${fmt(c.nested.r2)} · bias ${fmt(c.nested.bias)}`, tone: c.label === "Raw (no preprocessing)" ? ("grey" as const) : ("teal" as const) },
                        ...(binary ? [{ label: `Balanced accuracy · ${c.label === "Raw (no preprocessing)" ? "raw" : "pipeline"}`, value: fmt(c.nested.balancedAccuracy), unit: "%" }] : []),
                      ]
                    : [],
                )}
              />
              <table className="pp-table">
                <caption>{`Nested grouped CV: ${r.folds} outer folds, ${r.innerFolds}+ inner folds; ${r.samples} samples (${r.rows} spectra, predictions averaged per sample), ${r.groups} groups; seed ${r.seed}`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Configuration</th>
                    <th scope="col">{`RMSECV (${unit})`}</th>
                    <th scope="col">R²CV</th>
                    <th scope="col">Bias</th>
                    {binary ? <th scope="col">Balanced accuracy</th> : null}
                    <th scope="col">LVs selected per outer fold</th>
                  </tr>
                </thead>
                <tbody>
                  {r.configs.map((c) => (
                    <tr key={c.label}>
                      <th scope="row">{c.label}</th>
                      {c.error ? (
                        <td colSpan={binary ? 5 : 4} className="pp-warn">{c.error}</td>
                      ) : (
                        <>
                          <td>{fmt(c.nested?.rmse)}</td>
                          <td>{fmt(c.nested?.r2)}</td>
                          <td>{fmt(c.nested?.bias)}</td>
                          {binary ? <td>{`${fmt(c.nested?.balancedAccuracy)} %`}</td> : null}
                          <td>{c.selectedLv.join(", ")}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <h5 className="pp-sub">{S.chemoCurveTitle}</h5>
              <p className="pp-meta">{S.chemoCurveNote}</p>
              <LvCurve
                title={`RMSECV versus latent variables, ${r.folds} grouped folds`}
                yLabel={`RMSECV (${unit})`}
                series={r.configs.filter((c) => !c.error).map((c, i) => ({ id: `c${i}`, label: c.label, color: i === 0 ? "var(--cz-raw)" : "var(--cz-processed)", shape: i === 0 ? ("circle" as const) : ("square" as const), points: c.curve }))}
              />
              <details className="pp-details">
                <summary>LV curve values</summary>
                <ChartDataTable
                  caption="RMSECV and R²CV per latent-variable count (fixed LV over the outer folds)"
                  columns={["LV", ...r.configs.flatMap((c) => [`${c.label} RMSECV`, `${c.label} R²CV`])]}
                  rows={Array.from({ length: r.maxLv }, (_, a) => [String(a + 1), ...r.configs.flatMap((c) => [fmt(c.curve[a]?.rmse), fmt(c.curve[a]?.r2)])])}
                  locale={locale}
                />
              </details>
            </>
          )}
        </>
      )}
    </ChartCard>
  );
}
