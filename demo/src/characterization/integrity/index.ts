// Agent A module contract: integrity (§3, + T²/Q atypical spectra), SNR (§4) and diversity (§5).
// Rubric hooks (K's RubricBlocks from ../shared/blocks, plus `onBandSelect` for the inspection and
// `title`/`lead`): useIntegrityBlocks (spectral integrity), useSnrBlocks (noise), useDiversityBlocks.
// Legacy panels render the same blocks. Summary shapes for the overview cards:
//   integritySummary → { spikes, jumps: { affected, evaluated, affectedPercent, events, eventsPerAffected } | null,
//                        either: { count, total, percent } | null, threshold, comments } | null
//   snrSummary       → { medianDb, linear, relativeNoisePercent, indicativeBand, p5Db, p95Db, n, comments } | null
//   diversitySummary → { median, p95, max, typicalLevel, relativeP95, unit, n, comments } | null
export { IntegrityPanel } from "./IntegrityPanel";
export { SnrPanel } from "./SnrPanel";
export { DiversityPanel } from "./DiversityPanel";
export { useIntegrityBlocks, useAtypicalBlocks, useSnrBlocks, useDiversityBlocks, RubricView, scanLabel, unavailableSignals, type ABlocks } from "./blocks";
export { integritySummary, snrSummary, diversitySummary, integrityData, snrData, diversityData } from "./summaries";
