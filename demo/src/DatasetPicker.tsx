import { useEffect, useRef, useState } from "react";
import { DatasetDropzone, droppedFiles, type DroppedFile } from "nirs4all-ui/components";
import type { Locale } from "nirs4all-ui/lab";
import type { T } from "./App";
import { fill, type TextKey } from "./i18n";
import type { SavedDataset } from "./dataset";
import { DEMO_DATASETS, readDemoFiles, assembleDemoDataset, type DemoDataset } from "./demo-datasets";
import { importFiles, loadDatasetRuntime, type DetectedTable } from "./dataset-io";
import { listDatasets, removeDataset, saveDataset } from "./dataset-store";
import { parseCanonicalInput, type EngineInput } from "./input";
import type { SyntheticScenario } from "./synthetic";

export type LoadDataset = (input: EngineInput, name: string, tables?: DetectedTable[]) => void;

/** Decorative NIR-like curve (not data) for the example cards. */
export function heroCurve(k: number, w = 1200, h = 320, n = 120): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const y = 0.55 - 0.08 * k
      + 0.22 * Math.exp(-(((x - 0.3 - 0.02 * k) / 0.07) ** 2))
      + 0.3 * Math.exp(-(((x - 0.72) / 0.11) ** 2)) * (0.7 + 0.12 * k)
      + 0.12 * x;
    pts.push(`${(x * w).toFixed(1)},${(h - y * h * 0.94).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}
export const HERO_COLORS = ["#0d9488", "#06b6d4", "#10b981", "#0f766e", "#2dd4bf"];

function MiniSpectra({ flag }: { flag: boolean }) {
  return (
    <svg viewBox="0 0 120 48" className="demo-spark" aria-hidden="true">
      {[0, 1, 2, 3].map((k) => <path key={k} d={heroCurve(k, 120, 52, 40)} stroke={HERO_COLORS[k]} />)}
      {flag ? <circle cx="38" cy="16" r="4" className="demo-spark-flag" /> : null}
    </svg>
  );
}

const errorText = (cause: unknown, t: T) => `${t("dropFailed")} ${cause instanceof Error ? cause.message : String(cause)}`;

type Stage = "runtime" | "reading" | "assembling";

/** Lets the browser paint the progress state before the synchronous IO assembly. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export function DatasetPicker({ locale, t, onLoad, onSynthetic }: { locale: Locale; t: T; onLoad: LoadDataset; onSynthetic: (sc: SyntheticScenario) => void }) {
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<{ step: Stage; files: number } | null>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<SavedDataset | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    void listDatasets().then((items) => { if (active) setDatasets(items); }).catch(() => { if (active) setStorageError(t("datasetStorageError")); });
    return () => { active = false; generation.current++; };
  }, []);

  /** Saves for later reuse, then analyses; a storage failure never blocks the analysis. */
  const keep = async (input: EngineInput, name: string, tables: DetectedTable[] | undefined, current: number) => {
    const dataset: SavedDataset = { id: crypto.randomUUID(), name, savedAt: new Date().toISOString(), input, ...(tables?.length ? { tables } : {}) };
    try {
      await saveDataset(dataset);
      if (current === generation.current) onLoad(input, name, tables);
    } catch {
      if (current !== generation.current) return;
      setUnsaved(dataset);
      setStorageError(t("datasetStorageError"));
    }
  };

  const run = async (task: (current: number) => Promise<void>) => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setUnsaved(null);
    try {
      await task(current);
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause, t));
    } finally {
      if (current === generation.current) { setBusy(false); setStage(null); }
    }
  };

  const read = (pick: Promise<DroppedFile[]>) => run(async (current) => {
    setStage({ step: "reading", files: 0 });
    const files = await pick;
    if (!files.length) throw new Error(t("dropEmpty"));
    setStage({ step: "reading", files: files.length });
    const top = files[0]!.name.split("/")[0]!;
    const folder = files.every((f) => f.name.includes("/") && f.name.split("/")[0] === top) ? top : null;
    const name = folder ?? (files.length === 1 ? files[0]!.name : fill(t("filesName"), { first: files[0]!.name, n: files.length - 1 }));
    if (files.length === 1 && files[0]!.name.toLowerCase().endsWith(".json")) {
      const parsed = parseCanonicalInput(await files[0]!.file.text());
      if (!parsed.ok) throw new Error(`${t(`err_${parsed.code}` as TextKey)} ${parsed.detail}`.trim());
      await keep(parsed.input, name, undefined, current);
      return;
    }
    const incoming = await Promise.all(files.map(async (picked) => ({ name: picked.name, bytes: new Uint8Array(await picked.file.arrayBuffer()) })));
    setStage({ step: "runtime", files: files.length });
    const { io, formats } = await loadDatasetRuntime();
    setStage({ step: "assembling", files: files.length });
    await nextPaint();
    const { input, tables } = importFiles(incoming, name, io, formats);
    // A dataset of separate tables is named after its folder or its spectra file.
    const spectra = tables.find((table) => table.role === "x" && table.partition !== "test")?.file;
    const title = folder ?? (spectra && files.length > 1 ? fill(t("filesName"), { first: spectra, n: files.length - 1 }) : name);
    if (current === generation.current) await keep(input, title, tables, current);
  });

  const openDemo = (sample: DemoDataset) => run(async (current) => {
    setStage({ step: "runtime", files: 4 });
    const [files, { io, formats }] = await Promise.all([readDemoFiles(sample.id), loadDatasetRuntime()]);
    setStage({ step: "assembling", files: files.length });
    await nextPaint();
    if (current === generation.current) await keep(assembleDemoDataset(sample, files, io, formats), sample.name, undefined, current);
  });

  // The whole page accepts drops, so a drop next to the box is not lost.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth += 1; setOver(true); } };
    const leave = (event: DragEvent) => { if (hasFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) setOver(false); } };
    const dragOver = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer!.dropEffect = "copy"; } };
    // Capture phase: the drag ends wherever the drop lands (the zone stops its own drop from bubbling).
    const end = () => { depth = 0; setOver(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      void readRef.current(droppedFiles(event.dataTransfer!));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", end, true);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("drop", end, true);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const stageText = !stage || !stage.files ? t("datasetLoading") : fill(t(stage.step === "runtime" ? "stageRuntime" : stage.step === "assembling" ? "stageAssembling" : "stageReading"), { n: stage.files });

  return <div className="dataset-picker">
    {over ? <div className="drop-overlay" aria-hidden="true"><div className="drop-overlay-box">{t("dropActive")}</div></div> : null}
    <DatasetDropzone
      className="drop-target"
      onFiles={(files) => void read(Promise.resolve(files))}
      onError={(cause) => setError(errorText(cause, t))}
      active={over}
      busy={busy}
      title={t("dropTitle")}
      hint={<>{t("dropOr")} <u>{t("browse")}</u> — {t("dropHint")}</>}
      folderLabel={t("browseFolder")}
      busyTitle={stageText}
      busyHint={t("stageHint")}
      error={error ? <><p>{error}</p><p>{t("dropFailedHint")}</p></> : null}
    />
    {storageError ? <p role="alert" className="alert drop-alert">{storageError}</p> : null}
    {unsaved ? <button className="btn btn-primary" onClick={() => onLoad(unsaved.input, unsaved.name, unsaved.tables)}>{t("datasetContinue")}</button> : null}
    <details className="drop-help">
      <summary>{t("dropHelpTitle")}</summary>
      <ul>{(["dropHelpTable", "dropHelpXYM", "dropHelpFormats", "dropHelpJson"] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
    </details>

    <p className="demo-title">{t("tryDemo")}</p>
    <div className="demo-cards">
      {DEMO_DATASETS.map((sample) => (
        <button key={sample.id} className="demo-card" disabled={busy} onClick={() => void openDemo(sample)}>
          <MiniSpectra flag={false} />
          <span className="demo-card-text">
            <strong>{sample.id === "beer" ? "Beer" : "Anopheles"} <span className="tag tag-real">{t("realData")}</span></strong>
            <span>{t(sample.id === "beer" ? "beerDesc" : "anophelesDesc")}</span>
          </span>
          <span className="demo-card-arrow" aria-hidden="true">→</span>
        </button>
      ))}
      {(["clean", "pitfalls"] as const).map((sc) => (
        <button key={sc} className="demo-card" disabled={busy} onClick={() => onSynthetic(sc)}>
          <MiniSpectra flag={sc === "pitfalls"} />
          <span className="demo-card-text">
            <strong>{t(sc === "clean" ? "scClean" : "scPitfalls")} <span className="tag tag-synth">{t("synthetic")}</span></strong>
            <span>{t(sc === "clean" ? "scCleanDesc" : "scPitfallsDesc")}</span>
          </span>
          <span className="demo-card-arrow" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
    <p className="note center demo-sources">
      {DEMO_DATASETS.map((sample, i) => <span key={sample.id}>{i ? " · " : ""}{sample.id === "beer" ? "Beer" : "Anopheles"} : <a href={sample.source} target="_blank" rel="noreferrer">{sample.attribution}</a> (<a href={`${import.meta.env.BASE_URL}data/demo/${sample.licenseFile}`} target="_blank" rel="noreferrer">{sample.license}</a>)</span>)}
      {" · "}{t("syntheticNote")}
    </p>

    {datasets.length ? <section className="recent" aria-labelledby="recent-title">
      <h2 id="recent-title" className="demo-title">{t("datasetLibrary")}</h2>
      <ul className="recent-list">
        {datasets.map((dataset) => <li key={dataset.id} className="recent-item">
          <span className="recent-name">{dataset.name}</span>
          <span className="recent-meta">{fill(t("recentMeta"), { n: dataset.input.samples.length.toLocaleString(locale), p: dataset.input.sources.reduce((n, s) => n + s.axis.length, 0).toLocaleString(locale), y: dataset.input.targets.length })}</span>
          <span className="recent-actions">
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => onLoad(dataset.input, dataset.name, dataset.tables)}>{t("datasetReuse")}</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} aria-label={`${t("datasetRemove")} ${dataset.name}`} onClick={() => {
              void removeDataset(dataset.id).then(() => setDatasets((items) => items.filter((item) => item.id !== dataset.id))).catch(() => setStorageError(t("datasetStorageError")));
            }}>{t("datasetRemove")}</button>
          </span>
        </li>)}
      </ul>
      <p className="note center">{t("datasetLibraryHint")}</p>
    </section> : null}
  </div>;
}
