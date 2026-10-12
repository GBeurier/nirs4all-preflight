import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Locale } from "nirs4all-ui/lab";
import {
  AvailabilityBadge,
  CapabilityTable,
  ChartDataTable,
  EvidenceTable,
  FindingList,
  QualificationOverview,
  buildQualificationReportView,
  formatQualificationValue,
  type EngineReport,
  type QualificationMetricView,
  type QualificationProvenance,
} from "nirs4all-ui/qualification";
import { PcaScatter, SpectraPlot, N4_CATEGORICAL } from "nirs4all-ui/viz";
import { downloadText } from "./download";
import { createEngineHost, EngineError, type EngineHost, type EngineValidation } from "./engine";
import { initialLocale, translate, type TextKey } from "./i18n";
import { buildEngineInput, countIndependenceGroups, defaultConfig, parseCanonicalInput, parseSeed, type AnalysisConfig, type EngineInput, type IndependenceUnit } from "./input";
import { syntheticInput, type SyntheticScenario } from "./synthetic";

type Step = 0 | 1 | 2 | 3;
type Tab = "report" | "structure" | "evidence" | "capabilities" | "data" | "downloads";
type Run = { state: "idle" } | { state: "running" } | { state: "cancelled" } | { state: "error"; code: string; message: string };
type Origin = { kind: "file" | "synthetic"; name: string };
/** A report is only ever shown with the exact input that produced it. */
type Result = { report: EngineReport; input: EngineInput; origin: Origin };
type T = (k: TextKey) => string;

