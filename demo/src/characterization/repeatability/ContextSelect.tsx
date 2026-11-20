// Shared measurement-context selector (instrument × campaign × repeat type). One choice per source, held
// by the characterization provider, drives the repeatability blocks, the noise-proxy blocks and the
// spectral quality map together, so every view reads the same context.
import { useMemo } from "react";
import type { Scope } from "../../Sections";
import { useCharacterizationSelection } from "../overview/selection";
import { measurementContexts, pickContext, type MeasurementContext } from "./contexts";
import { sourceProfiles } from "./profiles";

export interface MeasurementContextState {
  contexts: MeasurementContext[];
  current: MeasurementContext | null;
  select: (key: string) => void;
}

export function useMeasurementContext(scope: Pick<Scope, "view" | "input" | "sourceId">): MeasurementContextState {
  const { view, input, sourceId } = scope;
  const shared = useCharacterizationSelection();
  const contexts = useMemo(() => {
    if (!sourceId || !input.sources.some((s) => s.source_id === sourceId)) return [];
    const { repeats, noise } = sourceProfiles(view, input, sourceId);
    return measurementContexts(repeats, noise);
  }, [view, input, sourceId]);
  const current = pickContext(contexts, sourceId ? shared.contextKey(sourceId) : null);
  const { selectContext } = shared;
  const select = useMemo(() => (key: string) => sourceId && selectContext(sourceId, key), [sourceId, selectContext]);
  return { contexts, current, select };
}

/** What each context provides, for the option text (never colour alone). */
const provides = (c: MeasurementContext) => [c.repeatIndex !== null ? "repeatability" : null, c.noiseIndex !== null ? "noise proxy" : null].filter(Boolean).join(" + ") || "no result";

/** Segmented buttons up to 4 contexts, a select beyond; nothing when there is a single context. */
export function MeasurementContextSelect({ state, label = "Measurement context" }: { state: MeasurementContextState; label?: string }) {
  const { contexts, current, select } = state;
  if (contexts.length < 2 || !current) return null;
  return (
    <div className="rp-context" role="group" aria-label={label}>
      <span className="rp-context-label">{label}</span>
      {contexts.length <= 4 ? (
        <div className="seg">
          {contexts.map((c) => (
            <button key={c.key} type="button" aria-pressed={c.key === current.key} title={`${c.label} — ${provides(c)}`} onClick={() => select(c.key)}>
              {c.label}{c.repeatIndex === null ? <span className="rp-context-note"> (noise only)</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <select value={current.key} onChange={(e) => select(e.target.value)} aria-label={label}>
          {contexts.map((c) => <option key={c.key} value={c.key}>{c.label} — {provides(c)}</option>)}
        </select>
      )}
      <span className="hint">Shared by the repeatability, noise-proxy and quality-map views; contexts are never pooled.</span>
    </div>
  );
}
