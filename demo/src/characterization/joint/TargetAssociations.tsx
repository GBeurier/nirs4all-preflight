// Metadata and target (spec §7): η² of categorical metadata, Spearman ρ of continuous metadata (separate axis),
// other measures for categorical targets, p-values, and the per-factor target distributions. Engine values only,
// except the per-unit points, rebuilt locally from development references and shown only when the local unit count
// equals the engine's (interim; debt: docs/implementation/debt/characterization-joint.md).
import { useMemo, useState } from "react";
import { formatEngineNumber, reasonLabel, type QualificationReportView } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";
import { fill } from "../../i18n";
import type { EngineInput } from "../../input";
import type { Scope } from "../../Sections";
import { BoxPlotRows, ChartCard, EmptyState } from "../shared/charts";
import { effectiveFactor, useDesignSelection } from "../design/selection";
import { EffectBars, GroupEcdf, GroupStrip, PValueDots, TrendScatter, type EffectRow, type GroupPoints, type ScatterDatum } from "./charts";
import { ETA_LANDMARKS } from "./interpret";
import { associationFamily, associationResults, isEtaOfCategorical, type AssociationResult } from "./model";
import { associationRows, metadataFactors, metadataValue, targetUnits, type AssociationRows } from "./units";
import "./joint.css";

type T = Scope["t"];