const STEPS: readonly { id: Step; label: TextKey }[] = [
  { id: 0, label: "stepData" },
  { id: 1, label: "stepConfig" },
  { id: 2, label: "stepRun" },
  { id: 3, label: "stepResults" },
];
const TABS: readonly { id: Tab; label: TextKey }[] = [
  { id: "report", label: "tabReport" },
  { id: "structure", label: "tabStructure" },
  { id: "evidence", label: "tabEvidence" },
  { id: "capabilities", label: "tabCapabilities" },
  { id: "data", label: "tabData" },
  { id: "downloads", label: "tabDownloads" },
];
const UNITS: readonly IndependenceUnit[] = ["unknown", "sample", "reference_group", "group"];

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t: T = (key) => translate(key, locale);
  const [step, setStep] = useState<Step>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [input, setInput] = useState<EngineInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [result, setResult] = useState<Result | null>(null);
  const [validation, setValidation] = useState<EngineValidation | null>(null);
  const [tab, setTab] = useState<Tab>("report");
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const host = useRef<EngineHost | null>(null);
  /** Job generation: responses of a superseded or cancelled job are ignored. */
  const job = useRef(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const firstStep = useRef(true);

  useEffect(() => {
    host.current = createEngineHost();
    return () => host.current?.dispose();
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (firstStep.current) firstStep.current = false;
    else mainRef.current?.focus();
  }, [step]);

  const report = result?.report ?? null;
  const view = useMemo(() => (report ? buildQualificationReportView(report) : null), [report]);
  const running = run.state === "running";

  const load = (next: EngineInput, from: Origin) => {
    if (running) {
      job.current += 1;
      host.current?.cancel();
    }
    setInput(next);
    setOrigin(from);
    setConfig(defaultConfig(next));
    setResult(null);
    setValidation(null);
    setRun({ state: "idle" });
    setLoadError(null);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseCanonicalInput(await file.text());
    if (parsed.ok) load(parsed.input, { kind: "file", name: file.name });
    else setLoadError(`${t(`err_${parsed.code}` as TextKey)} ${parsed.detail}`.trim());
    event.target.value = "";
  };

  const execute = async (mode: "analyze" | "validate") => {
    if (!input || !config || !origin || !host.current) return;
    const generation = ++job.current;
    const payload = buildEngineInput(input, config);
    setRun({ state: "running" });
    try {
      if (mode === "validate") {
        const outcome = await host.current.validate(payload);
        if (generation !== job.current) return;
        setValidation(outcome);
      } else {
        const outcome = await host.current.analyze(payload);
        if (generation !== job.current) return;
        setResult({ report: outcome, input: payload, origin });
        setValidation(null);
        setTab("report");
        setStep(3);
      }
      setRun({ state: "idle" });
    } catch (error) {
      if (generation !== job.current) return;
      if (error instanceof EngineError && error.code === "CANCELLED") setRun({ state: "cancelled" });
      else setRun({ state: "error", code: error instanceof EngineError ? error.code : "ENGINE_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const baseName = (r: Result) => ((r.origin.kind === "synthetic" || r.input.data_origin === "synthetic") ? "nirs4all-preflight-synthetic-demo" : "nirs4all-preflight");

  const downloadHtml = async () => {
    if (!result || !host.current) return;
    const name = `${baseName(result)}-report.html`;
    setHtmlError(null);
    try {
      downloadText(name, "text/html", await host.current.reportHtml(result.report));
    } catch (error) {
      setHtmlError(error instanceof Error ? error.message : String(error));
    }
  };

  const goto = (next: Step) => {
    setStep(next);
    setMenuOpen(false);
  };
  const enabled = (s: Step) => s === 0 || (input !== null && (s < 3 || result !== null));

  return (
    <div className="app">
      <a className="skip" href="#main">{t("skip")}</a>
      <header className="topbar">
        <img className="mark" src={`${import.meta.env.BASE_URL}brand-icon.svg`} alt="" width={36} height={36} />
        <div className="brand">
          <strong>nirs4all <span className="accent">preflight</span></strong>
          <span className="sub">{t("title")}</span>
        </div>
        <button className="menu-btn" aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen((o) => !o)}>{t("menu")}</button>
        <div className="lang" role="group" aria-label={t("language")}>
          {(["fr", "en"] as const).map((l) => (
            <button key={l} aria-pressed={locale === l} onClick={() => setLocale(l)} lang={l}>{l.toUpperCase()}</button>
          ))}
        </div>
      </header>
      <div className="layout">
        <nav id="sidebar" className="sidebar" data-open={menuOpen} aria-label={t("steps")}>
          <ol>
            {STEPS.map((s) => (
              <li key={s.id}>
                <button aria-current={step === s.id ? "step" : undefined} disabled={!enabled(s.id)} onClick={() => goto(s.id)}>
                  <span className="num" aria-hidden="true">{s.id + 1}</span>{t(s.label)}
                </button>
              </li>
            ))}
          </ol>
          <p className="alpha-note">{t("alpha")}</p>
        </nav>
        <main id="main" tabIndex={-1} ref={mainRef}>
          {step === 0 ? (
            <section aria-labelledby="h-data">
              <h1 id="h-data">{t("stepData")}</h1>
              <p>{t("dataIntro")}</p>
              <div className="actions">
                <label className="btn primary">
                  {t("upload")}
                  <input type="file" accept="application/json,.json" onChange={onFile} className="visually-hidden" />
                </label>
              </div>
              <h2>{t("synthetic")}</h2>
              <p className="note">{t("syntheticNote")}</p>
              <div className="actions">
                {(["clean", "pitfalls"] as const satisfies readonly SyntheticScenario[]).map((sc) => (
                  <button key={sc} className="btn" onClick={() => load(syntheticInput(sc), { kind: "synthetic", name: sc })}>{t(sc === "clean" ? "scClean" : "scPitfalls")}</button>
                ))}
              </div>
              {loadError ? <p role="alert" className="alert">{loadError}</p> : null}
              {input && origin ? <DatasetSummary input={input} origin={origin} t={t} /> : null}
              <div className="actions"><button className="btn primary" disabled={!input} onClick={() => goto(1)}>{t("next")}</button></div>
            </section>
          ) : null}

          {step === 1 && input && config ? (
            <section aria-labelledby="h-cfg">
              <h1 id="h-cfg">{t("stepConfig")}</h1>
              <ConfigForm input={input} config={config} onChange={setConfig} t={t} />
              <div className="actions">
                <button className="btn" onClick={() => goto(0)}>{t("back")}</button>
                <button className="btn primary" onClick={() => goto(2)}>{t("next")}</button>
              </div>
            </section>
          ) : null}

          {step === 2 && input && config ? (
            <section aria-labelledby="h-run">
              <h1 id="h-run">{t("stepRun")}</h1>
              <p className="note">{t("runScope")}</p>
              <div className="actions">
                <button className="btn" onClick={() => goto(1)} disabled={running}>{t("back")}</button>
                <button className="btn primary" disabled={running} onClick={() => void execute("analyze")}>{t("analyze")}</button>
                <button className="btn" disabled={running} onClick={() => void execute("validate")}>{t("validate")}</button>
                <button className="btn danger" disabled={!running} onClick={() => host.current?.cancel()}>{t("cancel")}</button>
              </div>
              <div role="status" aria-live="polite">
                {running ? <p className="note">{t("running")}</p> : null}
                {run.state === "cancelled" ? <p className="note">{t("cancelled")}</p> : null}
              </div>
              {run.state === "error" ? (
                <p role="alert" className="alert">
                  {run.code === "ENGINE_UNAVAILABLE" ? t("engineUnavailable") : `${t("engineError")} (${run.code}): ${run.message}`}
                </p>
              ) : null}
              {validation ? (
                <div>
                  <h2>{t("validation")}</h2>
                  <p>{validation.valid ? t("validOk") : t("validKo")}</p>
                  {validation.issues.length > 0 ? (
                    <ul>{validation.issues.map((i, k) => <li key={`${i.code}${k}`}><code>{i.code}</code> <span className="sub">{i.path}</span> — {i.message}</li>)}</ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 3 ? (
            <section aria-labelledby="h-res">
              <h1 id="h-res">{t("stepResults")}</h1>
              {view && result ? (
                <>
                  {(result.origin.kind === "synthetic" || result.input.data_origin === "synthetic") ? <p className="demo-label"><strong>{t("demoLabel")}</strong> — {t("demoLabelNote")}</p> : null}
                  <Tabs tab={tab} onTab={setTab} t={t} />
                  <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="panel">
                    {tab === "report" ? (
                      <>
                        <QualificationOverview view={view} locale={locale} />
                        <h2>{t("findings")}</h2>
                        <FindingList findings={view.findings} locale={locale} />
                      </>
                    ) : null}
                    {tab === "structure" ? <StructurePanel metrics={view.metrics} locale={locale} t={t} /> : null}
                    {tab === "evidence" ? <FilteredEvidence metrics={view.metrics} provenance={view.provenance} locale={locale} t={t} /> : null}
                    {tab === "capabilities" ? <CapabilityTable capabilities={view.capabilities} locale={locale} /> : null}
                    {tab === "data" ? <DataPreview input={result.input} locale={locale} t={t} /> : null}
                    {tab === "downloads" ? (
                      <div>
                        <p className="note">{t("dlNote")}</p>
                        {(result.origin.kind === "synthetic" || result.input.data_origin === "synthetic") ? <p className="note">{t("dlDemoNote")}</p> : null}
                        <div className="actions">
                          <button className="btn" onClick={() => downloadText(`${baseName(result)}-report.json`, "application/json", JSON.stringify(result.report, null, 2))}>{t("dlJson")}</button>
                          <button className="btn" onClick={() => void downloadHtml()}>{t("dlHtml")}</button>
                          <button className="btn" onClick={() => downloadText(`${baseName(result)}-input.json`, "application/json", JSON.stringify(result.input))}>{t("dlInput")}</button>
                        </div>
                        {htmlError ? <p role="alert" className="alert">{htmlError}</p> : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : <p>{t("noResult")}</p>}
            </section>
          ) : null}
        </main>
      </div>
      <footer>{t("footer")} · {t("tagline")}</footer>
    </div>
  );
}

function Tabs({ tab, onTab, t }: { tab: Tab; onTab: (tab: Tab) => void; t: T }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (event: KeyboardEvent) => {
    const i = TABS.findIndex((x) => x.id === tab);
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : move ? (i + move + TABS.length) % TABS.length : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = TABS[target];
    if (next) {
      onTab(next.id);
      refs.current[next.id]?.focus();
    }
  };
  return (
    <div role="tablist" className="tabs" onKeyDown={onKey}>
      {TABS.map((x) => (
        <button
          key={x.id}
          ref={(el) => { refs.current[x.id] = el; }}
          role="tab"
          id={`tab-${x.id}`}
          aria-selected={tab === x.id}
          aria-controls={tab === x.id ? `panel-${x.id}` : undefined}
          tabIndex={tab === x.id ? 0 : -1}
          onClick={() => onTab(x.id)}
        >{t(x.label)}</button>
      ))}
    </div>
  );
}

function DatasetSummary({ input, origin, t }: { input: EngineInput; origin: Origin; t: T }) {
  const obs = input.sources.reduce((n, s) => n + s.observation_ids.length, 0);
  return (
    <dl className="facts" aria-label={t("loaded")}>
      <dt>{t("origin")}</dt><dd>{origin.kind === "synthetic" ? t("originSynthetic") : t("originFile")} — {origin.name}</dd>
      <dt>{t("sources")}</dt><dd>{input.sources.length}</dd>
      <dt>{t("observations")}</dt><dd>{obs}</dd>
      <dt>{t("samples")}</dt><dd>{input.samples.length}</dd>
      <dt>{t("targets")}</dt><dd>{input.targets.length}</dd>
    </dl>
  );
}

function ConfigForm({ input, config, onChange, t }: { input: EngineInput; config: AnalysisConfig; onChange: (c: AnalysisConfig) => void; t: T }) {
  const [seedText, setSeedText] = useState(config.seed === null ? "" : String(config.seed));
  const seed = parseSeed(seedText);
  const grouped = countIndependenceGroups(input);
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <p className="note">{t("cfgScope")}</p>
      <label>
        {t("cfgUnit")}
        <select value={config.independenceUnit} onChange={(e) => onChange({ ...config, independenceUnit: e.target.value as IndependenceUnit })} aria-describedby="unit-hint">
          {UNITS.map((u) => <option key={u} value={u}>{t(`unit_${u}` as TextKey)}</option>)}
        </select>
        <span id="unit-hint" className="sub">{t("unitHint")}</span>
        {config.independenceUnit === "group" ? <span className="sub">{t("groupHint")} {grouped} / {input.samples.length}</span> : null}
      </label>
      <label className="check">
        <input type="checkbox" checked={config.assumeOneObservationPerSample} onChange={(e) => onChange({ ...config, assumeOneObservationPerSample: e.target.checked })} />
        {t("cfgOneObs")}
      </label>
      <label>
        {t("cfgSeed")}
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
        <span id="seed-hint" className="sub">{seed === "invalid" ? t("seedInvalid") : t("seedHint")}</span>
      </label>
    </form>
  );
}

/** Display filter over engine-reported rows; nothing is recomputed. */
function FilteredEvidence({ metrics, provenance, locale, t }: { metrics: readonly QualificationMetricView[]; provenance: QualificationProvenance; locale: Locale; t: T }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const sources = [...new Set(metrics.flatMap((m) => (m.sourceId === null ? [] : [m.sourceId])))];
  const targets = [...new Set(metrics.flatMap((m) => (m.targetId === null ? [] : [m.targetId])))];
  const shown = metrics.filter((m) => (source === "" || m.sourceId === source) && (target === "" || m.targetId === target));
  return (
    <>
      <div className="filters" role="group" aria-labelledby="filter-title">
        <p id="filter-title" className="note">{t("filterNote")}</p>
        <label>{t("source")}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t("filterAll")}</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>{t("target")}
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t("filterAll")}</option>
            {targets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <p className="sub" role="status">{t("filterShown")} {shown.length} / {metrics.length}</p>
      </div>
      <EvidenceTable metrics={shown} provenance={provenance} locale={locale} />
    </>
  );
}

interface PcaScores { sample_ids: string[]; scores: number[][] }

function isPcaScores(value: unknown): value is PcaScores {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.sample_ids) && Array.isArray(v.scores) && v.sample_ids.length === v.scores.length && v.scores.every(Array.isArray);
}

const SCORE_TABLE_MAX = 500;

/** Engine PCA scores only: points and table are read from `structure.pca_scores`, never derived here. */
function StructurePanel({ metrics, locale, t }: { metrics: readonly QualificationMetricView[]; locale: Locale; t: T }) {
  const scoreMetrics = metrics.filter((m) => m.id === "structure.pca_scores");
  const unavailable = metrics.filter((m) => m.id === "structure.pca");
  if (scoreMetrics.length === 0 && unavailable.length === 0) return <p>{t("pcaNone")}</p>;
  return (
    <div>
      <p className="note">{t("pcaIntro")}</p>
      {unavailable.map((m) => (
        <p key={`u-${m.sourceId ?? ""}`}>{t("source")} {m.sourceId}: <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></p>
      ))}
      {scoreMetrics.map((m) => {
        if (m.status !== "computed" || !isPcaScores(m.value)) {
          return <p key={`s-${m.sourceId ?? ""}`}>{t("source")} {m.sourceId}: <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></p>;
        }
        const { sample_ids: ids, scores } = m.value;
        const k = scores[0]?.length ?? 0;
        const retained = metrics.find((x) => x.id === "structure.explained_variance_retained" && x.sourceId === m.sourceId && x.status === "computed");
        const title = `${t("pcaTitle")} — ${t("source")} ${m.sourceId ?? ""}`;
        return (
          <figure key={`s-${m.sourceId ?? ""}`}>
            <figcaption>
              <strong>{title}</strong> — {t("view")} <code>{m.viewId}</code>; {t("pcaUnits")} {ids.length}
              {retained ? <>; {t("pcaRetained")} {formatQualificationValue(retained.value, locale)} ({k} {t("pcaComponents")})</> : null}
            </figcaption>
            {k >= 2 ? (
              <>
                <PcaScatter points={scores.map((row) => ({ x: row[0] as number, y: row[1] as number }))} legend={false} xLabel="PC1" yLabel="PC2" title={title} />
                <p className="note">{t("pcaAxes")}</p>
              </>
            ) : <p className="note">{t("pcaOneComponent")}</p>}
            {ids.length > SCORE_TABLE_MAX ? <p className="note">{t("pcaTableCap")} {SCORE_TABLE_MAX} / {ids.length}</p> : null}
            <ChartDataTable
              locale={locale}
              caption={title}
              columns={[t("pcaUnitId"), ...Array.from({ length: k }, (_, i) => `PC${i + 1}`)]}
              rows={ids.slice(0, SCORE_TABLE_MAX).map((id, i) => [id, ...(scores[i] ?? [])])}
            />
          </figure>
        );
      })}
    </div>
  );
}

const PREVIEW_MAX = 12;
type RowKind = "development" | "augmented" | "retained_test" | "prediction" | "undeclared";
const ROW_KINDS: readonly RowKind[] = ["development", "augmented", "retained_test", "prediction", "undeclared"];

/** Raw input spectra. Only complete development rows are drawn; retained-test rows are never plotted. */
function DataPreview({ input, locale, t }: { input: EngineInput; locale: Locale; t: T }) {
  const samples = new Map(input.samples.map((s) => [s.sample_id, s]));
  const kindOf = (sampleId: string): RowKind => {
    const s = samples.get(sampleId);
    if (!s) return "undeclared";
    const partition = s.partition ?? "development";
    return partition === "development" && s.augmentation_parent_id ? "augmented" : partition;
  };
  return (
    <div className="previews">
      <h2>{t("previewTitle")}</h2>
      <p className="note">{t("previewRule")}</p>
      {input.sources.map((source) => {
        const kinds = source.sample_ids.map(kindOf);
        const complete = source.x.map((row) => row.every((v) => v !== null && Number.isFinite(v)));
        const drawable = source.x.flatMap((row, i) => (kinds[i] === "development" && complete[i] ? [{ row: row as number[], i }] : []));
        const shown = drawable.slice(0, PREVIEW_MAX);
        const count = (kind: RowKind) => kinds.filter((k) => k === kind).length;
        const devIncomplete = kinds.filter((k, i) => k === "development" && !complete[i]).length;
        const caption = `${t("source")} ${source.source_id}`;
        const unit = source.axis_unit ?? "";
        return (
          <figure key={source.source_id}>
            <figcaption>
              <strong>{caption}</strong> — {t("previewShown")} {shown.length} / {drawable.length}; {t("previewIncomplete")} {devIncomplete};
              {" "}{t("previewExcluded")} {count("retained_test")} {t("kind_retained_test")}, {count("prediction")} {t("kind_prediction")}, {count("augmented")} {t("kind_augmented")}, {count("undeclared")} {t("kind_undeclared")}
            </figcaption>
            <SpectraPlot
              wavelengths={source.axis}
              series={shown.map(({ row, i }, k) => ({ id: source.observation_ids[i] ?? String(i), values: row, color: N4_CATEGORICAL[k % N4_CATEGORICAL.length] as string, opacity: 0.8 }))}
              unit={unit}
              yLabel={source.signal_unit ?? ""}
              title={`${caption} — ${t("previewPlotted")}`}
            />
            <ChartDataTable
              locale={locale}
              caption={`${caption} — ${t("previewRows")}`}
              columns={[t("previewKind"), t("rows"), t("previewDrawn")]}
              rows={ROW_KINDS.map((kind) => [t(`kind_${kind}` as TextKey), count(kind), kind === "development" ? shown.length : 0])}
            />
            <ChartDataTable
              locale={locale}
              caption={`${caption} — ${t("previewPlotted")}`}
              columns={["observation_id", "sample_id", `${t("axisRange")} (${unit})`]}
              rows={shown.map(({ i }) => [source.observation_ids[i] ?? null, source.sample_ids[i] ?? null, source.axis.length ? `${source.axis[0]} – ${source.axis[source.axis.length - 1]}` : null])}
            />
          </figure>
        );
      })}
    </div>
  );
}
