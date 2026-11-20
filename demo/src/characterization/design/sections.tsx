// Experimental design section (§2–3) and the confounding detail (§4–6): typed engine results from `model.ts`,
// interpretation rules here, charts from `charts.tsx` and the shared kit, every sentence from i18n templates.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChartDataTable, formatEngineNumber, formatPValue, reasonLabel } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";
import { fill, type TextKey } from "../../i18n";
import { Section, type Scope } from "../../Sections";
import { BoxPlotRows, ChartCard, EmptyState, KpiStrip, Legend, StackedShareBar, ValueBars, type BoxRow, type KpiItem, type Tone } from "../shared/charts";
import type { DotShape } from "../shared/charts";
import { quantile } from "../shared/derive";
import { loadMethods } from "../domains/kernels";
import { ContingencyHeatmap, DependencyGraph, GraphLegend, GroupedBars, PValuePlot, UnitScatter, levelStyle, type GroupedRow, type PRow } from "./charts";
import { permanovaChecks } from "./consistency";
import { adjustmentDrop, designModel, EVIDENCE_STATES, TEST_KINDS, type Crossing, type DesignModel, type EvidenceState, type FactorDesign, type TestEvidence, type TestKind } from "./model";
import { effectiveFactor, useDesignSelection } from "./selection";
import { designUnits, factorDistances, type FactorDistances } from "./units";
import "./design.css";

type T = Scope["t"];

