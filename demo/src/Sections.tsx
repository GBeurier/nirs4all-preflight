import { useMemo, useState, type ReactNode } from "react";
import type { Locale } from "nirs4all-ui/lab";
import {
  AvailabilityBadge,
  AvailabilitySummary,
  CapabilityGrid,
  ChartDataTable,
  CheckList,
  ClassCountBars,
  EigenvalueScree,
  EvidenceTable,
  FindingList,
  MeasureBars,
  PopulationFlow,
  ProfileStatusBadge,
  RepeatabilityProfile,
  SCORE_SEQUENTIAL,
  ScoreMap,
  StatTile,
  TargetDistribution,
  extractIntegrity,
  extractObservationFlow,
  extractPca,
  extractRepeatability,
  extractRepeatabilityUncertainty,
  extractSamplePopulations,
  extractTarget,
  formatEngineNumber,
  metricLabel,
  observationFlowStages,
  samplePopulationStage,
  type CheckItem,
  type QualificationReportView,
  withRepeatabilityUncertainty,
} from "nirs4all-ui/qualification";
import { NoiseProxyCard } from "./Blocks";
import type { T } from "./App";
import { Icon, type IconName } from "./icons";
import { Measured } from "./Measured";
import { fill, type TextKey } from "./i18n";
import type { EngineInput } from "./input";
import { developmentTargetPoints, pcaPoints, type PcaColorBy } from "./views";

export interface Scope {
  t: T;
  locale: Locale;
  view: QualificationReportView;
  input: EngineInput;
  sourceId: string | null;
  targetId: string | null;
}

