// One rubric of the detailed diagnostics (integrity / noise and repeatability / diversity): the blocks
// of its contributors grouped by visualization type, in a fixed order:
// KPI strip → headline visuals → interpretation bullets → per-spectrum distributions grid → ONE
// synchronized band-profile stack (AlignedTracks) → spectra inspection → collapsed tables / method / limits.
// Interim demo component (nirs4all-ui debt, see docs/implementation/debt/characterization-overview.md).
import type { ReactNode } from "react";
import { Section, type Accent } from "../../Sections";
import type { IconName } from "../../icons";
import { AlignedTracks, type BandSelection, type Track } from "../repeatability/AlignedTracks";
import { ChartCard, KpiStrip, Responsive } from "../shared/charts";
import { commentOf, renderSlot, type RubricBlock, type RubricBlocks } from "../shared/blocks";
import { useCharacterizationSelection, useSharedCursor } from "./selection";
import "./overview.css";

export interface RubricProps {
  id: string;
  index?: string;
  icon: IconName;
  accent: Accent;
  title: string;
  lead: string;
  sourceId: string;
  axis: readonly number[];
  axisLabel: string;
  /** Contributors in display order; null entries are skipped. */
  blocks: readonly (RubricBlocks | null)[];
  /** Optional reference track drawn first in the stack (e.g. the mean spectrum). */
  reference?: Track | null;
  /** Title of the band-profile stack. */
  tracksTitle?: string;
  tracksSubtitle?: string;
  /** Extra content placed after the inspection blocks. */
  children?: ReactNode;
  /** Controls that change what every block shows (e.g. the measurement context), placed before the KPIs. */
  controls?: ReactNode;
}

const sameAxis = (t: Track, n: number) =>
  (t.series?.some((s) => s.values.length === n) ?? false) || t.strip?.values.length === n || (t.envelopes?.some((e) => e.lower.length === n) ?? false);

/** True when the rubric has something to render. */
export const rubricHasContent = (blocks: readonly (RubricBlocks | null)[]) => blocks.some((b) => b !== null);

function BlockNode({ block }: { block: RubricBlock }) {
  return block.title ? <ChartCard title={block.title} subtitle={block.subtitle}>{block.node}</ChartCard> : <>{block.node}</>;
}

export function RubricSection({ id, index, icon, accent, title, lead, sourceId, axis, axisLabel, blocks, reference = null, tracksTitle = "Band profiles", tracksSubtitle = "One spectral axis for every profile: hover for local values (the cursor follows the other charts), drag to select an interval (shared with the quality map).", children, controls }: RubricProps) {
  const shared = useCharacterizationSelection();
  const [cursor, setCursor] = useSharedCursor(sourceId);
  const parts = blocks.filter((b): b is RubricBlocks => b !== null);
  if (!parts.length && !children) return null;
  const own = shared.selection && shared.selection.sourceId === sourceId ? shared.selection : null;
  const selection: BandSelection | null = own ? { i0: own.i0, i1: own.i1, from: own.from, to: own.to } : null;
  const ctx = { selection };
  const kpis = parts.flatMap((b) => b.kpis);
  const comments = parts.flatMap((b) => b.comments.map((c, i) => ({ ...commentOf(c, i), key: `${b.id}-${i}` })));
  const distributions = parts.flatMap((b) => b.distributions.map((d) => ({ block: d, key: `${b.id}-${d.id}` })));
  const profileTracks = parts.flatMap((b) => b.bandTracks).filter((t) => sameAxis(t, axis.length));
  const tracks = profileTracks.length ? [...(reference && sameAxis(reference, axis.length) ? [reference] : []), ...profileTracks] : [];
  const marks = parts.flatMap((b) => b.markRegions ?? []);
  const inspection = parts.map((b) => ({ id: b.id, slot: renderSlot(b.inspection, ctx) }));
  const details = parts.map((b) => ({ id: b.id, title: b.title, slot: renderSlot(b.details, ctx) }));
  const detailCount = details.filter((d) => d.slot.lists.length || d.slot.node || d.slot.parts).length;
  const unavailable = parts.filter((b) => b.unavailable).map((b) => ({ key: b.id, text: b.unavailable! }));
  const actions = parts.map((b) => b.actions).filter(Boolean);
  const onSelect = (sel: BandSelection | null) => {
    shared.select(sel ? { sourceId, ...sel } : null);
    for (const b of parts) b.onBandSelect?.(sel);
  };
  return (
    <Section id={id} {...(index ? { index } : {})} icon={icon} accent={accent} title={title} lead={lead}>
      {controls ? <div className="rb-controls">{controls}</div> : null}
      {kpis.length ? <KpiStrip items={kpis} label={`${title}: key figures`} /> : null}
      {parts.some((b) => b.headline) ? <div className="rb-headlines">{parts.map((b) => (b.headline ? <div key={b.id}>{b.headline}</div> : null))}</div> : null}
      {comments.length || unavailable.length ? (
        <ul className="rb-comments" aria-label={`${title}: interpretation`}>
          {comments.map((c) => <li key={c.key} data-tone={c.tone ?? "neutral"}>{c.text}</li>)}
          {unavailable.map((u) => <li key={u.key} data-tone="unavailable">{u.text}</li>)}
        </ul>
      ) : null}
      {actions.length ? <div className="rb-actions">{actions.map((a, i) => <span key={i}>{a}</span>)}</div> : null}
      {distributions.length ? (
        <div className="rb-grid">
          {distributions.map((d) => <div key={d.key} className={d.block.span === "full" ? "rb-full" : undefined}><BlockNode block={d.block} /></div>)}
        </div>
      ) : null}
      {tracks.length ? (
        <ChartCard title={tracksTitle} subtitle={tracksSubtitle} className="rb-tracks">
          <Responsive min={420}>
            {(w) => <AlignedTracks axis={axis} axisLabel={axisLabel} tracks={tracks} width={w} title={`${title} — ${tracksTitle}`} selection={selection} onSelect={onSelect} markRegions={marks} cursor={cursor} onCursor={setCursor} />}
          </Responsive>
        </ChartCard>
      ) : null}
      {inspection.map((d) => (
        <div key={d.id} className="rb-block">
          {d.slot.lists.map((b) => <BlockNode key={b.id} block={b} />)}
          {d.slot.node}
        </div>
      ))}
      {children}
      {detailCount ? (
        <details className="rb-details">
          <summary>Tables, method and limitations</summary>
          <div className="rb-details-body">
            {details.map((d) => (
              <div key={d.id}>
                {d.slot.lists.map((b) => <BlockNode key={b.id} block={b} />)}
                {d.slot.node}
                {d.slot.parts ? (
                  <>
                    {d.slot.parts.tables}
                    {d.slot.parts.limitations || d.slot.parts.methodology ? (
                      <div className="rb-method">
                        {parts.length > 1 && d.title ? <h4>{d.title}</h4> : null}
                        {d.slot.parts.limitations ? <p><strong>Limitations.</strong> {d.slot.parts.limitations}</p> : null}
                        {d.slot.parts.methodology}
                      </div>
                    ) : null}
                    {d.slot.parts.investigate?.length ? <ul className="rb-investigate">{d.slot.parts.investigate.map((c) => <li key={c}>{c}</li>)}</ul> : null}
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </Section>
  );
}
