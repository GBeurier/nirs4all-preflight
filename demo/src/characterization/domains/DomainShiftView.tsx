// "Shift between domains" section (wave 2): level 1 overview (four dimensions, a card per comparison,
// inference status, retained-test protection, deterministic interpretation), level 2 visuals of the selected
// comparison (centre/dispersion tracks, variance bars, T²/Q map, PCA overlap, energy benchmark) and level 3
// details (nearest-neighbour distances, samples beyond limits, definitions, full engine table).
// Engine values come from the report; per-unit values from Methods kernels (kernels.ts). Retained-test Y is
// never read: this module does not access `input.targets`.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Section, type Scope } from "../../Sections";
import { AlignedTracks, type Track } from "../repeatability/AlignedTracks";
import { ChartCard, EmptyState, Histogram, KpiStrip, ProportionBars, Responsive, StackedShareBar, ValueBars, type HistBin, type KpiItem } from "../shared/charts";
import { defaultFmt as f } from "../shared/charts/scale";
import { DOMAIN_COLORS, DomainLegend, Ecdf, PcaOverlap, RatioScale, ShiftIllustration, TqScatter } from "./charts";
import { bandProfiles, computeDiagnostics, dominantRegion, MAX_PAIRWISE_UNITS, type BandProfiles, type DomainDiagnostics } from "./kernels";
import { domainModel, interpret, type ComparisonModel, type FactorModel, type InferenceModel } from "./model";
import { domainPopulations, type DomainPopulations } from "./populations";
import { DOMAINS } from "./strings";
import "./domains.css";

