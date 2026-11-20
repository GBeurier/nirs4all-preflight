// Rubric hooks for agent K's page composition (contract v2, shared/blocks.ts): memoized blocks plus
// the contributor-owned controls (measurement context, noise units) placed in `actions`.
import { useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { noiseBlocks, repeatabilityBlocks, type BBlocks } from "./blocks";

function ContextSwitch({ contexts, index, onChange, label }: { contexts: readonly string[]; index: number; onChange: (i: number) => void; label: string }) {
  if (contexts.length < 2) return null;
  return (
    <div className="seg" role="group" aria-label={label}>
      {contexts.map((c, i) => <button key={c} type="button" aria-pressed={i === index} onClick={() => onChange(i)}>{c}</button>)}
    </div>
  );
}

export function useRepeatabilityBlocks(scope: Scope, opts: { onOpenSettings?: (() => void) | undefined } = {}): BBlocks | null {
  const [ctx, setCtx] = useState(0);
  const { view, input, sourceId } = scope;
  const { onOpenSettings } = opts;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the report, input, source and options only
  const blocks = useMemo(() => repeatabilityBlocks(scope, { onOpenSettings, contextIndex: ctx }), [view, input, sourceId, ctx, onOpenSettings]);
  return useMemo(() => {
    if (input.options.analysis_families?.repeatability === false || (!blocks.kpis.length && !blocks.distributions.length)) return null;
    return { ...blocks, actions: <ContextSwitch contexts={blocks.contexts} index={ctx} onChange={setCtx} label="Repeatability measurement context" /> };
  }, [blocks, ctx, input]);
}

export function useNoiseProxyBlocks(scope: Scope, _opts: { onOpenSettings?: (() => void) | undefined } = {}): BBlocks | null {
  const [ctx, setCtx] = useState(0);
  const [relative, setRelative] = useState(true);
  const { view, input, sourceId } = scope;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the report, input, source and options only
  const blocks = useMemo(() => noiseBlocks(scope, { contextIndex: ctx, relative }), [view, input, sourceId, ctx, relative]);
  return useMemo(() => {
    if (blocks.status === "unavailable" && !blocks.unavailable) return null;
    return {
      ...blocks,
      actions: blocks.status === "computed" ? (
        <div className="rp-row">
          <ContextSwitch contexts={blocks.contexts} index={ctx} onChange={setCtx} label="Noise proxy measurement context" />
          <div className="seg" role="group" aria-label="Noise proxy units">
            <button type="button" aria-pressed={relative} onClick={() => setRelative(true)}>Noise proxy in % of typical signal</button>
            <button type="button" aria-pressed={!relative} onClick={() => setRelative(false)}>In signal units</button>
          </div>
        </div>
      ) : null,
    };
  }, [blocks, ctx, relative]);
}