const fmtNum = (v: number | null | undefined, locale: Locale, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toLocaleString(locale) : (formatEngineNumber(v, locale, digits) ?? "—"));
const pct = (v: number | null | undefined, locale: Locale) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toLocaleString(locale, { maximumFractionDigits: v * 100 < 10 ? 1 : 0, minimumFractionDigits: 0 })} %`);
const reason = (code: string | null | undefined) => (code ? reasonLabel(code) : "—");

export const STATE_KEY: Record<EvidenceState, { label: TextKey; explain: TextKey; glyph: string; tone: Tone }> = {
  significant: { label: "dzStSignificant", explain: "dzExSignificant", glyph: "●", tone: "copper" },
  not_significant: { label: "dzStNotSignificant", explain: "dzExNotSignificant", glyph: "○", tone: "teal" },
  not_identifiable: { label: "dzStNotIdentifiable", explain: "dzExNotIdentifiable", glyph: "⊘", tone: "grey" },
  insufficient_resolution: { label: "dzStResolution", explain: "dzExResolution", glyph: "◔", tone: "grey" },
  blocked: { label: "dzStBlocked", explain: "dzExBlocked", glyph: "■", tone: "grey" },
  not_applicable: { label: "dzStNotApplicable", explain: "dzExNotApplicable", glyph: "–", tone: "muted" },
  error: { label: "dzStError", explain: "dzExError", glyph: "!", tone: "copper-2" },
};
const KIND_LABEL: Record<TestKind, TextKey> = { marginal: "dzColMarginal", within_cell: "dzColWithin", freedman_lane: "dzColPartial", permdisp: "dzColPermdisp" };
const KIND_SHAPE: Record<TestKind, DotShape> = { marginal: "circle", within_cell: "square", freedman_lane: "diamond", permdisp: "circle" };
const KIND_TONE: Record<TestKind, Tone> = { marginal: "teal", within_cell: "blue", freedman_lane: "copper", permdisp: "grey" };

/** Identifiability label of one factor (rank-based engine statuses). */
export function identifiability(f: FactorDesign, t: T, nVarying: number): string {
  if (!f.varying) return t("dzIdSingle");
  if (nVarying < 2) return t("dzIdAlone");
  if (f.dfReasonCode) return fill(t("dzIdUnknown"), { r: reason(f.dfReasonCode) });
  if (f.aliasedWithCells === true) {
    if (f.identifiableAdditive === true) return t("dzIdAdditiveOnly");
    if (f.identifiableAdditive === false) return t("dzIdNone");
    return fill(t("dzIdUnknown"), { r: reason(f.additiveReasonCode) });
  }
  if (f.partiallyConfounded === true) return fill(t("dzIdPartial"), { a: f.dfGivenCells ?? "—", b: f.dfNominal ?? "—" });
  if (f.aliasedWithCells === false) return t("dzIdFull");
  return fill(t("dzIdUnknown"), { r: "—" });
}

function relationSentence(r: DesignModel["relations"][number], t: T, locale: Locale, crossings: readonly Crossing[]): string {
  if (r.kind === "determines") return fill(t("dzSentDetermines"), { from: r.from, to: r.to });
  if (r.kind === "mutual") return fill(t("dzSentMutual"), { a: r.from, b: r.to });
  if (r.kind === "partial") {
    const c = crossings.find((x) => (x.a === r.from && x.b === r.to) || (x.a === r.to && x.b === r.from));
    return fill(t("dzSentPartial"), { a: r.from, b: r.to, occ: c?.occupied ?? "—", pos: c?.possible ?? "—", pct: pct(r.coverage, locale) });
  }
  if (r.kind === "aliasing") return fill(t("dzSentAliasing"), { from: r.from, to: r.to });
  return fill(t("dzSentUnknown"), { from: r.from, to: r.to });
}

function FactorChips({ t, factors, selected, onSelect }: { t: T; factors: readonly string[]; selected: string | null; onSelect: (f: string) => void }) {
  if (factors.length < 2) return null;
  return (
    <div className="dz-chips" role="group" aria-label={t("dzSelectFactor")}>
      <span className="dz-chips-label">{t("dzSelectFactor")}</span>
      {factors.map((f) => <button key={f} type="button" className={`dz-chip${f === selected ? " is-on" : ""}`} aria-pressed={f === selected} onClick={() => onSelect(f)}>{f}</button>)}
    </div>
  );
}

function useModel(scope: Scope): DesignModel | null {
  const { view, sourceId } = scope;
  return useMemo(() => (sourceId ? designModel(view, sourceId) : null), [view, sourceId]);
}

// --- §2–3 experimental design ---------------------------------------------------------------------------------

export function DesignSection(scope: Scope) {
  const { t, locale } = scope;
  const model = useModel(scope);
  const sel = useDesignSelection();
  const varying = useMemo(() => model?.factors.filter((f) => f.varying).map((f) => f.factor) ?? [], [model]);
  const factor = effectiveFactor(sel.factor, varying);
  const [pairKey, setPairKey] = useState<string | null>(null);
  if (!model) return null;
  const head = (children: ReactNode) => <Section id="s-design" icon="composition" accent="amber" title={t("dzDesignTitle")} lead={t("dzCommonLead")}>{children}</Section>;
  if (model.state.status !== "computed") return head(<p className="alert alert-info">{fill(t("dzUnavailable"), { reason: reason(model.state.reasonCode) })}</p>);

  const constant = model.factors.filter((f) => !f.varying).length;
  const full = model.factors.filter((f) => f.varying && f.aliasedWithCells === true && f.identifiableAdditive !== true).length;
  const partial = model.factors.filter((f) => f.varying && (f.partiallyConfounded === true || (f.aliasedWithCells === true && f.identifiableAdditive === true))).length;
  const kpis: KpiItem[] = [
    { label: t("dzKpiUnits"), value: fmtNum(model.nUnitsAnalyzed, locale), sub: fill(t("dzKpiUnitsSub"), { n: fmtNum(model.nIndependenceUnits, locale), s: fmtNum(model.nEligibleSamples, locale) }), tone: "teal" },
    { label: t("dzKpiFactors"), value: model.factors.length, sub: fill(t("dzKpiFactorsSub"), { v: varying.length, c: constant }), tone: "blue" },
    { label: t("dzKpiExcluded"), value: fmtNum((model.nMissing ?? 0) + (model.nVaries ?? 0), locale), sub: fill(t("dzKpiExcludedSub"), { m: fmtNum(model.nMissing, locale), v: fmtNum(model.nVaries, locale) }), tone: "grey" },
    { label: t("dzKpiCells"), value: fmtNum(model.nOccupiedCells, locale), sub: t("dzKpiCellsSub"), tone: "grey" },
    { label: t("dzKpiConfounded"), value: full + partial, sub: fill(t("dzKpiConfoundedSub"), { full, partial }), tone: full ? "copper" : "teal" },
  ];
  const levelRange = (f: FactorDesign) => {
    const ns = f.levels.map((l) => l.nUnits).filter((n): n is number => n !== null);
    return ns.length ? (Math.min(...ns) === Math.max(...ns) ? String(ns[0]) : `${Math.min(...ns)}–${Math.max(...ns)}`) : "—";
  };
  const crossings = model.crossings;
  const defaultPair = crossings.filter((c) => factor && (c.a === factor || c.b === factor)).sort((x, y) => x.coverage - y.coverage)[0] ?? crossings[0] ?? null;
  const pair = crossings.find((c) => `${c.a}×${c.b}` === pairKey) ?? defaultPair;
  const nodes = varying.map((f) => ({ id: f, sub: `${model.factors.find((x) => x.factor === f)!.nLevels} ${t("dzColLevels").toLowerCase()}` }));
  const relLabels = { determines: t("dzRelDetermines"), mutual: t("dzRelMutual"), partial: t("dzRelPartial"), aliasing: t("dzRelAliasing"), unknown: t("dzRelUnknown") };
  return head(
    <>
      <ChartCard title={t("dzOverview")} subtitle={fill(t("dzOverviewSub"), { unit: model.analysisUnit ?? "—" })}>
        <KpiStrip items={kpis} label={t("dzOverview")} />
        {model.undeclared.length ? <p className="hint">{fill(t("dzUndeclared"), { f: model.undeclared.join(", ") })}</p> : null}
      </ChartCard>
      <FactorChips t={t} factors={varying} selected={factor} onSelect={sel.setFactor} />
      <ChartCard title={t("dzFactorTable")}>
          <div className="dz-scroll">
            <table className="dz-table">
              <thead><tr><th>{t("dzColFactor")}</th><th>{t("dzColLevels")}</th><th>{t("dzColUnitsPerLevel")}</th><th>{t("dzColDfNominal")}</th><th>{t("dzColDfCells")}</th><th>{t("dzColDfAdditive")}</th><th>{t("dzColStatus")}</th></tr></thead>
              <tbody>
                {model.factors.map((f) => (
                  <tr key={f.factor} className={f.factor === factor ? "is-selected" : undefined} onClick={f.varying ? () => sel.setFactor(f.factor) : undefined}>
                    <th scope="row">{f.factor}</th>
                    <td className="num">{f.nLevels}</td>
                    <td className="num" title={f.levels.map((l) => `${l.level}: ${l.nUnits ?? "—"}`).join("\n")}>{levelRange(f)}</td>
                    <td className="num">{fmtNum(f.dfNominal, locale)}</td>
                    <td className="num">{fmtNum(f.dfGivenCells, locale)}</td>
                    <td className="num">{fmtNum(f.dfGivenMainEffects, locale)}</td>
                    <td>{identifiability(f, t, varying.length)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {factor ? <ChartDataTable locale={locale} caption={`${t("dzColUnitsPerLevel")} — ${factor}`} columns={[t("dzColLevels"), t("dzKpiUnits")]} rows={model.factors.find((f) => f.factor === factor)!.levels.map((l) => [l.level, l.nUnits])} /> : null}
      </ChartCard>
      <div className="grid-2">
        <ChartCard title={t("dzGraph")} subtitle={t("dzGraphSub")} footnote={model.aliasingRule ? fill(t("dzGraphRankNote"), { rule: model.aliasingRule }) : undefined}>
          {varying.length < 2 ? <EmptyState>{t("dzGraphSingle")}</EmptyState> : (
            <>
              <DependencyGraph nodes={nodes} relations={model.relations} selected={factor} onSelect={sel.setFactor} labels={relLabels} title={t("dzGraph")} />
              <GraphLegend labels={relLabels} />
              {model.relations.length ? <ul className="dz-sentences">{model.relations.map((r, i) => <li key={i} data-kind={r.kind}>{relationSentence(r, t, locale, crossings)}</li>)}</ul> : <EmptyState>{t("dzGraphNone")}</EmptyState>}
            </>
          )}
        </ChartCard>
      </div>
      <ChartCard title={t("dzCoverage")} subtitle={t("dzCoverageSub")} footnote={t("dzCoverageNote")}>
        {!crossings.length ? <EmptyState>{t("dzCoverageNone")}</EmptyState> : (
          <div className="dz-coverage">
            <div className="dz-scroll">
              <table className="dz-table dz-pairs">
                <caption className="dz-sr">{t("dzCoverage")}</caption>
                <thead><tr><th>{t("dzColPair")}</th><th>{t("dzColOccupied")}</th><th>{t("dzColCoverage")}</th><th>{t("dzColCellRange")}</th><th>{t("dzColSingletons")}</th></tr></thead>
                <tbody>
                  {crossings.map((c) => {
                    const key = `${c.a}×${c.b}`;
                    const on = pair && `${pair.a}×${pair.b}` === key;
                    return (
                      <tr key={key} className={on ? "is-selected" : undefined}>
                        <th scope="row"><button type="button" className="dz-link" aria-pressed={!!on} onClick={() => setPairKey(key)}>{`${c.a} × ${c.b}`}</button></th>
                        <td className="num">{`${c.occupied} / ${c.possible}`}</td>
                        <td><span className="dz-meter" aria-hidden="true"><span style={{ width: `${c.coverage * 100}%` }} /></span> {pct(c.coverage, locale)}</td>
                        <td className="num">{c.minOccupied === null ? "—" : `${c.minOccupied}–${c.maxOccupied}`}</td>
                        <td className="num">{c.singletons}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pair ? (
              <div>
                <h5 className="dz-sub">{fill(t("dzHeatmap"), { a: pair.a, b: pair.b })}</h5>
                <p className="hint">{t("dzHeatmapSub")}</p>
                <ContingencyHeatmap a={pair.a} b={pair.b} levelsA={pair.levelsA} levelsB={pair.levelsB} counts={pair.counts} title={fill(t("dzHeatmap"), { a: pair.a, b: pair.b })} emptyLabel={t("dzEmptyCell")} totalLabel={t("dzTotal")} />
                <ChartDataTable locale={locale} caption={fill(t("dzHeatmap"), { a: pair.a, b: pair.b })} columns={[`${pair.a} \\ ${pair.b}`, ...pair.levelsB]} rows={pair.levelsA.map((l, i) => [l, ...pair.counts[i]!])} />
              </div>
            ) : null}
          </div>
        )}
      </ChartCard>
    </>,
  );
}

// --- §4–6 variance partition, statistical evidence, PERMDISP --------------------------------------------------

function StateChip({ e, t, locale }: { e: TestEvidence | null; t: T; locale: Locale }) {
  if (!e) return <span className="dz-state" data-state="none">—</span>;
  const k = STATE_KEY[e.state];
  return (
    <span className={`dz-state cz-tone-${k.tone}`} data-state={e.state} title={`${t(k.label)} — ${e.state === "blocked" ? fill(t(k.explain), { reason: reason(e.reasonCode) }) : t(k.explain)}${e.reasonCode ? ` (${reason(e.reasonCode)})` : ""}`}>
      <span aria-hidden="true" className="dz-glyph">{k.glyph}</span>
      <span>{t(k.label)}</span>
      {e.pHolm !== null ? <span className="dz-p">{`p Holm ${formatPValue(e.pHolm)}`}</span> : null}
      {e.state !== "significant" && e.state !== "not_significant" && e.reasonCode ? <span className="dz-reason">{reason(e.reasonCode)}</span> : null}
      <span className="dz-sr">{fmtNum(e.statistic, locale)}</span>
    </span>
  );
}

const causeKey = { admissible_permutations: "dzCauseAdmissible", multiplicity: "dzCauseMultiplicity", requested_draws: "dzCauseDraws" } as const;

function useDistances(scope: Scope, model: DesignModel | null, factor: string | null): { state: "idle" | "loading" | "ok" | "no_scores" | "mismatch"; result: FactorDistances | null; coords: number[][] | null; reason?: string } {
  const { view, input } = scope;
  const units = useMemo(() => (model && model.state.status === "computed" ? designUnits(view, input, model) : null), [view, input, model]);
  const [res, setRes] = useState<{ factor: string; result: FactorDistances | null } | null>(null);
  useEffect(() => {
    if (!units?.ok || !model || !factor) return;
    let live = true;
    loadMethods().then((m) => { if (live) setRes({ factor, result: factorDistances(m, units.units, model, factor) }); }).catch(() => { if (live) setRes({ factor, result: null }); });
    return () => { live = false; };
  }, [units, model, factor]);
  if (!units || !factor) return { state: "idle", result: null, coords: null };
  if (!units.ok) return { state: units.reason === "NO_SCORES" ? "no_scores" : "mismatch", result: null, coords: null, reason: units.reason };
  if (!res || res.factor !== factor) return { state: "loading", result: null, coords: units.units.coordinates };
  if (!res.result || !res.result.matchesEngine) return { state: "mismatch", result: null, coords: null, reason: "DISTANCE_MISMATCH" };
  return { state: "ok", result: res.result, coords: units.units.coordinates };
}

export function ConfoundingDetail({ scope, original }: { scope: Scope; original?: ReactNode }) {
  const { t, locale } = scope;
  const model = useModel(scope);
  const sel = useDesignSelection();
  const varying = useMemo(() => model?.factors.filter((f) => f.varying) ?? [], [model]);
  const factor = effectiveFactor(sel.factor, varying.map((f) => f.factor));
  const [mode, setMode] = useState<"holm" | "raw" | "bh">("holm");
  const dist = useDistances(scope, model, factor);
  if (!model || model.state.status !== "computed" || !varying.length) return null;
  const selected = varying.find((f) => f.factor === factor) ?? null;
  const alpha = model.families[0]?.alpha ?? null;

  // Variance partition: three effect sizes per factor; non-identifiable states drawn explicitly.
  const others = (f: FactorDesign) => varying.filter((x) => x.factor !== f.factor).map((x) => x.factor).join(", ");
  const rows: GroupedRow[] = varying.map((f) => ({
    id: f.factor,
    label: f.factor,
    selected: f.factor === factor,
    bars: [
      { label: t("dzBarMarginal"), value: f.r2?.marginal ?? null, tone: "teal", missing: f.r2?.reasonCode ? reason(f.r2.reasonCode) : t("dzNotComputed") },
      { label: t("dzBarCells"), value: f.aliasedWithCells === true ? null : (f.r2?.uniqueGivenCells ?? null), tone: "blue", missing: varying.length < 2 ? t("dzNoOther") : f.aliasedWithCells === true ? t("dzNotIdentifiable") : t("dzNotComputed") },
      { label: t("dzBarAdditive"), value: f.identifiableAdditive === false ? null : (f.r2?.uniqueAdditive ?? null), tone: "copper", pattern: true, missing: varying.length < 2 ? t("dzNoOther") : f.identifiableAdditive === false ? t("dzNotIdentifiable") : t("dzNotComputed") },
    ],
  }));
  const drops = varying.map((f) => {
    const d = adjustmentDrop(f);
    if (d) return fill(t("dzDrop"), { factor: f.factor, m: pct(d.marginal, locale), a: pct(d.adjusted, locale), basis: t(d.basis === "cells" ? "dzBasisCells" : "dzBasisAdditive") });
    if (f.r2?.marginal !== null && f.r2?.marginal !== undefined && f.aliasedWithCells === true && f.identifiableAdditive === false) return fill(t("dzDropNonId"), { factor: f.factor, m: pct(f.r2.marginal, locale), others: others(f) });
    return null;
  }).filter((s): s is string => s !== null);
  const failed = varying.map((f) => ({ f, bad: permanovaChecks(f, model.nUnitsAnalyzed).filter((c) => !c.ok) })).filter((x) => x.bad.length);
  const joint = model.joint;

  // Evidence: p-values of executed tests.
  const pRows: PRow[] = varying.flatMap((f) => TEST_KINDS.flatMap((k) => {
    const e = f.tests[k];
    const p = !e ? null : mode === "raw" ? e.pRaw : mode === "holm" ? e.pHolm : e.pBhExploratory;
    return e && p !== null ? [{ id: `${f.factor}|${k}`, label: f.factor, sub: t(KIND_LABEL[k]), p, shape: KIND_SHAPE[k], tone: KIND_TONE[k], hollow: mode === "bh", significant: e.state === "significant" }] : [];
  }));
  const missing = varying.flatMap((f) => TEST_KINDS.flatMap((k) => (f.tests[k] && f.tests[k]!.pRaw === null ? [`${f.factor} · ${t(KIND_LABEL[k])}: ${t(STATE_KEY[f.tests[k]!.state].label)}`] : [])));
  const usedStates = EVIDENCE_STATES.filter((s) => varying.some((f) => TEST_KINDS.some((k) => f.tests[k]?.state === s)));

  // PERMDISP of the selected factor.
  const disp = selected?.dispersion ?? null;
  const pd = selected?.tests.permdisp ?? null;
  const boxRows: BoxRow[] = dist.result ? dist.result.levels.map((l, li) => {
    const ds = dist.result!.distances.filter((_, i) => dist.result!.codes[i] === li);
    return { label: l, n: ds.length, stats: { lo: Math.min(...ds), q1: quantile(ds, 0.25)!, median: quantile(ds, 0.5)!, q3: quantile(ds, 0.75)!, hi: Math.max(...ds) } };
  }) : [];
  const scatter = dist.result && dist.coords && dist.coords[0]!.length >= 2 ? dist.coords.map((c, i) => ({ x: c[0]!, y: c[1]!, level: dist.result!.codes[i]!, label: `#${i + 1}` })) : null;

  return (
    <>
      <FactorChips t={t} factors={varying.map((f) => f.factor)} selected={factor} onSelect={sel.setFactor} />
      <ChartCard title={t("dzPartition")} subtitle={t("dzPartitionSub")}>
        <GroupedBars rows={rows} title={t("dzPartition")} fmt={(v) => pct(v, locale)} axisLabel="R²" onSelect={sel.setFactor} />
        <ChartDataTable locale={locale} caption={t("dzPartition")} columns={[t("dzColFactor"), t("dzBarMarginal"), "df", t("dzBarCells"), t("dzColPartialR2"), "df", t("dzBarAdditive"), t("dzColPartialR2"), "df"]} rows={varying.map((f) => [f.factor, f.r2?.marginal ?? null, f.r2?.dfMarginal ?? null, f.r2?.uniqueGivenCells ?? null, f.r2?.partialGivenCells ?? null, f.r2?.dfGivenCells ?? null, f.r2?.uniqueAdditive ?? null, f.r2?.partialAdditive ?? null, f.r2?.dfAdditive ?? null])} />
        {joint && joint.r2AllCells !== null ? (
          <div className="dz-cells">
            <h5 className="dz-sub">{fill(t("dzCellsBarLabel"), { cells: fmtNum(joint.nCells, locale), df: fmtNum(joint.df, locale) })}</h5>
            <StackedShareBar label={fill(t("dzCellsBarLabel"), { cells: fmtNum(joint.nCells, locale), df: fmtNum(joint.df, locale) })} total={1} showLegend={false} segments={[{ label: t("dzCellsBar"), value: joint.r2AllCells, tone: "teal" }, { label: t("dzCellsRemaining"), value: 1 - joint.r2AllCells, tone: "grey", hatch: true }]} />
            <Legend items={[{ label: t("dzCellsBar"), tone: "teal", value: pct(joint.r2AllCells, locale) }, { label: t("dzCellsRemaining"), kind: "hatch", value: pct(1 - joint.r2AllCells, locale) }]} />
            <p className="hint">{t("dzCellsNote")}</p>
          </div>
        ) : null}
        {drops.length ? <ul className="dz-sentences">{drops.map((s) => <li key={s}>{s}</li>)}</ul> : null}
        <details className="dz-details">
          <summary>{t("dzDefTitle")}</summary>
          <ul className="plain small">
            <li>{t("dzDefMarginal")}</li><li>{t("dzDefCells")}</li><li>{t("dzDefAdditive")}</li><li>{t("dzDefJoint")}</li>
            <li>{fill(t("dzDefDenominator"), { ss: fmtNum(model.partition?.ssTotal, locale) + (model.partition?.ssExponent ? ` × 2^${model.partition.ssExponent}` : ""), unit: model.partition?.unit ?? "—", n: fmtNum(model.nUnitsAnalyzed, locale) })}</li>
            <li>{t("dzDefPartial")}</li>
          </ul>
        </details>
        <p className="hint dz-check">{failed.length ? failed.map(({ f, bad }) => fill(t("dzConsistencyFail"), { factor: f.factor, checks: bad.map((c) => `${c.id}: ${fmtNum(c.observed, locale, 6)} ≠ ${fmtNum(c.expected, locale, 6)}`).join("; ") })).join(" ") : `${t("dzConsistency")} — ${t("dzConsistencyOk")}`}</p>
      </ChartCard>

      <ChartCard title={t("dzEvidence")} subtitle={t("dzEvidenceSub")}>
        <div className="dz-scroll">
          <table className="dz-table dz-matrix">
            <thead><tr><th>{t("dzColFactor")}</th>{TEST_KINDS.map((k) => <th key={k}>{t(KIND_LABEL[k])}</th>)}</tr></thead>
            <tbody>
              {varying.map((f) => (
                <tr key={f.factor} className={f.factor === factor ? "is-selected" : undefined} onClick={() => sel.setFactor(f.factor)}>
                  <th scope="row">{f.factor}</th>
                  {TEST_KINDS.map((k) => <td key={k}><StateChip e={f.tests[k]} t={t} locale={locale} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="dz-states">
          {usedStates.map((s) => <div key={s}><dt><span aria-hidden="true" className={`dz-glyph cz-tone-${STATE_KEY[s].tone}`}>{STATE_KEY[s].glyph}</span> {t(STATE_KEY[s].label)}</dt><dd>{s === "blocked" ? fill(t(STATE_KEY[s].explain), { reason: reason(model.blockedReason) }) : t(STATE_KEY[s].explain)}</dd></div>)}
        </dl>
        <div className="dz-toggle" role="radiogroup" aria-label={t("dzPlot")}>
          {(["holm", "raw", "bh"] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} className={`dz-chip${mode === m ? " is-on" : ""}`} onClick={() => setMode(m)}>{t(m === "holm" ? "dzPlotHolm" : m === "raw" ? "dzPlotRaw" : "dzPlotBh")}</button>)}
        </div>
        {pRows.length ? <PValuePlot rows={pRows} alpha={alpha} title={`${t("dzPlot")} — ${t(mode === "holm" ? "dzPlotHolm" : mode === "raw" ? "dzPlotRaw" : "dzPlotBh")}`} alphaLabel={fill(t("dzPlotAlpha"), { a: alpha ?? "—" })} axisLabel={t("dzPlot")} /> : <EmptyState>{t("dzPlotEmpty")}</EmptyState>}
        {mode === "bh" ? <p className="hint">{t("dzPlotBhNote")}</p> : null}
        {missing.length ? <p className="hint">{fill(t("dzPlotMissing"), { list: missing.join(" · ") })}</p> : null}
        {selected ? (
          <details className="dz-details" open={TEST_KINDS.some((k) => selected.tests[k]?.state === "insufficient_resolution")}>
            <summary>{`${t("dzPlan")} — ${selected.factor}`}</summary>
            <div className="dz-scroll">
              <table className="dz-table">
                <thead><tr><th>{t("dzColTest")}</th><th>{t("dzColRestriction")}</th><th>{t("dzColBlocks")}</th><th>{t("dzColDistinct")}</th><th>{t("dzColDraws")}</th><th>{t("dzColResolution")}</th><th>{t("dzColThreshold")}</th><th>{t("dzColCause")}</th></tr></thead>
                <tbody>
                  {TEST_KINDS.map((k) => {
                    const e = selected.tests[k];
                    const p = e?.plan;
                    if (!e || !p) return null;
                    return (
                      <tr key={k}>
                        <th scope="row" title={p.nullHypothesis ?? undefined}>{t(KIND_LABEL[k])}</th>
                        <td>{p.restrictions === "within_blocks" ? t("dzRestrictWithin") : t("dzRestrictNone")}</td>
                        <td className="num">{p.blockSizes.length > 1 ? `${p.blockSizes.length} (${Math.min(...p.blockSizes)}–${Math.max(...p.blockSizes)})` : p.blockSizes[0] ?? "—"}</td>
                        <td className="num">{p.log10Distinct === null ? "—" : p.log10Distinct > 6 ? `10^${p.log10Distinct.toFixed(1)}` : fmtNum(Math.round(10 ** p.log10Distinct), locale)}</td>
                        <td className="num">{`${fmtNum(p.executed, locale)} / ${fmtNum(p.requested, locale)}`}</td>
                        <td className="num">{fmtNum(p.resolution, locale)}</td>
                        <td className="num">{fmtNum(p.threshold, locale)}</td>
                        <td>{p.resolutionCause ? t(causeKey[p.resolutionCause]) : e.state === "insufficient_resolution" ? "—" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="plain small">
              {TEST_KINDS.map((k) => selected.tests[k]?.plan?.nullHypothesis ? <li key={k}><strong>{t(KIND_LABEL[k])}</strong> — {t("dzPlanNull")}: {selected.tests[k]!.plan!.nullHypothesis}{selected.tests[k]!.plan!.seed ? ` (${fill(t("dzPlanSeed"), { seed: selected.tests[k]!.plan!.seed! })})` : ""}</li> : null)}
            </ul>
          </details>
        ) : null}
        {original ? <details className="dz-details"><summary>{t("dzOriginal")}</summary>{original}</details> : null}
      </ChartCard>

      {selected ? (
        <ChartCard title={`${t("dzPermdisp")} — ${selected.factor}`} subtitle={t("dzPermdispLead")} footnote={dist.state === "ok" ? t("dzLocalProvenance") : undefined}>
          {pd ? <p className="dz-verdict"><StateChip e={pd} t={t} locale={locale} />{pd.state === "significant" ? <span> {t("dzPermdispSig")}</span> : null}</p> : null}
          {disp && disp.state.status === "computed" ? (
            <div className="grid-2">
              <ValueBars title={t("dzMeanDistances")} unit="" axisLabel={t("dzDistancesAxis")} rows={disp.levels.map((l, i) => ({ label: `${l.level} (n = ${l.nUnits ?? "—"})`, value: l.meanDistance, tone: levelStyle(i).tone }))} />
              <div>
                {dist.state === "ok" ? <BoxPlotRows title={t("dzDistances")} rows={boxRows} axisLabel={t("dzDistancesAxis")} whiskerLabel="min–max" />
                  : dist.state === "loading" ? <p className="note" role="status">{t("dzLocalLoading")}</p>
                  : dist.state === "no_scores" ? <EmptyState>{t("dzLocalNoScores")}</EmptyState>
                  : dist.state === "mismatch" ? <EmptyState>{fill(t("dzLocalMismatch"), { reason: dist.reason ?? "—" })}</EmptyState> : null}
              </div>
            </div>
          ) : <EmptyState>{fill(t("dzDispersionNone"), { factor: selected.factor, reason: reason(disp?.state.reasonCode) })}</EmptyState>}
          {scatter ? (
            <>
              <h5 className="dz-sub">{t("dzSpread")}</h5>
              <p className="hint">{t("dzSpreadSub")}</p>
              <UnitScatter points={scatter} levels={dist.result!.levels} selected={sel.level} title={`${t("dzSpread")} — ${selected.factor}`} xLabel="PC1" yLabel="PC2" />
            </>
          ) : null}
        </ChartCard>
      ) : null}
    </>
  );
}