export const useFmt = (locale: Locale) => useMemo(() => (v: number) => formatEngineNumber(v, locale, 3) ?? "—", [locale]);
const pct = (v: number, locale: Locale) => `${(100 * v).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;

const measureSymbol: Record<string, string> = { eta_squared: "η²", spearman_rho: "ρ", cramers_v: "V", other: "effect" };

/** Tooltip of one association: effect, statistic and df, levels and units, p-values, population (§7, §11). */
export function associationTooltip(a: AssociationResult, t: T, fmt: (v: number) => string, locale: Locale): string {
  const parts = [`${a.metadata} × ${a.targetId}`];
  if (a.effect !== null) parts.push(`${measureSymbol[a.measure]} = ${fmt(a.effect)}${a.measure === "eta_squared" ? ` (${pct(a.effect, locale)})` : ""}`);
  else parts.push(`${t("jtStatus")}: ${a.reasonCode ? reasonLabel(a.reasonCode) : a.status}`);
  if (a.statistic !== null && a.statisticName && a.statisticName !== a.measure) parts.push(`${a.statisticName} = ${fmt(a.statistic)}`);
  if (a.df1 !== null || a.df2 !== null) parts.push(`df1 = ${a.df1 ?? "—"}, df2 = ${a.df2 ?? "—"}`);
  if (a.nLevels !== null) parts.push(`n_levels = ${a.nLevels}`);
  const per = a.levels.length ? a.levels : a.classes.map((c) => ({ level: c.label, nUnits: c.nUnits }));
  if (per.length) parts.push(`n_units: ${per.map((l) => `${l.level} ${l.nUnits ?? "—"}`).join(", ")}`);
  if (a.measure === "spearman_rho" && a.pearsonR !== null) parts.push(`Pearson r = ${fmt(a.pearsonR)} (descriptive)`);
  if (a.test) parts.push(`${t("jtPRaw")} ${a.test.pRaw === null ? "—" : fmt(a.test.pRaw)}, ${t("jtPHolm")} ${a.test.pHolm === null ? "—" : fmt(a.test.pHolm)}, ${t("jtPBh")} ${a.test.pBh === null ? "—" : fmt(a.test.pBh)}`);
  else if (a.joinMismatch) parts.push("test withheld: different population or model");
  parts.push(`${a.populationId} · ${a.denominators.n_units_analyzed ?? "—"} / ${a.denominators.n_independence_units ?? "—"} units (${a.analysisUnit ?? "—"})`);
  if (a.consistent === false) parts.push(t("jtFMismatch"));
  return parts.join("\n");
}

function effectRow(a: AssociationResult, t: T, fmt: (v: number) => string, locale: Locale, selected: string | null): EffectRow {
  const ok = a.status === "computed" && a.effect !== null;
  return {
    id: a.metadata,
    label: a.metadata,
    sub: `${a.denominators.n_units_analyzed ?? "—"} ${t("jtUnits").toLowerCase()}${a.test?.pHolm !== null && a.test?.pHolm !== undefined ? ` · ${t("jtPHolm")} ${fmt(a.test.pHolm)}` : ""}`,
    value: ok ? a.effect : null,
    missing: ok ? undefined : a.reasonCode ? reasonLabel(a.reasonCode) : a.status.replace(/_/g, " "),
    tooltip: associationTooltip(a, t, fmt, locale),
    selected: a.metadata === selected,
  };
}

/** Local per-unit rows of one pair, kept only when they reproduce the engine's analysed-unit count. */
export function localRows(input: EngineInput, a: AssociationResult): { rows: AssociationRows | null; local: number | null } {
  const units = targetUnits(input, a.targetId);
  const factor = metadataFactors(input).find((f) => f.name === a.metadata);
  if (!units || !factor) return { rows: null, local: null };
  const rows = associationRows(input, units, factor);
  const engine = a.denominators.n_units_analyzed;
  return { rows: engine === rows.rows.length ? rows : null, local: rows.rows.length };
}

export function FactorTargetDetail({ a, input, t, locale }: { a: AssociationResult; input: EngineInput; t: T; locale: Locale }) {
  const fmt = useFmt(locale);
  const [trend, setTrend] = useState(true);
  const [colorBy, setColorBy] = useState<string>("");
  const local = useMemo(() => localRows(input, a), [input, a]);
  const catFactors = useMemo(() => metadataFactors(input).filter((f) => f.kind === "categorical"), [input]);
  const samples = useMemo(() => new Map(input.samples.map((s) => [s.sample_id, s])), [input]);
  const yUnit = a.targetUnit ? ` (${a.targetUnit})` : "";
  const xUnit = a.metadataUnit ? ` (${a.metadataUnit})` : "";
  const rows = local.rows?.rows ?? null;
  const tipOf = (ids: readonly string[], v: string) => `${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}: ${v}`;
  const provenance = local.rows ? <p className="jt-provenance">{t("jtLocalRows")}</p> : local.local !== null ? <p className="jt-provenance">{fill(t("jtLocalMismatch"), { local: local.local, engine: a.denominators.n_units_analyzed ?? "—" })}</p> : null;

  if (a.status !== "computed") return <EmptyState>{`${a.metadata}: ${a.reasonCode ? reasonLabel(a.reasonCode) : a.status}`}</EmptyState>;

  // Categorical metadata, continuous target: per-level distributions and coverage.
  if (a.metadataKind === "categorical" && a.levels.some((l) => l.target)) {
    const groups: GroupPoints[] = a.levels.map((l) => {
      const mine = (rows ?? []).filter((r) => r.metadata.kind === "level" && r.metadata.level === l.level && r.target.kind === "value");
      return { id: l.level, label: l.level, values: mine.map((r) => (r.target as { value: number }).value), tips: mine.map((r) => tipOf(r.sampleIds, fmt((r.target as { value: number }).value))) };
    });
    return (
      <div className="jt-stack">
        <div className="jt-grid-2">
          <ChartCard title={fill(t("jtDistTitle"), { factor: a.metadata })} subtitle={`${a.targetId}${yUnit}`}>
            {rows ? <GroupStrip groups={groups} axisLabel={`${a.targetId}${yUnit}`} title={fill(t("jtDistTitle"), { factor: a.metadata })} fmt={fmt} /> : (
              <BoxPlotRows title={fill(t("jtDistTitle"), { factor: a.metadata })} whiskerLabel="min–max" axisLabel={`${a.targetId}${yUnit}`} fmt={fmt}
                rows={a.levels.flatMap((l) => (l.target && l.target.min !== null && l.target.q25 !== null && l.target.median !== null && l.target.q75 !== null && l.target.max !== null ? [{ label: l.level, n: l.nUnits ?? undefined, stats: { lo: l.target.min, q1: l.target.q25, median: l.target.median, q3: l.target.q75, hi: l.target.max } }] : []))} />
            )}
            {provenance}
          </ChartCard>
          {rows ? (
            <ChartCard title={fill(t("jtEcdfTitle"), { factor: a.metadata })} subtitle={`${a.targetId}${yUnit}`}>
              <GroupEcdf groups={groups} axisLabel={`${a.targetId}${yUnit}`} title={fill(t("jtEcdfTitle"), { factor: a.metadata })} fmt={fmt} />
            </ChartCard>
          ) : null}
        </div>
        <ChartCard title={t("jtCoverageTitle")} subtitle={`${a.targetId}${yUnit} · ${a.populationId}`}>
          <div className="jt-table-wrap">
            <table className="jt-table">
              <thead><tr><th>{t("jtLevel")}</th><th className="num">{t("jtUnits")}</th><th className="num">min</th><th className="num">Q1</th><th className="num">median</th><th className="num">Q3</th><th className="num">max</th><th className="num">mean</th><th className="num">SD</th></tr></thead>
              <tbody>{a.levels.map((l) => (
                <tr key={l.level}><td>{l.level}</td><td className="num">{l.nUnits ?? "—"}</td>{[l.target?.min, l.target?.q25, l.target?.median, l.target?.q75, l.target?.max, l.target?.mean, l.target?.sd].map((v, i) => <td key={i} className="num">{v === null || v === undefined ? "—" : fmt(v)}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        </ChartCard>
      </div>
    );
  }

  // Categorical metadata, categorical target: class counts per level (engine).
  if (a.metadataKind === "categorical") {
    const classes = [...new Set(a.levels.flatMap((l) => Object.keys(l.classCounts ?? {})))].sort();
    return (
      <ChartCard title={fill(t("jtClassTitle"), { factor: a.metadata })} subtitle={`${a.targetId} · ${a.populationId}`}>
        <div className="jt-table-wrap">
          <table className="jt-table">
            <thead><tr><th>{t("jtLevel")}</th><th className="num">{t("jtUnits")}</th>{classes.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
            <tbody>{a.levels.map((l) => <tr key={l.level}><td>{l.level}</td><td className="num">{l.nUnits ?? "—"}</td>{classes.map((c) => <td key={c} className="num">{l.classCounts?.[c] ?? 0}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </ChartCard>
    );
  }

  // Continuous metadata, categorical target: metadata distribution per class.
  if (a.classes.length) {
    const groups: GroupPoints[] = a.classes.map((c) => {
      const mine = (rows ?? []).filter((r) => r.target.kind === "class" && r.target.label === c.label && r.metadata.kind === "value");
      return { id: c.label, label: c.label, values: mine.map((r) => (r.metadata as { value: number }).value), tips: mine.map((r) => tipOf(r.sampleIds, fmt((r.metadata as { value: number }).value))) };
    });
    return (
      <ChartCard title={fill(t("jtDistTitle"), { factor: a.targetId })} subtitle={`${a.metadata}${xUnit}`}>
        {rows ? <GroupStrip groups={groups} axisLabel={`${a.metadata}${xUnit}`} title={fill(t("jtDistTitle"), { factor: a.targetId })} fmt={fmt} /> : (
          <BoxPlotRows title={fill(t("jtDistTitle"), { factor: a.targetId })} whiskerLabel="min–max" axisLabel={`${a.metadata}${xUnit}`} fmt={fmt}
            rows={a.classes.flatMap((c) => (c.metadata && c.metadata.min !== null && c.metadata.q25 !== null && c.metadata.median !== null && c.metadata.q75 !== null && c.metadata.max !== null ? [{ label: c.label, n: c.nUnits ?? undefined, stats: { lo: c.metadata.min, q1: c.metadata.q25, median: c.metadata.median, q3: c.metadata.q75, hi: c.metadata.max } }] : []))} />
        )}
        {provenance}
      </ChartCard>
    );
  }

  // Continuous metadata, continuous target: scatter with an optional descriptive trend line.
  const color = catFactors.find((f) => f.name === colorBy) ?? null;
  const points: ScatterDatum[] = (rows ?? []).flatMap((r) => {
    if (r.metadata.kind !== "value" || r.target.kind !== "value") return [];
    const levels = color ? new Set(r.sampleIds.map((id) => { const v = metadataValue(input, color, samples.get(id)!); return v?.kind === "level" ? v.level : null; })) : null;
    const group = levels && levels.size === 1 ? [...levels][0]! : null;
    return [{ x: r.metadata.value, y: r.target.value, group, tip: tipOf(r.sampleIds, `${a.metadata} ${fmt(r.metadata.value)}, ${a.targetId} ${fmt(r.target.value)}${group ? `, ${color!.name} ${group}` : ""}`) }];
  });
  return (
    <ChartCard title={fill(t("jtScatterTitle"), { factor: a.metadata })} subtitle={`ρ = ${a.effect === null ? "—" : fmt(a.effect)}${a.pearsonR !== null ? ` · Pearson r = ${fmt(a.pearsonR)}` : ""}`}
      actions={rows ? (
        <div className="jt-controls">
          <label><input type="checkbox" checked={trend} onChange={(e) => setTrend(e.target.checked)} /> {t("jtTrend")}</label>
          {catFactors.length ? <label>{t("jtColorBy")} <select value={colorBy} onChange={(e) => setColorBy(e.target.value)}><option value="">{t("jtNone")}</option>{catFactors.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}</select></label> : null}
        </div>
      ) : undefined}>
      {rows ? <TrendScatter points={points} xLabel={`${a.metadata}${xUnit}`} yLabel={`${a.targetId}${yUnit}`} title={fill(t("jtScatterTitle"), { factor: a.metadata })} trend={trend} fmt={fmt} /> : null}
      {provenance}
    </ChartCard>
  );
}

export function TargetAssociations({ scope }: { scope: Scope }) {
  const { t, locale, view, input } = scope;
  const fmt = useFmt(locale);
  const all = useMemo(() => associationResults(view, null), [view]);
  const family = useMemo(() => associationFamily(view), [view]);
  const [landmarks, setLandmarks] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const selection = useDesignSelection();
  const targets = [...new Set(all.map((a) => a.targetId))];
  const targetId = picked && targets.includes(picked) ? picked : scope.targetId && targets.includes(scope.targetId) ? scope.targetId : (targets[0] ?? null);
  const rows = all.filter((a) => a.targetId === targetId);
  const factor = effectiveFactor(selection.factor, rows.map((a) => a.metadata));
  const current = rows.find((a) => a.metadata === factor) ?? null;
  if (!input.targets.length) return <EmptyState>{t("jtNoTarget")}</EmptyState>;
  if (!rows.length) return <EmptyState>{t("jtNoRows")}</EmptyState>;
  const eta = rows.filter(isEtaOfCategorical);
  const rho = rows.filter((a) => a.measure === "spearman_rho");
  const other = rows.filter((a) => !isEtaOfCategorical(a) && a.measure !== "spearman_rho");
  const select = (id: string) => selection.setFactor(id);
  const first = (current?.status === "computed" ? current : rows.find((a) => a.status === "computed")) ?? rows[0]!;
  return (
    <div className="jt-stack">
      <div className="jt-controls">
        {targets.length > 1 ? <label>{t("jtTarget")} <select value={targetId ?? ""} onChange={(e) => setPicked(e.target.value)}>{targets.map((id) => <option key={id} value={id}>{id}</option>)}</select></label> : null}
        <p className="jt-pop">{fill(t("jtPopulation"), { pop: first.populationId, n: first.denominators.n_units_analyzed ?? "—", total: first.denominators.n_independence_units ?? "—", unit: first.analysisUnit ?? "—" })}</p>
      </div>
      <div className="jt-grid-2">
        {eta.length ? (
          <ChartCard title={t("jtEtaTitle")} subtitle={t("jtEtaSub")} footnote={landmarks ? t("jtLandmarksNote") : undefined}>
            <label className="jt-controls"><input type="checkbox" checked={landmarks} onChange={(e) => setLandmarks(e.target.checked)} /> {t("jtLandmarks")}</label>
            <EffectBars rows={eta.map((a) => effectRow(a, t, fmt, locale, factor))} domain={[0, 1]} fmt={(v) => `${fmt(v)} · ${pct(v, locale)}`} landmarks={landmarks ? ETA_LANDMARKS : undefined} axisLabel={`η² (${targetId})`} title={t("jtEtaTitle")} onSelect={select} />
          </ChartCard>
        ) : null}
        {rho.length ? (
          <ChartCard title={t("jtRhoTitle")} subtitle={t("jtRhoSub")}>
            <EffectBars rows={rho.map((a) => effectRow(a, t, fmt, locale, factor))} domain={[-1, 1]} fmt={fmt} axisLabel={`Spearman ρ (${targetId})`} title={t("jtRhoTitle")} onSelect={select} />
          </ChartCard>
        ) : null}
        {other.length ? (
          <ChartCard title={t("jtOtherTitle")} subtitle={t("jtOtherSub")}>
            <EffectBars rows={other.map((a) => ({ ...effectRow(a, t, fmt, locale, factor), label: `${a.metadata} (${measureSymbol[a.measure]})` }))} domain={[0, 1]} fmt={fmt} axisLabel={t("jtEffect")} title={t("jtOtherTitle")} onSelect={select} />
          </ChartCard>
        ) : null}
        {rows.some((a) => a.test) ? (
          <ChartCard title={t("jtPValues")} subtitle={fill(t("jtPSub"), { n: family?.size ?? "—", alpha: family?.alpha ?? "—" })}>
            <PValueDots rows={rows.map((a) => ({ id: a.metadata, label: a.metadata, raw: a.test?.pRaw ?? null, adjusted: a.test?.pHolm ?? null, missing: a.test ? (a.test.reasonCode ? reasonLabel(a.test.reasonCode) : a.test.status.replace(/_/g, " ")) : "—" }))} alpha={family?.alpha ?? null} title={t("jtPValues")} labels={{ raw: t("jtShowRaw"), adjusted: t("jtShowAdjusted"), axis: "p (log)" }} />
          </ChartCard>
        ) : null}
      </div>
      {current ? <div className="jt-detail"><FactorTargetDetail key={`${current.targetId}|${current.metadata}`} a={current} input={input} t={t} locale={locale} /></div> : null}
    </div>
  );
}

/** Association results of one target, for other sections (joint landscape). */
export const targetAssociations = (view: QualificationReportView, targetId: string | null) => associationResults(view, null).filter((a) => targetId === null || a.targetId === targetId);
