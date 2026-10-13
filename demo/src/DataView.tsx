import { useMemo, useState } from "react";
import type { Locale } from "nirs4all-ui/lab";
import { ClassCountBars, PopulationFlow, SCORE_SEQUENTIAL, SpectraExplorer, StatTile, TargetDistribution, type FlowSegment } from "nirs4all-ui/qualification";
import { categoricalColor, rampAt } from "nirs4all-ui/viz";
import type { T } from "./App";
import { fill, type TextKey } from "./i18n";
import { Icon } from "./icons";
import type { EngineInput } from "./input";
import { Measured } from "./Measured";
import { Section } from "./Sections";
import { ROW_KINDS, composition, developmentTargetPoints, developmentTargetValues, rowKind, sampleIndex, sampleRows, spectraPreview, type CountRow, type RowKind } from "./views";

type ColorBy = "target" | "campaign" | "instrument" | "none";
const EXPLORER_MAX = 200;
const TABLE_PAGE = 40;
const KIND_COLOR: Record<RowKind, string> = { development: "#0d9488", retained_test: "#0891b2", prediction: "#4f46e5", augmented: "#94a3b8", undeclared: "#e11d48" };
const NONE = "#0d9488";

const num = (v: number, locale: Locale) => (Number.isInteger(v) ? v.toLocaleString(locale) : Number(v.toPrecision(4)).toLocaleString(locale));

