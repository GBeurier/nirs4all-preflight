// Diagnosis sections of the preflight 0.1.0 capability blocks. Display only: every number
// is an engine value read by the nirs4all-ui selectors; nothing is recomputed here.
import { useMemo, type ReactNode } from "react";
import type { Locale } from "nirs4all-ui/lab";
import {
  AvailabilityBadge,
  ChartDataTable,
  CheckList,
  ComparisonMatrix,
  EigenvalueScree,
  HypothesisTestTable,
  MeasureBars,
  ReplicateHistogram,
  ScoreMap,
  StatTile,
  extractAssociationFamily,
  extractAssociations,
  extractClustering,
  extractConfounding,
  extractDomainShift,
  extractDuplicates,
  extractPca,
  extractProbes,
  extractStructureSensitivity,
  formatEngineNumber,
  formatEngineNumberExact,
  formatPValue,
  hasBlock,
  metricHelp,
  metricLabel,
  reasonLabel,
  statisticLabel,
  unavailableMetrics,
  type EngineNumber,
  type HypothesisTestRow,
  type MetricState,
  type PermutationTestView,
  type QualificationMetricView,
  type ScorePoint,
} from "nirs4all-ui/qualification";
import { fill, isTextKey, type TextKey } from "./i18n";
import { Measured } from "./Measured";
import { Section, type Scope } from "./Sections";
import { DomainShiftView } from "./characterization/domains";
import { exactDuplicatePairs, type ExactPairSide } from "./views";


