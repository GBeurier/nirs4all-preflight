// Small SVG charts of the explorer (interim demo components; nirs4all-ui debt). Series are told
// apart by outline pattern and labelled legends, never by colour alone.
import { useId } from "react";
import type { BenchmarkPoint } from "./evaluate";

const fmt = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : Number(v.toPrecision(3)).toString());

export function PairedHistogram({ title, xLabel, edges, counts, labels, width }: { title: string; xLabel: string; edges: number[]; counts: number[][]; labels: [string, string]; width: number }) {
  const uid = useId().replace(/:/g, "");
  const H = 170, L = 44, R = 12, T = 26, B = 34;
  const w = width - L - R, h = H - T - B;
  const max = Math.max(1, ...counts.flat());
  const lo = edges[0]!, hi = edges[edges.length - 1]!;
  const x = (v: number) => L + ((v - lo) / (hi - lo || 1)) * w;
  const y = (c: number) => T + h - (c / max) * h;
  const styles = [
    { fill: "rgba(15,118,110,.25)", stroke: "#0f766e", dash: undefined },
    { fill: `url(#pp-hatch-${uid})`, stroke: "#7c3aed", dash: "4 3" },
  ];
  return (
    <svg className="pp-chart" width={width} height={H} role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <pattern id={`pp-hatch-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#7c3aed" strokeWidth="1.5" opacity=".5" />
        </pattern>
      </defs>
      {counts.map((series, s) => (
        <g key={s}>
          {series.map((c, k) =>
            c > 0 ? <rect key={k} x={x(edges[k]!)} y={y(c)} width={Math.max(1, x(edges[k + 1]!) - x(edges[k]!) - 1)} height={T + h - y(c)} fill={styles[s]!.fill} stroke={styles[s]!.stroke} strokeDasharray={styles[s]!.dash} /> : null,
          )}
        </g>
      ))}
      <line x1={L} x2={L + w} y1={T + h} y2={T + h} stroke="currentColor" opacity=".4" />
      {[lo, (lo + hi) / 2, hi].map((v) => (
        <text key={v} x={x(v)} y={T + h + 13} textAnchor="middle" className="pp-tick">{fmt(v)}</text>
      ))}
      <text x={L - 6} y={T + 4} textAnchor="end" className="pp-tick">{max}</text>
      <text x={L - 6} y={T + h} textAnchor="end" className="pp-tick">0</text>
      <text x={L + w / 2} y={H - 4} textAnchor="middle" className="pp-axis">{xLabel}</text>
      {labels.map((label, s) => (
        <g key={label} transform={`translate(${L + s * 170},8)`}>
          <rect width="14" height="10" fill={styles[s]!.fill} stroke={styles[s]!.stroke} strokeDasharray={styles[s]!.dash} />
          <text x="19" y="9" className="pp-legend">{label}</text>
        </g>
      ))}
    </svg>
  );
}

export function BenchmarkScatter({ points, nominalKey, front, showFront, selectedKey, onPick, width }: { points: BenchmarkPoint[]; nominalKey: string | null; front: Set<number>; showFront: boolean; selectedKey: string | null; onPick: (p: BenchmarkPoint) => void; width: number }) {
  const H = 320, L = 56, R = 16, T = 16, B = 42;
  const w = width - L - R, h = H - T - B;
  const ok = points.map((p, i) => ({ p, i })).filter(({ p }) => p.distortion !== null && p.reduction !== null);
  const xs = ok.map(({ p }) => p.distortion!), ys = ok.map(({ p }) => p.reduction!);
  const x0 = 0, x1 = Math.max(1e-9, ...xs) * 1.08;
  const y0 = Math.min(0, ...ys), y1 = Math.max(1, ...ys) * 1.05;
  const x = (v: number) => L + ((v - x0) / (x1 - x0)) * w;
  const y = (v: number) => T + h - ((v - y0) / (y1 - y0 || 1)) * h;
  const frontLine = ok.filter(({ i }) => front.has(i)).sort((a, b) => a.p.distortion! - b.p.distortion!);
  const shape = (family: string) => (family === "savgol" ? "circle" : family === "gaussian" ? "square" : "triangle");
  return (
    <svg className="pp-chart" width={width} height={H} role="img" aria-label="Benchmark: spectral distortion versus fine-scale variation reduction">
      <title>Preprocessing benchmark: distortion versus fine-scale variation reduction</title>
      <line x1={L} x2={L + w} y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".25" />
      <line x1={L} x2={L} y1={T} y2={T + h} stroke="currentColor" opacity=".4" />
      <line x1={L} x2={L + w} y1={T + h} y2={T + h} stroke="currentColor" opacity=".4" />
      {[x0, (x0 + x1) / 2, x1].map((v) => <text key={`x${v}`} x={x(v)} y={T + h + 14} textAnchor="middle" className="pp-tick">{fmt(v)}</text>)}
      {[y0, (y0 + y1) / 2, y1].map((v) => <text key={`y${v}`} x={L - 6} y={y(v) + 3} textAnchor="end" className="pp-tick">{fmt(v)}</text>)}
      <text x={L + w / 2} y={H - 6} textAnchor="middle" className="pp-axis">Spectral distortion: median relative RMSE (%)</text>
      <text transform={`translate(12,${T + h / 2}) rotate(-90)`} textAnchor="middle" className="pp-axis">Fine-scale variation reduction (%)</text>
      {showFront && frontLine.length > 1 ? (
        <polyline points={frontLine.map(({ p }) => `${x(p.distortion!)},${y(p.reduction!)}`).join(" ")} fill="none" stroke="#b45309" strokeDasharray="5 3" />
      ) : null}
      {ok.map(({ p, i }) => {
        const cx = x(p.distortion!), cy = y(p.reduction!);
        const kind = shape(p.steps[0]?.kind ?? "");
        const onFront = showFront && front.has(i);
        const common = {
          fill: onFront ? "#b45309" : "#0f766e",
          fillOpacity: onFront ? 0.9 : 0.55,
          stroke: p.key === selectedKey ? "#0f172a" : "white",
          strokeWidth: p.key === selectedKey ? 2 : 1,
          style: { cursor: "pointer" },
          onClick: () => onPick(p),
          tabIndex: 0,
          role: "button",
          "aria-label": `${p.label}: distortion ${fmt(p.distortion!)} %, reduction ${fmt(p.reduction!)} %${onFront ? ", non-dominated" : ""}${p.key === nominalKey ? ", nominal configuration" : ""}`,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") onPick(p);
          },
        };
        return (
          <g key={p.key}>
            {kind === "circle" ? <circle cx={cx} cy={cy} r={5} {...common} /> : kind === "square" ? <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} {...common} /> : <polygon points={`${cx},${cy - 6} ${cx + 5.5},${cy + 4} ${cx - 5.5},${cy + 4}`} {...common} />}
            {p.key === nominalKey ? (
              <g pointerEvents="none">
                <circle cx={cx} cy={cy} r={10} fill="none" stroke="#0f172a" strokeDasharray="2 2" />
                <text x={cx + 12} y={cy - 8} className="pp-legend">nominal</text>
              </g>
            ) : null}
            <title>{common["aria-label"]}</title>
          </g>
        );
      })}
      <g transform={`translate(${L + 8},${T + 4})`} className="pp-legend">
        <circle cx="5" cy="5" r="4" fill="#0f766e" fillOpacity=".55" /><text x="13" y="9">SG smoothing</text>
        <rect x="96" y="1" width="8" height="8" fill="#0f766e" fillOpacity=".55" /><text x="108" y="9">Gaussian</text>
        <polygon points="180,0 185,9 175,9" fill="#0f766e" fillOpacity=".55" /><text x="190" y="9">Wavelet</text>
        {showFront ? <><rect x="250" y="1" width="8" height="8" fill="#b45309" /><text x="262" y="9">non-dominated (dashed line)</text></> : null}
      </g>
    </svg>
  );
}
