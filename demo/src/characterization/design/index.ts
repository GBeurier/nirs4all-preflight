// Experimental design, variance partition, statistical evidence and PERMDISP views (joint interpretation
// request §1–6, §11). Shared with the joint-interpretation sections: the typed design adapter and the
// selected-factor context.
export { designModel, bhAdjust, holmAdjust, evidenceState, adjustmentDrop, TEST_KINDS, EVIDENCE_STATES, type DesignModel, type FactorDesign, type TestEvidence, type TestKind, type EvidenceState, type DesignRelation, type RelationKind, type Crossing, type PlanView } from "./model";
export { DesignSelectionProvider, useDesignSelection, effectiveFactor, type DesignSelection } from "./selection";
export { associationRows, type AssociationRow } from "./consistency";
export { DesignSection, ConfoundingDetail } from "./sections";
