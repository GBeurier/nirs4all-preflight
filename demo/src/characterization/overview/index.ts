// Agent D module contract: page organisation of the characterization views (overview cards, phase
// headings, spectral quality map), the comment framework and the shared exploration state.
export { CharacterizationOverview, hasOverview, type OverviewProps } from "./CharacterizationOverview";
export { SpectralQualityMap, hasQualityMap } from "./SpectralQualityMap";
export { PhaseArrow, PhaseHeading } from "./PhaseHeading";
export { DetailedProfiles, detailedTracks } from "./DetailedProfiles";
export { DiversityRubric, IntegrityRubric, NoiseRubric } from "./rubrics";
export { RubricSection } from "./RubricSection";
export { CharacterizationProvider, useCharacterizationSelection, type BandInterval, type InvestigationRegion, type CharacterizationSelection } from "./selection";
export { CROSS_RULES, crossComments, fromLines, mergeComments, runRules, type CharacterizationComment, type CommentRule, type CrossContext, type Dimension } from "./comments";
export { overviewModel, type OverviewModel } from "./model";
export { MAP, OVERVIEW, PHASES, RUBRICS } from "./strings";
