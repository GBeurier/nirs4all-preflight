// Domain-shift charts the shared kit lacks (interim demo components, nirs4all-ui debt): normalized T²/Q
// scatter, reference-fitted PCA overlap scatter, ECDF of distances, ratio scale centred on 1, and the
// four-panel illustration of principle. Reference = blue (filled circle), compared = orange (diamond):
// the marker shape and the text labels carry the domain, never the colour alone.
import { useState } from "react";
import { EmptyState, Legend, Responsive } from "../shared/charts";
import { defaultFmt, extent, linear, niceTicks } from "../shared/charts/scale";

const REF = "var(--dm-ref)";
const CMP = "var(--dm-cmp)";

function Diamond({ x, y, r, className, title }: { x: number; y: number; r: number; className?: string; title?: string }) {
  return <path d={`M${x},${y - r}L${x + r},${y}L${x},${y + r}L${x - r},${y}Z`} className={className}>{title ? <title>{title}</title> : null}</path>;
}

export function DomainLegend({ reference, compared }: { reference: string; compared: string }) {
  return (
    <ul className="dm-legend" aria-label="Domains">
      <li><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" className="dm-ref-fill" /></svg>Reference · {reference}</li>
      <li><svg width="12" height="12" aria-hidden="true"><Diamond x={6} y={6} r={5.5} className="dm-cmp-fill" /></svg>Compared · {compared}</li>
    </ul>
  );
}

// --- normalized T²/Q scatter ---------------------------------------------------------------------------------

export interface TqPoint {
  id: string;
  t2: number;
  q: number;
}

const LOG_FLOOR = 0.01;
const lg = (v: number) => Math.log10(Math.max(LOG_FLOOR, v));

