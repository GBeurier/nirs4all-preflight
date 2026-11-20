// Before/after per-spectrum distribution built from two kit histograms on shared bins (small
// multiples: raw on top, processed below, same x scale). Interim demo component (nirs4all-ui debt).
import { EmptyState, Histogram, Legend, Responsive, defaultFmt, extent, linear, niceTicks, type HistBin } from "../shared/charts";
import { medianOf, sharedHistogram } from "./metrics";

const BINS = 24;

/** Shared-edge bins of each series; separate edges when the scales differ. */
export function pairedBins(raw: readonly (number | null)[], processed: readonly (number | null)[] | null, separate = false): [HistBin[], HistBin[] | null] | null {
  const toBins = (edges: number[], counts: number[]): HistBin[] => counts.map((count, k) => ({ lo: edges[k]!, hi: edges[k + 1]!, count }));
  if (!processed || separate) {
    const a = sharedHistogram([raw], BINS);
    if (!a) return null;
    const b = processed ? sharedHistogram([processed], BINS) : null;
    return [toBins(a.edges, a.counts[0]!), b ? toBins(b.edges, b.counts[0]!) : null];
  }
  const h = sharedHistogram([raw, processed], BINS);
  return h ? [toBins(h.edges, h.counts[0]!), toBins(h.edges, h.counts[1]!)] : null;
}

const finiteMedian = (xs: readonly (number | null)[]) => medianOf(xs.filter((v): v is number => v !== null && Number.isFinite(v)));

export function PairedDistribution({ title, unit, raw, processed, separateScales = false, withheld }: {
  title: string;
  unit: string;
  raw: readonly (number | null)[] | null;
  processed: readonly (number | null)[] | null;
  separateScales?: boolean;
  withheld: string | null;
}) {
  const bins = raw ? pairedBins(raw, processed, separateScales) : null;
  const marker = (xs: readonly (number | null)[] | null) => {
    const m = xs ? finiteMedian(xs) : null;
    return m === null ? [] : [{ value: m, label: "Median", tone: "teal" as const }];
  };
  return (
    <figure className="pp-dist">
      <figcaption className="pp-dist-title">{title}</figcaption>
      {!raw ? (
        <EmptyState>Computing…</EmptyState>
      ) : !bins ? (
        <EmptyState>{`No evaluable value for this distribution.`}</EmptyState>
      ) : (
        <>
          <p className="pp-dist-label">Raw</p>
          <Histogram bins={bins[0]} xLabel={unit} title={`${title}, raw`} markers={marker(raw)} tone="grey" height={128} />
          <p className="pp-dist-label">{separateScales ? "Processed (own scale, different units)" : "Processed (same bins)"}</p>
          {bins[1] ? (
            <Histogram bins={bins[1]} xLabel={separateScales ? "processed units" : unit} title={`${title}, processed`} markers={marker(processed)} tone="accent" height={128} />
          ) : (
            <EmptyState>{withheld ?? "Waiting for the processed spectra…"}</EmptyState>
          )}
        </>
      )}
    </figure>
  );
}

export interface LvSeries {
  id: string;
  label: string;
  color: string;
  shape: "circle" | "square";
  points: { lv: number; rmse: number }[];
}

/**
 * RMSECV versus the number of latent variables (fixed-LV sweep over the outer folds), one line per
 * pipeline; circles vs squares so the series never rely on colour alone. Interim (nirs4all-ui debt).
 */
export function LvCurve({ series, yLabel, title, height = 220 }: { series: readonly LvSeries[]; yLabel: string; title: string; height?: number }) {
  const all = series.flatMap((s) => s.points.filter((p) => Number.isFinite(p.rmse)));
  if (!all.length) return <EmptyState>No LV curve computed.</EmptyState>;
  const maxLv = Math.max(...all.map((p) => p.lv));
  const [ya, yb] = extent([...all.map((p) => p.rmse), 0], 0.06)!;
  return (
    <figure className="pp-lv">
      <Legend items={series.map((s) => ({ label: s.label, color: s.color, kind: "line" as const }))} />
      <Responsive min={280}>
        {(width) => {
          const pad = { l: 56, r: 14, t: 10, b: 40 };
          const x = linear(0.5, maxLv + 0.5, pad.l, width - pad.r);
          const y = linear(ya, yb, height - pad.b, pad.t);
          const yt = niceTicks(ya, yb, 4);
          const xt = Array.from({ length: maxLv }, (_, i) => i + 1).filter((v) => maxLv <= 15 || v % 2 === 1);
          return (
            <svg width={width} height={height} role="img" aria-label={title} className="pp-lv-svg">
              <title>{title}</title>
              {yt.map((v) => (
                <g key={`y${v}`}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--cz-grid)" />
                  <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="pp-lv-tick">{defaultFmt(v)}</text>
                </g>
              ))}
              {xt.map((v) => <text key={`x${v}`} x={x(v)} y={height - pad.b + 16} textAnchor="middle" className="pp-lv-tick">{v}</text>)}
              <text x={(pad.l + width - pad.r) / 2} y={height - 6} textAnchor="middle" className="pp-lv-axis">Latent variables</text>
              <text transform={`translate(12 ${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="pp-lv-axis">{yLabel}</text>
              {series.map((s) => {
                const pts = s.points.filter((p) => Number.isFinite(p.rmse));
                return (
                  <g key={s.id}>
                    <polyline fill="none" stroke={s.color} strokeWidth={2} points={pts.map((p) => `${x(p.lv)},${y(p.rmse)}`).join(" ")} />
                    {pts.map((p) =>
                      s.shape === "circle" ? (
                        <circle key={p.lv} cx={x(p.lv)} cy={y(p.rmse)} r={3.5} fill={s.color}><title>{`${s.label}: ${p.lv} LV, RMSECV ${defaultFmt(p.rmse)}`}</title></circle>
                      ) : (
                        <rect key={p.lv} x={x(p.lv) - 3.5} y={y(p.rmse) - 3.5} width={7} height={7} fill={s.color}><title>{`${s.label}: ${p.lv} LV, RMSECV ${defaultFmt(p.rmse)}`}</title></rect>
                      ),
                    )}
                  </g>
                );
              })}
            </svg>
          );
        }}
      </Responsive>
    </figure>
  );
}