/** Counts exactly; other engine numbers with `digits` significant digits, exponent form outside [1e-4, 1e6). */
const n = (v: number | null | undefined, locale: Locale, digits = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toLocaleString(locale) : (formatEngineNumber(v, locale, digits) ?? "—");
/** Table cell: keep the raw engine value; the shared table handles display formatting. */
const cellNumber = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
const pc = (v: number | null | undefined, locale: Locale) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${n(v * 100, locale, 3)} %`);
const en = (v: EngineNumber | null, locale: Locale) => (v ? (formatEngineNumber(v.kind === "double" ? v.value : { significand: v.significand, exponent: v.exponent, representation: "significand_times_2_pow_exponent" }, locale) ?? "—") : "—");

/** Sections present in the report, in display order (drives the chip navigation). */
export const BLOCK_SECTIONS: readonly { id: string; label: TextKey; prefixes: readonly string[] }[] = [
  { id: "s-sensitivity", label: "navSensitivity", prefixes: ["structure.snv_", "structure.detrend_", "structure.balanced_repeat_sensitivity"] },
  { id: "s-duplicates", label: "navDuplicates", prefixes: ["integrity.cross_partition_exact_duplicate_pairs", "integrity.cross_physical_exact_duplicate_pairs", "integrity.quasi_duplicate_pairs", "integrity.cross_partition_quasi_duplicate_pairs", "reference."] },
  { id: "s-clustering", label: "navClustering", prefixes: ["clustering."] },
  { id: "s-confounding", label: "navConfounding", prefixes: ["confounding."] },
  { id: "s-shift", label: "navShift", prefixes: ["domain_shift."] },
  { id: "s-association", label: "navAssociation", prefixes: ["association."] },
  { id: "s-probe", label: "navProbe", prefixes: ["probe."] },
  { id: "s-quality", label: "navQuality", prefixes: ["intrinsic."] },
];

export const presentSections = (s: Scope) => BLOCK_SECTIONS.filter((b) => hasBlock(s.view, b.prefixes));

function Help({ id, locale }: { id: string; locale: Locale }) {
  const text = metricHelp(id, locale);
  return text ? <p className="hint help">{text}</p> : null;
}

function CardTitle({ id, locale, children }: { id: string; locale: Locale; children?: ReactNode }) {
  return (
    <>
      <h3 className="card-title">{metricLabel(id, locale)}{children}</h3>
      <Help id={id} locale={locale} />
    </>
  );
}

function Unavailable({ metrics, locale }: { metrics: readonly QualificationMetricView[]; locale: Locale }) {
  if (!metrics.length) return null;
  const seen = new Set<string>();
  const rows = metrics.filter((m) => {
    const key = `${m.id}|${m.status}|${m.reasonCode ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return <ul className="plain small unavailable">{rows.map((m) => <li key={`${m.id}${m.reasonCode}`}>{metricLabel(m.id, locale)} : <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></li>)}</ul>;
}

function StateBadge({ state, locale }: { state: MetricState; locale: Locale }) {
  return <AvailabilityBadge status={state.status} reason={state.reasonCode} locale={locale} />;
}

/** One row of the shared hypothesis-test table. */
function testRow(t: PermutationTestView, label: string, effectSize: HypothesisTestRow["effectSize"], locale: Locale, blocks: string): HypothesisTestRow {
  return {
    id: `${t.test}|${t.factor}`,
    effect: t.factor,
    test: label,
    status: t.state.status,
    reasonCode: t.state.reasonCode,
    statistic: t.statistic === null && !t.statisticName ? null : { label: statisticLabel(t.statisticName ?? "", locale), value: t.statistic },
    effectSize,
    pValue: t.pValue,
    pAdjusted: t.pValueHolm,
    rejects: t.rejects,
    note: t.nPermutations ? `${n(t.nPermutations, locale)} permutations${t.restrictions === "within_blocks" ? ` · ${blocks}` : ""}` : undefined,
  };
}

// --- SNV and balanced-repeat sensitivity -----------------------------------------------------

export function SensitivitySection({ t, locale, view, sourceId }: Scope) {
  if (!sourceId || !hasBlock(view, BLOCK_SECTIONS[0]!.prefixes)) return null;
  const sens = extractStructureSensitivity(view, sourceId);
  const snv = sens.find((c) => c.id === "structure.snv_sensitivity");
  const baseline = view.metrics.find((m) => m.sourceId === sourceId && m.id === "structure.detrend_sensitivity");
  const baselineValue = baseline?.value as { canonical?: { effective_dimension?: number; eigenvalue_shares?: number[] }; detrended?: { effective_dimension?: number; eigenvalue_shares?: number[] } } | undefined;
  const balanced = sens.find((c) => c.id === "structure.balanced_repeat_sensitivity");
  return (
    <Section id="s-sensitivity" icon="structure" accent="indigo" title={t("sensTitle")} lead={t("sensLead")}>
      <div className="grid-2">
        {snv ? (
          <div className="card">
            <CardTitle id="structure.snv_sensitivity" locale={locale} />
            {snv.state.status === "computed" && snv.reference && snv.compared ? (
              <>
                <div className="stats stats-2">
                  <StatTile label={t("sensDimRaw")} value={n(snv.reference.effectiveDimension, locale)} hint={t("kpiDimHint")} />
                  <StatTile label={t("sensDimSnv")} value={n(snv.compared.effectiveDimension, locale)} hint={`Δ ${n(snv.deltaEffectiveDimension, locale)}`} tone="neutral" />
                  <StatTile label={t("sensPc1")} value={pc(snv.compared.firstComponentShare, locale)} hint={`${t("sensRaw")} ${pc(snv.reference.firstComponentShare, locale)}`} />
                </div>
                <Measured>{(w) => (
                  <MeasureBars
                    width={w}
                    format="fraction"
                    title={t("sensShares")}
                    valueLabel={t("sensSnv")}
                    compareLabel={t("sensRaw")}
                    locale={locale}
                    rows={snv.compared!.eigenvalueShares.slice(0, 6).map((v, i) => ({ id: `pc${i}`, label: `PC${i + 1}`, value: v, compare: snv.reference!.eigenvalueShares[i] ?? null }))}
                  />
                )}</Measured>
                {snv.snvEigenvalues ? (
                  <Measured>{(w) => <EigenvalueScree eigenvalues={snv.snvEigenvalues!} totalVariance={snv.snvTotalVariance} title={metricLabel("structure.snv_pca_eigenvalues", locale)} locale={locale} width={w} height={Math.min(240, Math.max(190, w * 0.5))} />}</Measured>
                ) : null}
                <ChartDataTable
                  locale={locale}
                  caption={t("sensShares")}
                  columns={[t("component"), t("sensRaw"), t("sensSnv")]}
                  rows={snv.compared.eigenvalueShares.map((v, i) => [`PC${i + 1}`, cellNumber(snv.reference!.eigenvalueShares[i]), cellNumber(v)])}
                />
              </>
            ) : <p className="empty"><StateBadge state={snv.state} locale={locale} /></p>}
          </div>
        ) : null}
        {balanced ? (
          <div className="card">
            <CardTitle id="structure.balanced_repeat_sensitivity" locale={locale} />
            {balanced.state.status === "computed" && balanced.reference && balanced.compared ? (
              <>
                <div className="stats stats-2">
                  <StatTile label={t("sensRStar")} value={n(balanced.rStar, locale)} hint={t("sensRStarHint")} />
                  <StatTile label={t("sensDimBalanced")} value={n(balanced.compared.effectiveDimension, locale)} hint={`Δ ${n(balanced.deltaEffectiveDimension, locale)}`} />
                  <StatTile label={t("sensPc1")} value={pc(balanced.compared.firstComponentShare, locale)} hint={`${t("sensRaw")} ${pc(balanced.reference.firstComponentShare, locale)}`} />
                </div>
                {balanced.repeatHistogram.length ? (
                  <Measured>{(w) => <MeasureBars width={w} title={t("repeatCounts")} valueLabel={t("repeatCounts")} locale={locale} rows={balanced.repeatHistogram.map((h) => ({ id: String(h.r), label: fill(t("repeatsR"), { r: h.r }), value: h.nSamples }))} />}</Measured>
                ) : null}
              </>
            ) : <p className="empty"><StateBadge state={balanced.state} locale={locale} /></p>}
          </div>
        ) : null}
      </div>
      {baseline ? <div className="card"><h3 className="card-title">Linear baseline correction</h3><p className="hint">A straight baseline is removed from each acquisition before repeats are averaged. Compare the remaining variance with raw spectra. A change suggests baseline effects deserve inspection; it does not establish their cause.</p>{baseline.status === "computed" ? <><div className="stats"><StatTile label="Raw effective dimension" value={n(baselineValue?.canonical?.effective_dimension, locale)} /><StatTile label="After linear baseline correction" value={n(baselineValue?.detrended?.effective_dimension, locale)} /></div>{baselineValue?.detrended?.eigenvalue_shares?.length ? <Measured>{(w) => <MeasureBars width={w} format="fraction" title="Variance shares per component" valueLabel="after baseline correction" compareLabel={t("sensRaw")} locale={locale} rows={baselineValue.detrended!.eigenvalue_shares!.slice(0, 6).map((v, i) => ({ id: `pc${i}`, label: `PC${i + 1}`, value: v, compare: baselineValue.canonical?.eigenvalue_shares?.[i] ?? null }))} />}</Measured> : null}<ChartDataTable locale={locale} caption="Raw and baseline-corrected structure" columns={["Component", "Raw variance share", "After baseline correction"]} rows={(baselineValue?.detrended?.eigenvalue_shares ?? []).map((v, i) => [`PC${i + 1}`, baselineValue?.canonical?.eigenvalue_shares?.[i] ?? null, v])} /></> : <AvailabilityBadge status={baseline.status} reason={baseline.reasonCode} locale={locale} />}</div> : null}
      <Unavailable metrics={unavailableMetrics(view, ["structure.snv_"], sourceId)} locale={locale} />
    </Section>
  );
}

// --- exact duplicates, near duplicates and reference conflicts --------------------------------

const EXACT_IDS = ["integrity.cross_partition_exact_duplicate_pairs", "integrity.cross_physical_exact_duplicate_pairs"] as const;
/** Reasons meaning "the user did not set the tolerance", never an all-clear. */
const TOLERANCE_REASONS: Partial<Record<string, TextKey>> = {
  QUASI_DUPLICATE_TOLERANCE_NOT_DECLARED: "dupSetSimilarity",
  REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED: "dupSetReference",
};
const pairSide = (s: ExactPairSide) => (s.physicalId === s.sampleId ? s.sampleId : `${s.sampleId} (physical ${s.physicalId})`);

export function DuplicatesSection({ t, locale, view, input, sourceId, onOpenSettings }: Scope & { onOpenSettings?: (() => void) | undefined }) {
  const exact = EXACT_IDS.map((id) => view.metrics.find((m) => m.id === id && m.sourceId === sourceId) ?? null);
  const flagged = exact.some((m) => m?.status === "computed" && typeof m.value === "number" && m.value > 0);
  // The report carries exact counts only; the pairs are listed from the loaded spectra when the engine flags any.
  const pairs = useMemo(() => (flagged && sourceId ? exactDuplicatePairs(input, sourceId) : null), [flagged, input, sourceId]);
  if (!sourceId || !hasBlock(view, BLOCK_SECTIONS[1]!.prefixes)) return null;
  const all = extractDuplicates(view, sourceId);
  const computed = all.filter((d) => d.state.status === "computed");
  const missing = unavailableMetrics(view, BLOCK_SECTIONS[1]!.prefixes, sourceId);
  const notEvaluated = missing.filter((m) => m.reasonCode && TOLERANCE_REASONS[m.reasonCode]);
  const [partition, physical] = exact;
  const count = (m: QualificationMetricView | null) => (m?.status === "computed" && typeof m.value === "number" ? m.value : null);
  const leak = count(partition ?? null);
  const dup = count(physical ?? null);
  const d = (m: QualificationMetricView | null | undefined, k: string) => m?.denominators[k] ?? null;
  const listing = [
    { metric: partition, total: leak, list: pairs?.crossPartition, columns: [t("dupCalSample"), t("dupCalObs"), t("dupTestSample"), t("dupTestObs")] },
    { metric: physical, total: dup, list: pairs?.crossPhysical, columns: [t("dupSampleA"), t("dupObsA"), t("dupSampleB"), t("dupObsB")] },
  ].filter((x) => x.metric && (x.total ?? 0) > 0);
  return (
    <Section id="s-duplicates" icon="evidence" accent="rose" title={t("dupTitle")} lead={t("dupLead")}>
      {partition || physical ? (
        <div className={`card${(leak ?? 0) > 0 ? " card-critical" : (dup ?? 0) > 0 ? " card-warm" : ""}`} id="dup-exact">
          <h3 className="card-title">{t("dupExactTitle")}</h3>
          <p className="hint help">{t("dupExactExplain")}</p>
          <div className="stats">
            {partition ? (
              <StatTile
                label={metricLabel(partition.id, locale)}
                value={leak === null ? <StateBadge state={{ status: partition.status, reasonCode: partition.reasonCode }} locale={locale} /> : n(leak, locale)}
                suffix={leak === null ? undefined : t("dupPairs")}
                hint={leak === null ? undefined : fill(t("dupPartitionHint"), { a: n(d(partition, "n_affected_development_observations"), locale), nd: n(d(partition, "n_development_observations"), locale), b: n(d(partition, "n_affected_retained_test_observations"), locale), nt: n(d(partition, "n_retained_test_observations"), locale) })}
                tone={leak === null ? "neutral" : leak > 0 ? "critical" : "good"}
                href={`#ev-${partition.id}`}
              />
            ) : null}
            {physical ? (
              <StatTile
                label={metricLabel(physical.id, locale)}
                value={dup === null ? <StateBadge state={{ status: physical.status, reasonCode: physical.reasonCode }} locale={locale} /> : n(dup, locale)}
                suffix={dup === null ? undefined : t("dupPairs")}
                hint={dup === null ? undefined : fill(t("dupPhysicalHint"), { nd: n(d(physical, "n_development_observations"), locale) })}
                tone={dup === null ? "neutral" : dup > 0 ? "warning" : "good"}
                href={`#ev-${physical.id}`}
              />
            ) : null}
          </div>
          {listing.map(({ metric, total, list, columns }) => list && list.total === total ? (
            <ChartDataTable
              key={metric!.id}
              open
              locale={locale}
              caption={`${metricLabel(metric!.id, locale)}${list.listed.length < list.total ? ` — ${fill(t("dupFirstPairs"), { k: list.listed.length, n: list.total })}` : ""}`}
              columns={columns}
              rows={list.listed.map(([a, b]) => [pairSide(a), a.observationId, pairSide(b), b.observationId])}
            />
          ) : <p className="hint" key={metric!.id}>{fill(t("dupListUnavailable"), { n: total ?? 0 })}</p>)}
        </div>
      ) : null}
      {computed.length ? <div className="stats">
        {computed.map((d) => {
          const nothing = d.candidatePairs === 0;
          return (
            <StatTile
              key={`${d.id}${d.targetId ?? ""}`}
              label={`${metricLabel(d.id, locale)}${d.targetId ? ` · ${d.targetId}` : ""}`}
              value={n(d.pairs, locale)}
              suffix={d.candidatePairs !== null ? `/ ${n(d.candidatePairs, locale)}` : undefined}
              hint={nothing ? t("dupNothingCompared") : d.tolerance !== null ? fill(t("dupTolerance"), { tol: n(d.tolerance, locale), unit: d.toleranceUnit ?? "" }) : undefined}
              tone={(d.pairs ?? 0) > 0 ? (d.id === "integrity.cross_partition_quasi_duplicate_pairs" ? "critical" : "warning") : nothing ? "neutral" : "good"}
              href={`#ev-${d.id}`}
            />
          );
        })}
      </div> : null}
      <div className="grid-2">
        {computed.filter((d) => d.listed.length).map((d) => (
          <div className="card" key={`list-${d.id}${d.targetId ?? ""}`}>
            <CardTitle id={d.id} locale={locale}>{d.targetId ? <span className="unit"> · {d.targetId}</span> : null}</CardTitle>
            <ChartDataTable
              open
              locale={locale}
              caption={`${metricLabel(d.id, locale)}${d.truncated ? d.pairs !== null ? ` — first ${d.listed.length} of ${d.pairs} pairs` : ` (${t("truncated")}; total unavailable)` : ""}`}
              columns={d.id.startsWith("integrity.") ? [t("dupA"), t("dupB"), t("dupRms")] : [t("dupA"), t("dupB"), t("dupRefA"), t("dupRefB"), t("dupDiff"), t("dupRms")]}
              rows={d.listed.map((p) => (d.id.startsWith("integrity.") ? [p.a, p.b, cellNumber(p.distance)] : [p.a, p.b, cellNumber(p.referenceA), cellNumber(p.referenceB), cellNumber(p.difference), cellNumber(p.distance)]))}
            />
          </div>
        ))}
      </div>
      {notEvaluated.length ? (
        <ul className="plain small unavailable not-evaluated">
          {[...new Map(notEvaluated.map((m) => [`${m.id}|${m.reasonCode}`, m])).values()].map((m) => (
            <li key={`${m.id}${m.reasonCode}`}>{metricLabel(m.id, locale)} : <strong>{t(TOLERANCE_REASONS[m.reasonCode!]!)}</strong> <code>{m.reasonCode}</code></li>
          ))}
          {onOpenSettings ? <li><button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSettings}>{t("dupOpenSettings")}</button></li> : null}
        </ul>
      ) : null}
      <Unavailable metrics={missing.filter((m) => !notEvaluated.includes(m))} locale={locale} />
    </Section>
  );
}

