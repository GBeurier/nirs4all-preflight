import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Locale } from "nirs4all-ui/lab";
import { buildQualificationReportView, evidenceCsv, reportSourceIds, reportTargetIds } from "nirs4all-ui/qualification";
import { baseName, type Origin, type Result, type Run, type T } from "./App";
import { buildChecks, needsReview } from "./checks";
import { DataView } from "./DataView";
import { downloadText } from "./download";
import type { EngineValidation } from "./engine";
import { fill, type TextKey } from "./i18n";
import { Icon, type IconName } from "./icons";
import { countIndependenceGroups, defaultConfig, parseSeed, type AnalysisConfig, type EngineInput, type IndependenceUnit } from "./input";
import { DECLARABLE_REPETITIONS, type RepetitionDeclaration } from "./dataset";
import { AssociationSection, ClusteringSection, ConfoundingSection, DomainShiftSection, DuplicatesSection, ProbeSection, SensitivitySection, SpectralQualitySection, presentSections } from "./Blocks";
import { CapabilitiesSection, DiagnosisSummary, EvidenceSection, PopulationsSection, RepeatSection, Section, StructureSection, TargetSection, TechnicalSection, type Scope } from "./Sections";

type View = "data" | "diagnosis" | "evidence" | "export";
const UNITS: readonly IndependenceUnit[] = ["unknown", "sample", "reference_group", "group"];
const DIAG_LINKS: readonly { id: string; label: TextKey }[] = [
  { id: "s-populations", label: "navPopulations" },
  { id: "s-structure", label: "navStructure" },
  { id: "s-repeat", label: "navRepeat" },
  { id: "s-target", label: "navTarget" },
];