export function TqScatter({ compared, reference, t2Limit, qLimit, height = 320 }: { compared: readonly TqPoint[]; reference: readonly TqPoint[]; t2Limit: number; qLimit: number; height?: number }) {
  const [showRef, setShowRef] = useState(true);
  if (!(t2Limit > 0) || !(qLimit > 0) || !compared.length) return <EmptyState>No individual T²/Q value to plot.</EmptyState>;
  const norm = (p: TqPoint) => ({ id: p.id, x: p.t2 / t2Limit, y: p.q / qLimit });
  const cmp = compared.map(norm);
  const ref = reference.map(norm);
  const all = [...cmp, ...(showRef ? ref : [])];
  const lo = Math.min(-1, Math.floor(Math.min(...all.map((p) => lg(p.x)), ...all.map((p) => lg(p.y)))));
  const hi = Math.max(1, Math.ceil(Math.max(...all.map((p) => lg(p.x)), ...all.map((p) => lg(p.y)))));
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return (
    <div>
      <label className="dm-toggle"><input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> Show reference units (out-of-fold, low opacity)</label>
      <Responsive min={300}>
        {(width) => {
          const pad = { l: 56, r: 16, t: 12, b: 44 };
          const x = linear(lo, hi, pad.l, width - pad.r);
          const y = linear(lo, hi, height - pad.b, pad.t);
          const x1 = x(0);
          const y1 = y(0);
          const quad = [
            { label: "Within both limits", cx: (pad.l + x1) / 2, cy: (y1 + height - pad.b) / 2 },
            { label: "High T² only", cx: (x1 + width - pad.r) / 2, cy: (y1 + height - pad.b) / 2 },
            { label: "High Q only", cx: (pad.l + x1) / 2, cy: (pad.t + y1) / 2 },
            { label: "High T² and Q", cx: (x1 + width - pad.r) / 2, cy: (pad.t + y1) / 2 },
          ];
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`Normalized T² against normalized Q for ${cmp.length} compared units; lines at the reference limits (1).`}>
              <rect x={x1} y={pad.t} width={width - pad.r - x1} height={y1 - pad.t} className="dm-zone" />
              <rect x={x1} y={y1} width={width - pad.r - x1} height={height - pad.b - y1} className="dm-zone dm-zone-light" />
              <rect x={pad.l} y={pad.t} width={x1 - pad.l} height={y1 - pad.t} className="dm-zone dm-zone-light" />
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={x(t)} x2={x(t)} y1={pad.t} y2={height - pad.b} className="cz-grid" />
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" />
                  <text x={x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{10 ** t >= 1 ? 10 ** t : (10 ** t).toPrecision(1)}</text>
                  <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{10 ** t >= 1 ? 10 ** t : (10 ** t).toPrecision(1)}</text>
                </g>
              ))}
              {quad.map((q) => <text key={q.label} x={q.cx} y={q.cy} textAnchor="middle" className="dm-quad">{q.label}</text>)}
              <line x1={x1} x2={x1} y1={pad.t} y2={height - pad.b} className="dm-limit" />
              <line x1={pad.l} x2={width - pad.r} y1={y1} y2={y1} className="dm-limit" />
              {showRef ? ref.map((p) => <circle key={`r${p.id}`} cx={x(lg(p.x))} cy={y(lg(p.y))} r={3} className="dm-ref-fill" opacity={0.3}><title>{`Reference ${p.id}: T²/limit ${defaultFmt(p.x)}, Q/limit ${defaultFmt(p.y)}`}</title></circle>) : null}
              {cmp.map((p) => <Diamond key={`c${p.id}`} x={x(lg(p.x))} y={y(lg(p.y))} r={4.5} className="dm-cmp-fill dm-outline" title={`Compared ${p.id}: T²/limit ${defaultFmt(p.x)}, Q/limit ${defaultFmt(p.y)}`} />)}
              <text x={(pad.l + width - pad.r) / 2} y={height - 6} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>T² / T² limit (log scale; values below {LOG_FLOOR} drawn at {LOG_FLOOR})</text>
              <text transform={`translate(14,${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>Q / Q limit (log scale)</text>
            </svg>
          );
        }}
      </Responsive>
    </div>
  );
}

// --- PCA overlap ------------------------------------------------------------------------------------------------

/**
 * Empirical concentration ellipse of 2-D points: shape from the sample covariance (ddof 1), size = the `level`
 * type-7 quantile of the points' own Mahalanobis distances, so about that share of the points lies inside it
 * without any normality assumption. Not a prediction region and not a confidence region of the centroid.
 * Returns polygon vertices in data coordinates, or null (fewer than 3 points or a degenerate covariance).
 */
export function concentrationEllipse(pts: readonly (readonly [number, number])[], level = 0.9, vertices = 72): [number, number][] | null {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  sxx /= n - 1;
  syy /= n - 1;
  sxy /= n - 1;
  const det = sxx * syy - sxy * sxy;
  if (!(det > 1e-12 * Math.max(sxx * syy, 1e-300))) return null;
  const d = pts.map(([x, y]) => {
    const u = x - mx;
    const v = y - my;
    return Math.sqrt(Math.max(0, (syy * u * u - 2 * sxy * u * v + sxx * v * v) / det));
  }).sort((a, b) => a - b);
  const h = (n - 1) * level;
  const r = d[Math.floor(h)]! + (h - Math.floor(h)) * ((d[Math.ceil(h)] ?? d[Math.floor(h)]!) - d[Math.floor(h)]!);
  const tr = sxx + syy;
  const disc = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const [c, s] = [Math.cos(th), Math.sin(th)];
  return Array.from({ length: vertices }, (_, k) => {
    const t = (2 * Math.PI * k) / vertices;
    const a = r * Math.sqrt(l1) * Math.cos(t);
    const b = r * Math.sqrt(l2) * Math.sin(t);
    return [mx + a * c - b * s, my + a * s + b * c];
  });
}

export const ELLIPSE_LEVEL = 0.9;

export function PcaOverlap({ reference, compared, explained, referenceIds, comparedIds, referenceInfo, comparedInfo, height = 320, ellipsesDefault = true }: { reference: readonly number[][]; compared: readonly number[][]; explained: readonly (number | null)[]; referenceIds: readonly string[]; comparedIds: readonly string[]; referenceInfo?: readonly string[] | undefined; comparedInfo?: readonly string[] | undefined; height?: number; ellipsesDefault?: boolean }) {
  const k = Math.min(reference[0]?.length ?? 0, explained.length);
  const pairs: [number, number][] = k >= 3 ? [[0, 1], [0, 2], [1, 2]] : k === 2 ? [[0, 1]] : [];
  const [pair, setPair] = useState(0);
  const [ellipses, setEllipses] = useState(ellipsesDefault);
  if (!pairs.length) return <EmptyState>Fewer than two resolved reference components.</EmptyState>;
  const [a, b] = pairs[Math.min(pair, pairs.length - 1)]!;
  const pts = [...reference, ...compared];
  const ex = extent(pts.map((p) => p[a]!), 0.08)!;
  const ey = extent(pts.map((p) => p[b]!), 0.08)!;
  const centroid = (rows: readonly number[][], c: number) => rows.reduce((s, r) => s + r[c]!, 0) / Math.max(1, rows.length);
  const cr = [centroid(reference, a), centroid(reference, b)];
  const cc = [centroid(compared, a), centroid(compared, b)];
  const pcLabel = (c: number) => `PC${c + 1}${explained[c] !== null && explained[c] !== undefined ? ` (${(100 * explained[c]!).toPrecision(3)} % of reference variance)` : ""}`;
  const ellR = ellipses ? concentrationEllipse(reference.map((p) => [p[a]!, p[b]!] as const), ELLIPSE_LEVEL) : null;
  const ellC = ellipses ? concentrationEllipse(compared.map((p) => [p[a]!, p[b]!] as const), ELLIPSE_LEVEL) : null;
  const tip = (side: string, ids: readonly string[], info: readonly string[] | undefined, i: number) => `${side} ${ids[i] ?? i}${info?.[i] ? `\n${info[i]}` : ""}`;
  return (
    <div>
      <div className="dm-controls">
        {pairs.length > 1 ? (
          <div className="dm-seg" role="group" aria-label="Component pair">
            {pairs.map(([p, q], i) => <button key={i} type="button" aria-pressed={i === pair} onClick={() => setPair(i)}>PC{p + 1} / PC{q + 1}</button>)}
          </div>
        ) : null}
        <label className="dm-toggle"><input type="checkbox" checked={ellipses} onChange={(e) => setEllipses(e.target.checked)} /> Empirical {Math.round(100 * ELLIPSE_LEVEL)} % concentration ellipses</label>
      </div>
      <Responsive min={300}>
        {(width) => {
          const pad = { l: 56, r: 16, t: 12, b: 44 };
          const x = linear(ex[0], ex[1], pad.l, width - pad.r);
          const y = linear(ey[0], ey[1], height - pad.b, pad.t);
          const xt = niceTicks(ex[0], ex[1], 5);
          const yt = niceTicks(ey[0], ey[1], 4);
          const dx = x(cc[0]!) - x(cr[0]!);
          const dy = y(cc[1]!) - y(cr[1]!);
          const len = Math.hypot(dx, dy);
          const poly = (e: [number, number][]) => e.map(([u, v]) => `${x(u).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`Scores on ${pcLabel(a)} and ${pcLabel(b)} of a PCA fitted on the reference units only; compared units projected; centroids joined by an arrow${ellipses ? "; dashed outlines: empirical concentration ellipses" : ""}.`}>
              <defs>
                <marker id="dm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" className="dm-ink-fill" /></marker>
                <clipPath id="dm-plot-clip"><rect x={pad.l} y={pad.t} width={width - pad.l - pad.r} height={height - pad.t - pad.b} /></clipPath>
              </defs>
              {xt.map((t) => <g key={`x${t}`}><line x1={x(t)} x2={x(t)} y1={pad.t} y2={height - pad.b} className="cz-grid" /><text x={x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{defaultFmt(t)}</text></g>)}
              {yt.map((t) => <g key={`y${t}`}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" /><text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{defaultFmt(t)}</text></g>)}
              <g clipPath="url(#dm-plot-clip)">
                {ellR ? <polygon points={poly(ellR)} className="dm-ell dm-ell-ref"><title>{`Reference: empirical ${Math.round(100 * ELLIPSE_LEVEL)} % concentration ellipse`}</title></polygon> : null}
                {ellC ? <polygon points={poly(ellC)} className="dm-ell dm-ell-cmp"><title>{`Compared: empirical ${Math.round(100 * ELLIPSE_LEVEL)} % concentration ellipse`}</title></polygon> : null}
              </g>
              {reference.map((p, i) => <circle key={`r${i}`} cx={x(p[a]!)} cy={y(p[b]!)} r={3.2} className="dm-ref-fill" opacity={0.55}><title>{tip("Reference", referenceIds, referenceInfo, i)}</title></circle>)}
              {compared.map((p, i) => <Diamond key={`c${i}`} x={x(p[a]!)} y={y(p[b]!)} r={4} className="dm-cmp-fill" title={tip("Compared", comparedIds, comparedInfo, i)} />)}
              {len > 12 ? <line x1={x(cr[0]!)} y1={y(cr[1]!)} x2={x(cc[0]!) - (dx / len) * 8} y2={y(cc[1]!) - (dy / len) * 8} className="dm-arrow" markerEnd="url(#dm-arrow)" /> : null}
              <circle cx={x(cr[0]!)} cy={y(cr[1]!)} r={7} className="dm-ref-fill dm-centroid"><title>Reference centroid</title></circle>
              <Diamond x={x(cc[0]!)} y={y(cc[1]!)} r={8} className="dm-cmp-fill dm-centroid" title="Compared centroid" />
              <text x={(pad.l + width - pad.r) / 2} y={height - 6} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{pcLabel(a)}</text>
              <text transform={`translate(14,${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{pcLabel(b)}</text>
            </svg>
          );
        }}
      </Responsive>
      {ellipses ? <p className="dm-note">Ellipse = empirical concentration: shape from the sample covariance of the two scores, size = the {Math.round(100 * ELLIPSE_LEVEL)}th percentile of each domain&apos;s own Mahalanobis distances (no normality assumed). It is neither a prediction ellipse nor a confidence region of the centroid. Hover a point for its samples and metadata.</p> : null}
    </div>
  );
}

// --- ECDF -------------------------------------------------------------------------------------------------------

export interface EcdfSeries {
  id: string;
  label: string;
  values: readonly number[];
  color: string;
  dash?: string;
}

export function Ecdf({ series, xLabel, height = 220, title }: { series: readonly EcdfSeries[]; xLabel: string; height?: number; title: string }) {
  const used = series.filter((s) => s.values.length);
  if (!used.length) return <EmptyState>No distance to show.</EmptyState>;
  const ex = extent(used.flatMap((s) => s.values), 0.04)!;
  const lo = Math.min(0, ex[0]);
  return (
    <div>
      <Responsive min={280}>
        {(width) => {
          const pad = { l: 44, r: 12, t: 10, b: 40 };
          const x = linear(lo, ex[1], pad.l, width - pad.r);
          const y = linear(0, 1, height - pad.b, pad.t);
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${title}: ${used.map((s) => `${s.label} (${s.values.length})`).join(", ")}`}>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="cz-grid" /><text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="cz-t-axis">{t * 100} %</text></g>)}
              {niceTicks(lo, ex[1], 5).map((t) => <text key={t} x={x(t)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{defaultFmt(t)}</text>)}
              {used.map((s) => {
                const xs = [...s.values].sort((p, q) => p - q);
                let d = `M${x(lo)},${y(0)}`;
                xs.forEach((v, i) => (d += `H${x(v)}V${y((i + 1) / xs.length)}`));
                d += `H${width - pad.r}`;
                return <path key={s.id} d={d} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeDasharray={s.dash}><title>{s.label}</title></path>;
              })}
              <text x={(pad.l + width - pad.r) / 2} y={height - 4} textAnchor="middle" className="cz-t-axis" style={{ fill: "var(--cz-ink-2)" }}>{xLabel}</text>
            </svg>
          );
        }}
      </Responsive>
      <Legend items={used.map((s) => ({ label: `${s.label} (n = ${s.values.length})`, color: s.color, kind: "line" as const }))} />
    </div>
  );
}

