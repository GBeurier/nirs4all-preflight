import { useEffect, useRef, useState } from "react";
import { DatasetBuilder, type DatasetExportConfig, type DatasetSource } from "nirs4all-ui/datasetBuilder";
import { DatasetPreviewCard } from "nirs4all-ui/components";
import type { Locale } from "nirs4all-ui/lab";
import type { T } from "./App";
import type { TextKey } from "./i18n";
import { datasetPreview, type SavedDataset } from "./dataset";
import { DEMO_DATASETS, readDemoFiles, assembleDemoDataset, type DemoDataset } from "./demo-datasets";
import { assembleDraft, loadDatasetRuntime, prepareDataset, type DatasetDraft } from "./dataset-io";
import { listDatasets, removeDataset, saveDataset } from "./dataset-store";
import { parseCanonicalInput, type EngineInput } from "./input";

export function DatasetPicker({ locale, t, onLoad }: { locale: Locale; t: T; onLoad: (input: EngineInput, name: string) => void }) {
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  const [draft, setDraft] = useState<DatasetDraft | null>(null);
  const [sources, setSources] = useState<DatasetSource[]>([]);
  const [name, setName] = useState("");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<SavedDataset | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canonical = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    void listDatasets().then((items) => { if (active) setDatasets(items); }).catch(() => { if (active) setStorageError(t("datasetStorageError")); });
    return () => { active = false; generation.current++; };
  }, []);

  const keep = async (input: EngineInput, datasetName: string, current: number) => {
    const dataset: SavedDataset = { id: crypto.randomUUID(), name: datasetName, savedAt: new Date().toISOString(), input };
    try {
      await saveDataset(dataset);
      if (current === generation.current) onLoad(input, datasetName);
    } catch {
      if (current !== generation.current) return;
      setUnsaved(dataset);
      setStorageError(t("datasetStorageError"));
    }
  };

  const read = async (files: File[], canonicalOnly = false) => {
    if (!files.length || busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setUnsaved(null); setOpen(true);
    try {
      if (files.length === 1 && files[0]!.name.toLowerCase().endsWith(".json")) {
        const text = await files[0]!.text();
        const parsed = parseCanonicalInput(text);
        if (parsed.ok) {
          if (current === generation.current) await keep(parsed.input, files[0]!.name, current);
          return;
        }
        if (canonicalOnly) throw new Error(`${t(`err_${parsed.code}` as TextKey)} ${parsed.detail}`.trim());
      }
      const runtime = await loadDatasetRuntime();
      const incoming = await Promise.all(files.map(async (file) => ({ name: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
      if (new Set(incoming.map((file) => file.name)).size !== incoming.length) throw new Error(t("datasetDuplicateNames"));
      // Adding sources re-runs IO inference over the complete selection.
      const byName = new Map((draft?.files ?? []).map((file) => [file.name, file]));
      incoming.forEach((file) => byName.set(file.name, file));
      const next = prepareDataset([...byName.values()], runtime.io, runtime.formats);
      if (current !== generation.current) return;
      setDraft(next); setSources(next.sources); setName(next.spec.name ?? files[0]!.name);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const create = async (config: DatasetExportConfig, selected: DatasetSource[]) => {
    if (!draft || busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setUnsaved(null);
    try {
      const { io } = await loadDatasetRuntime();
      await keep(assembleDraft(draft, config, selected, io), config.name, current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const openDemo = async (sample: DemoDataset) => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setUnsaved(null);
    try {
      const [files, { io, formats }] = await Promise.all([readDemoFiles(sample.id), loadDatasetRuntime()]);
      if (current === generation.current) await keep(assembleDemoDataset(sample, files, io, formats), sample.name, current);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return <div className="dataset-picker">
    <section className="dataset-library dataset-public-demos" aria-labelledby="dataset-demos-title">
      <h2 id="dataset-demos-title">{t("realDemoDatasets")}</h2>
      <p className="note">{t("realDemoHint")}</p>
      <div className="dataset-library-grid">
        {DEMO_DATASETS.map((sample) => <div key={sample.id} className="dataset-library-item">
          <DatasetPreviewCard dataset={{ id: sample.id, name: sample.name, taskType: sample.task,
            sampleCount: sample.samples, featureCount: sample.bands, targetCount: 1,
            splitCounts: { train: sample.train, test: sample.test } }} statListClassName="dataset-preview-stats" badgeListClassName="dataset-preview-badges" />
          <p className="note"><a href={sample.source} target="_blank" rel="noreferrer">{sample.attribution}</a> · <a href={`${import.meta.env.BASE_URL}data/demo/${sample.licenseFile}`} target="_blank" rel="noreferrer">{sample.license}</a></p>
          {sample.id === "anopheles" ? <p className="note">{t("largeDemoHint")}</p> : null}
          <button className="btn btn-primary" disabled={busy} onClick={() => void openDemo(sample)}>{t("tryRealDataset")} {sample.id === "beer" ? "Beer" : "Anopheles"}</button>
        </div>)}
      </div>
    </section>
    <div className="dataset-entry-actions">
      <button className="btn btn-primary" disabled={busy} onClick={() => { setOpen(true); picker.current?.click(); }}>{t("importDataset")}</button>
      <button className="btn btn-outline" disabled={busy} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="dataset-builder">{t("configureDataset")}</button>
    </div>
    <p className="note">{t("datasetImportHint")}</p>
    <input ref={picker} type="file" multiple className="visually-hidden" aria-label={t("importDataset")} onChange={(event) => { void read(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <div role="status" aria-live="polite">{busy ? <p className="note"><span className="spinner" aria-hidden="true" /> {t("datasetLoading")}</p> : null}</div>
    {error ? <p role="alert" className="alert">{error}</p> : null}
    {storageError ? <p role="alert" className="alert">{storageError}</p> : null}
    {unsaved ? <button className="btn btn-primary" onClick={() => onLoad(unsaved.input, unsaved.name)}>{t("datasetContinue")}</button> : null}
    {open ? <div id="dataset-builder" className="dataset-builder" aria-busy={busy} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void read(Array.from(event.dataTransfer.files)); }}>
      <div className="dataset-entry-actions">
        <button className="btn btn-outline" disabled={busy} onClick={() => picker.current?.click()}>{t("datasetAddFiles")}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { generation.current++; setDraft(null); setSources([]); setError(null); }}>{t("datasetClear")}</button>
      </div>
      <p className="note">{t("datasetRawPolicy")}</p>
      {draft?.warnings.length ? <details className="dataset-import-notes"><summary>{t("datasetWarnings")}</summary><ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
      <fieldset disabled={busy} className="dataset-builder-fieldset">
        <DatasetBuilder sources={sources} onChange={setSources} datasetName={name} onDatasetNameChange={setName} autoDetectOnLoad={false}
          onRequestAddSource={() => picker.current?.click()} onExport={(config, selected) => void create(config, selected)} locale={locale} />
      </fieldset>
    </div> : null}
    <section className="dataset-library" aria-labelledby="dataset-library-title">
      <h2 id="dataset-library-title">{t("datasetLibrary")}</h2>
      <p className="note">{t("datasetLibraryHint")}</p>
      {datasets.length === 0 ? <p className="note">{t("datasetLibraryEmpty")}</p> : <div className="dataset-library-grid">
        {datasets.map((dataset) => <div key={dataset.id} className="dataset-library-item">
          <DatasetPreviewCard dataset={datasetPreview(dataset)} statListClassName="dataset-preview-stats" badgeListClassName="dataset-preview-badges" />
          <div className="dataset-entry-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onLoad(dataset.input, dataset.name)}>{t("datasetReuse")}</button>
            <button className="btn btn-ghost" disabled={busy} aria-label={`${t("datasetRemove")} ${dataset.name}`} onClick={() => {
              void removeDataset(dataset.id).then(() => setDatasets((items) => items.filter((item) => item.id !== dataset.id))).catch(() => setStorageError(t("datasetStorageError")));
            }}>{t("datasetRemove")}</button>
          </div>
        </div>)}
      </div>}
    </section>
    <details className="dataset-canonical"><summary>{t("canonicalImport")}</summary>
      <p className="note">{t("canonicalHint")}</p>
      <button className="btn btn-outline" disabled={busy} onClick={() => canonical.current?.click()}>{t("browse")}</button>
      <input ref={canonical} type="file" accept=".json,application/json" className="visually-hidden" aria-label={t("canonicalImport")} onChange={(event) => { void read(Array.from(event.target.files ?? []), true); event.target.value = ""; }} />
    </details>
  </div>;
}
