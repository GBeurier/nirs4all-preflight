import { useEffect, useRef, useState } from "react";
import type { Locale } from "nirs4all-ui/lab";
import type { EngineReport } from "nirs4all-ui/qualification";
import { downloadText } from "./download";
import { createEngineHost, EngineError, type EngineHost, type EngineValidation } from "./engine";
import { initialLocale, translate, type TextKey } from "./i18n";
import { buildEngineInput, defaultConfig, type AnalysisConfig, type EngineInput } from "./input";
import { Landing } from "./Landing";
import { syntheticInput, type SyntheticScenario } from "./synthetic";
import { Workspace } from "./Workspace";

export type Run = { state: "idle" } | { state: "running" } | { state: "cancelled" } | { state: "error"; code: string; message: string };
export type Origin = { kind: "file" | "synthetic"; name: string };
/** A report is only ever shown with the exact input that produced it. */
export type Result = { report: EngineReport; input: EngineInput; origin: Origin };
export type T = (k: TextKey) => string;
type Theme = "light" | "dark";

const isSynthetic = (r: Result) => r.origin.kind === "synthetic" || r.input.data_origin === "synthetic";
export const baseName = (r: Result) => (isSynthetic(r) ? "nirs4all-preflight-synthetic-demo" : "nirs4all-preflight");

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("n4pf-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage unavailable: fall back to the system preference
  }
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const t: T = (key) => translate(key, locale);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [input, setInput] = useState<EngineInput | null>(null);
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [result, setResult] = useState<Result | null>(null);
  const [validation, setValidation] = useState<EngineValidation | null>(null);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const host = useRef<EngineHost | null>(null);
  /** Job generation: responses of a superseded or cancelled job are ignored. */
  const job = useRef(0);

  useEffect(() => {
    host.current = createEngineHost();
    return () => host.current?.dispose();
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("n4pf-theme", theme);
    } catch {
      // preference is a convenience only
    }
  }, [theme]);

  const execute = async (data: EngineInput, cfg: AnalysisConfig, from: Origin) => {
    if (!host.current) return;
    const generation = ++job.current;
    const payload = buildEngineInput(data, cfg);
    setRun({ state: "running" });
    setValidation(null);
    try {
      const report = await host.current.analyze(payload);
      if (generation !== job.current) return;
      setResult({ report, input: payload, origin: from });
      setRun({ state: "idle" });
    } catch (error) {
      if (generation !== job.current) return;
      if (error instanceof EngineError && error.code === "CANCELLED") {
        setRun({ state: "cancelled" });
        return;
      }
      setRun({ state: "error", code: error instanceof EngineError ? error.code : "ENGINE_ERROR", message: error instanceof Error ? error.message : String(error) });
      // Explain a refused input with the engine's own validation issues.
      try {
        const outcome = await host.current.validate(payload);
        if (generation === job.current && !outcome.valid) setValidation(outcome);
      } catch {
        // the analysis error above is already shown
      }
    }
  };

  const load = (next: EngineInput, from: Origin) => {
    if (run.state === "running") {
      job.current += 1;
      host.current?.cancel();
    }
    const cfg = defaultConfig(next);
    setInput(next);
    setOrigin(from);
    setConfig(cfg);
    setResult(null);
    setHtmlError(null);
    window.scrollTo({ top: 0 });
    void execute(next, cfg, from);
  };

  const reset = () => {
    job.current += 1;
    host.current?.cancel();
    setInput(null);
    setOrigin(null);
    setResult(null);
    setValidation(null);
    setRun({ state: "idle" });
  };

  const downloadHtml = async () => {
    if (!result || !host.current) return;
    setHtmlError(null);
    try {
      downloadText(`${baseName(result)}-report.html`, "text/html", await host.current.reportHtml(result.report));
    } catch (error) {
      setHtmlError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="app">
      <a className="skip" href="#main">{t("skip")}</a>
      <header className="nav">
        <div className="nav-inner">
          <button className="nav-logo" onClick={reset} aria-label="nirs4all preflight">
            <img src={`${import.meta.env.BASE_URL}brand-icon.svg`} alt="" width={30} height={30} />
            <span>nirs4all <em>preflight</em></span>
          </button>
          <span className="nav-alpha">{t("alphaBadge")}</span>
          <div className="nav-actions">
            {input ? <button className="btn btn-ghost" onClick={reset} aria-label={t("newDataset")}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg><span className="hide-sm">{t("newDataset")}</span></button> : null}
            <a className="btn btn-ghost hide-sm" href="https://github.com/GBeurier/nirs4all-preflight/blob/main/docs/SPECIFICATION.md" target="_blank" rel="noreferrer">{t("docs")}</a>
            <div className="seg" role="group" aria-label={t("language")}>
              {(["fr", "en"] as const).map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => setLocale(l)} lang={l}>{l.toUpperCase()}</button>
              ))}
            </div>
            <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`${t("theme")}: ${t(theme === "dark" ? "themeDark" : "themeLight")}`} title={t("theme")}>
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              )}
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {input && origin && config ? (
          <Workspace
            t={t}
            locale={locale}
            input={input}
            origin={origin}
            config={config}
            onConfig={setConfig}
            run={run}
            result={result}
            validation={validation}
            htmlError={htmlError}
            onRun={() => void execute(input, config, origin)}
            onCancel={() => host.current?.cancel()}
            onDownloadHtml={() => void downloadHtml()}
          />
        ) : (
          <Landing t={t} locale={locale} onDataset={(data, name) => load(data, { kind: "file", name })} onSynthetic={(sc: SyntheticScenario) => load(syntheticInput(sc), { kind: "synthetic", name: sc })} />
        )}
      </main>
      <footer className="footer">
        <div className="container footer-inner">
          <span>{t("footer")}</span>
          <span>{t("privacy")}</span>
        </div>
      </footer>
    </div>
  );
}
