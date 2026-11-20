// Joint interpretation of spectral and target associations (joint interpretation request §1, §7–10):
// metadata and target associations, the joint X–Y landscape with dynamic interpretation, and the validation
// scenario audit. Consumes the design module's typed adapter and shared factor selection.
export { TargetAssociations } from "./TargetAssociations";
export { JointSection } from "./JointSection";
export { ScenarioAuditSection } from "./ScenarioAudit";
export { associationResults, associationFamily, jointRows, type AssociationResult, type JointRow } from "./model";
export { jointSentences, ETA_LANDMARKS, type Sentence } from "./interpret";
export { targetUnits, associationRows, metadataFactors, identityComponents, exactDevelopmentReferences } from "./units";
