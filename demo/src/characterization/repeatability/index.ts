// Agent B module contract: repeatability / noise proxy panels, their summaries, per-band profiles
// and the generic AlignedTracks component reused by the other characterization views.
export { AlignedTracks, nearestBand, niceTicks, runs, type AlignedTracksProps, type BandRange, type BandSelection, type Track, type TrackSeries, type TrackEnvelope, type TrackStrip, type TrackRefBand } from "./AlignedTracks";
export { RepeatabilityPanel, KOO_LI_BANDS, REPEAT_WARNING } from "./RepeatabilityPanel";
export { NoiseProxyPanel, RATIO_BANDS } from "./NoiseProxyPanel";
export { repeatabilitySummary, noiseProxySummary, NO_REPLICATES_MESSAGE, type PanelSummary, type SummaryMetric } from "./summary";
export { bandProfiles, type BandProfiles } from "./profiles";
export { repeatabilityComments, noiseComments, NO_REPLICATES_COMMENT } from "./comments";
