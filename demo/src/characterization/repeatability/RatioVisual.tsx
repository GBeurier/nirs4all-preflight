// "Sample diversity vs. measurement variability" (chat mockup): an illustration of the one-way
// variance model, ICC = R²/(1 + R²) with R = σb/σw. Simulated dots, never dataset values; the slider
// starts at the dataset's median R when the engine model makes it exact (balanced ICC(1,1) or REML components).
import { useId, useState } from "react";
import { Responsive } from "../shared/charts";
import { ratioToIcc } from "../shared/derive";
import { fmt } from "./comments";

/** Fixed simulated repeat offsets (in σw units) of the three illustrative samples. */
const REPEATS = [-1.3, -0.7, -0.1, 0.4, 1.1];
const SAMPLES = [
  { id: "A", tone: "blue" },
  { id: "B", tone: "teal" },
  { id: "C", tone: "copper" },
] as const;

export function RatioVisual({ datasetRatio }: { datasetRatio: number | null }) {
  const start = datasetRatio !== null && Number.isFinite(datasetRatio) ? Math.min(10, Math.max(0, datasetRatio)) : 3;
  const [ratio, setRatio] = useState(start);
  const id = useId();
  const icc = ratioToIcc(ratio);
  return (
    <div className="rp-ratio">
      <span className="cz-illustration-tag">Illustration · simulated values, not dataset results</span>
      <Responsive min={220} fallback={340}>
        {(width) => {
          const cx = width / 2;
          const unit = Math.min(14, (width - 60) / 28);
          return (
            <svg className="cz-svg" width={width} height={128} role="img" aria-label={`Illustration: three physical samples A, B, C with five simulated repeats each; sample means are ${fmt(ratio, 2)} within-sample SDs apart`}>
              {SAMPLES.map((s, j) => {
                const y = 22 + j * 34;
                const mean = cx + (j - 1) * ratio * unit;
                return (
                  <g key={s.id} className={`cz-tone-${s.tone}`}>
                    <line x1={20} x2={width - 8} y1={y} y2={y} className="cz-grid" strokeDasharray="3 3" />
                    <text x={4} y={y + 4} className="cz-t-strong">{s.id}</text>
                    {REPEATS.map((r, i) => <circle key={i} cx={mean + r * unit} cy={y + ((i % 3) - 1) * 4} r={3.8} className="cz-fill" opacity={0.8} />)}
                    <line x1={mean} x2={mean} y1={y - 12} y2={y + 12} className="cz-stroke" strokeWidth={1.8} />
                  </g>
                );
              })}
              <text x={cx} y={124} textAnchor="middle" className="cz-t-axis">Signal at a selected band (simulated)</text>
            </svg>
          );
        }}
      </Responsive>
      <div className="rp-ratio-ctl">
        <label htmlFor={id}>Between / within SD ratio R</label>
        <strong>{fmt(ratio, 2)}×</strong>
      </div>
      <input id={id} type="range" min={0} max={10} step={0.1} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />
      <div className="rp-ratio-kpis">
        <div><span>Illustrative ICC</span><strong>{fmt(icc, 3)}</strong></div>
        <div><span>Illustrative between-sample variance fraction</span><strong>{fmt(100 * icc, 3)} %</strong></div>
      </div>
      {datasetRatio !== null && Number.isFinite(datasetRatio) ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRatio(Math.min(10, Math.max(0, datasetRatio)))}>Reset to the dataset median R ({fmt(datasetRatio, 3)})</button>
      ) : null}
    </div>
  );
}
