// English UI text of the characterization overview, quality map and page structure, registered in
// demo/src/i18n.ts (keys `czOv*`, `czPh*`, `czRb*`, `czMap*`, with their French counterparts). The
// characterization UI is English only for now, so the values are read in English once, at module load.
import { translate, type TextKey } from "../../i18n";

const en = (key: TextKey) => translate(key, "en");

export const OVERVIEW = {
  title: en("czOvTitle"),
  lead: en("czOvLead"),
  navLabel: en("czOvNavLabel"),
  integrity: {
    title: en("czOvIntegrityTitle"),
    sub: en("czOvIntegritySub"),
    metric: en("czOvIntegrityMetric"),
    metricJump: en("czOvIntegrityMetricJump"),
    detail: en("czOvIntegrityDetail"),
    hint: en("czOvIntegrityHint"),
    none: en("czOvIntegrityNone"),
  },
  noise: {
    title: en("czOvNoiseTitle"),
    sub: en("czOvNoiseSub"),
    metric: en("czOvNoiseMetric"),
    hint: en("czOvNoiseHint"),
    none: en("czOvNoiseNone"),
    repeatAvailable: en("czOvNoiseRepeatAvailable"),
    repeatNone: en("czOvNoiseRepeatNone"),
    repeatSettings: en("czOvNoiseRepeatSettings"),
  },
  diversity: {
    title: en("czOvDiversityTitle"),
    sub: en("czOvDiversitySub"),
    metric: en("czOvDiversityMetric"),
    hint: en("czOvDiversityHint"),
    none: en("czOvDiversityNone"),
  },
  commentsTitle: en("czOvCommentsTitle"),
  commentsLead: en("czOvCommentsLead"),
  commentsNone: en("czOvCommentsNone"),
  denominators: en("czOvDenominators"),
  jump: en("czOvJump"),
} as const;

export const PHASES = {
  overviewTitle: en("czPhOverviewTitle"),
  overviewLead: en("czPhOverviewLead"),
  detailedTitle: en("czPhDetailedTitle"),
  detailedLead: en("czPhDetailedLead"),
  detailedNav: en("czPhDetailedNav"),
  preprocessingTitle: en("czPhPreprocessingTitle"),
  preprocessingLead: en("czPhPreprocessingLead"),
  preprocessingNav: en("czPhPreprocessingNav"),
  mapTitle: en("czPhMapTitle"),
  mapLead: en("czPhMapLead"),
  mapNav: en("czPhMapNav"),
} as const;

/** Rubrics of the detailed diagnostics: one section each, same-type visuals grouped inside. */
export const RUBRICS = {
  integrity: {
    title: en("czRbIntegrityTitle"),
    nav: en("czRbIntegrityNav"),
    lead: en("czRbIntegrityLead"),
    tracks: en("czRbIntegrityTracks"),
  },
  noise: {
    title: en("czRbNoiseTitle"),
    nav: en("czRbNoiseNav"),
    lead: en("czRbNoiseLead"),
    tracks: en("czRbNoiseTracks"),
  },
  diversity: {
    title: en("czRbDiversityTitle"),
    nav: en("czRbDiversityNav"),
    lead: en("czRbDiversityLead"),
    tracks: en("czRbDiversityTracks"),
  },
} as const;

export const MAP = {
  title: en("czMapTitle"),
  lead: en("czMapLead"),
  warning: en("czMapWarning"),
  stripLead: en("czMapStripLead"),
  stripInteraction: en("czMapStripInteraction"),
  valuesTitle: en("czMapValuesTitle"),
  interaction: en("czMapInteraction"),
  selected: en("czMapSelected"),
  mark: en("czMapMark"),
  markHint: en("czMapMarkHint"),
  regionsTitle: en("czMapRegionsTitle"),
  regionsNone: en("czMapRegionsNone"),
  regionsExport: en("czMapRegionsExport"),
  regionsClear: en("czMapRegionsClear"),
  openIn: en("czMapOpenIn"),
  panels: {
    "s-repeat": en("czMapPanelsSRepeat"),
    "s-quality": en("czMapPanelsSQuality"),
    "s-preprocessing": en("czMapPanelsSPreprocessing"),
  },
  legendsTitle: en("czMapLegendsTitle"),
  notDrawn: en("czMapNotDrawn"),
  tableCaption: en("czMapTableCaption"),
  empty: en("czMapEmpty"),
  scaleNote: en("czMapScaleNote"),
  nonEvaluable: en("czMapNonEvaluable"),
  originLabel: {
    engine: en("czMapOriginLabelEngine"),
    derived: en("czMapOriginLabelDerived"),
    interim: en("czMapOriginLabelInterim"),
  },
  modeLabel: en("czMapModeLabel"),
  modeRaw: en("czMapModeRaw"),
  modeSubset: en("czMapModeSubset"),
  modeProcessed: en("czMapModeProcessed"),
  modeDisabled: en("czMapModeDisabled"),
  modeProvenance: en("czMapModeProvenance"),
  modeEmpty: en("czMapModeEmpty"),
} as const;
