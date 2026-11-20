// Characterization chart kit (interim demo components, nirs4all-ui debt): import "./charts.css" once via this index.
import "./charts.css";

export { ChartCard, EmptyState, KpiStrip, Legend, Responsive, toneClass, type KpiItem, type LegendItem, type Tone } from "./frame";
export { AnomalyGlyph, AnomalyShapes, ProportionBars, StackedShareBar, ValueBars, type GlyphKind, type ProportionRow, type ShareSegment, type ValueRow } from "./bars";
export { DualScaleGauge, type GaugeBand, type GaugeTick } from "./DualScaleGauge";
export { BoxPlotRows, boxStatsValid, type BoxRow, type BoxStats } from "./BoxPlotRows";
export { DotMark, DotPlot, type DotPoint, type DotRow, type DotShape } from "./DotPlot";
export { Histogram, type HistBin, type HistMarker } from "./Histogram";
export { ParetoScatter, type ScatterPoint, type ScatterZone } from "./ParetoScatter";
export { SegmentStrip, classRuns, type StripClass, type StripRange, type StripRow } from "./SegmentStrip";
export { PrincipleIllustration } from "./PrincipleIllustration";
export { binValues, clamp, defaultFmt, extent, linear, niceTicks, share, textWidth, useWidth, type Fmt } from "./scale";
