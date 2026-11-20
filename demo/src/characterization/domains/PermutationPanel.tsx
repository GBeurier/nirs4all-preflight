// Energy permutation test card (§10): the engine's valid test with its null distribution recomputed locally
// (permutation.ts, in the domain-shift worker) from the engine's own plan. Rendered only for a valid engine
// test; a blocked test keeps the "Statistical inference unavailable" state and no unit is invented.
import { useEffect, useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { ChartCard, Histogram, KpiStrip, type HistBin } from "../shared/charts";
import { defaultFmt as f } from "../shared/charts/scale";
import { domainTask } from "./host";
import { testPlan, type FactorModel, type TestPlan } from "./model";
import { monteCarloAgreement, type PermutationResult } from "./permutation";
import { testPopulation } from "./populations";
import { DOMAINS } from "./strings";

const nf = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : f(v, d));
const SCHEMES: Record<string, string> = {
  none_single_block: "free permutation of unit labels in one block",
  within_blocks: "permutation within blocks",
};

export function nullBins(draws: readonly number[], observed: number, n = 30): HistBin[] {
  const lo = Math.min(...draws, observed);
  const hi = Math.max(...draws, observed);
  const w = (hi - lo) / n || 1;
  const bins: HistBin[] = Array.from({ length: n }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, count: 0 }));
  for (const v of draws) bins[Math.min(n - 1, Math.max(0, Math.floor((v - lo) / w)))]!.count++;
  return bins;
}

function useLocalNull(scope: Scope, factor: FactorModel, plan: TestPlan | null) {
  const [state, setState] = useState<{ result: PermutationResult | null; error: string | null; busy: boolean }>({ result: null, error: null, busy: !!plan });
  const opts = scope.input.options.domain_shift ?? {};
  const pop = useMemo(() => (plan && scope.sourceId ? testPopulation(scope.input, scope.sourceId, factor.factor, factor.audit) : null), [plan, scope.input, scope.sourceId, factor.factor, factor.audit]);
  useEffect(() => {
    if (!plan || !pop) return;
    let live = true;
    setState({ result: null, error: null, busy: true });
    const leading = !factor.audit && !opts.energy_on_spectra ? { development: pop.development.map((u) => u.spectrum), index: pop.developmentIndex! } : null;
    domainTask({ op: "permutation", req: {
      spectra: pop.units.map((u) => u.spectrum), codes: pop.codes, nGroups: pop.levels.length, seed: plan.seed, permutations: plan.permutations, leading,
      family: plan.familyPValues ? { pValues: plan.familyPValues, member: plan.member } : null,
    } })
      .then((result) => live && setState({ result, error: null, busy: false }))
      .catch((e: unknown) => live && setState({ result: null, error: e instanceof Error ? e.message : String(e), busy: false }));
    return () => { live = false; };
  }, [plan, pop, factor.audit, opts.energy_on_spectra]);
  return state;
}

