// Rubric hooks for agent K's page composition (contract v2, shared/blocks.ts): memoized blocks plus
// the contributor-owned controls (noise units) placed in `actions`. The measurement context comes from
// the shared selector (ContextSelect.tsx), so the repeatability and noise blocks and the quality map
// always read the same instrument × campaign × repeat type.
import { useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { noiseBlocks, repeatabilityBlocks, type BBlocks } from "./blocks";
import { useMeasurementContext } from "./ContextSelect";

export function useRepeatabilityBlocks(scope: Scope, opts: { onOpenSettings?: (() => void) | undefined } = {}): BBlocks | null {
  const { view, input, sourceId } = scope;
  const { onOpenSettings } = opts;
  const { current } = useMeasurementContext(scope);
  const contextIndex = current ? current.repeatIndex : undefined;
  const contextLabel = current?.label;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the report, input, source and options only
  const blocks = useMemo(() => repeatabilityBlocks(scope, { onOpenSettings, contextIndex, contextLabel }), [view, input, sourceId, contextIndex, contextLabel, onOpenSettings]);
  return useMemo(() => {
    if (input.options.analysis_families?.repeatability === false || (!blocks.kpis.length && !blocks.distributions.length)) return null;
    return blocks;
  }, [blocks, input]);
}

export function useNoiseProxyBlocks(scope: Scope, _opts: { onOpenSettings?: (() => void) | undefined } = {}): BBlocks | null {
  const [relative, setRelative] = useState(true);
  const { view, input, sourceId } = scope;
  const { current } = useMeasurementContext(scope);
  const contextIndex = current ? current.noiseIndex : undefined;
  const contextLabel = current?.label;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the report, input, source and options only
  const blocks = useMemo(() => noiseBlocks(scope, { contextIndex, relative, contextLabel }), [view, input, sourceId, contextIndex, contextLabel, relative]);
  return useMemo(() => {
    if (blocks.status === "unavailable" && !blocks.unavailable) return null;
    return {
      ...blocks,
      actions: blocks.status === "computed" ? (
        <div className="rp-row">
          <div className="seg" role="group" aria-label="Noise proxy units">
            <button type="button" aria-pressed={relative} onClick={() => setRelative(true)}>Noise proxy in % of typical signal</button>
            <button type="button" aria-pressed={!relative} onClick={() => setRelative(false)}>In signal units</button>
          </div>
        </div>
      ) : null,
    };
  }, [blocks, relative]);
}
