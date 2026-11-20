// The three diagnostic rubrics of the characterization page, composed from the contributors' block hooks:
// 1 Spectral integrity (isolated peaks, abrupt changes, T²/Q atypical spectra), 2 Spectral noise and
// repeatability (SNR, noise proxy, per-band repeatability), 3 Spectral diversity (distance to the mean, envelope).
import { useMemo, type ReactNode } from "react";
import type { Scope } from "../../Sections";
import { AvailabilityBadge, extractRepeatabilityUncertainty, metricLabel } from "nirs4all-ui/qualification";
import { useAtypicalBlocks, useDiversityBlocks, useIntegrityBlocks, useSnrBlocks } from "../integrity/blocks";
import { ValueBars } from "../shared/charts";
import * as repeatability from "../repeatability";
import { NoiseProxyPanel } from "../repeatability/NoiseProxyPanel";
import { RepeatabilityPanel } from "../repeatability/RepeatabilityPanel";
import type { Track } from "../repeatability/AlignedTracks";
import { MeasurementContextSelect, useMeasurementContext } from "../repeatability/ContextSelect";
import type { RubricBlocks } from "../shared/blocks";
import { RubricSection } from "./RubricSection";
import { RUBRICS } from "./strings";
import { meanSpectrum } from "./bandStats";

type Hook = (scope: Scope, opts?: { onOpenSettings?: (() => void) | undefined }) => RubricBlocks | null;
const noHook: Hook = () => null;
// B's hooks are picked up as soon as its index exports them (module-level constant: hook order stays stable).
const B = repeatability as unknown as Partial<Record<"useNoiseProxyBlocks" | "useRepeatabilityBlocks", Hook>>;
const useNoiseProxyBlocks: Hook = B.useNoiseProxyBlocks ?? noHook;
const useRepeatabilityBlocks: Hook = B.useRepeatabilityBlocks ?? noHook;
const B_READY = Boolean(B.useNoiseProxyBlocks && B.useRepeatabilityBlocks);

function useSourceAxis(scope: Scope) {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const axisLabel = source?.axis_unit ? `Spectral axis (${source.axis_unit})` : "Band index / spectral axis";
  const reference = useMemo<Track | null>(() => {
    if (!source || !source.axis.length) return null;
    return { id: "mean-spectrum", title: "Mean spectrum", ...(source.signal_unit ? { unit: source.signal_unit } : {}), height: 64, series: [{ id: "mean", label: "Mean spectrum", values: meanSpectrum(source.x, source.axis.length), color: "#7f93ab" }] };
  }, [source]);
  return { source, axisLabel, reference };
}

interface RubricScope extends Scope {
  onOpenSettings?: (() => void) | undefined;
}

export function IntegrityRubric(scope: RubricScope) {
  const { source, axisLabel, reference } = useSourceAxis(scope);
  const integrity = useIntegrityBlocks(scope);
  const atypical = useAtypicalBlocks(scope);
  if (!source || !scope.sourceId) return null;
  return <RubricSection id="s-quality" index="2.1" icon="data" accent="rose" title={RUBRICS.integrity.title} lead={RUBRICS.integrity.lead} sourceId={scope.sourceId} axis={source.axis} axisLabel={axisLabel} blocks={[integrity, atypical]} reference={reference} tracksTitle={RUBRICS.integrity.tracks} />;
}

/**
 * Replicate design facts of the repeatability engine (moved from the former RepeatSection): acquisitions per
 * physical sample in each measurement context, and the engine's reason for every replicate metric not computed.
 */
export function repeatDesignBlocks(scope: Pick<Scope, "view" | "sourceId" | "locale">): RubricBlocks | null {
  const { view, sourceId, locale } = scope;
  if (!sourceId) return null;
  const counts = extractRepeatabilityUncertainty(view, sourceId).filter((u) => u.repeatCounts?.histogram.length);
  const reasons = view.metrics.filter((m) => m.sourceId === sourceId && m.id.startsWith("measurement.") && !m.id.startsWith("measurement.noise_proxy") && m.status !== "computed");
  if (!counts.length && !reasons.length) return null;
  return {
    id: "repeat-design",
    kpis: [],
    comments: [],
    distributions: counts.map((u) => ({
      id: `counts-${u.id}`,
      title: `Technical repeats per physical sample · ${u.id}`,
      subtitle: "Physical samples by number of acquisitions in this measurement context.",
      node: <ValueBars rows={u.repeatCounts!.histogram.map((h) => ({ label: `${h.r} acquisition${h.r === 1 ? "" : "s"}`, value: h.nGroups, tone: "teal-2" as const }))} unit="samples" axisLabel="Physical samples" digits={6} />,
    })),
    bandTracks: [],
    inspection: [],
    details: reasons.length ? <div className="rb-method"><h4>Replicate metrics not computed</h4><ul className="plain small unavailable">{reasons.map((m, i) => <li key={`${m.id}${i}`}>{metricLabel(m.id, locale)} : <AvailabilityBadge status={m.status} reason={m.reasonCode} locale={locale} /></li>)}</ul></div> : [],
  };
}

export function NoiseRubric(scope: RubricScope) {
  const { source, axisLabel, reference } = useSourceAxis(scope);
  const snr = useSnrBlocks(scope);
  const proxy = useNoiseProxyBlocks(scope, { onOpenSettings: scope.onOpenSettings });
  const repeat = useRepeatabilityBlocks(scope, { onOpenSettings: scope.onOpenSettings });
  const design = useMemo(() => repeatDesignBlocks(scope), [scope.view, scope.sourceId, scope.locale]);
  const context = useMeasurementContext(scope);
  if (!source || !scope.sourceId) return null;
  const repeatOn = scope.input.options.analysis_families?.repeatability !== false;
  // Until the repeatability module exposes its hooks, its panels are shown as they are.
  const legacy: ReactNode = B_READY ? null : (
    <>
      {repeatOn ? <RepeatabilityPanel {...scope} {...(scope.onOpenSettings ? { onOpenSettings: scope.onOpenSettings } : {})} /> : null}
      <NoiseProxyPanel {...scope} {...(scope.onOpenSettings ? { onOpenSettings: scope.onOpenSettings } : {})} />
    </>
  );
  return (
    <RubricSection id="s-repeat" index="2.2" icon="repeat" accent="green" title={RUBRICS.noise.title} lead={RUBRICS.noise.lead} sourceId={scope.sourceId} axis={source.axis} axisLabel={axisLabel} blocks={[snr, proxy, repeatOn ? repeat : null, repeatOn ? design : null]} reference={reference} tracksTitle={RUBRICS.noise.tracks} controls={<MeasurementContextSelect state={context} />}>
      {legacy}
    </RubricSection>
  );
}

export function DiversityRubric(scope: RubricScope) {
  const { source, axisLabel, reference } = useSourceAxis(scope);
  const diversity = useDiversityBlocks(scope);
  if (!source || !scope.sourceId) return null;
  return <RubricSection id="s-diversity" index="2.3" icon="spectra" accent="indigo" title={RUBRICS.diversity.title} lead={RUBRICS.diversity.lead} sourceId={scope.sourceId} axis={source.axis} axisLabel={axisLabel} blocks={[diversity]} reference={reference} tracksTitle={RUBRICS.diversity.tracks} />;
}
