// Per-band noise proxy (request §7) as a standalone panel, composed from the rubric building blocks.
import { useMemo, useState } from "react";
import type { Scope } from "../../Sections";
import { noiseBlocks, rubricAxis, spectrumTrack } from "./blocks";
import { RubricPanel } from "./ui";

export { NOISE_LEAD, RATIO_BANDS } from "./blocks";
export { MAX_HEATMAP_SPECTRA, divergingColor } from "./ResidualInspection";

export function NoiseProxyPanel(props: Scope & { onOpenSettings?: (() => void) | undefined; withSpectrum?: boolean | undefined }) {
  const { view, input, sourceId, withSpectrum = true } = props;
  const [ctx, setCtx] = useState(0);
  const [relative, setRelative] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- blocks depend on the report, input, source and options only
  const blocks = useMemo(() => noiseBlocks(props, { contextIndex: ctx, relative }), [view, input, sourceId, ctx, relative]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spectrum = useMemo(() => (withSpectrum ? spectrumTrack(props) : null), [view, input, sourceId, withSpectrum]);
  const axis = useMemo(() => rubricAxis(props), [input, sourceId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!axis || blocks.status === "unavailable") return null;
  return (
    <RubricPanel
      blocks={[blocks]}
      spectrum={spectrum}
      axis={axis.axis}
      axisLabel={axis.axisLabel}
      title={`Per-band noise proxy — ${sourceId ?? ""}`}
      header={
        <div className="rp-row rp-head">
          <h3 className="card-title">Per-band noise proxy</h3>
          {blocks.contexts.length > 1 ? (
            <div className="seg" role="group" aria-label="Measurement context">
              {blocks.contexts.map((c, i) => <button key={c} type="button" aria-pressed={i === ctx} onClick={() => setCtx(i)}>{c}</button>)}
            </div>
          ) : null}
          <div className="seg" role="group" aria-label="Noise proxy units">
            <button type="button" aria-pressed={relative} onClick={() => setRelative(true)}>% of typical signal</button>
            <button type="button" aria-pressed={!relative} onClick={() => setRelative(false)}>Signal units</button>
          </div>
        </div>
      }
    />
  );
}