const pc = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${f(100 * v, d)} %`);
const nf = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : f(v, d));
const frac = (k: number | null, n: number | null) => (k === null || n === null || n <= 0 ? null : k / n);

export interface DomainShiftViewProps extends Scope {
  onOpenSettings?: (() => void) | undefined;
  /** Full engine table (legacy matrix, test table, definitions) shown in the level-3 details. */
  engineTable?: ReactNode;
}

function spaceLabel(space: string | null) {
  if (!space) return "engine input space not reported";
  if (space.startsWith("complete")) return "complete canonical spectra";
  if (space.startsWith("leading_pca")) return "leading PCA scores of all development units (label-free)";
  return space.replace(/_/g, " ");
}

/** Four dimension cards of one comparison (level 1). */
function comparisonKpis(c: ComparisonModel, unit: string, d: DomainDiagnostics | null): KpiItem[] {
  const n = c.coverage.nCompared;
  const either = frac(c.coverage.nBeyondEither, n);
  return [
    { label: "Location · relative centre shift", value: nf(c.centre.relative, 3), sub: `Centre shift ${nf(c.centre.distance, 4)}${unit ? ` ${unit}` : ""} · centroid T² ${nf(c.centre.centroidT2, 3)}`, tone: "blue" },
    { label: "Dispersion · variance ratio", value: nf(c.dispersion.ratio, 4), sub: `${pc(c.dispersion.ratio)} of the reference variance · relative SD ${pc(c.dispersion.relativeSd)}`, tone: "blue" },
    { label: "Coverage · beyond T² or Q", value: either === null ? "—" : f(100 * either, 3), unit: either === null ? undefined : "%", bar: either === null ? null : 100 * either, sub: `T² ${pc(frac(c.coverage.nBeyondT2, n), 3)} · Q ${pc(frac(c.coverage.nBeyondQ, n), 3)} · both ${pc(frac(c.coverage.nBeyondBoth, n), 3)}`, tone: "copper" },
    { label: "Distribution · energy distance", value: nf(c.energy.value, 4), unit: unit || undefined, sub: `Relative ${nf(c.energy.relative, 3)}${d && d.energy.percentile !== null ? ` · internal reference percentile ${f(100 * d.energy.percentile, 3)}${d.energy.status === "approximate" ? " (approximate)" : ""}` : ""}`, tone: "copper" },
  ];
}

function InferenceAlert({ inference, onOpenSettings }: { inference: InferenceModel; onOpenSettings?: (() => void) | undefined }) {
  if (inference.status !== "unavailable") return null;
  return (
    <div className="dm-alert" role="note">
      <h4>{DOMAINS.inferenceUnavailableTitle}</h4>
      <p>{DOMAINS.inferenceUnavailableText}</p>
      {inference.missing.length ? <><p><strong>{DOMAINS.inferenceMissing}</strong>{inference.reasonCode ? <> (engine reason <code>{inference.reasonCode}</code>)</> : null}:</p><ul>{inference.missing.map((m) => <li key={m}>{m}</li>)}</ul></> : null}
      <p>{DOMAINS.inferenceNoInvent}</p>
      {onOpenSettings ? <button type="button" className="btn btn-outline btn-sm" onClick={onOpenSettings}>{DOMAINS.openSettings}</button> : null}
    </div>
  );
}

function PermutationCard({ inference }: { inference: InferenceModel }) {
  const t = inference.test;
  if (inference.status !== "valid" || !t) return null;
  return (
    <ChartCard title="Energy permutation test" subtitle={DOMAINS.testHeader} footnote={`${t.rejects ? DOMAINS.significant : DOMAINS.nonSignificant} The null distribution itself is not published by the engine (debt).`}>
      <table className="dm-table">
        <tbody>
          <tr><th>Statistic (K-sample energy, Σ nₐn_b/(nₐ+n_b)·E)</th><td className="num">{nf(t.statistic, 5)}</td></tr>
          <tr><th>Permutations B (Monte Carlo, p = (b+1)/(B+1))</th><td className="num">{nf(t.nPermutations, 6)}</td></tr>
          <tr><th>Raw p</th><td className="num">{nf(t.pValue, 3)}</td></tr>
          <tr><th>Conservative p (undecidable draws as ties)</th><td className="num">{nf(t.pValueConservative, 3)}</td></tr>
          <tr><th>Holm-adjusted p (family {t.family ?? "of this source"})</th><td className="num">{nf(t.pValueHolm, 3)}</td></tr>
          <tr><th>Rejects at the family level</th><td className="num">{t.rejects === null ? "—" : t.rejects ? "yes" : "no"}</td></tr>
        </tbody>
      </table>
    </ChartCard>
  );
}

function useDiagnostics(pop: DomainPopulations | null, c: ComparisonModel, scope: Scope): { data: DomainDiagnostics | null; error: string | null; busy: boolean } {
  const [state, setState] = useState<{ data: DomainDiagnostics | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: !!pop });
  const opts = scope.input.options.domain_shift ?? {};
  useEffect(() => {
    if (!pop) return;
    let live = true;
    setState({ data: null, error: null, busy: true });
    computeDiagnostics(pop, { audit: c.audit, energyOnSpectra: Boolean(opts.energy_on_spectra), monitorOnSpectra: Boolean(opts.monitor_on_spectra) }, c.energy.value)
      .then((data) => live && setState({ data, error: null, busy: false }))
      .catch((e: unknown) => live && setState({ data: null, error: e instanceof Error ? e.message : String(e), busy: false }));
    return () => { live = false; };
  }, [pop, c.key, c.audit, c.energy.value, opts.energy_on_spectra, opts.monitor_on_spectra]);
  return state;
}

function profileTracks(b: BandProfiles, unit: string): Track[] {
  const nonEval = (v: readonly (number | null)[]) => v.map((x) => x === null);
  return [
    { id: "means", title: "Mean spectra with P5–P95 envelopes", unit, height: 130, envelopes: [
      { id: "env-r", label: "Reference P5–P95", lower: b.p5Ref, upper: b.p95Ref, color: DOMAIN_COLORS.reference },
      { id: "env-c", label: "Compared P5–P95", lower: b.p5Cmp, upper: b.p95Cmp, color: DOMAIN_COLORS.compared },
    ], series: [
      { id: "m-r", label: "Reference mean", values: b.meanRef, color: DOMAIN_COLORS.reference },
      { id: "m-c", label: "Compared mean", values: b.meanCmp, color: DOMAIN_COLORS.compared, dash: "5 3" },
    ] },
    { id: "diff", title: "Signed mean difference (compared − reference)", unit, height: 90, includeZero: true, refLines: [{ y: 0, label: "0" }], series: [{ id: "d", label: "Mean difference", values: b.diff, color: "var(--cz-ink-2)" }] },
    { id: "std", title: "Standardized difference (÷ pooled per-band SD)", height: 90, includeZero: true, refLines: [{ y: 0, label: "0" }], nonEvaluable: nonEval(b.standardized), series: [{ id: "s", label: "Standardized difference", values: b.standardized, color: "var(--cz-ink-2)" }] },
    { id: "sd", title: "Per-band SD of each domain", unit, height: 100, includeZero: true, series: [
      { id: "sd-r", label: "Reference SD", values: b.sdRef, color: DOMAIN_COLORS.reference },
      { id: "sd-c", label: "Compared SD", values: b.sdCmp, color: DOMAIN_COLORS.compared, dash: "5 3" },
    ] },
    { id: "ratio", title: "Local dispersion ratio (variance, compared ÷ reference)", height: 90, includeZero: true, refLines: [{ y: 1, label: "1" }], nonEvaluable: nonEval(b.localRatio), series: [{ id: "lr", label: "Local variance ratio", values: b.localRatio, color: DOMAIN_COLORS.compared }] },
  ];
}

function energyBins(values: readonly number[], observed: number | null): HistBin[] {
  const hi = Math.max(...values, observed ?? 0) * 1.05;
  const n = 24;
  const w = hi / n || 1;
  const bins: HistBin[] = Array.from({ length: n }, (_, i) => ({ lo: i * w, hi: (i + 1) * w, count: 0 }));
  for (const v of values) bins[Math.min(n - 1, Math.floor(v / w))]!.count++;
  return bins;
}

function ComparisonDetail({ c, factor, pop, scope }: { c: ComparisonModel; factor: FactorModel; pop: DomainPopulations | null; scope: Scope }) {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const unit = source?.signal_unit ?? "";
  const axisLabel = source?.axis_unit ? `Spectral axis (${source.axis_unit})` : "Band index / spectral axis";
  const { data: d, error, busy } = useDiagnostics(pop, c, scope);
  const bands = useMemo(() => (pop ? bandProfiles(pop.reference, pop.compared) : null), [pop]);
  const region = useMemo(() => (bands && pop ? dominantRegion(bands.diff) : null), [bands, pop]);
  const regionText = region && pop ? `${f(pop.axis[region.i0]!, 5)}–${f(pop.axis[region.i1]!, 5)}${source?.axis_unit ? ` ${source.axis_unit}` : ""}` : null;
  const it = interpret(c, factor.inference, { support: d?.neighbours?.support ?? null, energy: d?.energy ?? null, region: regionText });
  const refIds = pop?.reference.map((u) => u.members.join(", ")) ?? [];
  const cmpIds = pop?.compared.map((u) => u.members.join(", ")) ?? [];
  const unitsMatch = pop && c.nReferenceUnits !== null && c.nComparedUnits !== null ? pop.reference.length === c.nReferenceUnits && pop.compared.length === c.nComparedUnits : null;
  const mon = d?.monitor ?? null;
  const cats = mon ? mon.comparedT2.map((t, i) => {
    const hiT = t > mon.t2Limit;
    const hiQ = mon.comparedQ[i]! > mon.qLimit;
    return hiT && hiQ ? "both" : hiT ? "t2" : hiQ ? "q" : "within";
  }) : [];
  const count = (k: string) => cats.filter((x) => x === k).length;
  const refRate = (xs: readonly number[], lim: number) => (xs.length ? xs.filter((v) => v > lim).length / xs.length : null);
  const beyond = mon ? cats.map((k, i) => ({ k, i })).filter((x) => x.k !== "within") : [];
  return (
    <div className="dm-detail">
      <ul className="dm-findings" aria-label="Interpretation">
        {it.findings.map((x) => <li key={x.id} data-tone={x.tone}>{x.text}</li>)}
      </ul>
      {it.investigate.length ? <details className="dm-details"><summary>Suggested investigations</summary><ul className="dm-investigate">{it.investigate.map((s) => <li key={s}>{s}</li>)}</ul></details> : null}
      {busy ? <p className="dm-note" role="status">{DOMAINS.computing}</p> : null}
      {error ? <p className="dm-note" role="alert">Per-unit diagnostics unavailable: {error}</p> : null}
      {unitsMatch === false ? <p className="dm-note">Approximate units: the demo rebuilt {pop!.reference.length} / {pop!.compared.length} units while the engine reports {c.nReferenceUnits} / {c.nComparedUnits} (identity links are not published per unit). Engine values above are unaffected.</p> : null}

      <h4 className="dm-h">Spectral centre shift and dispersion</h4>
      <p className="dm-note">{DOMAINS.centreHeader}</p>
      {bands && pop ? (
        <ChartCard title="Centre and dispersion along the spectrum" subtitle="Unit-mean spectra; hover for local values, drag to select an interval." footnote={`Standardized difference = mean difference ÷ sqrt((SD_ref² + SD_cmp²)/2); masked (hatched) where that pooled SD is zero or negligible. Local dispersion ratio = per-band variance ratio, masked where the reference SD is negligible.${region ? ` Highlighted: the window holding ${f(100 * region.share, 3)} % of the squared mean difference.` : ""}`}>
          <Responsive min={420}>{(w) => <AlignedTracks axis={pop.axis} axisLabel={axisLabel} tracks={profileTracks(bands, unit)} width={w} title="Centre and dispersion along the spectrum" markRegions={region ? [{ i0: region.i0, i1: region.i1, label: "Largest difference" }] : []} />}</Responsive>
        </ChartCard>
      ) : <EmptyState>Spectra of the two domains could not be rebuilt for the band profiles.</EmptyState>}
      <div className="dm-grid dm-scope">
        <ChartCard title="Total spectral variance" subtitle="Reference = 100 %." footnote={`${DOMAINS.lowerIsNotBetter} Difference in total variance: ${c.dispersion.differencePercent === null ? "—" : `${f(c.dispersion.differencePercent, 4)} %`}; relative overall SD ${pc(c.dispersion.relativeSd)}.`}>
          <ValueBars rows={[{ label: `Reference · ${c.referenceName}`, value: c.dispersion.ratio === null ? null : 100, tone: "blue" }, { label: `Compared · ${c.comparedName}`, value: c.dispersion.relativePercent, tone: "copper" }]} unit="%" digits={4} axisLabel="Share of the reference total variance (%)" />
          <RatioScale value={c.dispersion.ratio} label="Dispersion ratio" />
        </ChartCard>
        <ChartCard title="Centre shift" subtitle={`Engine values in the ${spaceLabel(c.monitorSpace)}.`} footnote={`Relative centre shift = centre shift ÷ sqrt(reference total variance), i.e. ÷ the reference RMS distance to its centroid (ddof 1), same space, bands and scaling. <1 smaller than the typical reference spread, >1 larger: mathematical comparisons, not risk thresholds.`}>
          <table className="dm-table">
            <tbody>
              <tr><th>Centre shift (Euclidean)</th><td className="num">{nf(c.centre.distance)} {unit}</td></tr>
              <tr><th>Relative centre shift</th><td className="num">{nf(c.centre.relative, 3)}</td></tr>
              <tr><th>Inside the reference PCA subspace</th><td className="num">{nf(c.centre.subspace)} {unit}</td></tr>
              <tr><th>Residual outside that subspace</th><td className="num">{nf(c.centre.residual)} {unit}</td></tr>
              <tr><th>Squared share outside (residual² ÷ shift²)</th><td className="num">{pc(c.centre.outsideSquaredShare, 3)}</td></tr>
              <tr><th>Centroid T² (reference eigenvalues; not comparable to individual limits)</th><td className="num">{nf(c.centre.centroidT2, 3)}</td></tr>
            </tbody>
          </table>
        </ChartCard>
      </div>

      <h4 className="dm-h">T² and Q applicability domain</h4>
      <p className="dm-note">{DOMAINS.coverageHeader}</p>
      {mon ? (
        <div className="dm-grid">
          <ChartCard className="dm-full" title="Normalized T² / Q map" subtitle={`PCA fitted on the reference units only (${mon.components} components, ${mon.folds} folds); compared units projected, never fitted.`} footnote={`Limits: empirical 95 % quantiles of out-of-fold reference statistics (engine limit type ${c.coverage.limitType ?? "—"}). ${DOMAINS.notFailure}`}>
            <DomainLegend reference={c.referenceName} compared={c.comparedName} />
            <TqScatter compared={mon.comparedT2.map((t, i) => ({ id: cmpIds[i] ?? String(i), t2: t, q: mon.comparedQ[i]! }))} reference={mon.referenceT2.map((t, i) => ({ id: refIds[i] ?? String(i), t2: t, q: mon.referenceQ[i]! }))} t2Limit={mon.t2Limit} qLimit={mon.qLimit} />
          </ChartCard>
          <ChartCard title="Compared units by category" subtitle="Per-unit value against each limit.">
            <StackedShareBar label="Compared units" segments={[{ label: "Within both", value: count("within"), tone: "grey" }, { label: "High T² only", value: count("t2"), tone: "copper-2" }, { label: "High Q only", value: count("q"), tone: "teal-2" }, { label: "High both", value: count("both"), tone: "copper" }]} />
          </ChartCard>
          <ChartCard title="Exceedance rates" subtitle="Reference out-of-fold vs compared." footnote={DOMAINS.unionNote}>
            <table className="dm-table">
              <thead><tr><th /><th className="num">Reference</th><th className="num">Compared</th></tr></thead>
              <tbody>
                <tr><th>Beyond T²</th><td className="num">{pc(refRate(mon.referenceT2, mon.t2Limit), 3)}</td><td className="num">{pc(frac(c.coverage.nBeyondT2, c.coverage.nCompared), 3)}</td></tr>
                <tr><th>Beyond Q</th><td className="num">{pc(refRate(mon.referenceQ, mon.qLimit), 3)}</td><td className="num">{pc(frac(c.coverage.nBeyondQ, c.coverage.nCompared), 3)}</td></tr>
                <tr><th>Beyond either</th><td className="num">{pc(mon.referenceT2.length ? mon.referenceT2.filter((t, i) => t > mon.t2Limit || mon.referenceQ[i]! > mon.qLimit).length / mon.referenceT2.length : null, 3)}</td><td className="num">{pc(frac(c.coverage.nBeyondEither, c.coverage.nCompared), 3)}</td></tr>
                <tr><th>Beyond both</th><td className="num">{pc(mon.referenceT2.length ? mon.referenceT2.filter((t, i) => t > mon.t2Limit && mon.referenceQ[i]! > mon.qLimit).length / mon.referenceT2.length : null, 3)}</td><td className="num">{pc(frac(c.coverage.nBeyondBoth, c.coverage.nCompared), 3)}</td></tr>
              </tbody>
            </table>
            <p className="dm-note">Compared rates are the engine counts (tolerance rule); Methods recomputed {mon.nBeyondEither} beyond either{c.coverage.nBeyondEither !== null && mon.nBeyondEither !== c.coverage.nBeyondEither ? ` (engine ${c.coverage.nBeyondEither}: approximate units)` : " (matches the engine)"}.</p>
          </ChartCard>
        </div>
      ) : busy ? null : <EmptyState>No individual T²/Q value: {d?.notes.join(" ") || "per-unit diagnostics unavailable."}</EmptyState>}

      <h4 className="dm-h">Spectral population overlap</h4>
      <p className="dm-note">{DOMAINS.overlapHeader}</p>
      <div className="dm-grid">
        {d?.overlap ? (
          <ChartCard title="PCA scores (reference-fitted)" subtitle="Centring and loadings from the reference units only; compared units projected." footnote={DOMAINS.twoPcNote}>
            <DomainLegend reference={c.referenceName} compared={c.comparedName} />
            <PcaOverlap reference={d.overlap.reference} compared={d.overlap.compared} explained={d.overlap.explained} referenceIds={refIds} comparedIds={cmpIds} />
          </ChartCard>
        ) : null}
        {d?.neighbours ? (
          <ChartCard title="Asymmetric coverage" subtitle={DOMAINS.asymmetryHeader} footnote="Nearest-neighbour estimator in the energy input space, one point per independent unit, the unit itself excluded. Supported: nearest reference distance ≤ P95 of reference→reference nearest distances; represented: nearest compared distance ≤ P95 of compared→compared nearest distances. Nearest distances shrink as sample size grows: compare shares, not raw distances, between unequal domains.">
            <ProportionBars total={100} unitLabel="units" rows={[
              { label: "Compared supported by reference", count: Math.round(100 * (d.neighbours.support.supported ?? 0)), tone: "copper" },
              { label: "Reference represented by compared", count: Math.round(100 * (d.neighbours.support.represented ?? 0)), tone: "blue" },
            ]} />
          </ChartCard>
        ) : null}
      </div>

      <h4 className="dm-h">Energy distance</h4>
      <p className="dm-note">{DOMAINS.energyHeader}</p>
      {d ? (
        <ChartCard className="dm-scope" title="Energy distance — internal reference benchmark" subtitle={d.energy.status === "unavailable" ? `Unavailable: ${d.energy.reason}` : `Distribution of energy distances between disjoint reference subsets (${d.energy.sizes?.[0]} vs ${d.energy.sizes?.[1]} units, ${d.energy.resamples} seeded splits, seed ${d.energy.seed})${d.energy.status === "approximate" ? " — approximate" : ""}; observed cross-domain distance marked.`}
          footnote={`${DOMAINS.percentileNotP} Relative energy distance = energy ÷ mean within-reference pairwise distance (${nf(c.energy.meanWithinReference)} ${unit}). Estimator: energy_e = 2E|X−Y| − E|X−X′| − E|Y−Y′| over unit means (V-statistic, self-pairs included), in the ${spaceLabel(c.energySpace)}.${d.energy.reason && d.energy.status === "approximate" ? ` ${d.energy.reason}` : ""}${d.energy.observed !== null && c.energy.value !== null ? ` Recomputed from Methods distances: ${nf(d.energy.observed, 6)} (engine ${nf(c.energy.value, 6)}).` : ""}`}>
          {d.energy.status !== "unavailable" ? (
            <>
              <KpiStrip items={[
                { label: "Observed (cross-domain)", value: nf(c.energy.value, 4), unit: unit || undefined, tone: "copper" },
                { label: "Typical internal (median)", value: nf(d.energy.typical, 4), unit: unit || undefined, tone: "blue" },
                { label: "Internal reference percentile", value: d.energy.percentile === null ? "—" : f(100 * d.energy.percentile, 3), unit: "%", sub: d.energy.status === "approximate" ? "approximate" : "descriptive, not a p-value" },
              ]} />
              <Histogram bins={energyBins(d.energy.values, c.energy.value)} tone="blue" xLabel={`Energy distance${unit ? ` (${unit})` : ""}`} yLabel="splits" title="Energy distances between internal reference subsets" markers={[...(c.energy.value !== null ? [{ value: c.energy.value, label: "Observed", tone: "copper" as const }] : []), ...(d.energy.typical !== null ? [{ value: d.energy.typical, label: "Typical", tone: "blue" as const }] : [])]} />
            </>
          ) : null}
        </ChartCard>
      ) : null}

      <details className="dm-details">
        <summary>Nearest-neighbour distances, samples beyond limits and definitions</summary>
        {d?.neighbours ? (
          <ChartCard title="Nearest-neighbour distance distributions" subtitle={`Energy input space; ${pop?.reference.length ?? 0} reference and ${pop?.compared.length ?? 0} compared units; the unit itself is excluded (units already merge technical repeats of one physical sample).`}>
            <Ecdf title="Nearest-neighbour distances" xLabel={`Euclidean distance${unit ? ` (${unit})` : ""}`} series={[
              { id: "rr", label: "Reference → reference", values: d.neighbours.refToRef, color: DOMAIN_COLORS.reference },
              { id: "cr", label: "Compared → reference", values: d.neighbours.cmpToRef, color: DOMAIN_COLORS.compared },
              { id: "rc", label: "Reference → compared", values: d.neighbours.refToCmp, color: "var(--cz-ink-3)", dash: "5 3" },
            ]} />
          </ChartCard>
        ) : d && (pop?.reference.length ?? 0) + (pop?.compared.length ?? 0) > MAX_PAIRWISE_UNITS ? <EmptyState>Too many units for in-browser pairwise distances.</EmptyState> : null}
        {mon ? (
          <ChartCard title="Compared units beyond a limit" subtitle={beyond.length ? `${beyond.length} of ${cats.length} units (first 50 listed).` : undefined}>
            {beyond.length ? (
              <table className="dm-table">
                <thead><tr><th>Unit (sample IDs)</th><th className="num">T² ÷ limit</th><th className="num">Q ÷ limit</th><th>Category</th></tr></thead>
                <tbody>{beyond.slice(0, 50).map(({ k, i }) => <tr key={i}><td>{cmpIds[i]}</td><td className="num">{nf(mon.comparedT2[i]! / mon.t2Limit, 3)}</td><td className="num">{nf(mon.comparedQ[i]! / mon.qLimit, 3)}</td><td>{k === "both" ? "High T² and Q" : k === "t2" ? "High T² only" : "High Q only"}</td></tr>)}</tbody>
              </table>
            ) : <EmptyState>No compared unit beyond either limit.</EmptyState>}
          </ChartCard>
        ) : null}
        <div className="rb-method">
          <p><strong>Units.</strong> Every comparison is between distributions of independence-unit mean spectra (engine estimand); technical repeats of one physical sample are averaged before any distance.</p>
          <p><strong>Spaces.</strong> Centre shift, dispersion and T²/Q: {spaceLabel(c.monitorSpace)}; energy: {spaceLabel(c.energySpace)}. Band profiles: complete spectra.</p>
          <p><strong>Dispersion.</strong> Ratio = trace of the compared covariance ÷ trace of the reference covariance (each about its own centroid, ddof 1); relative total variance = 100 × ratio; relative overall SD = √ratio.</p>
          <p><strong>T²/Q.</strong> T² = Σ tₐ²/λₐ over the effective components; Q = squared residual norm outside the reference subspace. Limits are empirical type-7 quantiles (1 − 0.05) of out-of-fold reference statistics, one limit each: the union is not a 5 % rate.</p>
        </div>
      </details>
    </div>
  );
}

function ComparisonCard({ c, selected, onSelect, unit }: { c: ComparisonModel; selected: boolean; onSelect: () => void; unit: string }) {
  return (
    <button type="button" className="dm-card" aria-pressed={selected} onClick={onSelect}>
      <span className="dm-pill dm-pill-cmp">◆ {c.comparedName}</span> <span className="dm-vs">vs</span> <span className="dm-pill dm-pill-ref">● {c.referenceName}</span>
      <span className="dm-card-grid">
        <span><em>Relative centre shift</em><strong>{nf(c.centre.relative, 3)}</strong></span>
        <span><em>Dispersion ratio</em><strong>{nf(c.dispersion.ratio, 3)}</strong></span>
        <span><em>Beyond T² or Q</em><strong>{pc(frac(c.coverage.nBeyondEither, c.coverage.nCompared), 3)}</strong></span>
        <span><em>Energy{unit ? ` (${unit})` : ""}</em><strong>{nf(c.energy.value, 3)}</strong></span>
      </span>
      <span className="dm-counts">{c.nComparedUnits ?? "—"} / {c.nReferenceUnits ?? "—"} units</span>
    </button>
  );
}

function LevelMatrix({ f: factor }: { f: FactorModel }) {
  if (factor.comparisons.length <= 2) return null;
  return (
    <ChartCard title={`Normalized metrics by level · ${factor.factor}`} subtitle="Each row: that level (compared) against all other levels pooled (reference), as the engine compares them; read along rows only.">
      <table className="dm-table">
        <thead><tr><th>Compared level → reference</th><th className="num">Relative centre shift</th><th className="num">Dispersion ratio</th><th className="num">Beyond T² or Q</th><th className="num">Relative energy</th></tr></thead>
        <tbody>{factor.comparisons.map((c) => <tr key={c.key}><td>{c.comparedName} → {c.referenceName}</td><td className="num">{nf(c.centre.relative, 3)}</td><td className="num">{nf(c.dispersion.ratio, 3)}</td><td className="num">{pc(frac(c.coverage.nBeyondEither, c.coverage.nCompared), 3)}</td><td className="num">{nf(c.energy.relative, 3)}</td></tr>)}</tbody>
      </table>
    </ChartCard>
  );
}

function FactorBlock({ factor, scope, onOpenSettings }: { factor: FactorModel; scope: Scope; onOpenSettings?: (() => void) | undefined }) {
  const [sel, setSel] = useState(0);
  const c = factor.comparisons[Math.min(sel, factor.comparisons.length - 1)]!;
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const unit = source?.signal_unit ?? "";
  const pop = useMemo(() => (scope.sourceId ? domainPopulations(scope.input, scope.sourceId, c) : null), [scope.input, scope.sourceId, c.key]);
  const spectra = (us: DomainPopulations["reference"] | undefined) => us?.reduce((a, u) => a + u.rows, 0) ?? null;
  return (
    <div className="dm-factor">
      <div className="dm-cmp-head">
        <h3>{factor.audit ? "Calibration vs retained test (X only)" : `Factor ${factor.factor}`}</h3>
        <span className="dm-counts">{factor.comparisons.length} comparison{factor.comparisons.length > 1 ? "s" : ""}</span>
      </div>
      {factor.audit ? (
        <div className="dm-alert dm-protect" role="note">
          <h4>{DOMAINS.targetProtected}</h4>
          <p>{DOMAINS.targetProtectedNote}</p>
        </div>
      ) : null}
      <InferenceAlert inference={factor.inference} onOpenSettings={onOpenSettings} />
      {factor.comparisons.length > 1 ? (
        <div className="dm-cards" role="group" aria-label="Comparisons">
          {factor.comparisons.map((x, i) => <ComparisonCard key={x.key} c={x} selected={i === sel} onSelect={() => setSel(i)} unit={unit} />)}
        </div>
      ) : null}
      <div className="dm-cmp-head">
        <span className="dm-pill dm-pill-cmp">◆ Compared · {c.comparedName}</span>
        <span className="dm-pill dm-pill-ref">● Reference · {c.referenceName}</span>
        <span className="dm-counts">Independent units {c.nComparedUnits ?? "—"} / {c.nReferenceUnits ?? "—"} · physical samples {c.nComparedSamples ?? "—"} / {c.nReferenceSamples ?? "—"} · spectra {spectra(pop?.compared) ?? "—"} / {spectra(pop?.reference) ?? "—"} (compared / reference)</span>
      </div>
      <DiagnosticsLevel1 c={c} unit={unit} />
      {c.target ? <p className="dm-note">Target shift (development samples only, engine): median difference {nf(c.target.medianDifference)} {c.target.unit ?? ""}.</p> : null}
      <ComparisonDetail key={c.key} c={c} factor={factor} pop={pop} scope={scope} />
      <LevelMatrix f={factor} />
      <PermutationCard inference={factor.inference} />
    </div>
  );
}

function DiagnosticsLevel1({ c, unit }: { c: ComparisonModel; unit: string }) {
  return <KpiStrip items={comparisonKpis(c, unit, null)} label={`${c.comparedName} vs ${c.referenceName}: key figures`} />;
}

export function hasDomainShift(scope: Scope): boolean {
  return !!scope.sourceId && domainModel(scope.view, scope.input, scope.sourceId).length > 0;
}

export function DomainShiftView(props: DomainShiftViewProps) {
  const { onOpenSettings, engineTable, ...scope } = props;
  const factors = useMemo(() => (scope.sourceId ? domainModel(scope.view, scope.input, scope.sourceId) : []), [scope.view, scope.input, scope.sourceId]);
  return (
    <Section id="s-shift" icon="flow" accent="indigo" title={DOMAINS.title} lead={DOMAINS.lead}>
      <div className="dm-dims">
        {DOMAINS.dimensions.map((d) => <div key={d.id} className="dm-dim"><h4>{d.title}</h4><p>{d.text}</p></div>)}
      </div>
      <p className="dm-note">{DOMAINS.noScore}</p>
      {factors.length ? factors.map((fm) => <FactorBlock key={fm.factor} factor={fm} scope={scope} onOpenSettings={onOpenSettings} />) : <EmptyState>No domain comparison was computed for this source.</EmptyState>}
      <details className="dm-details">
        <summary>{DOMAINS.illustrationTitle}</summary>
        <DomainLegend reference="reference population" compared="compared population" />
        <ShiftIllustration />
        <p className="dm-note">{DOMAINS.illustrationNote}</p>
      </details>
      {engineTable ? <details className="dm-details"><summary>Full numerical table (engine values)</summary>{engineTable}</details> : null}
    </Section>
  );
}
