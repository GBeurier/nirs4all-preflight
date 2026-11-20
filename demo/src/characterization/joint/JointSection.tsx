// Joint X–Y association landscape (spec §8) and dynamic joint interpretation (§9). Spectral R² (engine
// confounding, development units in the canonical PCA space) and target η² (engine association, development
// references) are different response spaces and possibly different populations: they are shown side by side,
// never combined, subtracted or divided into a score.
import { Fragment, useMemo } from "react";
import { reasonLabel } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";
import { fill } from "../../i18n";
import { Section, type Scope } from "../../Sections";
import { ChartCard, EmptyState, Responsive, linear, niceTicks } from "../shared/charts";
import { UnitScatter } from "../design/charts";
import { designModel, type DesignModel, type TestEvidence, type TestKind } from "../design/model";
import { effectiveFactor, useDesignSelection } from "../design/selection";
import { designUnits } from "../design/units";
import { EffectBars, Mark, ShapeLegend, type EffectRow } from "./charts";
import { jointSentences } from "./interpret";
import { associationResults, jointRows, type JointRow } from "./model";
import { FactorTargetDetail, associationTooltip, useFmt } from "./TargetAssociations";
import "./joint.css";

type T = Scope["t"];
const pct = (v: number, locale: Locale) => `${(100 * v).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
const sigLabel = (v: boolean | null, t: T) => (v === null ? t("jtNA") : v ? t("jtSig") : t("jtNotSig"));

function rowTooltip(r: JointRow, t: T, fmt: (v: number) => string): string {
  const s = r.spectral;
  return [
    `${r.factor}`,
    `${t("jtR2Axis")}: ${r.r2Marginal === null ? "—" : fmt(r.r2Marginal)} · ${t("jtR2Unique")}: ${s?.r2?.uniqueGivenCells === null || s?.r2?.uniqueGivenCells === undefined ? "—" : fmt(s.r2.uniqueGivenCells)}`,
    `${t("jtTestMarginal")}: ${sigLabel(r.spectralSignificant, t)} · ${t("jtTestPermdisp")}: ${sigLabel(r.dispersionSignificant, t)}`,
    `${t("jtEtaAxis")}: ${r.eta2 === null ? "—" : fmt(r.eta2)} · ${t("jtTargetSide")}: ${sigLabel(r.targetSignificant, t)}`,
    fill(t("jtPopNote"), { nx: r.spectralUnits ?? "—", ny: r.target?.denominators.n_units_analyzed ?? "—" }),
  ].join("\n");
}

/** Scatter X = marginal spectral R², Y = marginal target η², one point per factor with both values. */
export function JointLandscape({ rows, selected, onSelect, t, fmt }: { rows: readonly JointRow[]; selected: string | null; onSelect: (f: string) => void; t: T; fmt: (v: number) => string }) {
  const pts = rows.filter((r) => r.r2Marginal !== null && r.eta2 !== null);
  const without = rows.filter((r) => r.r2Marginal === null || r.eta2 === null);
  if (!pts.length) return <EmptyState>{t("jtNoJoint")}</EmptyState>;
  // Axes start at 0 and end at the first 0.1 step above the largest value (at most 1).
  const top = (v: number) => Math.min(1, Math.max(0.1, Math.ceil(v * 1.08 * 10) / 10));
  const xHi = top(Math.max(...pts.map((r) => r.r2Marginal!)));
  const yHi = top(Math.max(...pts.map((r) => r.eta2!)));
  const shape = (r: JointRow) => (r.identifiable === null ? "square" : r.identifiable ? "circle" : "triangle");
  return (
    <div>
      <Responsive min={280}>
        {(width) => {
          const height = Math.min(360, Math.max(260, width * 0.6));
          const pad = { l: 52, r: 16, t: 12, b: 42 };
          const x = linear(0, xHi, pad.l, width - pad.r - 60);
          const y = linear(0, yHi, height - pad.b, pad.t);
          // Labels of nearby points are stacked so they never overlap (deterministic, by factor order).
          const placed: { x: number; y: number }[] = [];
          const labelY = new Map<string, number>();
          for (const r of [...pts].sort((a, b) => b.eta2! - a.eta2!)) {
            let ly = y(r.eta2!) + 4;
            while (placed.some((p) => Math.abs(p.x - x(r.r2Marginal!)) < 90 && Math.abs(p.y - ly) < 13)) ly += 13;
            placed.push({ x: x(r.r2Marginal!), y: ly });
            labelY.set(r.factor, ly);
          }
          return (
            <svg className="cz-svg" width={width} height={height} role="img" aria-label={`${t("jtLandTitle")}: ${pts.map((r) => `${r.factor} R² ${fmt(r.r2Marginal!)}, η² ${fmt(r.eta2!)}`).join("; ")}`}>
              <title>{t("jtLandTitle")}</title>
              {niceTicks(0, yHi, 5).map((v) => <g key={`y${v}`}><line x1={pad.l} x2={width - pad.r - 60} y1={y(v)} y2={y(v)} className="cz-grid" /><text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="cz-t-axis">{fmt(v)}</text></g>)}
              {niceTicks(0, xHi, 5).map((v) => <text key={`x${v}`} x={x(v)} y={height - pad.b + 14} textAnchor="middle" className="cz-t-axis">{fmt(v)}</text>)}
              {pts.map((r) => {
                const cx = x(r.r2Marginal!);
                const cy = y(r.eta2!);
                const sel = r.factor === selected;
                return (
                  <g key={r.factor} className={`jt-landscape-pt${sel ? " jt-selected" : ""}`} tabIndex={0} role="button" aria-pressed={sel} aria-label={rowTooltip(r, t, fmt).replace(/\n/g, "; ")}
                    onClick={() => onSelect(r.factor)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.factor); } }}>
                    <circle className="jt-halo" cx={cx} cy={cy} r={13} fill="none" />
                    {r.targetSignificant ? <circle cx={cx} cy={cy} r={10} fill="none" style={{ stroke: "var(--cz-ink)" }} strokeWidth={1.4} /> : null}
                    <Mark shape={shape(r)} x={cx} y={cy} r={6} fill={r.spectralSignificant ? "var(--jt-c2)" : "var(--cz-surface)"} stroke="var(--jt-c2)" dash={r.dispersionSignificant ? "2.5 2" : undefined} strokeWidth={1.8} />
                    <text x={cx + 14} y={labelY.get(r.factor) ?? cy + 4} className="jt-pt-label">{r.factor}</text>
                    <title>{rowTooltip(r, t, fmt)}</title>
                  </g>
                );
              })}
              <text x={(pad.l + width - pad.r) / 2} y={height - 4} textAnchor="middle" className="cz-t-axis">{t("jtR2Axis")}</text>
              <text transform={`translate(12 ${(pad.t + height - pad.b) / 2}) rotate(-90)`} textAnchor="middle" className="cz-t-axis">{t("jtEtaAxis")}</text>
            </svg>
          );
        }}
      </Responsive>
      <div className="jt-legends">
        <ShapeLegend title={t("jtLegShape")} items={[{ label: t("jtIdentifiable"), shape: "circle", color: "var(--jt-c2)" }, { label: t("jtAliased"), shape: "triangle", color: "var(--jt-c2)" }, { label: t("jtUnknownId"), shape: "square", color: "var(--jt-c2)" }]} />
        <ShapeLegend title={t("jtLegFill")} items={[{ label: t("jtSig"), shape: "circle", color: "var(--jt-c2)" }, { label: `${t("jtNotSig")} / ${t("jtNA")}`, shape: "circle", color: "var(--jt-c2)", hollow: true }]} />
        <ShapeLegend title={t("jtLegRing")} items={[{ label: t("jtSig"), shape: "circle", color: "var(--jt-c2)", hollow: true, ring: true }, { label: `${t("jtNotSig")} / ${t("jtNA")}`, shape: "circle", color: "var(--jt-c2)", hollow: true }]} />
        <ShapeLegend title={t("jtLegDash")} items={[{ label: t("jtSig"), shape: "circle", color: "var(--jt-c2)", hollow: true, dash: "2.5 2" }]} />
      </div>
      {without.length ? <p className="jt-provenance">{without.map((r) => `${r.factor}: ${r.r2Marginal === null ? `R² ${t("jtNA")}` : ""}${r.r2Marginal === null && r.eta2 === null ? ", " : ""}${r.eta2 === null ? `η² ${t("jtNA")}` : ""}`).join(" · ")}</p> : null}
    </div>
  );
}

const TESTS: { kind: TestKind; label: "jtTestMarginal" | "jtTestWithin" | "jtTestFL" | "jtTestPermdisp" }[] = [
  { kind: "marginal", label: "jtTestMarginal" },
  { kind: "within_cell", label: "jtTestWithin" },
  { kind: "freedman_lane", label: "jtTestFL" },
  { kind: "permdisp", label: "jtTestPermdisp" },
];

const stateText = (e: TestEvidence | null, t: T, fmt: (v: number) => string) =>
  !e ? t("jtNA") : e.state === "significant" || e.state === "not_significant" ? `${e.state === "significant" ? t("jtSig") : t("jtNotSig")} (${t("jtPHolm")} ${e.pHolm === null ? "—" : fmt(e.pHolm)})` : e.reasonCode ? reasonLabel(e.reasonCode) : e.state.replace(/_/g, " ");

/** Selected factor: spectral PCA groups, target distribution, crossings, effect sizes and permutation results. */
function FactorJointDetail({ row, scope, design, fmt }: { row: JointRow; scope: Scope; design: DesignModel | null; fmt: (v: number) => string }) {
  const { t, locale, view, input } = scope;
  const s = row.spectral;
  const units = useMemo(() => (design ? designUnits(view, input, design) : null), [view, input, design]);
  const scatter = useMemo(() => {
    if (!units?.ok || !s) return null;
    const levels = s.levels.map((l) => l.level);
    const pts = units.units.coordinates.flatMap((c, i) => {
      const li = levels.indexOf(units.units.levels[i]?.[s.factor] ?? "");
      return c.length >= 2 && li >= 0 ? [{ x: c[0]!, y: c[1]!, level: li, label: units.units.members[i]!.slice(0, 3).join(", ") }] : [];
    });
    return pts.length ? { pts, levels } : null;
  }, [units, s]);
  const crossings = (design?.crossings ?? []).filter((c) => c.a === row.factor || c.b === row.factor);
  return (
    <div className="jt-stack">
      <div className="jt-grid-2">
        <ChartCard title={`${t("jtSpectralSide")} — ${row.factor}`} subtitle={fill(t("jtPopNote"), { nx: row.spectralUnits ?? "—", ny: row.target?.denominators.n_units_analyzed ?? "—" })}>
          <dl className="jt-kv">
            <dt>{t("jtR2Axis")}</dt><dd>{s?.r2?.marginal === null || s?.r2?.marginal === undefined ? t("jtNA") : `${fmt(s.r2.marginal)} (${pct(s.r2.marginal, locale)})`}</dd>
            <dt>{t("jtR2Unique")}</dt><dd>{s?.r2?.uniqueGivenCells === null || s?.r2?.uniqueGivenCells === undefined ? (s?.aliasedWithCells ? t("jtAliased") : t("jtNA")) : fmt(s.r2.uniqueGivenCells)}</dd>
            <dt>{t("jtR2Additive")}</dt><dd>{s?.r2?.uniqueAdditive === null || s?.r2?.uniqueAdditive === undefined ? (s?.identifiableAdditive === false ? t("jtAliased") : t("jtNA")) : fmt(s.r2.uniqueAdditive)}</dd>
            {TESTS.map((k) => <Fragment key={k.kind}><dt>{t(k.label)}</dt><dd>{stateText(s?.tests[k.kind] ?? null, t, fmt)}</dd></Fragment>)}
            <dt>{t("jtEtaAxis")}</dt><dd>{row.eta2 === null ? t("jtNA") : `${fmt(row.eta2)} (${pct(row.eta2, locale)})`}</dd>
            <dt>{t("jtTargetSide")}</dt><dd>{row.target?.test ? `${sigLabel(row.targetSignificant, t)} (${t("jtPHolm")} ${row.target.test.pHolm === null ? "—" : fmt(row.target.test.pHolm)})` : t("jtNA")}</dd>
          </dl>
          {crossings.length ? (
            <div className="jt-chips" style={{ marginTop: 8 }}>
              {crossings.map((c) => <span key={`${c.a}|${c.b}`} className="jt-chip" title={`${c.occupied} / ${c.possible} cells, min ${c.minOccupied ?? "—"}, max ${c.maxOccupied ?? "—"} units`}>{`${c.a} × ${c.b}: ${pct(c.coverage, locale)}`}</span>)}
            </div>
          ) : null}
        </ChartCard>
        {scatter ? (
          <ChartCard title={`PCA — ${row.factor}`} subtitle={`${row.spectralUnits ?? "—"} ${t("jtUnits").toLowerCase()}`}>
            <UnitScatter points={scatter.pts} levels={scatter.levels} selected={null} title={`PCA — ${row.factor}`} xLabel="PC1" yLabel="PC2" />
          </ChartCard>
        ) : null}
      </div>
      {row.target ? <FactorTargetDetail key={`${row.target.targetId}|${row.factor}`} a={row.target} input={input} t={t} locale={locale} /> : null}
    </div>
  );
}

export function JointSection(scope: Scope) {
  const { t, locale, view, sourceId, targetId } = scope;
  const fmt = useFmt(locale);
  const design = useMemo(() => (sourceId ? designModel(view, sourceId) : null), [view, sourceId]);
  const assoc = useMemo(() => associationResults(view, null), [view]);
  const tId = targetId !== null && assoc.some((a) => a.targetId === targetId) ? targetId : (assoc[0]?.targetId ?? null);
  const rows = useMemo(() => jointRows(design, assoc, tId), [design, assoc, tId]);
  const sentences = useMemo(() => jointSentences(rows, design, assoc, tId, fmt), [rows, design, assoc, tId, fmt]);
  const selection = useDesignSelection();
  if (!rows.length || !design || !assoc.length) return null;
  const factor = effectiveFactor(selection.factor, rows.map((r) => r.factor));
  const current = rows.find((r) => r.factor === factor) ?? null;
  const bars: EffectRow[] = rows.map((r) => ({
    id: r.factor,
    label: r.factor,
    sub: fill(t("jtPopNote"), { nx: r.spectralUnits ?? "—", ny: r.target?.denominators.n_units_analyzed ?? "—" }),
    value: r.r2Marginal,
    missing: r.spectral?.r2?.reasonCode ? reasonLabel(r.spectral.r2.reasonCode) : t("jtNA"),
    tooltip: rowTooltip(r, t, fmt),
    selected: r.factor === factor,
    compare: { value: r.eta2, missing: r.target && r.target.status !== "computed" ? (r.target.reasonCode ? reasonLabel(r.target.reasonCode) : t("jtNA")) : r.target && r.target.measure !== "eta_squared" ? fill(t("jtNotEta"), { measure: r.target.measure.replace(/_/g, " ") }) : t("jtNA"), tooltip: r.target ? associationTooltip(r.target, t, fmt, locale) : t("jtNA") },
  }));
  return (
    <Section id="s-joint" icon="composition" accent="indigo" title={t("jtJointTitle")} lead={t("jtCommonLead")}>
      <div className="jt-stack">
        <div className="jt-grid-2">
          <ChartCard title={t("jtBarsTitle")} subtitle={t("jtBarsSub")}>
            <EffectBars rows={bars} domain={[0, 1]} fmt={(v) => `${fmt(v)} · ${pct(v, locale)}`} axisLabel={`R² / η² (${tId ?? "—"})`} title={t("jtBarsTitle")} onSelect={selection.setFactor} labels={[`${t("jtR2Axis")} (${t("jtSpectralSide").toLowerCase()})`, `${t("jtEtaAxis")} (${tId ?? "—"})`]} />
          </ChartCard>
          <ChartCard title={t("jtLandTitle")} subtitle={t("jtSelectHint")}>
            <JointLandscape rows={rows} selected={factor} onSelect={selection.setFactor} t={t} fmt={fmt} />
          </ChartCard>
        </div>
        <ChartCard title={t("jtInterpTitle")} subtitle={t("jtInterpLead")}>
          {sentences.length ? (
            <ul className="jt-sentences">{sentences.map((s, i) => <li key={i} className={s.factor !== null && s.factor === factor ? "jt-sel" : undefined}>{fill(t(s.key), s.vars)}</li>)}</ul>
          ) : <EmptyState>{t("jtINone")}</EmptyState>}
        </ChartCard>
        {current ? <div className="jt-detail"><FactorJointDetail key={current.factor} row={current} scope={scope} design={design} fmt={fmt} /></div> : null}
      </div>
    </Section>
  );
}
