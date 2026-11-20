// Agent C module contract: the interactive preprocessing explorer and the distortion profile of
// its current configuration for the spectral quality map.
export { PreprocessingExplorer, useDebounced } from "./PreprocessingExplorer";
export { useDistortionProfile, getDistortionProfile, type DistortionProfile } from "./distortion";
// Fitted pipeline API (agent E, domain-shift preprocessing explorer): learned parameters fitted on
// reference rows only, applied to other rows. Run in a worker; Methods WASM loads once per thread.
export { loadMethodsKernel } from "./methodsKernel";
export { applyPipelineFitted, applyPipelineFittedRows, applyPipeline, takeRows, type ExplorerKernel } from "./evaluate";
export { STEP_SPECS, STEP_KINDS, pipelineLabel, stepIssue, type StepRecipe, type StepKind } from "./catalog";
export type { Matrix } from "./metrics";