// --- ratio scale centred on 1 (log axis) ------------------------------------------------------------------------

export function RatioScale({ value, label }: { value: number | null; label: string }) {
  if (value === null || !(value > 0)) return <EmptyState>Dispersion ratio not available.</EmptyState>;
  const span = Math.max(1, Math.ceil(Math.abs(Math.log10(value)) + 0.2));
  const ticks = [-span, ...(span > 1 ? [-1] : []), 0, ...(span > 1 ? [1] : []), span].map((e) => 10 ** e);
  const fine = [0.5, 2].filter((t) => Math.abs(Math.log10(t)) < span);
  return (
    <Responsive min={280}>
      {(width) => {
        const pad = 24;
        const x = linear(-span, span, pad, width - pad);
        const xv = x(Math.log10(value));
        const h = 74;
        return (
          <svg className="cz-svg" width={width} height={h} role="img" aria-label={`${label}: ${defaultFmt(value, 4)} on a logarithmic scale centred on 1`}>
            <rect x={pad} y={28} width={x(0) - pad} height={10} rx={3} className="dm-narrow" />
            <rect x={x(0)} y={28} width={width - pad - x(0)} height={10} rx={3} className="dm-broad" />
            <text x={pad} y={20} className="cz-t-axis">Narrower than reference</text>
            <text x={width - pad} y={20} textAnchor="end" className="cz-t-axis">Broader than reference</text>
            <line x1={x(0)} x2={x(0)} y1={24} y2={42} className="dm-limit" />
            {[...ticks, ...fine].map((t) => <text key={t} x={x(Math.log10(t))} y={56} textAnchor="middle" className="cz-t-axis">{defaultFmt(t)}</text>)}
            <path d={`M${xv - 7},${18}L${xv + 7},${18}L${xv},${30}Z`} className="dm-cmp-fill dm-outline" />
            <text x={xv} y={h - 2} textAnchor="middle" className="cz-t-strong" style={{ fontSize: 12 }}>{defaultFmt(value, 4)}</text>
          </svg>
        );
      }}
    </Responsive>
  );
}