/** Counts exactly; other engine numbers with `digits` significant digits, exponent form outside [1e-4, 1e6). */
const num = (v: number | null, locale: Locale, digits = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toLocaleString(locale) : (formatEngineNumber(v, locale, digits) ?? "—");

export type Accent = "teal" | "cyan" | "indigo" | "amber" | "green" | "rose";

export function Section({ id, index, icon, accent = "teal", title, lead, children, aside }: { id: string; index?: string; icon?: IconName; accent?: Accent; title: string; lead?: string | undefined; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} className="section" aria-labelledby={`${id}-h`}>
      <header className="section-head">
        <div className="section-title">
          {icon ? <span className="section-icon" data-accent={accent}><Icon name={icon} size={22} /></span> : null}
          <div>
            {index ? <span className="eyebrow">{index}</span> : null}
            <h2 id={`${id}-h`}>{title}</h2>
            {lead ? <p className="lead">{lead}</p> : null}
          </div>
        </div>
        {aside ? <div className="section-aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

// --- diagnosis summary ------------------------------------------------------------------------

export function DiagnosisSummary({ t, locale, view, checks }: Scope & { checks: readonly CheckItem[] }) {
  return (
    <Section id="s-overview" icon="diagnosis" accent="teal" title={t("diagTitle")} lead={t("diagLead")}>
      <div className="grid-3-2">
        <div className="card card-feature">
          <CheckList items={checks} locale={locale} />
        </div>
        <div className="stack">
          <div className="card">
            <h3 className="card-title">{t("findings")} <span className="count">{view.findings.length}</span></h3>
            {view.findings.length ? <FindingList findings={view.findings} locale={locale} evidenceHref={(id) => `#ev-${id}`} /> : <p className="empty-ok">{t("noFindings")}</p>}
            {view.issues.length ? (
              <div className="issues">
                <h4>{t("validationIssues")}</h4>
                <ul>{view.issues.map((i, k) => <li key={`${i.code}${k}`}><code>{i.code}</code> {i.path} — {i.message}{i.blocking ? ` (${t("blocking")})` : ""}</li>)}</ul>
              </div>
            ) : null}
          </div>
          <div className="card">
            <h3 className="card-title">{t("availability")}</h3>
            <div className="profile-line"><ProfileStatusBadge status={view.profileStatus} locale={locale} />{view.completion ? <code>{view.completion}</code> : null}</div>
            <AvailabilitySummary counts={view.availabilityCounts} locale={locale} hideEmpty className="compact-summary" />
          </div>
        </div>
      </div>
    </Section>
  );
}

export function TechnicalSection({ t, view }: Scope) {
  const p = view.provenance;
  return (
    <div className="grid-2-1 tech">
      {view.limitations.length ? (
        <div className="card card-warm">
          <h3 className="card-title">{t("limitations")}</h3>
          <ul className="plain">{view.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : <div />}
      <div className="card">
        <h3 className="card-title">{t("provenance")}</h3>
        <dl className="prov-grid">
          <dt>engine</dt><dd>{p.engineVersion}</dd>
          <dt>protocols</dt><dd>{p.protocolBundleVersion}</dd>
          <dt>schema</dt><dd>v{p.schemaVersion}</dd>
          <dt>profile</dt><dd>{view.profileStatus}{view.completion ? ` · ${view.completion}` : ""}</dd>
        </dl>
      </div>
    </div>
  );
}

// --- 02 populations ---------------------------------------------------------------------------

export function PopulationsSection({ t, locale, view, sourceId }: Scope) {
  const pop = samplePopulationStage(extractSamplePopulations(view), locale);
  const flow = sourceId ? extractObservationFlow(view, sourceId) : null;
  return (
    <Section id="s-populations" icon="flow" accent="cyan" title={t("popTitle")} lead={t("popLead")}>
      <div className="card">
        {pop ? <Measured>{(w) => <PopulationFlow stages={[pop]} title={t("navPopulations")} locale={locale} width={w} />}</Measured> : null}
        {flow ? <div className="flow-gap"><Measured>{(w) => <PopulationFlow stages={observationFlowStages(flow, locale)} title={`${t("source")} ${flow.sourceId}`} locale={locale} width={w} />}</Measured></div> : null}
      </div>
    </Section>
  );
}

// --- 04 structure -----------------------------------------------------------------------------

const COLOR_MODES: readonly PcaColorBy[] = ["none", "campaign", "instrument", "target"];
const SCORE_TABLE_MAX = 500;

export function StructureSection({ t, locale, view, input, sourceId, targetId }: Scope) {
  const pca = sourceId ? extractPca(view, sourceId) : null;
  const [xi, setXi] = useState(0);
  const [yi, setYi] = useState(1);
  const [colorBy, setColorBy] = useState<PcaColorBy>("target");
  const k = pca?.scores[0]?.length ?? 0;
  const points = useMemo(() => (pca ? pcaPoints(input, pca, xi, Math.min(yi, k - 1), colorBy, targetId) : []), [input, pca, xi, yi, k, colorBy, targetId]);
  const unavailable = view.metrics.filter((m) => m.sourceId === sourceId && (m.id === "structure.pca" || m.id === "structure.pca_scores") && m.status !== "computed");
  const pcs = Array.from({ length: k }, (_, i) => i);
  const share = (i: number) => (pca?.eigenvalues && pca.totalVariance ? ` (${num(((pca.eigenvalues[i] ?? 0) / pca.totalVariance) * 100, locale, 3)} %)` : "");
  return (
    <Section id="s-structure" icon="structure" accent="indigo" title={t("structTitle")} lead={t("structLead")}>
      {!pca ? (
        <div className="card">{unavailable.length ? unavailable.map((m) => <p key={m.id}>{metricLabel(m.id, locale)} : <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></p>) : <p className="note">—</p>}</div>
      ) : (
        <>
          <div className="toolbar" role="group" aria-label={t("structTitle")}>
            <label>{t("axisX")}<select value={xi} onChange={(e) => setXi(Number(e.target.value))}>{pcs.map((i) => <option key={i} value={i}>PC{i + 1}</option>)}</select></label>
            <label>{t("axisY")}<select value={yi} onChange={(e) => setYi(Number(e.target.value))}>{pcs.map((i) => <option key={i} value={i}>PC{i + 1}</option>)}</select></label>
            <div className="seg" role="group" aria-label={t("colorBy")}>
              <span className="seg-label">{t("colorBy")}</span>
              {COLOR_MODES.filter((m) => m !== "target" || targetId).map((m) => (
                <button key={m} aria-pressed={colorBy === m} onClick={() => setColorBy(m)}>{t(`color_${m}` as TextKey)}</button>
              ))}
            </div>
          </div>
          <div className="grid-3-2">
            <div className="card">
              {k >= 2 ? (
                <Measured>{(w) => <ScoreMap
                  width={w}
                  height={Math.min(460, Math.max(300, w * 0.72))}
                  points={points}
                  colorBy={colorBy === "none" ? "none" : colorBy === "target" ? "value" : "group"}
                  xLabel={`PC${xi + 1}${share(xi)}`}
                  yLabel={`PC${Math.min(yi, k - 1) + 1}${share(Math.min(yi, k - 1))}`}
                  colorLabel={colorBy === "target" ? targetId ?? "" : t(`color_${colorBy}` as TextKey)}
                  title={`${t("scoreTable")} — ${pca.sourceId}`}
                  locale={locale}
                />}</Measured>
              ) : <p className="note">PC1</p>}
              <p className="hint">{t("hoverHint")}</p>
            </div>
            <div className="stack">
              <div className="stats stats-2">
                <StatTile label={t("scoreUnits")} value={num(pca.sampleIds.length, locale)} />
                <StatTile label={t("retained")} value={pca.retainedFraction !== null ? `${num(pca.retainedFraction * 100, locale, 4)} %` : "—"} hint={`${k} ${t("components")}`} />
                <StatTile label={t("kpiDim")} value={num(pca.effectiveDimension, locale)} hint={t("kpiDimHint")} />
              </div>
              {pca.eigenvalues ? (
                <div className="card">
                  <h3 className="card-title">{t("scree")}</h3>
                  <Measured>{(w) => <EigenvalueScree eigenvalues={pca.eigenvalues!} totalVariance={pca.totalVariance} title={t("scree")} locale={locale} width={w} height={Math.min(260, Math.max(200, w * 0.6))} />}</Measured>
                </div>
              ) : null}
            </div>
          </div>
          {pca.sampleIds.length > SCORE_TABLE_MAX ? <p className="note">{t("tableCap")} {SCORE_TABLE_MAX} / {pca.sampleIds.length}</p> : null}
          <ChartDataTable
            locale={locale}
            caption={`${t("scoreTable")} — ${pca.sourceId} (${pca.viewId})`}
            columns={[t("unitId"), ...pcs.map((i) => `PC${i + 1}`)]}
            rows={pca.sampleIds.slice(0, SCORE_TABLE_MAX).map((id, i) => [id, ...(pca.scores[i] ?? [])])}
          />
        </>
      )}
    </Section>
  );
}

// --- 05 repeatability -------------------------------------------------------------------------

export function RepeatSection(scope: Scope) {
  const { t, locale, view, input, sourceId } = scope;
  const source = input.sources.find((s) => s.source_id === sourceId);
  const uncertainty = sourceId ? extractRepeatabilityUncertainty(view, sourceId) : [];
  const contexts = sourceId ? withRepeatabilityUncertainty(extractRepeatability(view, sourceId), uncertainty) : [];
  const reasons = view.metrics.filter((m) => m.sourceId === sourceId && m.id.startsWith("measurement.") && !m.id.startsWith("measurement.noise_proxy") && m.status !== "computed");
  const counts = uncertainty.filter((u) => u.repeatCounts?.histogram.length);
  return (
    <Section id="s-repeat" icon="repeat" accent="green" title={t("repeatTitle")} lead={t("repeatLead")}>
      <div className="card">
        {contexts.length && source ? (
          <>
            <Measured>{(w) => <RepeatabilityProfile axis={source.axis} axisUnit={source.axis_unit ?? ""} contexts={contexts} title={`${t("repeatTitle")} — ${source.source_id}`} locale={locale} width={w} />}</Measured>
            <p className="hint">{t("hoverHint")}{contexts.some((c) => c.sdInterval || c.iccInterval) ? ` ${t("repeatUncertaintyHint")}` : ""}</p>
          </>
        ) : (
          <div className="empty">
            <p>{t("repeatNone")}</p>
          </div>
        )}
        {reasons.length ? <ul className="plain small">{reasons.map((m, i) => <li key={`${m.id}${i}`}>{metricLabel(m.id, locale)} : <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></li>)}</ul> : null}
      </div>
      {counts.length || source ? (
        <div className="grid-2 flow-gap-sm">
          {counts.map((u) => (
            <div className="card" key={u.id}>
              <h3 className="card-title">{metricLabel("measurement.repeat_counts", locale)} <span className="unit">· {u.id}</span></h3>
              <Measured>{(w) => <MeasureBars width={w} title={`${metricLabel("measurement.repeat_counts", locale)} — ${u.id}`} valueLabel={t("physicalGroups")} locale={locale} rows={u.repeatCounts!.histogram.map((h) => ({ id: String(h.r), label: fill(t("repeatsR"), { r: h.r }), value: h.nGroups }))} />}</Measured>
            </div>
          ))}
          {source ? <NoiseProxyCard {...scope} axis={source.axis} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

// --- 06 target --------------------------------------------------------------------------------

export function TargetSection({ t, locale, view, input, targetId }: Scope) {
  if (!targetId) return null;
  const target = extractTarget(view, targetId);
  const d = target.denominators;
  const points = developmentTargetPoints(input, targetId);
  const unavailable = view.metrics.filter((m) => m.targetId === targetId && m.status !== "computed");
  return (
    <Section id="s-target" icon="target" accent="amber" title={t("targetTitle")} lead={t("targetLead")}>
      <div className="stats">
        <StatTile label={t("eligible")} value={num(target.eligible, locale)} suffix={d.n_development_real_samples !== undefined ? `/ ${d.n_development_real_samples}` : undefined} />
        <StatTile label={t("excludedCensored")} value={num(d.n_excluded_censored ?? null, locale)} tone={(d.n_excluded_censored ?? 0) > 0 ? "warning" : "neutral"} />
        <StatTile label={t("excludedComposite")} value={num(d.n_excluded_composite ?? null, locale)} tone={(d.n_excluded_composite ?? 0) > 0 ? "warning" : "neutral"} />
        <StatTile label={t("inconsistent")} value={num(d.n_inconsistent_samples ?? null, locale)} tone={(d.n_inconsistent_samples ?? 0) > 0 ? "critical" : "neutral"} />
        {target.localContrast.map((c) => (
          <StatTile key={c.sourceId ?? ""} label={`${t("kpiContrast")} · ${c.sourceId ?? ""}`} value={num(c.value, locale)} hint={c.k ? `${t("kpiContrastHint")} = ${c.k}` : undefined} />
        ))}
      </div>
      <div className="card">
        <h3 className="card-title">{targetId}{target.unit ? <span className="unit"> ({target.unit})</span> : null}</h3>
        {target.classCounts ? (
          <Measured>{(w) => <ClassCountBars counts={target.classCounts!} title={targetId} width={w} />}</Measured>
        ) : (
          <Measured>{(w) => <TargetDistribution summary={target.summary} points={points} unit={target.unit} title={`${t("targetTitle")} — ${targetId}`} locale={locale} width={w} />}</Measured>
        )}
        {unavailable.length ? (
          <ul className="plain small">{unavailable.map((m, i) => <li key={`${m.id}${i}`}>{metricLabel(m.id, locale)} : <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></li>)}</ul>
        ) : null}
      </div>
    </Section>
  );
}

// --- 07 evidence ------------------------------------------------------------------------------

type StatusFilter = "all" | "computed" | "other";

export function EvidenceSection({ t, locale, view, initialQuery = "" }: Scope & { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState<StatusFilter>("all");
  const q = query.trim().toLowerCase();
  const shown = view.metrics.filter((m) =>
    (status === "all" || (status === "computed") === (m.status === "computed"))
    && (!q || m.id.toLowerCase().includes(q) || metricLabel(m.id, locale).toLowerCase().includes(q) || (m.sourceId ?? "").toLowerCase().includes(q) || (m.targetId ?? "").toLowerCase().includes(q)));
  return (
    <Section id="s-evidence" icon="evidence" accent="teal" title={t("evidenceTitle")} lead={t("evidenceLead")}>
      <div className="toolbar">
        <label className="search">
          <span className="visually-hidden">{t("search")}</span>
          <input type="search" placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label={t("filterStatus")}>
          {(["all", "computed", "other"] as const).map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{t(s === "all" ? "filterAll" : s === "computed" ? "statusComputed" : "statusOther")}</button>
          ))}
        </div>
        <span className="hint" role="status">{shown.length} / {view.metrics.length} {t("shown")}</span>
      </div>
      <div className="card card-flush">
        <EvidenceTable metrics={shown} provenance={view.provenance} locale={locale} />
      </div>
    </Section>
  );
}

// --- 08 capabilities --------------------------------------------------------------------------

export function CapabilitiesSection({ t, locale, view }: Scope) {
  return (
    <Section id="s-capabilities" icon="capability" accent="indigo" title={t("capTitle")} lead={view.capabilities.some((c) => c.qualified) ? undefined : t("capLead")}>
      <CapabilityGrid capabilities={view.capabilities} locale={locale} />
    </Section>
  );
}