export function DataView({ t, locale, input, sourceId, targetId }: { t: T; locale: Locale; input: EngineInput; sourceId: string | null; targetId: string | null }) {
  const source = input.sources.find((s) => s.source_id === sourceId) ?? input.sources[0];
  const [colorBy, setColorBy] = useState<ColorBy>(targetId ? "target" : "campaign");
  const [selected, setSelected] = useState<string | null>(null);
  const preview = useMemo(() => (source ? spectraPreview(input, source, EXPLORER_MAX) : null), [input, source]);
  const comp = useMemo(() => composition(input, source), [input, source]);
  const values = useMemo(() => (targetId ? developmentTargetValues(input, targetId) : new Map<string, number>()), [input, targetId]);
  const samples = useMemo(() => sampleIndex(input), [input]);
  const observations = input.sources.reduce((n, s) => n + s.observation_ids.length, 0);

  const known = [...values.values()];
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 1;
  const groupKey = (sampleId: string) => (colorBy === "campaign" ? samples.get(sampleId)?.campaign : colorBy === "instrument" ? samples.get(sampleId)?.instrument : undefined) ?? "—";
  const groups = [...new Set((preview?.rows ?? []).map((r) => groupKey(r.sampleId)))].sort((a, b) => a.localeCompare(b));
  const colorOf = (sampleId: string) => {
    if (colorBy === "none") return NONE;
    if (colorBy === "target") {
      const v = values.get(sampleId);
      return v === undefined ? "#94a3b8" : rampAt(SCORE_SEQUENTIAL, (v - lo) / (hi - lo || 1));
    }
    return categoricalColor(groups.indexOf(groupKey(sampleId)));
  };
  const selectedObs = preview?.rows.filter((r) => r.sampleId === selected).map((r) => r.observationId) ?? [];
  const sampleOfObs = (obsId: string | null) => preview?.rows.find((r) => r.observationId === obsId)?.sampleId ?? null;

  const segments = (rows: CountRow[]): FlowSegment[] => rows.map((r, i) => ({ id: r.label, label: r.label, count: r.count, tone: "primary", color: categoricalColor(i) }));
  const partitionSegments: FlowSegment[] = ROW_KINDS.filter((k) => comp.partitions[k] > 0).map((k) => ({ id: k, label: t(`kind_${k}` as TextKey), count: comp.partitions[k], tone: "primary", color: KIND_COLOR[k] }));
  const repeatSegments: FlowSegment[] = [
    { id: "1", label: t("rep1"), count: comp.repeats.one, tone: "primary" },
    { id: "2", label: t("rep2"), count: comp.repeats.two, tone: "secondary" },
    { id: "3", label: t("rep3"), count: comp.repeats.more, tone: "violet" },
    { id: "0", label: t("rep0"), count: comp.repeats.none, tone: "muted" },
  ];

  return (
    <>
      <Section id="data-overview" icon="data" accent="teal" title={t("dataTitle")} lead={t("dataLead")}>
        <div className="stats stats-5">
          <StatTile label={t("tileSamples")} value={num(input.samples.length, locale)} hint={`${comp.partitions.development} ${t("kind_development")} · ${comp.partitions.retained_test} ${t("kind_retained_test")}`} />
          <StatTile label={t("tileObservations")} value={num(observations, locale)} hint={preview?.incompleteDevelopment ? fill(t("incompleteRows"), { n: preview.incompleteDevelopment }) : undefined} tone={preview?.incompleteDevelopment ? "warning" : "neutral"} />
          <StatTile label={t("tileBands")} value={num(source?.axis.length ?? 0, locale)} hint={source?.axis.length ? `${source.axis[0]}–${source.axis[source.axis.length - 1]} ${source.axis_unit ?? ""}` : undefined} />
          <StatTile label={t("tileTargets")} value={num(input.targets.length, locale)} hint={input.targets.map((x) => x.target_id).join(", ") || undefined} />
          <StatTile label={t("tileSources")} value={num(input.sources.length, locale)} hint={input.sources.map((s) => s.signal_type ?? s.source_id).join(", ")} />
        </div>
      </Section>

      {source && preview ? (
        <div className="grid-3-2 data-grid" id="data-spectra">
          <div className="card card-feature">
            <div className="card-head">
              <h3 className="card-title"><span className="card-icon" data-accent="cyan"><Icon name="spectra" size={18} /></span>{t("explorerTitle")}</h3>
              <div className="seg" role="group" aria-label={t("colorBy")}>
                {(["target", "campaign", "instrument", "none"] as const).filter((m) => m !== "target" || targetId).map((m) => (
                  <button key={m} aria-pressed={colorBy === m} onClick={() => setColorBy(m)}>{t(`color_${m}` as TextKey)}</button>
                ))}
              </div>
            </div>
            <Measured>{(w) => (
              <SpectraExplorer
                axis={source.axis}
                axisUnit={source.axis_unit ?? ""}
                yLabel={source.signal_unit ?? ""}
                series={preview.rows.map((r) => ({ id: r.observationId, values: r.values, color: colorOf(r.sampleId), label: `${r.sampleId}${targetId && values.has(r.sampleId) ? ` · ${targetId} ${num(values.get(r.sampleId) as number, locale)}` : ""}` }))}
                selected={selectedObs}
                onSelect={(obs) => setSelected(sampleOfObs(obs))}
                title={`${t("explorerTitle")} — ${source.source_id}`}
                locale={locale}
                width={w}
                height={Math.min(380, Math.max(260, w * 0.46))}
              />
            )}</Measured>
            <div className="explorer-foot">
              {colorBy === "target" && known.length ? (
                <div className="n4q-colorbar">
                  <span className="n4q-legend-title">{targetId}</span>
                  <span>{num(lo, locale)}</span>
                  <span className="n4q-colorbar-ramp" style={{ background: `linear-gradient(90deg, ${SCORE_SEQUENTIAL.join(", ")})` }} aria-hidden="true" />
                  <span>{num(hi, locale)}</span>
                </div>
              ) : null}
              {colorBy === "campaign" || colorBy === "instrument" ? (
                <ul className="n4q-legend">{groups.map((g, i) => <li key={g}><span className="n4q-key-line" style={{ background: categoricalColor(i) }} aria-hidden="true" />{g}</li>)}</ul>
              ) : null}
              {selected ? (
                <span className="pill-selected">{t("selected")} : <strong>{selected}</strong> <button onClick={() => setSelected(null)}>{t("clear")}</button></span>
              ) : null}
            </div>
            <p className="hint">{t("explorerHint")} {fill(t("explorerScope"), { n: preview.rows.length, total: source.x.length })}</p>
          </div>

          <div className="card">
            <h3 className="card-title"><span className="card-icon" data-accent="indigo"><Icon name="composition" size={18} /></span>{t("compositionTitle")}</h3>
            <div className="comp-list">
              <CompBar title={t("compPartitions")} segments={partitionSegments} locale={locale} />
              <CompBar title={t("compRepeats")} segments={repeatSegments} locale={locale} />
              <CompBar title={t("compCampaigns")} segments={segments(comp.campaigns)} locale={locale} />
              <CompBar title={t("compInstruments")} segments={segments(comp.instruments)} locale={locale} />
            </div>
          </div>
        </div>
      ) : null}

      {input.targets.length ? (
        <Section id="data-targets" icon="target" accent="amber" title={t("targetsTitle")} lead={t("targetsLead")}>
          <div className="target-cards">
            {input.targets.map((target) => {
              const points = developmentTargetPoints(input, target.target_id);
              const categories = target.kind === "categorical"
                ? target.values.reduce<Record<string, number>>((acc, v) => {
                    if (v.status === "exact" && v.category && rowKind(samples, v.sample_id) === "development") acc[v.category] = (acc[v.category] ?? 0) + 1;
                    return acc;
                  }, {})
                : null;
              return (
                <div key={target.target_id} className="card">
                  <div className="card-head">
                    <h3 className="card-title">{target.target_id}{target.unit ? <span className="unit"> ({target.unit})</span> : null}</h3>
                    <span className="chip">{t(target.kind === "categorical" ? "kindCategorical" : "kindContinuous")}</span>
                  </div>
                  <Measured>{(w) => (categories
                    ? <ClassCountBars counts={categories} title={target.target_id} width={w} />
                    : <TargetDistribution summary={null} points={points} unit={target.unit ?? null} title={target.target_id} locale={locale} width={w} />)}
                  </Measured>
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      <SampleTable t={t} locale={locale} input={input} sourceIndex={Math.max(0, input.sources.indexOf(source!))} selected={selected} onSelect={setSelected} />
    </>
  );
}

function CompBar({ title, segments, locale }: { title: string; segments: FlowSegment[]; locale: Locale }) {
  return (
    <div className="comp">
      <Measured min={200}>{(w) => <PopulationFlow stages={[{ id: title, label: title, unit: "", segments }]} title={title} locale={locale} width={w} barHeight={14} />}</Measured>
    </div>
  );
}

type SortKey = "sampleId" | "kind" | "instrument" | "campaign" | "observations";

function SampleTable({ t, locale, input, sourceIndex, selected, onSelect }: { t: T; locale: Locale; input: EngineInput; sourceIndex: number; selected: string | null; onSelect: (id: string | null) => void }) {
  const source = input.sources[sourceIndex];
  const rows = useMemo(() => sampleRows(input, source), [input, source]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<RowKind | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sampleId", dir: 1 });
  const [all, setAll] = useState(false);
  const q = query.trim().toLowerCase();
  const kinds = ROW_KINDS.filter((k) => rows.some((r) => r.kind === k));
  const shown = rows
    .filter((r) => (kind === "all" || r.kind === kind) && (!q || [r.sampleId, r.instrument, r.campaign].some((v) => v?.toLowerCase().includes(q))))
    .sort((a, b) => {
      const va = a[sort.key] ?? "";
      const vb = b[sort.key] ?? "";
      return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true })) * sort.dir;
    });
  const visible = all ? shown : shown.slice(0, TABLE_PAGE);
  const head = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="th-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}>
        {label}<span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</span>
      </button>
    </th>
  );
  const fmtRef = (v: { value: number | string | null; status: string } | "hidden") => {
    if (v === "hidden") return <span className="muted-cell">{t("hiddenValue")}</span>;
    if (v.value === null) return <span className="muted-cell">{t("missingRef")}</span>;
    const text = typeof v.value === "number" ? num(v.value, locale) : v.value;
    return v.status === "exact" ? text : <span className="ref-flag" data-status={v.status}>{text} <small>{v.status === "censored" || v.status === "composite" ? t(`ref_${v.status}`) : v.status}</small></span>;
  };
  return (
    <Section id="data-samples" icon="table" accent="green" title={t("tableTitle")}>
      <div className="toolbar">
        <label className="search">
          <span className="visually-hidden">{t("tableSearch")}</span>
          <input type="search" placeholder={t("tableSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label={t("colPartition")}>
          <button aria-pressed={kind === "all"} onClick={() => setKind("all")}>{t("filterAll")}</button>
          {kinds.map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`kind_${k}` as TextKey)}</button>)}
        </div>
        <span className="hint" role="status">{fill(t("rowsShown"), { n: visible.length, total: rows.length })}</span>
      </div>
      <div className="card card-flush">
        <div className="table-wrap" role="region" tabIndex={0} aria-label={t("tableTitle")}>
          <table className="samples">
            <thead>
              <tr>
                {head("sampleId", t("colSample"))}
                {head("kind", t("colPartition"))}
                {head("instrument", t("colInstrument"))}
                {head("campaign", t("colCampaign"))}
                {head("observations", t("colObs"))}
                {input.targets.map((x) => <th key={x.target_id} scope="col" className="num">{x.target_id}</th>)}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.sampleId} aria-selected={selected === r.sampleId} onClick={() => onSelect(selected === r.sampleId ? null : r.sampleId)}>
                  <th scope="row">
                    <button className="row-btn" onClick={(e) => { e.stopPropagation(); onSelect(selected === r.sampleId ? null : r.sampleId); document.getElementById("data-spectra")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{r.sampleId}</button>
                  </th>
                  <td><span className="kind-chip" style={{ ["--kind" as string]: KIND_COLOR[r.kind] }}>{t(`kind_${r.kind}` as TextKey)}</span></td>
                  <td>{r.instrument ?? "—"}</td>
                  <td>{r.campaign ?? "—"}</td>
                  <td className="num">{r.observations}{r.incomplete ? <span className="warn-dot" title={fill(t("incompleteRows"), { n: r.incomplete })}> ●</span> : null}</td>
                  {input.targets.map((x) => <td key={x.target_id} className="num">{fmtRef(r.targets[x.target_id] ?? "hidden")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!all && shown.length > TABLE_PAGE ? <button className="btn btn-ghost show-all" onClick={() => setAll(true)}>{fill(t("showAll"), { n: shown.length })}</button> : null}
      </div>
    </Section>
  );
}