export function PermutationCard({ scope, factor }: { scope: Scope; factor: FactorModel }) {
  const t = factor.inference.test;
  const valid = factor.inference.status === "valid" && !!t;
  const plan = useMemo(() => (valid && scope.sourceId ? testPlan(scope.view, scope.sourceId, factor.factor) : null), [valid, scope.view, scope.sourceId, factor.factor]);
  const { result: r, error, busy } = useLocalNull(scope, factor, plan);
  if (!valid || !t) return null;
  const B = plan?.permutations ?? t.nPermutations ?? null;
  const statMismatch = r && plan?.statistic ? Math.abs(r.observed - plan.statistic) > 1e-6 * Math.max(1, Math.abs(plan.statistic)) : false;
  const agree = r && t.pValue !== null && B ? monteCarloAgreement(r.pValue, t.pValue, B) : null;
  const unit = scope.input.sources.find((s) => s.source_id === scope.sourceId)?.signal_unit ?? "";
  const familyText = plan?.family ? `family “${plan.family}” (m = ${plan.familyFactors.length}: ${plan.familyFactors.join(", ")}; family α ${nf(plan.familyAlpha, 2)})` : "family of this source";
  return (
    <ChartCard title="Energy permutation test" subtitle={DOMAINS.testHeader} footnote={`${t.rejects ? DOMAINS.significant : DOMAINS.nonSignificant} ${DOMAINS.permutationProvenance}`}>
      <KpiStrip items={[
        { label: "Raw p (local)", value: r ? nf(r.pValue, 3) : "—", sub: `Engine reference ${nf(t.pValue, 3)} · p = (b+1)/(B+1)`, tone: "copper" },
        { label: "Holm-adjusted p", value: r?.pValueHolm !== null && r?.pValueHolm !== undefined ? nf(r.pValueHolm, 3) : nf(t.pValueHolm, 3), sub: `Engine ${nf(t.pValueHolm, 3)} · ${plan?.family ? `family ${plan.family}, m = ${plan.familyFactors.length}` : "source family"}`, tone: "blue" },
        { label: "Statistic Σ nₐn_b/(nₐ+n_b)·E", value: nf(r?.observed ?? t.statistic, 4), unit: unit || undefined, sub: `Engine ${nf(t.statistic, 6)}`, tone: "muted" },
        { label: "Permutations B", value: nf(B, 6), sub: r ? `b = ${r.atLeast} draws ≥ observed (engine ${plan?.atLeast ?? "—"})` : undefined, tone: "muted" },
      ]} />
      {busy ? <p className="dm-note" role="status">Recomputing the permutation null distribution in the worker…</p> : null}
      {error ? <p className="dm-note" role="alert">Local null distribution unavailable: {error}. The engine values above remain valid.</p> : null}
      {r ? (
        <>
          <Histogram bins={nullBins(r.draws, r.observed)} xLabel={`Permuted energy statistic${unit ? ` (${unit})` : ""}`} yLabel="permutations" title="Permutation null distribution of the energy statistic" tone="blue" highlightTone="copper"
            highlighted={(bin) => bin.hi > r.observed} markers={[{ value: r.observed, label: "Observed", tone: "copper" }]} />
          <p className="dm-note">Shaded: the tail at or beyond the observed statistic ({r.atLeast} of {r.permutations} draws); the other bars are the rest of the null distribution.</p>
          {statMismatch ? <p className="dm-note" role="alert">The locally rebuilt units give a statistic of {nf(r.observed, 6)} against {nf(plan?.statistic, 6)} in the engine: the local null distribution is approximate (identity links are not published per unit). The engine p-value is the reference.</p> : null}
          {agree?.differs ? <p className="dm-note" role="alert">The local p-value ({nf(r.pValue, 4)}) differs from the engine p-value ({nf(t.pValue, 4)}) by more than the Monte-Carlo error (2 × {nf(agree.standardError, 2)} + 1/(B+1)). The engine p-value is the reference.</p> : r.pValue === t.pValue ? <p className="dm-note">The local p-value reproduces the engine p-value exactly (same draws).</p> : agree ? <p className="dm-note">The local and engine p-values agree within the Monte-Carlo error (SE ≈ {nf(agree.standardError, 2)}).</p> : null}
        </>
      ) : null}
      <table className="dm-table">
        <tbody>
          <tr><th>Experimental unit (permuted)</th><td>{plan?.exchangeableUnit ?? "—"} · {r ? `${r.n} units, group sizes ${r.groupSizes.join(" / ")}` : "—"}</td></tr>
          <tr><th>Scheme</th><td>{SCHEMES[plan?.restrictions ?? ""] ?? plan?.restrictions ?? "—"}; Monte Carlo draws ({plan?.drawMethod?.replace(/_/g, " ") ?? "—"})</td></tr>
          <tr><th>Space</th><td>{r ? (r.space === "leading_pca" ? `leading label-free PCA scores of every development unit (${r.dimensions} components)` : `complete spectra (${r.dimensions} bands)`) : "—"}</td></tr>
          <tr><th>Seed</th><td><code>{plan?.seed ?? "—"}</code> ({plan?.rng?.replace(/_/g, " ") ?? "—"}; {plan?.seedDerivation ?? "derived per source and factor"})</td></tr>
          <tr><th>Effect size (relative energy distance)</th><td>{factor.comparisons.map((c) => `${c.comparedName} vs ${c.referenceName}: ${nf(c.energy.relative, 3)}`).join(" · ")} (magnitude, kept apart from significance)</td></tr>
          <tr><th>Holm family</th><td>{familyText}</td></tr>
          <tr><th>Rejects at the family level (engine)</th><td>{t.rejects === null ? "—" : t.rejects ? "yes" : "no"}</td></tr>
          <tr><th>Conservative p (undecidable draws as ties, engine)</th><td className="num">{nf(t.pValueConservative, 3)}</td></tr>
        </tbody>
      </table>
    </ChartCard>
  );
}
