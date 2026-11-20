// Per-band technical repeatability (request §6) as a standalone panel, composed from the rubric
// building blocks (blocks.tsx). The page may instead merge these blocks into one rubric stack.
import { useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { repeatabilityBlocks, rubricAxis, spectrumTrack } from "./blocks";
import { RubricPanel } from "./ui";

export { KOO_LI_BANDS, REPEAT_LEAD, REPEAT_WARNING } from "./blocks";
export { NOISE_PROXY_STILL_AVAILABLE } from "./NoReplicatesCard";

export function RepeatabilityPanel(props: Scope & { onOpenSettings?: (() => void) | undefined }) {
  const { view, input, sourceId, onOpenSettings } = props;
  const [ctx, setCtx] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- blocks depend on the report, input, source and context only
  const blocks = useMemo(() => repeatabilityBlocks(props, { onOpenSettings, contextIndex: ctx }), [view, input, sourceId, ctx, onOpenSettings]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spectrum = useMemo(() => spectrumTrack(props), [view, input, sourceId]);
  const axis = useMemo(() => rubricAxis(props), [input, sourceId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!axis) return null;
  if (blocks.status === "unavailable") return blocks.distributions.length ? <div className="rp-block-plain">{blocks.distributions.map((d) => <div key={d.id}>{d.node}</div>)}</div> : null;
  return (
    <RubricPanel
      blocks={[blocks]}
      spectrum={spectrum}
      axis={axis.axis}
      axisLabel={axis.axisLabel}
      title={`Per-band repeatability — ${sourceId ?? ""}`}
      header={
        <div className="rp-row rp-head">
          <h3 className="card-title">Per-band technical repeatability</h3>
          {blocks.contexts.length > 1 ? (
            <div className="seg" role="group" aria-label="Measurement context">
              {blocks.contexts.map((c, i) => <button key={c} type="button" aria-pressed={i === ctx} onClick={() => setCtx(i)}>{c}</button>)}
            </div>
          ) : null}
        </div>
      }
    />
  );
}
