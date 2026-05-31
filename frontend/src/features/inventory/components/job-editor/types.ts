import type { PhaseWorkflowStatus, Warehouse } from '../../../../domain';

export interface JobRequirementEditorLine {
  requirementId?: string;
  phaseId?: string;
  phaseNumber?: number;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
}

export interface JobEditorSubmitPayload {
  jobNumber: string;
  warehouse: Warehouse;
  workScope: string;
  sections: string;
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  requirements: JobRequirementEditorLine[];
  caulkRequirements: JobCaulkRequirementEditorLine[];
  phases?: JobEditorSubmitPhaseLine[];
}

export interface JobCaulkRequirementEditorLine {
  requirementId?: string;
  phaseId?: string;
  phaseNumber?: number;
  productId: string;
  requiredTubes: number;
}

export interface JobPhaseEditorLine {
  id: string;
  phaseId?: string;
  phaseNumber: number | string;
  workScope: string;
  sections: string;
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  laborStatus?: 'ACTIVE' | 'COMPLETE';
  workflowStatus?: PhaseWorkflowStatus;
  isPrimary?: boolean;
  isComplete?: boolean;
  isNextRelevant?: boolean;
  isExpandedByDefault?: boolean;
  status?: string;
  requirements?: JobRequirementEditorLine[];
  caulkRequirements?: JobCaulkRequirementEditorLine[];
}

export interface JobEditorSubmitPhaseLine {
  phaseId?: string;
  phaseNumber: number;
  workScope: string;
  sections: string;
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  laborStatus?: 'ACTIVE' | 'COMPLETE';
  workflowStatus?: PhaseWorkflowStatus;
  isPrimary?: boolean;
  requirements?: JobRequirementEditorLine[];
  caulkRequirements?: JobCaulkRequirementEditorLine[];
}

export interface RequirementDraftLine {
  id: string;
  requirementId: string;
  phaseKey: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  requiredFeet: string;
}

export interface CaulkRequirementDraftLine {
  id: string;
  requirementId: string;
  phaseKey: string;
  productId: string;
  requiredTubes: string;
}
