// Agent B module contract: repeatability / noise proxy panels, rubric building blocks, their summaries,
// per-band profiles and the generic AlignedTracks component reused by the other characterization views.
export { AlignedTracks, TRACK_PAD, legendItems, nearestBand, niceTicks, runs, type AlignedTracksProps, type BandRange, type BandSelection, type Track, type TrackSeries, type TrackEnvelope, type TrackStrip, type TrackRefBand } from "./AlignedTracks";
export { RepeatabilityPanel } from "./RepeatabilityPanel";
export { NoiseProxyPanel } from "./NoiseProxyPanel";
export { repeatabilityBlocks, noiseBlocks, spectrumTrack, rubricAxis, KOO_LI_BANDS, RATIO_BANDS, REPEAT_WARNING, REPEAT_LEAD, NOISE_LEAD, type BBlocks } from "./blocks";
export { useRepeatabilityBlocks, useNoiseProxyBlocks } from "./hooks";
export { NoReplicatesCard, NOISE_PROXY_STILL_AVAILABLE } from "./NoReplicatesCard";
export { RubricPanel } from "./ui";
export { repeatabilitySummary, noiseProxySummary, NO_REPLICATES_MESSAGE, type PanelSummary, type SummaryMetric } from "./summary";
export { bandProfiles, type BandProfiles } from "./profiles";
export { repeatabilityComments, noiseComments, NO_REPLICATES_COMMENT } from "./comments";