// --- clustering ------------------------------------------------------------------------------

const VERDICT: Record<string, TextKey> = {
  no_density_separated_groups: "verdictNone",
  compatible_with_fitted_gaussian: "verdictGaussian",
  stable_candidate_versus_fitted_gaussian: "verdictStable",
  uncertain_partition: "verdictUncertain",
};

export function ClusteringSection({ t, locale, view, sourceId }: Scope) {
  if (!sourceId || !hasBlock(view, ["clustering."])) return null;
  const c = extractClustering(view, sourceId);
  const pca = extractPca(view, sourceId);
  const missing = unavailableMetrics(view, ["clustering."], sourceId);
  const label = (l: number) => (l === (c?.partition?.noiseLabel ?? -1) ? t("noise") : fill(t("clusterN"), { n: l }));
  const points: ScorePoint[] = [];
  if (c?.partition && pca && (pca.scores[0]?.length ?? 0) >= 2) {
    const at = new Map(pca.sampleIds.map((id, i) => [id, pca.scores[i]!]));
    c.partition.sampleIds.forEach((id, i) => {
      const row = at.get(id);
      if (!row) return;
      const l = c.partition!.labels[i] ?? -1;
      points.push({ id, x: row[0] ?? Number.NaN, y: row[1] ?? Number.NaN, group: label(l), details: [`${t("membership")} ${n(c.partition!.membership[i] ?? null, locale)}`, `GLOSH ${n(c.partition!.outlierScores[i] ?? null, locale)}`] });
    });
  }
  const threshold = c?.assessment?.criteria.find((k) => k.id === "lowest_appearance_frequency_scaled")?.threshold ?? null;
  const ariThreshold = c?.assessment?.criteria.find((k) => k.id === "median_ari_scaled")?.threshold ?? null;
  return (
    <Section id="s-clustering" icon="structure" accent="cyan" title={t("clusTitle")} lead={t("clusLead")}>
      {!c || !c.partition ? (
        <div className="card"><Unavailable metrics={missing} locale={locale} /></div>
      ) : (
        <>
          <div className="stats">
            <StatTile label={metricLabel("clustering.candidate_cluster_count", locale)} value={n(c.candidateCount, locale)} hint={t("clusNotFirm")} href="#ev-clustering.candidate_cluster_count" />
            {(c.candidateCount ?? 0) > 0 ? <StatTile label="Outside candidate groups" value={pc(c.noiseFraction, locale)} suffix={c.nNoise !== null ? `${c.nNoise} / ${c.nEligible ?? "—"}` : undefined} hint="Samples not assigned to a candidate group; this is unrelated to measurement noise." /> : null}
            <StatTile label={t("verdict")} value={c.assessment?.verdict ? t(VERDICT[c.assessment.verdict] ?? "verdictUncertain") : "—"} hint={t("verdictHint")} tone={c.assessment?.verdict === "stable_candidate_versus_fitted_gaussian" ? "good" : "neutral"} href="#ev-clustering.partition_assessment" />
          </div>
          <div className="grid-3-2">
            <div className="card">
              <CardTitle id="clustering.partition" locale={locale} />
              {points.length ? (
                <Measured>{(w) => <ScoreMap width={w} height={Math.min(420, Math.max(280, w * 0.66))} points={points} colorBy="group" groupColors={{ [t("noise")]: "#94a3b8" }} xLabel="PC1" yLabel="PC2" colorLabel={t("navClustering")} title={metricLabel("clustering.partition", locale)} locale={locale} />}</Measured>
              ) : <p className="note">{t("clusNoScores")}</p>}
              <ChartDataTable
                locale={locale}
                caption={metricLabel("clustering.partition", locale)}
                columns={[t("unitId"), t("navClustering"), t("membership"), "GLOSH"]}
                rows={c.partition.sampleIds.map((id, i) => [id, label(c.partition!.labels[i] ?? -1), cellNumber(c.partition!.membership[i]), cellNumber(c.partition!.outlierScores[i])])}
              />
            </div>
            <div className="fit-row">
              {c.assessment ? (
                <div className="card">
                  <CardTitle id="clustering.partition_assessment" locale={locale} />
                  <div className="scroll-body"><CheckList
                    locale={locale}
                    items={c.assessment.criteria.map((k) => ({
                      id: k.id,
                      status: k.passed === null ? "unavailable" : k.passed ? "ok" : "attention",
                      title: isTextKey(`crit_${k.id}`) ? t(`crit_${k.id}` as TextKey) : k.id,
                      detail: typeof k.value === "boolean" ? (k.value ? t("yes") : t("no")) : `${n(k.value, locale)}${k.threshold !== null ? ` · ${t("threshold")} ${n(k.threshold, locale)}` : ""}`,
                    }))}
                  /></div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="grid-2">
            <div className="card">
              <CardTitle id="clustering.cluster_appearance_frequency" locale={locale} />
              <Measured>{(w) => (
                <MeasureBars
                  width={w}
                  format="fraction"
                  title={metricLabel("clustering.cluster_appearance_frequency", locale)}
                  valueLabel={t("paramsScaled")}
                  compareLabel={t("paramsConstant")}
                  intervalLabel={t("jaccardIqr")}
                  reference={threshold !== null ? { value: threshold, label: t("threshold") } : null}
                  locale={locale}
                  rows={c.appearance.scaled.map((a) => {
                    const constant = c.appearance.constant.find((x) => x.label === a.label);
                    return { id: String(a.label), label: label(a.label), value: a.frequency, low: a.matchedJaccard?.q25 ?? null, high: a.matchedJaccard?.q75 ?? null, compare: constant?.frequency ?? null, note: `${a.nAppeared ?? "—"} / ${a.nEvaluable ?? "—"} · ${a.nMembers ?? "—"} ${t("members")}` };
                  })}
                />
              )}</Measured>
            </div>
            <div className="card">
              <CardTitle id="clustering.subsample_stability" locale={locale} />
              <Measured>{(w) => (
                <MeasureBars
                  width={w}
                  format="fraction"
                  domain={{ min: Math.min(0, c.stability.scaled?.ari?.min ?? 0, c.stability.constant?.ari?.min ?? 0), max: 1 }}
                  title={metricLabel("clustering.subsample_stability", locale)}
                  valueLabel={t("ariMedian")}
                  intervalLabel={t("iqr")}
                  reference={ariThreshold !== null ? { value: ariThreshold, label: t("threshold") } : null}
                  locale={locale}
                  rows={([["scaled", c.stability.scaled], ["constant", c.stability.constant]] as const).map(([k, s]) => ({
                    id: k,
                    label: t(k === "scaled" ? "paramsScaled" : "paramsConstant"),
                    value: s?.ari?.median ?? null,
                    low: s?.ari?.q25 ?? null,
                    high: s?.ari?.q75 ?? null,
                    note: s ? fill(t("ariNote"), { n: s.nAriEvaluable ?? "—", total: s.nSubsamples ?? "—", f: pc(s.assignedInBothFraction?.median, locale) }) : undefined,
                  }))}
                />
              )}</Measured>
            </div>
          </div>
          {c.nullModel ? (
            <div className="card">
              <CardTitle id="clustering.gaussian_null_model" locale={locale} />
              <Measured>{(w) => (
                <ReplicateHistogram
                  width={w}
                  values={c.nullModel!.replicates}
                  observed={c.nullModel!.observed}
                  observedNote={`${t("tailFraction")} ${n(c.nullModel!.tailFraction, locale)}${c.nullModel!.decisional === false ? ` · ${t("descriptiveOnly")}` : ""}`}
                  title={metricLabel("clustering.gaussian_null_model", locale)}
                  valueLabel={t("coverageStability")}
                  locale={locale}
                />
              )}</Measured>
            </div>
          ) : null}
          <Unavailable metrics={missing} locale={locale} />
        </>
      )}
    </Section>
  );
}

// --- confounding -----------------------------------------------------------------------------

const TEST_LABEL: Record<string, TextKey> = {
  "confounding.permanova_marginal_test": "testMarginal",
  "confounding.permanova_conditional_test": "testConditional",
  "confounding.permanova_freedman_lane_test": "testFreedmanLane",
  "confounding.permdisp_test": "testPermdisp",
};

export function ConfoundingSection({ t, locale, view, sourceId }: Scope) {
  if (!sourceId || !hasBlock(view, ["confounding."])) return null;
  const c = extractConfounding(view, sourceId);
  const missing = unavailableMetrics(view, ["confounding.design", "confounding.variance_partition", "confounding.dispersion"], sourceId);
  if (!c) return null;
  const share = (factor: string) => c.partition?.shares.find((s) => s.factor === factor) ?? null;
  const rows = c.tests.map((x) => testRow(x, t(TEST_LABEL[x.test] ?? "testMarginal"), x.test === "confounding.permdisp_test" ? null : { label: x.test === "confounding.permanova_marginal_test" ? "R²" : "R² unique", value: x.test === "confounding.permanova_marginal_test" ? (share(x.factor)?.r2Marginal ?? null) : x.test === "confounding.permanova_conditional_test" ? (share(x.factor)?.r2UniqueGivenOtherFactors ?? null) : (share(x.factor)?.r2UniqueGivenOtherMainEffects ?? null) }, locale, t("withinBlocks")));
  const alpha = c.families[0]?.alpha ?? null;
  return (
    <Section id="s-confounding" icon="composition" accent="amber" title={t("confTitle")} lead={t("confLead")}>
      <div className="grid-2">
        <div className="card">
          <CardTitle id="confounding.design" locale={locale} />
          <ul className="plain">
            {c.factors.map((f) => (
              <li key={f.factor}>
                <strong>{f.factor}</strong> — {f.levels.map((l) => `${l.level} (${l.nUnits ?? "—"})`).join(", ")}
                {f.aliasedWithOtherFactorCells ? <span className="tag tag-warn">{fill(t("aliasedWith"), { f: f.determinedBy.join(", ") || "—" })}</span> : null}
                {f.identifiableUnderAdditiveModel === false ? <span className="tag tag-warn">{t("notIdentifiableAdditive")}</span> : null}
              </li>
            ))}
          </ul>
          {c.crossings.map((x) => {
            const cols = [...new Set(Object.values(x.unitCounts).flatMap((r) => Object.keys(r)))].sort();
            return <ChartDataTable key={x.factors.join("×")} open locale={locale} caption={`${t("crossing")} ${x.factors.join(" × ")}`} columns={[x.factors[0] ?? "", ...cols]} rows={Object.entries(x.unitCounts).map(([k, r]) => [k, ...cols.map((col) => r[col] ?? 0)])} />;
          })}
        </div>
        {c.partition ? (
          <div className="card">
            <CardTitle id="confounding.variance_partition" locale={locale} />
            <Measured>{(w) => (
              <MeasureBars
                width={w}
                format="fraction"
                title={metricLabel("confounding.variance_partition", locale)}
                valueLabel={t("r2Marginal")}
                compareLabel={t("r2Unique")}
                reference={c.partition!.r2AllFactorCells !== null ? { value: c.partition!.r2AllFactorCells, label: t("r2Joint") } : null}
                locale={locale}
                rows={c.partition!.shares.map((s) => ({ id: s.factor, label: s.factor, value: s.r2Marginal, compare: s.r2UniqueGivenOtherFactors, note: s.reasonCode ? reasonLabel(s.reasonCode) : undefined }))}
              />
            )}</Measured>
            <p className="hint">{t("notAdditive")}</p>
          </div>
        ) : null}
      </div>
      {rows.length ? (
        <div className="card card-flush">
          <HypothesisTestTable rows={rows} caption={t("confTests")} alpha={alpha} locale={locale} />
        </div>
      ) : null}
      {c.dispersion.some((d) => d.state.status === "computed") ? (
        <ChartDataTable
          locale={locale}
          caption={metricLabel("confounding.dispersion", locale)}
          columns={[t("factor"), t("level"), t("meanDistance"), t("units")]}
          rows={c.dispersion.flatMap((d) => d.levels.map((l) => [d.factor, l.level, cellNumber(l.meanDistance), l.nUnits]))}
        />
      ) : null}
      <Unavailable metrics={missing} locale={locale} />
    </Section>
  );
}

// --- domain shift ----------------------------------------------------------------------------

export function DomainShiftSection(scope: Scope & { onOpenSettings?: (() => void) | undefined }) {
  const { t, locale, view, sourceId } = scope;
  if (!sourceId || !hasBlock(view, ["domain_shift."])) return null;
  const factors = extractDomainShift(view, sourceId);
  const tests: HypothesisTestRow[] = factors.filter((f) => f.test).map((f) => ({
    id: f.factor,
    effect: f.audit ? t("auditFactor") : f.factor,
    test: t("energyTest"),
    status: f.test!.state.status,
    reasonCode: f.test!.state.reasonCode,
    statistic: { label: statisticLabel("energy", locale), value: f.test!.statistic },
    pValue: f.test!.pValue,
    pAdjusted: f.test!.pValueHolm,
    rejects: f.test!.rejects,
    note: f.test!.nPermutations ? `${n(f.test!.nPermutations, locale)} permutations` : undefined,
  }));
  /** partition names of the X-only audit read as populations */
  const dom = (d: string) => (d === "retained_test" ? t("kind_retained_test") : d === "development" ? t("kind_development") : d);
  const columns = [
    { id: "centre", label: t("shiftCentre"), hint: t("shiftCentreHint") },
    { id: "t2", label: "T²", hint: t("shiftT2Hint") },
    { id: "ratio", label: t("shiftRatio"), hint: t("shiftRatioHint"), format: "ratio" as const },
    { id: "energy", label: t("shiftEnergy") },
    { id: "beyond", label: t("shiftBeyond"), hint: t("shiftBeyondHint"), format: "fraction" as const },
    { id: "dy", label: t("shiftDy"), format: "signed" as const },
  ];
  // Wave 2: interpretable views (characterization/domains); the engine matrix stays as the full numerical table.
  const engineTable = (
    <>
      {factors.filter((f) => f.comparisons.length).map((f) => (
        <div className="card" key={f.factor}>
          <h3 className="card-title">{f.audit ? t("auditFactor") : fill(t("shiftFactor"), { f: f.factor })}{f.test?.rejects ? <span className="tag tag-warn">{t("rejected")}</span> : null}</h3>
          <ComparisonMatrix
            locale={locale}
            caption={f.audit ? t("auditFactor") : fill(t("shiftFactor"), { f: f.factor })}
            rowHeader={t("domainCompared")}
            columns={columns}
            rows={f.comparisons.map((c) => ({
              id: c.key,
              label: dom(c.targetDomain),
              sublabel: `${t("vs")} ${c.referenceDomains.map(dom).join(", ")} · ${c.nTarget ?? "—"} / ${c.nReference ?? "—"} ${t("units")}`,
              cells: { centre: c.centroidDistance, t2: c.hotellingT2, ratio: c.varianceRatio, energy: c.energy, beyond: c.beyondEitherFraction, dy: c.medianDifference },
              note: Object.keys(c.unavailable).length ? <>{Object.entries(c.unavailable).map(([id, s]) => <span key={id} className="n4q-sub">{metricLabel(id, locale)} : <StateBadge state={s} locale={locale} /></span>)}</> : undefined,
            }))}
            noteHeader={t("notes")}
          />
        </div>
      ))}
      <ul className="plain small">{["domain_shift.center_shift", "domain_shift.dispersion", "domain_shift.coverage", "domain_shift.target_change"].map((id) => <li key={id}><strong>{metricLabel(id, locale)}</strong> — {metricHelp(id, locale)}</li>)}</ul>
      {tests.length ? <div className="card card-flush"><HypothesisTestTable rows={tests} caption={metricLabel("domain_shift.energy_test", locale)} alpha={0.05} locale={locale} /></div> : null}
      <Unavailable metrics={view.metrics.filter((m) => m.sourceId === sourceId && m.id === "domain_shift.design" && m.status !== "computed")} locale={locale} />
    </>
  );
  return <DomainShiftView {...scope} engineTable={engineTable} />;
}

// --- metadata associations -------------------------------------------------------------------

export function AssociationSection({ t, locale, view, targetId }: Scope) {
  if (!hasBlock(view, ["association."])) return null;
  const rows = extractAssociations(view).filter((a) => !targetId || a.targetId === targetId);
  const family = extractAssociationFamily(view);
  const tests: HypothesisTestRow[] = rows.map((a) => ({
    id: `${a.targetId}|${a.metadata}`,
    effect: `${a.metadata}${a.metadataUnit ? ` (${a.metadataUnit})` : ""}`,
    test: `${a.targetId} · ${a.metadataKind === "continuous" ? t("kindContinuous") : a.metadataKind === "categorical" ? t("kindCategorical") : (a.metadataKind ?? "")}`,
    status: a.test ? a.test.state.status : a.state.status,
    reasonCode: a.test ? a.test.state.reasonCode : a.state.reasonCode,
    statistic: a.statistic !== null ? { label: statisticLabel(a.statisticName ?? "", locale), value: a.statistic } : null,
    effectSize: a.effectSize !== null ? { label: statisticLabel(a.effectSizeName ?? "", locale), value: a.effectSize } : null,
    pValue: a.test?.pValue ?? null,
    pAdjusted: a.test?.pValueHolm ?? null,
    rejects: a.test?.rejects ?? null,
    note: a.test?.pValueBhExploratory !== null && a.test?.pValueBhExploratory !== undefined ? `BH ${formatPValue(a.test.pValueBhExploratory)} (${t("exploratory")})` : undefined,
  }));
  const withLevels = rows.filter((a) => a.levels.some((l) => l.target));
  return (
    <Section id="s-association" icon="target" accent="amber" title={t("assocTitle")} lead={t("assocLead")}>
      <div className="card card-flush">
        <HypothesisTestTable rows={tests} caption={metricLabel("association.metadata_target", locale)} alpha={family?.alpha ?? null} locale={locale} />
      </div>
      {withLevels.length ? (
        <ChartDataTable
          locale={locale}
          caption={t("assocLevels")}
          columns={[t("metadata"), t("level"), t("units"), t("median"), "Q1", "Q3"]}
          rows={withLevels.flatMap((a) => a.levels.map((l) => [a.metadata, l.level, l.nUnits, cellNumber(l.target?.median), cellNumber(l.target?.q25), cellNumber(l.target?.q75)]))}
        />
      ) : null}
      <p className="hint">{t("assocNotCausal")}</p>
    </Section>
  );
}

// --- validation probe ------------------------------------------------------------------------

export function ProbeSection({ t, locale, view, sourceId, targetId }: Scope) {
  if (!hasBlock(view, ["probe."])) return null;
  const probes = extractProbes(view).filter((p) => (!sourceId || p.sourceId === sourceId) && (!targetId || p.targetId === targetId));
  return (
    <Section id="s-probe" icon="diagnosis" accent="green" title={t("probeTitle")} lead={t("probeLead")}>
      {probes.length === 0 ? <p className="note">{t("probeNone")}</p> : null}
      {probes.map((p) => {
        const unit = p.unit ? ` ${p.unit}` : "";
        const skillValue = p.skill?.kind === "double" ? p.skill.value : p.skill ? -1 : null;
        const oof = p.oof;
        const points: ScorePoint[] = oof ? oof.sampleIds.flatMap((id, i) => {
          const x = oof.observed[i];
          const y = oof.predicted[i];
          return x === null || x === undefined || y === null || y === undefined ? [] : [{ id, x, y, group: oof.foldIds[i] ?? null, details: [`${t("trainMean")} ${n(oof.trainMean[i] ?? null, locale)}`] }];
        }) : [];
        return (
          <div className="stack probe" key={`${p.sourceId}|${p.targetId}|${p.estimator ?? ""}`}>
            <h3 className="card-title">{fill(t("probeOf"), { y: p.targetId, x: p.sourceId })}{p.estimator ? <span className="tag">{p.estimator.toUpperCase()}</span> : null}</h3>
            {p.state.status !== "computed" ? (
              <div className="card"><Unavailable metrics={view.metrics.filter((m) => m.id.startsWith("probe.") && m.sourceId === p.sourceId && m.targetId === p.targetId && m.status !== "computed").slice(0, 1)} locale={locale} /></div>
            ) : (
              <>
                <div className="stats">
                  <StatTile label={metricLabel("probe.rmse", locale)} value={n(p.rmse, locale)} suffix={unit.trim() || undefined} hint={`${t("baseline")} ${n(p.trainMeanRmse, locale)}${unit}`} href="#ev-probe.rmse" />
                  <StatTile label={metricLabel("probe.mae", locale)} value={n(p.mae, locale)} suffix={unit.trim() || undefined} hint={`${t("baseline")} ${n(p.trainMeanMae, locale)}${unit}`} />
                  <StatTile label={metricLabel("probe.r2_oof", locale)} value={<span title={p.r2?.kind === "scaled" ? formatEngineNumberExact(p.r2, locale) : undefined}>{en(p.r2, locale)}</span>} hint={p.unavailable["probe.r2_oof"]?.reasonCode ?? t("r2Hint")} />
                  <StatTile label={metricLabel("probe.skill_vs_train_mean", locale)} value={<span title={p.skill?.kind === "scaled" ? formatEngineNumberExact(p.skill, locale) : undefined}>{en(p.skill, locale)}</span>} hint={skillValue === null ? (p.unavailable["probe.skill_vs_train_mean"]?.reasonCode ?? "—") : skillValue > 0 ? t("skillPositive") : t("skillNone")} tone={skillValue === null ? "neutral" : skillValue > 0 ? "good" : "warning"} />
                </div>
                <div className="grid-3-2">
                  <div className="card">
                    <CardTitle id="probe.oof_predictions" locale={locale} />
                    {points.length ? (
                      <Measured>{(w) => <ScoreMap width={w} height={Math.min(420, Math.max(280, w * 0.7))} points={points} colorBy="group" identityLine xLabel={`${t("observed")}${unit}`} yLabel={`${t("predicted")}${unit}`} colorLabel={t("fold")} title={metricLabel("probe.oof_predictions", locale)} locale={locale} />}</Measured>
                    ) : <Unavailable metrics={view.metrics.filter((m) => m.id === "probe.oof_predictions" && m.sourceId === p.sourceId && m.targetId === p.targetId && m.status !== "computed")} locale={locale} />}
                    {oof ? <ChartDataTable locale={locale} caption={metricLabel("probe.oof_predictions", locale)} columns={[t("unitId"), t("fold"), t("observed"), t("predicted"), t("trainMean")]} rows={oof.sampleIds.map((id, i) => [id, oof.foldIds[i] ?? null, cellNumber(oof.observed[i]), cellNumber(oof.predicted[i]), cellNumber(oof.trainMean[i])])} /> : null}
                  </div>
                  <div className="stack">
                    <div className="card">
                      <CardTitle id="probe.rmse" locale={locale} />
                      <Measured>{(w) => (
                        <MeasureBars
                          width={w}
                          title={metricLabel("probe.domain_scores", locale)}
                          valueLabel={t("probeModel")}
                          compareLabel={t("baseline")}
                          locale={locale}
                          rows={[
                            { id: "all", label: t("allSamples"), value: p.rmse, compare: p.trainMeanRmse, note: `${p.nSamples ?? "—"} ${t("samples")}` },
                            ...p.domains.map((d, i) => ({ id: `d${i}`, label: [d.instrument, d.campaign].filter(Boolean).join(" · ") || "—", value: d.rmse, compare: d.trainMeanRmse, note: `${d.nSamples ?? "—"} ${t("samples")} · skill ${en(d.skill, locale)}` })),
                          ]}
                        />
                      )}</Measured>
                    </div>
                    <div className="card">
                      <CardTitle id="probe.plan" locale={locale} />
                      <dl className="prov-grid">
                        <dt>{t("estimator")}</dt><dd>{p.estimator ?? "—"}</dd>
                        <dt>{t("folds")}</dt><dd>{fill(t("foldsValue"), { o: p.outerSplits ?? "—", i: p.innerSplits ?? "—" })}</dd>
                        <dt>{t("grid")}</dt><dd>{p.componentGrid.join(", ") || "—"}</dd>
                        <dt>{t("fits")}</dt><dd>{p.nFits ?? p.plannedFits ?? "—"}</dd>
                      </dl>
                      {p.folds.length ? <ChartDataTable locale={locale} caption={metricLabel("probe.folds", locale)} columns={[t("fold"), t("fitN"), t("evalN"), t("components"), t("trainMean")]} rows={p.folds.map((f) => [f.foldId, f.nFit, f.nEval, f.selectedComponents, cellNumber(f.trainMean)])} /> : null}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </Section>
  );
}

