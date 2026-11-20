// "Detailed spectral diagnostics" head block (image (15), block 2): three synchronized profiles of the
// loaded source on one spectral axis — mean spectrum, local noise, spread across spectra — with a shared
// dashed cursor and the selected interval shaded (the selection is shared with the rubrics and the quality map).
// Every value comes from the data or the engine report; nothing here is illustrative.
import { useMemo } from "react";
import { Section, type Scope } from "../../Sections";
import { readBandCounts } from "../integrity/model";
import { AlignedTracks, type BandSelection, type Track } from "../repeatability/AlignedTracks";
import { bandProfiles } from "../repeatability/profiles";
import { Responsive } from "../shared/charts";
import { bandSd, meanSpectrum } from "./bandStats";
import { useCharacterizationSelection } from "./selection";
import { PHASES, RUBRICS } from "./strings";
import "./overview.css";

export function detailedTracks(scope: Pick<Scope, "view" | "input" | "sourceId">): Track[] {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  if (!source || !scope.sourceId || !source.axis.length) return [];
  const p = source.axis.length;
  const unit = source.signal_unit ? { unit: source.signal_unit } : {};
  const profiles = bandProfiles(scope);
  const tracks: Track[] = [{ id: "mean", title: "Mean spectrum", ...unit, height: 74, series: [{ id: "mean", label: "Mean spectrum", values: meanSpectrum(source.x, p), color: "#7f93ab" }] }];
  if (profiles?.noiseProxy && profiles.noiseProxy.length === p) {
    tracks.push({ id: "noise", title: "Local noise (SG residual proxy)", ...unit, height: 64, series: [{ id: "noise", label: "Noise proxy", values: profiles.noiseProxy, color: "#c2702b" }] });
  } else {
    const spikes = readBandCounts(scope.view, scope.sourceId, "spike");
    const jumps = readBandCounts(scope.view, scope.sourceId, "jump");
    const counts = spikes && spikes.counts.length === p ? spikes.counts.map((c, i) => c + (jumps && jumps.counts.length === p ? jumps.counts[i] ?? 0 : 0)) : null;
    if (counts) tracks.push({ id: "events", title: "Spike and jump flags per band (spectra; a spike also counts on its two neighbouring bands)", unit: "spectra", height: 64, includeZero: true, series: [{ id: "events", label: "Spike + jump band flags", values: counts, color: "#c2702b", kind: "bars" }] });
  }
  const spread = profiles?.diversity && profiles.diversity.length === p ? profiles.diversity : bandSd(source.x, p);
  const basis = profiles?.diversityKind === "between-sample" ? "between samples" : "between spectra";
  tracks.push({ id: "spread", title: `Spread ${basis} (SD)`, ...unit, height: 64, series: [{ id: "spread", label: `SD ${basis}`, values: spread, color: "#18807a" }] });
  return tracks;
}

export function DetailedProfiles(scope: Scope) {
  const { view, input, sourceId } = scope;
  const shared = useCharacterizationSelection();
  const tracks = useMemo(() => detailedTracks({ view, input, sourceId }), [view, input, sourceId]);
  const source = input.sources.find((s) => s.source_id === sourceId);
  if (!source || !sourceId || tracks.length < 2) return null;
  const own = shared.selection && shared.selection.sourceId === sourceId ? shared.selection : null;
  const axisLabel = source.axis_unit ? `Spectral axis (${source.axis_unit})` : "Band index / spectral axis";
  return (
    <Section id="s-detailed" index="2 / 4" icon="spectra" accent="cyan" title={PHASES.detailedTitle} lead={PHASES.detailedLead}>
      <div className="dp-chart">
        <Responsive min={420}>
          {(w) => (
            <AlignedTracks
              axis={source.axis}
              axisLabel={axisLabel}
              tracks={tracks}
              width={w}
              title={`${PHASES.detailedTitle} — ${sourceId}`}
              selection={own ? { i0: own.i0, i1: own.i1 } : null}
              onSelect={(sel: BandSelection | null) => shared.select(sel ? { sourceId, ...sel } : null)}
            />
          )}
        </Responsive>
      </div>
      <nav className="dp-links" aria-label="Detailed rubrics">
        <a href="#s-quality">{RUBRICS.integrity.nav} →</a>
        <a href="#s-repeat">{RUBRICS.noise.nav} →</a>
        <a href="#s-diversity">{RUBRICS.diversity.nav} →</a>
      </nav>
    </Section>
  );
}