/** One line per issue code: an input can repeat the same issue on thousands of values. */
function issueGroups(validation: EngineValidation) {
  const groups = new Map<string, { code: string; message: string; blocking: boolean; paths: string[] }>();
  for (const issue of validation.issues) {
    const group = groups.get(issue.code) ?? { code: issue.code, message: issue.message, blocking: false, paths: [] };
    group.blocking ||= issue.blocking;
    group.paths.push(issue.path);
    groups.set(issue.code, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/** Diagnosis sections in display order; the menu lists those present in the report. */
const DIAG_ORDER = ["s-overview", "s-populations", "s-quality", "s-duplicates", "s-structure", "s-sensitivity", "s-clustering", "s-repeat", "s-target", "s-association", "s-confounding", "s-shift", "s-probe"];
const diagMenu = (scope: Scope): { id: string; label: TextKey }[] =>
  [{ id: "s-overview", label: "diagTitle" as TextKey }, ...DIAG_LINKS, ...presentSections(scope)].sort((a, b) => DIAG_ORDER.indexOf(a.id) - DIAG_ORDER.indexOf(b.id));

/** Sticky left menu of the diagnosis sections; the section in view is highlighted. */
function DiagnosisMenu({ t, items }: { t: T; items: { id: string; label: TextKey }[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const side = useRef<HTMLElement>(null);
  const ids = items.map((i) => i.id).join(" ");
  useEffect(() => {
    // Horizontal bar on narrow screens: keep the current section's link in view.
    const bar = side.current;
    const link = bar?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (bar && link && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = link.offsetLeft - 16;
  }, [active]);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-25% 0px -65% 0px" });
    for (const id of ids.split(" ")) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return (
    <aside className="diag-side" ref={side}>
      <nav aria-label={t("diagCharts")}>
        <p className="diag-side-title">{t("diagCharts")}</p>
        <ol>
          {items.map((item) => (
            <li key={item.id}><a href={`#${item.id}`} aria-current={active === item.id ? "location" : undefined}>{t(item.label)}</a></li>
          ))}
        </ol>
      </nav>
    </aside>
  );
}

/** Which journey step owns an in-page anchor. */
function viewOf(anchor: string): View | null {
  if (anchor.startsWith("ev-") || anchor === "s-evidence" || anchor === "s-capabilities") return "evidence";
  if (anchor.startsWith("data-")) return "data";
  if (anchor.startsWith("s-")) return "diagnosis";
  if (anchor === "export") return "export";
  return null;
}

interface WorkspaceProps {
  t: T;
  locale: Locale;
  input: EngineInput;
  origin: Origin;
  config: AnalysisConfig;
  onConfig: (c: AnalysisConfig) => void;
  run: Run;
  result: Result | null;
  validation: EngineValidation | null;
  htmlError: string | null;
  onRun: () => void;
  onCancel: () => void;
  onDownloadHtml: () => void;
  /** Re-imports the dropped files with this repetition column; absent when the files are not in memory. */
  onRepetition?: (repetition: RepetitionDeclaration | undefined) => void;
}

const sameConfig = (a: AnalysisConfig, b: AnalysisConfig) =>
  a.independenceUnit === b.independenceUnit && a.assumeOneObservationPerSample === b.assumeOneObservationPerSample && a.seed === b.seed && a.fullComputation === b.fullComputation;

export function Workspace({ t, locale, input, origin, config, onConfig, run, result, validation, htmlError, onRun, onCancel, onDownloadHtml, onRepetition }: WorkspaceProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>("data");
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [evidenceQuery, setEvidenceQuery] = useState("");
  const report = useMemo(() => (result ? buildQualificationReportView(result.report) : null), [result]);
  const sources = report ? reportSourceIds(report) : input.sources.map((s) => s.source_id);
  const targets = report ? reportTargetIds(report) : input.targets.map((x) => x.target_id);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const source = sourceId && sources.includes(sourceId) ? sourceId : (sources[0] ?? input.sources[0]?.source_id ?? null);
  const target = targetId && targets.includes(targetId) ? targetId : (targets[0] ?? input.targets[0]?.target_id ?? null);
  const running = run.state === "running";
  const dirty = result !== null && !sameConfig(config, defaultConfig(result.input));
  const synthetic = origin.kind === "synthetic" || input.data_origin === "synthetic";
  const observations = input.sources.reduce((n, s) => n + s.observation_ids.length, 0);
  const bands = input.sources.reduce((n, s) => n + s.axis.length, 0);
  const scope: Scope | null = report && result ? { t, locale, view: report, input: result.input, sourceId: source, targetId: target } : null;
  const checks = scope ? buildChecks(scope.view, scope.input, source, target, t, locale) : [];
  const review = needsReview(checks);

  const go = (next: View, anchor: string | null = null) => {
    setView(next);
    setScrollTo(anchor);
    if (!anchor) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(scrollTo);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo(null);
  }, [scrollTo, view]);

  /** In-page anchors switch to the step that owns them (evidence links also prefill the search). */
  const onClickCapture = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a[href^='#']");
    if (!link) return;
    const anchor = decodeURIComponent((link.getAttribute("href") ?? "").slice(1));
    const owner = viewOf(anchor);
    if (!owner) return;
    e.preventDefault();
    if (anchor.startsWith("ev-")) {
      setEvidenceQuery(anchor.slice(3));
      go("evidence", "s-evidence");
    } else go(owner, anchor);
  };

  const steps: { id: View; icon: IconName; label: string; sub: string; badge?: "busy" | "warn" | "ok"; disabled: boolean }[] = [
    { id: "data", icon: "data", label: t("stepData"), sub: fill(t("stepDataSub"), { obs: observations, bands }), disabled: false },
    {
      id: "diagnosis",
      icon: "diagnosis",
      label: t("stepDiag"),
      sub: running ? t("stepDiagRunning") : report ? (review ? fill(t("stepDiagCount"), { n: review }) : t("stepDiagNone")) : t("stepDiagWait"),
      ...(running ? { badge: "busy" as const } : report ? { badge: review ? ("warn" as const) : ("ok" as const) } : {}),
      disabled: !report,
    },
    { id: "evidence", icon: "evidence", label: t("stepEvidence"), sub: report ? fill(t("stepEvidenceSub"), { n: report.metrics.length }) : t("stepDiagWait"), disabled: !report },
    { id: "export", icon: "export", label: t("stepExport"), sub: t("stepExportSub"), disabled: !report },
  ];

  return (
    <div onClickCapture={onClickCapture}>
      <section className="ws-head">
        <div className="container ws-head-inner">
          <div className="ws-head-main">
            <span className="eyebrow">{t("reportOf")}</span>
            <div className="ws-title-row">
              <h1 className="ws-title">{origin.kind === "synthetic" ? t(origin.name === "clean" ? "scClean" : "scPitfalls") : origin.name}</h1>
              {synthetic ? <span className="tag tag-synth">{t("synthetic")}</span> : null}
            </div>
            {synthetic ? <p className="ws-sub">{t("demoLabel")}</p> : null}
            {origin.tables?.length ? (
              <p className="ws-sub ws-files">
                {t("detectedFiles")}{" "}
                {origin.tables.map((table, i) => (
                  <span key={table.file} className="ws-file">{i ? " · " : ""}<code>{table.file}</code> → {t(`role_${table.role}` as TextKey)}{table.partition === "test" ? ` (${t("partitionTest")})` : table.partition === "predict" ? ` (${t("partitionPredict")})` : ""}{table.emptyBands ? ` — ${fill(t("emptyBands"), { n: table.emptyBands })}` : ""}</span>
                ))}
              </p>
            ) : null}
          </div>
          <div className="ws-actions">
            <div className="ws-status" role="status" aria-live="polite">
              {running ? <><span className="spinner" aria-hidden="true" />{t("running")}</> : null}
              {run.state === "cancelled" ? t("cancelled") : null}
              {run.state === "idle" && result && !dirty ? <><span className="ok-dot" aria-hidden="true" />{t("done")}</> : null}
              {dirty && !running ? <span className="warn-text">{t("settingsChanged")}</span> : null}
            </div>
            <button className="btn btn-outline" aria-expanded={settingsOpen} aria-controls="settings" onClick={() => setSettingsOpen((o) => !o)}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="10" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="18" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              {t("settings")}
            </button>
            {running ? (
              <button className="btn btn-danger" onClick={onCancel}>{t("cancel")}</button>
            ) : (
              <button className={dirty || run.state !== "idle" ? "btn btn-primary" : "btn btn-outline"} onClick={onRun}>{t("rerun")}</button>
            )}
          </div>
        </div>
        <div className="container">
          {settingsOpen ? <Settings t={t} input={input} config={config} onChange={onConfig} origin={origin} onRepetition={onRepetition && ((r) => { setSettingsOpen(false); onRepetition(r); })} /> : null}
          {run.state === "error" ? (
            <div role="alert" className="alert">
              {run.code === "INPUT_REFUSED" ? null : <p>{run.code === "ENGINE_UNAVAILABLE" ? t("engineUnavailable") : run.code === "CELL_BUDGET_EXCEEDED" ? `${t("tooManyCells")} (${run.message})` : `${t("engineError")} (${run.code}) : ${run.message}`}</p>}
              {validation ? (
                <>
                  <p>{t("validKo")}</p>
                  <ul>{issueGroups(validation).map((g) => <li key={g.code}><code>{g.code}</code> {g.message}{g.blocking ? ` (${t("blocking")})` : ""} — {g.paths.slice(0, 3).join(", ")}{g.paths.length > 3 ? ` … (${g.paths.length})` : ""}</li>)}</ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <nav className="journey" aria-label={t("journey")}>
        <div className="container journey-inner">
          <ol>
            {steps.map((s, i) => (
              <li key={s.id}>
                <button className="journey-step" aria-current={view === s.id ? "step" : undefined} disabled={s.disabled} onClick={() => go(s.id)}>
                  <span className="journey-icon"><Icon name={s.icon} size={18} />{s.badge ? <span className="journey-badge" data-kind={s.badge} aria-hidden="true" /> : null}</span>
                  <span className="journey-text">
                    <span className="journey-label"><span className="journey-num">{i + 1}</span>{s.label}</span>
                    <span className="journey-sub">{s.sub}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {sources.length > 1 || targets.length > 1 ? (
            <div className="ws-scope">
              {sources.length > 1 ? <label>{t("source")}<select value={source ?? ""} onChange={(e) => setSourceId(e.target.value)}>{sources.map((s) => <option key={s}>{s}</option>)}</select></label> : null}
              {targets.length > 1 ? <label>{t("target")}<select value={target ?? ""} onChange={(e) => setTargetId(e.target.value)}>{targets.map((s) => <option key={s}>{s}</option>)}</select></label> : null}
            </div>
          ) : null}
        </div>
      </nav>

      <div className={`container ws-body${running && result ? " is-stale" : ""}`}>
        {view === "data" ? (
          <>
            {scope ? (
              <button className="ready-banner" onClick={() => go("diagnosis")}>
                <span className="ready-icon" data-kind={review ? "warn" : "ok"}><Icon name="diagnosis" size={22} /></span>
                <span className="ready-text">
                  <strong>{t("diagReady")}</strong>
                  <span>{fill(t("diagReadySub"), { n: review, total: checks.length })}</span>
                </span>
                <span className="ready-cta">{t("seeDiag")} →</span>
              </button>
            ) : running ? (
              <div className="ready-banner is-busy" role="status">
                <span className="spinner" aria-hidden="true" />
                <span className="ready-text"><strong>{t("running")}</strong><span>{t("runningDetail")}</span></span>
              </div>
            ) : null}
            <DataView key={source ?? ""} t={t} locale={locale} input={result?.input ?? input} sourceId={source} targetId={target} report={report} />
          </>
        ) : null}

        {view === "diagnosis" && scope ? (
          <div className="diag-layout">
            <DiagnosisMenu t={t} items={diagMenu(scope)} />
            <div className="diag-main">
            <DiagnosisSummary {...scope} checks={checks} />
            <PopulationsSection {...scope} />
            <SpectralQualitySection {...scope} />
            <DuplicatesSection {...scope} />
            <StructureSection key={`pca-${source ?? ""}`} {...scope} />
            <SensitivitySection {...scope} />
            <ClusteringSection {...scope} />
            <RepeatSection {...scope} />
            <TargetSection {...scope} />
            <AssociationSection {...scope} />
            <ConfoundingSection {...scope} />
            <DomainShiftSection {...scope} />
            <ProbeSection {...scope} />
            <NextStep label={t("stepEvidence")} t={t} onClick={() => go("evidence")} />
            </div>
          </div>
        ) : null}

        {view === "evidence" && scope ? (
          <>
            <EvidenceSection key={evidenceQuery} {...scope} initialQuery={evidenceQuery} fileName={`${baseName(result!)}-evidence.csv`} />
            <CapabilitiesSection {...scope} />
            <Section id="s-technical" icon="data" accent="amber" title={t("techTitle")}>
              <TechnicalSection {...scope} />
            </Section>
            <NextStep label={t("stepExport")} t={t} onClick={() => go("export")} />
          </>
        ) : null}

        {view === "export" && result ? (
          <Section id="export" icon="export" accent="cyan" title={t("exportTitle")}>
            <div className="exports">
              <button className="export-card" onClick={() => downloadText(`${baseName(result)}-report.json`, "application/json", JSON.stringify(result.report, null, 2))}>
                <span className="export-ext">JSON</span><strong>{t("dlJson")}</strong><span>{t("dlJsonDesc")}</span>
              </button>
              <button className="export-card" onClick={onDownloadHtml}>
                <span className="export-ext">HTML</span><strong>{t("dlHtml")}</strong><span>{t("dlHtmlDesc")}</span>
              </button>
              <button className="export-card" onClick={() => downloadText(`${baseName(result)}-evidence.csv`, "text/csv", `\uFEFF${evidenceCsv(report!.metrics, locale)}`)}>
                <span className="export-ext">CSV</span><strong>{t("dlCsv")}</strong><span>{t("dlCsvDesc")}</span>
              </button>
              <button className="export-card" onClick={() => downloadText(`${baseName(result)}-input.json`, "application/json", JSON.stringify(result.input))}>
                <span className="export-ext">IN</span><strong>{t("dlInput")}</strong><span>{t("dlInputDesc")}</span>
              </button>
            </div>
            {synthetic ? <p className="note">{t("dlDemoNote")}</p> : null}
            {htmlError ? <p role="alert" className="alert">{htmlError}</p> : null}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function NextStep({ label, t, onClick }: { label: string; t: T; onClick: () => void }) {
  return (
    <div className="next-step">
      <button className="btn btn-primary" onClick={onClick}>{t("next")} : {label} →</button>
    </div>
  );
}

type SettingsProps = { t: T; input: EngineInput; config: AnalysisConfig; onChange: (c: AnalysisConfig) => void; origin: Origin; onRepetition: WorkspaceProps["onRepetition"] };

function Settings({ t, input, config, onChange, origin, onRepetition }: SettingsProps) {
  const [seedText, setSeedText] = useState(config.seed === null ? "" : String(config.seed));
  const seed = parseSeed(seedText);
  return (
    <form id="settings" className="settings" onSubmit={(e) => e.preventDefault()}>
      {origin.columns?.length ? <RepetitionSetting key={`${origin.repetition?.column ?? ""}:${origin.repetition?.type ?? ""}`} t={t} columns={origin.columns} current={origin.repetition} onApply={onRepetition} /> : null}
      <label>
        <span>{t("cfgUnit")}</span>
        <select value={config.independenceUnit} onChange={(e) => onChange({ ...config, independenceUnit: e.target.value as IndependenceUnit })} aria-describedby="unit-hint">
          {UNITS.map((u) => <option key={u} value={u}>{t(`unit_${u}` as TextKey)}</option>)}
        </select>
        <small id="unit-hint">{config.independenceUnit === "group" ? `${t("groupHint")} ${countIndependenceGroups(input)} / ${input.samples.length}` : t("unitHint")}</small>
      </label>
      <label>
        <span>{t("cfgSeed")}</span>
        <input
          type="text"
          inputMode="numeric"
          value={seedText}
          aria-invalid={seed === "invalid"}
          aria-describedby="seed-hint"
          onChange={(e) => {
            setSeedText(e.target.value);
            const next = parseSeed(e.target.value);
            if (next !== "invalid") onChange({ ...config, seed: next });
          }}
        />
        <small id="seed-hint">{seed === "invalid" ? t("seedInvalid") : t("seedHint")}</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={config.assumeOneObservationPerSample} onChange={(e) => onChange({ ...config, assumeOneObservationPerSample: e.target.checked })} />
        <span>{t("cfgOneObs")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={config.fullComputation} aria-describedby="full-hint" onChange={(e) => onChange({ ...config, fullComputation: e.target.checked })} />
        <span>{t("cfgFull")}</span>
      </label>
      <small id="full-hint">{t("cfgFullHint")}</small>
      <p className="note settings-scope">{t("cfgScope")}</p>
    </form>
  );
}

/** Declares the metadata column whose equal values are repeated acquisitions of one physical sample. */
function RepetitionSetting({ t, columns, current, onApply }: { t: T; columns: string[]; current: RepetitionDeclaration | undefined; onApply: WorkspaceProps["onRepetition"] }) {
  const [column, setColumn] = useState(current?.column ?? "");
  const [type, setType] = useState<RepetitionDeclaration["type"]>(current?.type ?? "rescan");
  const changed = column !== (current?.column ?? "") || (column !== "" && type !== current?.type);
  return (
    <fieldset className="settings-repetition">
      <label>
        <span>{t("cfgRepetition")}</span>
        <select value={column} disabled={!onApply} onChange={(e) => setColumn(e.target.value)} aria-describedby="repetition-hint">
          <option value="">{t("cfgRepetitionNone")}</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label>
        <span>{t("cfgRepetitionType")}</span>
        <select value={type} disabled={!onApply || column === ""} onChange={(e) => setType(e.target.value as RepetitionDeclaration["type"])}>
          {DECLARABLE_REPETITIONS.map((k) => <option key={k} value={k}>{t(`repType_${k}` as TextKey)}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn-outline" disabled={!onApply || !changed} onClick={() => onApply?.(column ? { column, type } : undefined)}>{t("cfgRepetitionApply")}</button>
      <small id="repetition-hint">{onApply ? t("cfgRepetitionHint") : t("cfgRepetitionNoFiles")}</small>
    </fieldset>
  );
}
