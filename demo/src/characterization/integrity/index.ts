// Agent A module contract: integrity (§3), SNR (§4) and diversity (§5) panels and the
// overview summaries. Summary shapes:
//   integritySummary → { spikes, jumps: { affected, evaluated, affectedPercent, events, eventsPerAffected } | null,
//                        either: { count, total, percent } | null, threshold, comments } | null
//   snrSummary       → { medianDb, linear, relativeNoisePercent, indicativeBand, p5Db, p95Db, n, comments } | null
//   diversitySummary → { median, p95, max, typicalLevel, relativeP95, unit, n, comments } | null
export { IntegrityPanel } from "./IntegrityPanel";
export { SnrPanel } from "./SnrPanel";
export { DiversityPanel } from "./DiversityPanel";
export { integritySummary, snrSummary, diversitySummary, integrityData, snrData, diversityData } from "./summaries";
