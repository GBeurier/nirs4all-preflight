// Design charts (interim demo components, nirs4all-ui debt): factor dependency graph, contingency heatmap,
// grouped effect-size bars with explicit non-identifiable states, permutation p-values on a log axis and the
// unit scatter of PCA spread. Labels arrive translated; values are drawn as given (no estimation here).
import type { ReactNode } from "react";
import { DotMark, Legend, Responsive, type DotShape, type Tone } from "../shared/charts";
import { linear, niceTicks, textWidth } from "../shared/charts/scale";
import type { DesignRelation } from "./model";

/** Categorical level styles: colour and shape together (never colour alone). */
export const LEVEL_TONES: readonly Tone[] = ["teal", "copper", "blue", "grey", "teal-2", "copper-2"];
export const LEVEL_SHAPES: readonly DotShape[] = ["circle", "square", "diamond"];
export const levelStyle = (i: number) => ({ tone: LEVEL_TONES[i % LEVEL_TONES.length]!, shape: LEVEL_SHAPES[Math.floor(i / LEVEL_TONES.length) % LEVEL_SHAPES.length]! });

// --- dependency graph ----------------------------------------------------------------------------------------

export interface GraphNode { id: string; sub: string }

export function DependencyGraph({ nodes, relations, selected, onSelect, labels, title }: {
  nodes: readonly GraphNode[];
  relations: readonly DesignRelation[];
  selected: string | null;
  onSelect: (id: string) => void;
  labels: Record<DesignRelation["kind"], string>;
  title: string;
}) {
  return (
    <Responsive min={300}>
      {(width) => {
        const h = Math.max(190, Math.min(380, 70 + nodes.length * 36));
        const cx = width / 2;
        const cy = h / 2 - 8;
        const rx = Math.max(60, width / 2 - 110);
        const ry = Math.max(50, h / 2 - 50);
        const pos = new Map(nodes.map((n, i) => {
          const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, nodes.length);
          return [n.id, nodes.length === 1 ? { x: cx, y: cy } : { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }];
        }));
        const boxW = (n: GraphNode) => Math.max(textWidth(n.id, 13), textWidth(n.sub, 11)) + 20;
        const nodeById = new Map(nodes.map((n) => [n.id, n]));
        // Point on the node box border towards (tx, ty).
        const edgePoint = (id: string, tx: number, ty: number) => {
          const p = pos.get(id)!;
          const hw = boxW(nodeById.get(id)!) / 2 + 3;
          const hh = 20;
          const dx = tx - p.x;
          const dy = ty - p.y;
          const s = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 1e-9);
          return { x: p.x + dx * s, y: p.y + dy * s };
        };
        const segments: ReactNode[] = [];
        relations.forEach((r, k) => {
          const to = pos.get(r.to);
          if (!to) return;
          if (r.kind === "aliasing" || r.kind === "unknown") {
            const from = r.fromFactors.map((f) => pos.get(f)).filter((p): p is { x: number; y: number } => !!p);
            if (!from.length) return;
            const hx = (from.reduce((s, p) => s + p.x, 0) / from.length + to.x) / 2 + 14;
            const hy = (from.reduce((s, p) => s + p.y, 0) / from.length + to.y) / 2 + 14;
            const cls = r.kind === "aliasing" ? "dz-edge dz-edge-alias" : "dz-edge dz-edge-unknown";
            r.fromFactors.forEach((f, j) => {
              const a = edgePoint(f, hx, hy);
              segments.push(<line key={`${k}-${j}`} x1={a.x} y1={a.y} x2={hx} y2={hy} className={cls} />);
            });
            const b = edgePoint(r.to, hx, hy);
            segments.push(<line key={`${k}-to`} x1={hx} y1={hy} x2={b.x} y2={b.y} className={cls} markerEnd="url(#dz-arrow)" />);
            segments.push(<g key={`${k}-hub`}><path d={`M${hx},${hy - 7} L${hx + 7},${hy} L${hx},${hy + 7} L${hx - 7},${hy} Z`} className={`dz-hub dz-hub-${r.kind}`} /><text x={hx} y={hy + 3.5} className="dz-hub-label" textAnchor="middle">{r.kind === "aliasing" ? "R" : "?"}</text><title>{`${labels[r.kind]}: ${r.from} → ${r.to}`}</title></g>);
            return;
          }
          const fromP = pos.get(r.from);
          if (!fromP) return;
          const a = edgePoint(r.from, to.x, to.y);
          const b = edgePoint(r.to, fromP.x, fromP.y);
          const cls = r.kind === "partial" ? "dz-edge dz-edge-partial" : r.kind === "mutual" ? "dz-edge dz-edge-mutual" : "dz-edge dz-edge-det";
          segments.push(
            <g key={k}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={cls} markerEnd={r.kind === "partial" ? undefined : "url(#dz-arrow)"} markerStart={r.kind === "mutual" ? "url(#dz-arrow-start)" : undefined} />
              {r.kind === "partial" && r.coverage !== null ? <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} className="dz-edge-label" textAnchor="middle">{`${Math.round(r.coverage * 100)} %`}</text> : null}
              <title>{`${r.from} — ${labels[r.kind]} — ${r.to}`}</title>
            </g>,
          );
        });
        return (
          <svg width={width} height={h} role="img" aria-label={title} className="dz-graph">
            <title>{title}</title>
            <defs>
              <marker id="dz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="dz-arrowhead" /></marker>
              <marker id="dz-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,0 L0,5 L10,10 z" className="dz-arrowhead" /></marker>
            </defs>
            {segments}
            {nodes.map((n) => {
              const p = pos.get(n.id)!;
              const w = boxW(n);
              return (
                <g key={n.id} className={`dz-node${selected === n.id ? " is-selected" : ""}`} role="button" tabIndex={0} aria-pressed={selected === n.id} onClick={() => onSelect(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.id); } }}>
                  <rect x={p.x - w / 2} y={p.y - 20} width={w} height={40} rx={8} />
                  <text x={p.x} y={p.y - 3} textAnchor="middle" className="dz-node-name">{n.id}</text>
                  <text x={p.x} y={p.y + 12} textAnchor="middle" className="dz-node-sub">{n.sub}</text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </Responsive>
  );
}

export function GraphLegend({ labels }: { labels: Record<DesignRelation["kind"], string> }) {
  const item = (cls: string, label: string, hub?: string) => (
    <li key={cls}>
      <svg width="34" height="12" aria-hidden="true"><line x1="2" y1="6" x2="30" y2="6" className={`dz-edge ${cls}`} />{hub ? <text x="16" y="10" textAnchor="middle" className="dz-hub-label">{hub}</text> : null}</svg>
      {label}
    </li>
  );
  return (
    <ul className="cz-legend dz-graph-legend">
      {item("dz-edge-det", `→ ${labels.determines}`)}
      {item("dz-edge-mutual", `↔ ${labels.mutual}`)}
      {item("dz-edge-partial", labels.partial)}
      {item("dz-edge-alias", labels.aliasing, "R")}
      {item("dz-edge-unknown", labels.unknown, "?")}
    </ul>
  );
}

// --- contingency heatmap -------------------------------------------------------------------------------------

export function ContingencyHeatmap({ a, b, levelsA, levelsB, counts, title, emptyLabel, totalLabel }: {
  a: string; b: string; levelsA: readonly string[]; levelsB: readonly string[]; counts: readonly (readonly number[])[];
  title: string; emptyLabel: string; totalLabel: string;
}) {
  const max = Math.max(1, ...counts.flat());
  const rowTotals = counts.map((r) => r.reduce((s, n) => s + n, 0));
  const colTotals = levelsB.map((_, j) => counts.reduce((s, r) => s + r[j]!, 0));
  const labelW = Math.min(180, Math.max(textWidth(a, 12), ...levelsA.map((l) => textWidth(l, 12))) + 16);
  const headH = Math.min(120, Math.max(textWidth(b, 12), ...levelsB.map((l) => textWidth(l, 11))) * 0.75 + 24);
  return (
    <Responsive min={280}>
      {(width) => {
        const cell = Math.max(18, Math.min(56, (width - labelW - 60) / Math.max(1, levelsB.length)));
        const w = labelW + cell * levelsB.length + 56;
        const h = headH + cell * levelsA.length + 30;
        return (
          <div className="dz-scroll">
            <svg width={w} height={h} role="img" aria-label={title} className="dz-heat">
              <title>{title}</title>
              <defs><pattern id="dz-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" className="dz-hatch-bg" /><line x1="0" y1="0" x2="0" y2="6" className="dz-hatch-line" /></pattern></defs>
              <text x={4} y={12} className="dz-axis-name">{`${a} ↓ / ${b} →`}</text>
              {levelsB.map((l, j) => <text key={l} transform={`translate(${labelW + j * cell + cell / 2},${headH - 8}) rotate(-45)`} className="dz-tick">{l}</text>)}
              <text x={labelW + levelsB.length * cell + 28} y={headH - 8} textAnchor="middle" className="dz-tick dz-strong">{totalLabel}</text>
              {levelsA.map((la, i) => (
                <g key={la}>
                  <text x={labelW - 8} y={headH + i * cell + cell / 2 + 4} textAnchor="end" className="dz-tick">{la}</text>
                  {levelsB.map((lb, j) => {
                    const n = counts[i]![j]!;
                    const x = labelW + j * cell;
                    const y = headH + i * cell;
                    return (
                      <g key={lb}>
                        <rect x={x + 1} y={y + 1} width={cell - 2} height={cell - 2} rx={3} className={n ? "dz-cell" : "dz-cell-empty"} style={n ? { fillOpacity: 0.18 + 0.82 * (n / max) } : { fill: "url(#dz-hatch)" }}><title>{`${a} = ${la}, ${b} = ${lb}: ${n || emptyLabel}`}</title></rect>
                        {cell >= 22 ? <text x={x + cell / 2} y={y + cell / 2 + 4} textAnchor="middle" className={`dz-cell-n${n / max > 0.6 ? " is-dark" : ""}`}>{n || "·"}</text> : null}
                      </g>
                    );
                  })}
                  <text x={labelW + levelsB.length * cell + 28} y={headH + i * cell + cell / 2 + 4} textAnchor="middle" className="dz-tick dz-strong">{rowTotals[i]}</text>
                </g>
              ))}
              {colTotals.map((n, j) => <text key={j} x={labelW + j * cell + cell / 2} y={headH + levelsA.length * cell + 18} textAnchor="middle" className="dz-tick dz-strong">{n}</text>)}
            </svg>
          </div>
        );
      }}
    </Responsive>
  );
}

// --- grouped effect-size bars --------------------------------------------------------------------------------

export interface GroupedBar { label: string; value: number | null; tone: Tone; pattern?: boolean; missing?: string | undefined; note?: string | undefined }
export interface GroupedRow { id: string; label: string; bars: GroupedBar[]; selected?: boolean }

/** Horizontal grouped bars on a shared 0–max axis; a missing value is drawn as an explicit labelled state, never a zero-length bar. */
export function GroupedBars({ rows, title, fmt, axisLabel, onSelect }: { rows: readonly GroupedRow[]; title: string; fmt: (v: number) => string; axisLabel: string; onSelect?: (id: string) => void }) {
  const values = rows.flatMap((r) => r.bars.map((b) => b.value)).filter((v): v is number => v !== null && Number.isFinite(v));
  const hi = Math.max(0.05, ...values);
  const ticks = niceTicks(0, hi, 5);
  const d1 = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const labelW = Math.min(200, Math.max(...rows.map((r) => textWidth(r.label, 13))) + 16);
  const barH = 14;
  const gap = 3;
  return (
    <Responsive min={320}>
      {(width) => {
        const x = linear(0, d1, labelW + 140, width - 70);
        const groupH = (r: GroupedRow) => r.bars.length * (barH + gap) + 14;
        let y = 6;
        const groups = rows.map((r) => {
          const y0 = y;
          y += groupH(r);
          return { r, y0 };
        });
        const h = y + 34;
        return (
          <svg width={width} height={h} role="img" aria-label={title} className="dz-grouped">
            <title>{title}</title>
            {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={2} y2={y} className="dz-grid" /><text x={x(t)} y={y + 14} textAnchor="middle" className="dz-tick">{fmt(t)}</text></g>)}
            <text x={(x(0) + x(d1)) / 2} y={y + 30} textAnchor="middle" className="dz-axis-name">{axisLabel}</text>
            {groups.map(({ r, y0 }) => (
              <g key={r.id} className={`dz-group${r.selected ? " is-selected" : ""}`} onClick={onSelect ? () => onSelect(r.id) : undefined} style={onSelect ? { cursor: "pointer" } : undefined}>
                <rect x={0} y={y0 - 3} width={width} height={groupH(r) - 4} className="dz-group-bg" />
                <text x={4} y={y0 + 12} className="dz-row-label">{r.label}</text>
                {r.bars.map((b, i) => {
                  const by = y0 + i * (barH + gap);
                  return (
                    <g key={b.label}>
                      <text x={labelW + 132} y={by + barH - 3} textAnchor="end" className="dz-bar-label">{b.label}</text>
                      {b.value !== null && Number.isFinite(b.value) ? (
                        <>
                          <rect x={x(0)} y={by} width={Math.max(1.5, x(b.value) - x(0))} height={barH} rx={2} className={`dz-bar cz-tone-${b.tone}${b.pattern ? " dz-bar-striped" : ""}`}><title>{`${r.label} — ${b.label}: ${fmt(b.value)}${b.note ? ` (${b.note})` : ""}`}</title></rect>
                          <text x={x(b.value) + 5} y={by + barH - 3} className="dz-bar-value">{fmt(b.value)}</text>
                        </>
                      ) : (
                        <>
                          <rect x={x(0)} y={by} width={Math.min(150, x(d1) - x(0))} height={barH} rx={2} className="dz-bar-missing" />
                          <text x={x(0) + 6} y={by + barH - 3} className="dz-bar-missing-label">{b.missing ?? "—"}</text>
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        );
      }}
    </Responsive>
  );
}

// --- p-values on a log axis ----------------------------------------------------------------------------------

export interface PRow { id: string; label: string; sub: string; p: number; shape: DotShape; tone: Tone; hollow?: boolean; significant: boolean }

export function PValuePlot({ rows, alpha, title, alphaLabel, axisLabel }: { rows: readonly PRow[]; alpha: number | null; title: string; alphaLabel: string; axisLabel: string }) {
  const min = Math.min(1e-3, ...rows.map((r) => r.p).filter((p) => p > 0));
  const lo = 10 ** Math.floor(Math.log10(min));
  const decades: number[] = [];
  for (let e = Math.round(Math.log10(lo)); e <= 0; e++) decades.push(10 ** e);
  const labelW = Math.min(300, Math.max(...rows.map((r) => textWidth(`${r.label} · ${r.sub}`, 12))) + 16);
  const rowH = 24;
  return (
    <Responsive min={320}>
      {(width) => {
        const lx = (p: number) => linear(Math.log10(lo), 0, labelW + 10, width - 48)(Math.log10(Math.max(p, lo)));
        const h = rows.length * rowH + 46;
        const yEnd = rows.length * rowH + 8;
        return (
          <svg width={width} height={h} role="img" aria-label={title} className="dz-pplot">
            <title>{title}</title>
            {decades.map((d) => <g key={d}><line x1={lx(d)} x2={lx(d)} y1={4} y2={yEnd} className="dz-grid" /><text x={lx(d)} y={yEnd + 14} textAnchor="middle" className="dz-tick">{d >= 0.01 ? String(d) : `1e${Math.round(Math.log10(d))}`}</text></g>)}
            {alpha !== null ? <g><line x1={lx(alpha)} x2={lx(alpha)} y1={0} y2={yEnd} className="dz-alpha" /><text x={lx(alpha) + 4} y={10} className="dz-alpha-label">{alphaLabel}</text></g> : null}
            <text x={(labelW + width) / 2} y={yEnd + 32} textAnchor="middle" className="dz-axis-name">{axisLabel}</text>
            {rows.map((r, i) => {
              const y = 8 + i * rowH + rowH / 2;
              return (
                <g key={r.id}>
                  <line x1={labelW + 10} x2={width - 48} y1={y} y2={y} className="dz-row-rule" />
                  <text x={4} y={y + 4} className="dz-row-label-sm"><tspan className="dz-strong">{r.label}</tspan>{` · ${r.sub}`}</text>
                  <g className={r.hollow ? "dz-hollow" : r.significant ? "dz-sig" : undefined}><DotMark shape={r.shape} x={lx(r.p)} y={y} r={5.5} tone={r.tone} /></g>
                  <text x={lx(r.p) + 9} y={y + 4} className="dz-bar-value">{r.p < 0.001 ? r.p.toExponential(1) : r.p.toPrecision(2)}</text>
                  <title>{`${r.label} · ${r.sub}: p = ${r.p}`}</title>
                </g>
              );
            })}
          </svg>
        );
      }}
    </Responsive>
  );
}

// --- unit scatter --------------------------------------------------------------------------------------------

export function UnitScatter({ points, levels, selected, title, xLabel, yLabel }: {
  points: readonly { x: number; y: number; level: number; label: string }[];
  levels: readonly string[];
  selected: string | null;
  title: string; xLabel: string; yLabel: string;
}) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = (lo: number, hi: number) => { const d = hi - lo || Math.abs(hi) || 1; return [lo - d * 0.06, hi + d * 0.06] as const; };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const centroids = levels.map((_, li) => {
    const pts = points.filter((p) => p.level === li);
    return pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : null;
  });
  return (
    <>
      <Responsive min={280}>
        {(width) => {
          const h = Math.min(380, Math.max(240, width * 0.6));
          const sx = linear(x0, x1, 64, width - 12);
          const sy = linear(y0, y1, h - 34, 8);
          return (
            <svg width={width} height={h} role="img" aria-label={title} className="dz-scatter">
              <title>{title}</title>
              {niceTicks(x0, x1, 5).map((t) => <g key={`x${t}`}><line x1={sx(t)} x2={sx(t)} y1={8} y2={h - 34} className="dz-grid" /><text x={sx(t)} y={h - 20} textAnchor="middle" className="dz-tick">{t.toPrecision(2)}</text></g>)}
              {niceTicks(y0, y1, 5).map((t) => <g key={`y${t}`}><line x1={64} x2={width - 12} y1={sy(t)} y2={sy(t)} className="dz-grid" /><text x={58} y={sy(t) + 4} textAnchor="end" className="dz-tick">{t.toPrecision(2)}</text></g>)}
              <text x={(width + 64) / 2} y={h - 4} textAnchor="middle" className="dz-axis-name">{xLabel}</text>
              <text transform={`translate(12,${(h - 34) / 2}) rotate(-90)`} textAnchor="middle" className="dz-axis-name">{yLabel}</text>
              {points.map((p, i) => {
                const st = levelStyle(p.level);
                const dim = selected !== null && levels[p.level] !== selected;
                return <g key={i} opacity={dim ? 0.25 : 0.85}><DotMark shape={st.shape} x={sx(p.x)} y={sy(p.y)} r={4} tone={st.tone} /><title>{`${p.label} — ${levels[p.level]}`}</title></g>;
              })}
              {centroids.map((c, li) => c ? (
                <g key={`c${li}`} className="dz-centroid"><path d={`M${sx(c.x) - 7},${sy(c.y)} h14 M${sx(c.x)},${sy(c.y) - 7} v14`} /><title>{levels[li]}</title></g>
              ) : null)}
            </svg>
          );
        }}
      </Responsive>
      <Legend items={levels.map((l, i) => ({ label: `${l} (${levelStyle(i).shape})`, tone: levelStyle(i).tone }))} />
    </>
  );
}
