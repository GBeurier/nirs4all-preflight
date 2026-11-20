// Validation scenario audit (spec §10): candidate splits generated from the declared metadata and the independence
// units of the development partition, described fold by fold. No scenario is ranked, recommended or called
// unsuitable; retained-test rows are never used (construction) and their target values are never read (coverage).
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Locale } from "nirs4all-ui/lab";
import { fill } from "../../i18n";
import { Section, type Scope } from "../../Sections";
import { ChartCard, EmptyState } from "../shared/charts";
import { spectralTask } from "./host";
import { auditFold, candidateScenarios, customScenario, scenarioBase, scenarioTargets, MAX_FOLDS, type CustomDomain, type FoldAudit, type LevelGap, type Scenario, type ScenarioBase } from "./scenarios";
import type { FoldSpectral } from "./spectralShift";
import { useFmt } from "./TargetAssociations";
import "./joint.css";

type T = Scope["t"];
const pct = (v: number, locale: Locale) => `${(100 * v).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
const gapText = (gaps: readonly LevelGap[]) => gaps.map((g) => `${g.factor} (${g.levels.slice(0, 6).join(", ")}${g.levels.length > 6 ? ` +${g.levels.length - 6}` : ""})`).join("; ");

export function scenarioLabel(s: Scenario, t: T): string {
  switch (s.kind) {
    case "grouped_cv": return fill(t("jtScCv"), { k: s.folds.length });
    case "leave_level_out": return fill(t("jtScLolo"), { factor: s.factors[0]! });
    case "interval": return fill(t("jtScInterval"), { factor: s.factors[0]! });
    case "combination": return fill(t("jtScCombo"), { a: s.factors[0]!, b: s.factors[1]! });
    case "custom": return `${t("jtScCustom")} (${s.factors[0]})`;
  }
}

/** Parameterized flag of a fold holding out entire levels of other factors (never a verdict on the scenario). */
export function simultaneousMessage(s: Scenario, a: FoldAudit, t: T): string | null {
  if (!a.simultaneous.length) return null;
  const others = gapText(a.simultaneous);
  return s.factors.length ? fill(t("jtScSimultaneous"), { heldOut: a.fold.heldOut, others, factor: s.factors.join(" × ") }) : fill(t("jtScSimultaneousFold"), { heldOut: a.fold.heldOut, others });
}

export function targetMessage(a: FoldAudit, t: T, fmt: (v: number) => string): string | null {
  const c = a.target;
  if (c.kind === "continuous" && c.nOutside > 0) return fill(t("jtScExtrapolation"), { n: c.nOutside, m: c.nValUnits, lo: fmt(c.devRange[0]), hi: fmt(c.devRange[1]) });
  if (c.kind === "categorical" && c.absentFromDev.length) return fill(t("jtScClassesAbsent"), { classes: c.absentFromDev.join(", ") });
  return null;
}

function CustomForm({ base, t, onApply }: { base: ScenarioBase; t: T; onApply: (d: CustomDomain) => void }) {
  const factors = [...base.categorical, ...base.continuous];
  const [name, setName] = useState(factors[0]?.name ?? "");
  const factor = factors.find((f) => f.name === name) ?? null;
  const levels = useMemo(() => (factor?.kind === "categorical" ? [...new Set(base.units.map((u) => u.levels[factor.name]).filter((v): v is string => !!v))].sort() : []), [base, factor]);
  const values = useMemo(() => (factor?.kind === "continuous" ? base.units.map((u) => u.values[factor.name]).filter((v): v is number => v !== null && v !== undefined) : []), [base, factor]);
  const [picked, setPicked] = useState<string[]>([]);
  const [lo, setLo] = useState<string>("");
  const [hi, setHi] = useState<string>("");
  if (!factor) return null;
  const apply = () => {
    if (factor.kind === "categorical") onApply({ factor: factor.name, kind: "categorical", levels: picked });
    else onApply({ factor: factor.name, kind: "continuous", lo: lo === "" ? Math.min(...values) : Number(lo), hi: hi === "" ? Math.max(...values) : Number(hi) });
  };
  return (
    <details className="jt-detail">
      <summary>{t("jtScCustomTitle")}</summary>
      <div className="jt-controls" style={{ marginTop: 8 }}>
        <label>{t("jtFactor")} <select value={name} onChange={(e) => { setName(e.target.value); setPicked([]); setLo(""); setHi(""); }}>{factors.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}</select></label>
        {factor.kind === "categorical" ? (
          <fieldset className="jt-chips" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="jt-provenance">{t("jtScCustomLevels")}</legend>
            {levels.map((l) => <label key={l} className="jt-chip"><input type="checkbox" checked={picked.includes(l)} onChange={(e) => setPicked(e.target.checked ? [...picked, l] : picked.filter((x) => x !== l))} /> {l}</label>)}
          </fieldset>
        ) : (
          <>
            <label>{t("jtScFrom")} <input type="number" value={lo} placeholder={String(Math.min(...values))} onChange={(e) => setLo(e.target.value)} /></label>
            <label>{t("jtScTo")} <input type="number" value={hi} placeholder={String(Math.max(...values))} onChange={(e) => setHi(e.target.value)} /></label>
          </>
        )}
        <button type="button" className="btn btn-sm btn-primary" disabled={factor.kind === "categorical" && !picked.length} onClick={apply}>{t("jtScApply")}</button>
      </div>
    </details>
  );
}

type SpectralState = { id: string; result: (FoldSpectral | { error: string })[] | null; error: string | null };

export function ScenarioAuditSection(scope: Scope) {
  const { t, locale, input, sourceId, targetId } = scope;
  const fmt = useFmt(locale);
  const base = useMemo(() => (sourceId ? scenarioBase(input, sourceId) : null), [input, sourceId]);
  const candidates = useMemo(() => (base ? candidateScenarios(input, base, fmt) : []), [input, base, fmt]);
  const [custom, setCustom] = useState<Scenario | null>(null);
  const [customEmpty, setCustomEmpty] = useState(false);
  const scenarios = useMemo(() => (custom ? [...candidates, custom] : candidates), [candidates, custom]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scenario = scenarios.find((s) => s.id === selectedId) ?? scenarios[0] ?? null;
  const targets = useMemo(() => scenarioTargets(input, targetId), [input, targetId]);
  const audits = useMemo(() => (base && scenario ? scenario.folds.map((f) => auditFold(base, scenario, f, targets.labels, targets.kind)) : []), [base, scenario, targets]);
  const [spectral, setSpectral] = useState<SpectralState | null>(null);
  const key = scenario ? `${scenario.id}|${scenario.folds.map((f) => f.heldOut).join(",")}` : "";

  useEffect(() => {
    if (!base || !scenario) return;
    let live = true;
    setSpectral({ id: key, result: null, error: null });
    spectralTask({ spectra: base.spectra, folds: scenario.folds.map((f) => ({ development: f.development, validation: f.validation })) })
      .then((result) => { if (live) setSpectral({ id: key, result, error: null }); })
      .catch((e: unknown) => { if (live) setSpectral({ id: key, result: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [base, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sourceId) return null;
  if (!base || !scenario) {
    return <Section id="s-scenarios" icon="flow" accent="indigo" title={t("jtScTitle")} lead={t("jtScLead")}><EmptyState>{t("jtScNone")}</EmptyState></Section>;
  }
  const sp = spectral?.id === key ? spectral : null;
  const spec = (i: number): FoldSpectral | null => { const r = sp?.result?.[i]; return r && !("error" in r) ? r : null; };
  const specCell = (i: number, pick: (s: FoldSpectral) => string | null) => {
    if (!sp || (!sp.result && !sp.error)) return "…";
    const r = sp.result?.[i];
    if (!r) return sp.error ? "—" : "…";
    if ("error" in r) return <span title={r.error}>—</span>;
    return pick(r) ?? <span title={r.note ?? ""}>—</span>;
  };
  return (
    <Section id="s-scenarios" icon="flow" accent="indigo" title={t("jtScTitle")} lead={t("jtScLead")}>
      <div className="jt-stack">
        <div className="jt-controls">
          <label>{t("jtScScenario")} <select value={scenario.id} onChange={(e) => setSelectedId(e.target.value)}>{scenarios.map((s) => <option key={s.id} value={s.id}>{scenarioLabel(s, t)}</option>)}</select></label>
          <span>{t("jtScNotRanked")}</span>
        </div>
        {!base.categorical.length && !base.continuous.length ? <p className="jt-provenance">{t("jtScOnlyCv")}</p> : null}
        <CustomForm base={base} t={t} onApply={(d) => { const s = customScenario(base, d, fmt); setCustomEmpty(!s); if (s) { setCustom(s); setSelectedId(s.id); } }} />
        {customEmpty ? <p className="jt-provenance" role="status">{t("jtScCustomEmpty")}</p> : null}
        <ChartCard title={scenarioLabel(scenario, t)} subtitle={[scenario.unassigned ? fill(t("jtScUnassigned"), { n: scenario.unassigned }) : null, scenario.omitted ? fill(t("jtScOmitted"), { n: scenario.omitted, cap: MAX_FOLDS }) : null].filter(Boolean).join(" ") || undefined}
          footnote={<>{targets.kind ? t("jtScTargetProtected") : t("jtScNoTarget")} {t("jtScSpectralNote")}</>}>
          {sp && !sp.result && !sp.error ? <p className="note" role="status">{t("jtScComputing")}</p> : null}
          <div className="jt-table-wrap">
            <table className="jt-table">
              <thead>
                <tr>
                  <th>{t("jtScHeldOut")}</th><th className="num">{t("jtScDev")}</th><th className="num">{t("jtScVal")}</th>
                  {audits[0]?.groupSizes.length ? <th>{t("jtScGroups")}</th> : null}
                  <th>{t("jtScAbsentDev")}</th><th>{t("jtScAbsentVal")}</th>
                  <th className="num">{t("jtScCells")}</th><th className="num">{t("jtScUnseen")}</th>
                  <th className="num">{t("jtScCentre")}</th><th className="num">{t("jtScDisp")}</th><th className="num">{t("jtScCover")}</th>
                  <th title={t("jtScTargetHint")}>{t("jtScTarget")}</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a, i) => {
                  const sim = simultaneousMessage(scenario, a, t);
                  const tm = targetMessage(a, t, fmt);
                  const c = a.target;
                  const s = spec(i);
                  const cols = 11 + (audits[0]?.groupSizes.length ? 1 : 0);
                  return (
                    <Fragment key={a.fold.id}>
                    <tr className={sim || tm ? "jt-has-flags" : undefined}>
                      <td><strong>{a.fold.heldOut}</strong></td>
                      <td className="num">{a.nDev}</td>
                      <td className="num">{a.nVal}</td>
                      {audits[0]?.groupSizes.length ? <td>{a.groupSizes.map((g) => `${g.factor}: ${g.dev.map((x) => `${x.level} ${x.n}`).join(", ") || "—"} | ${g.val.map((x) => `${x.level} ${x.n}`).join(", ") || "—"}`).join("; ")}</td> : null}
                      <td>{gapText(a.absentFromDev) || "—"}</td>
                      <td>{gapText(a.absentFromVal) || "—"}</td>
                      <td className="num">{a.cells.total ? `${a.cells.inDev} / ${a.cells.total} (${pct(a.cells.inDev / a.cells.total, locale)})` : "—"}</td>
                      <td className="num">{a.cells.total ? `${a.cells.valUnseen} / ${a.cells.val}` : "—"}</td>
                      <td className="num">{specCell(i, (r) => (r.centreShift === null ? null : fmt(r.centreShift)))}</td>
                      <td className="num">{specCell(i, (r) => (r.dispersionRatio === null ? null : fmt(r.dispersionRatio)))}</td>
                      <td className="num">{specCell(i, (r) => (r.coverage === null ? null : `${pct(r.coverage, locale)}${r.nBeyondEither !== null ? ` (${a.nVal - r.nBeyondEither} / ${a.nVal})` : ""}`))}{s?.components ? <span className="jt-sub" title="PCA components"> k={s.components}</span> : null}</td>
                      <td>
                        {c.kind === "continuous" ? `${t("jtScValAbbr")} ${c.valRange ? `${fmt(c.valRange[0])} – ${fmt(c.valRange[1])}` : "—"} · ${t("jtScDevAbbr")} ${fmt(c.devRange[0])} – ${fmt(c.devRange[1])}` : c.kind === "categorical" ? `${c.nValUnits} ${t("jtUnits").toLowerCase()}` : "—"}
                      </td>
                    </tr>
                    {sim || tm ? <tr className="jt-flag-row"><td colSpan={cols}>{sim ? <span className="jt-flag">{sim}</span> : null}{tm ? <span className="jt-flag">{tm}</span> : null}</td></tr> : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
    </Section>
  );
}