// --- illustration of principle (image 17) ------------------------------------------------------------------------

function cloud(seed: number, n: number, cx: number, cy: number, rx: number, ry: number): [number, number][] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => {
    const r = Math.sqrt(rnd());
    const t = 2 * Math.PI * rnd();
    return [cx + rx * r * Math.cos(t), cy + ry * r * Math.sin(t)];
  });
}

const PANELS = [
  { title: "Similar populations", ref: [80, 60, 56, 34], cmp: [80, 60, 56, 34] },
  { title: "Location shift", ref: [62, 66, 48, 32], cmp: [104, 48, 48, 32] },
  { title: "Dispersion shift", ref: [80, 60, 56, 36], cmp: [80, 60, 20, 13] },
  { title: "Limited overlap", ref: [60, 66, 48, 32], cmp: [122, 44, 30, 22] },
] as const;

export function ShiftIllustration() {
  return (
    <figure className="dm-illus">
      <div className="dm-illus-grid">
        {PANELS.map((p, i) => (
          <div key={p.title} className="dm-illus-panel">
            <svg viewBox="0 0 160 120" role="img" aria-label={`Illustration: ${p.title}`}>
              <ellipse cx={p.ref[0]} cy={p.ref[1]} rx={p.ref[2] + 4} ry={p.ref[3] + 4} className="dm-ell dm-ell-ref" />
              <ellipse cx={p.cmp[0]} cy={p.cmp[1]} rx={p.cmp[2] + 4} ry={p.cmp[3] + 4} className="dm-ell dm-ell-cmp" />
              {cloud(11 + i, 26, p.ref[0], p.ref[1], p.ref[2], p.ref[3]).map(([x, y], k) => <circle key={`r${k}`} cx={x} cy={y} r={2} className="dm-ref-fill" />)}
              {cloud(53 + i, 22, p.cmp[0], p.cmp[1], p.cmp[2], p.cmp[3]).map(([x, y], k) => <Diamond key={`c${k}`} x={x} y={y} r={2.3} className="dm-cmp-fill" />)}
            </svg>
            <p>{p.title}</p>
          </div>
        ))}
      </div>
    </figure>
  );
}

export const DOMAIN_COLORS = { reference: REF, compared: CMP };
