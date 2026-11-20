// Illustration of principle (docx image7): raw / moderate / excessive smoothing on a SYNTHETIC spectrum.
// Deterministic synthetic data, clearly labelled; it never displays dataset values.
import { Responsive } from "./frame";

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return 2 * (s - Math.floor(s)) - 1;
};

function synthetic(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sig = 0.9 * Math.exp(-(((t - 0.3) / 0.07) ** 2)) + 0.55 * Math.exp(-(((t - 0.62) / 0.025) ** 2)) + 0.7 * Math.exp(-(((t - 0.8) / 0.06) ** 2)) + 0.15;
    out.push(sig + 0.05 * noise(i));
  }
  return out;
}

const movingAverage = (v: readonly number[], half: number) => v.map((_, i) => {
  let s = 0;
  let c = 0;
  for (let j = Math.max(0, i - half); j <= Math.min(v.length - 1, i + half); j++) {
    s += v[j]!;
    c++;
  }
  return s / c;
});

const PANELS = [
  { id: "raw", title: "Raw spectrum", note: "noise visible", half: 0 },
  { id: "moderate", title: "Moderate smoothing", note: "noise reduced, peaks kept", half: 3 },
  { id: "excessive", title: "Excessive smoothing", note: "narrow peak flattened", half: 14 },
] as const;

export function PrincipleIllustration({ caption = "A smoother spectrum is not necessarily a better spectrum." }: { caption?: string }) {
  const raw = synthetic(160);
  const series = PANELS.map((p) => (p.half ? movingAverage(raw, p.half) : raw));
  return (
    <figure style={{ margin: 0 }}>
      <span className="cz-illustration-tag">Illustration of principle · synthetic data</span>
      <Responsive min={300}>
        {(width) => {
          const gap = 14;
          const pw = (width - 2 * gap) / 3;
          const ph = 92;
          const h = ph + 44;
          return (
            <svg className="cz-svg" width={width} height={h} role="img" aria-label="Illustration of principle on a synthetic spectrum: raw, moderate smoothing that keeps the peaks, excessive smoothing that flattens a narrow peak.">
              {PANELS.map((p, k) => {
                const ox = k * (pw + gap);
                const v = series[k]!;
                const pts = v.map((y, i) => `${(ox + (i / (v.length - 1)) * pw).toFixed(1)},${(22 + ph - 8 - (y / 1.05) * (ph - 16)).toFixed(1)}`).join(" ");
                return (
                  <g key={p.id}>
                    <text x={ox} y={13} className="cz-t-strong" style={{ fontSize: 12.5 }}>{p.title}</text>
                    <rect x={ox} y={22} width={pw} height={ph} rx={6} style={{ fill: "var(--cz-surface-2)" }} />
                    {k > 0 ? <polyline points={series[0]!.map((y, i) => `${(ox + (i / (v.length - 1)) * pw).toFixed(1)},${(22 + ph - 8 - (y / 1.05) * (ph - 16)).toFixed(1)}`).join(" ")} fill="none" style={{ stroke: "var(--cz-raw)", strokeWidth: 1, opacity: 0.45 }} /> : null}
                    <polyline points={pts} fill="none" style={{ stroke: k === 0 ? "var(--cz-raw)" : k === 1 ? "var(--cz-processed)" : "var(--cz-copper)", strokeWidth: 1.8 }} />
                    <text x={ox} y={22 + ph + 16} className="cz-t-axis">{p.note}</text>
                  </g>
                );
              })}
            </svg>
          );
        }}
      </Responsive>
      <figcaption className="cz-card-foot">{caption}</figcaption>
    </figure>
  );
}
