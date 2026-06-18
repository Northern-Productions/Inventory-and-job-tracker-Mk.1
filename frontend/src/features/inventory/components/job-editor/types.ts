import type { PhaseWorkflowStatus, Warehouse } from '../../../../domain';

export type JobRequirementEditorStatus = 'ACTIVE' | 'COMPLETE';

export interface JobRequirementEditorLine {
  requirementId?: string;
  phaseId?: string;
  phaseNumber?: number;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
  status?: JobRequirementEditorStatus;
  actualUsedFeet?: number;
  completedAt?: string;
  completedBy?: string;
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
  status?: JobRequirementEditorStatus;
  actualUsedTubes?: number;
  completedAt?: string;
  completedBy?: string;
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
  status?: JobRequirementEditorStatus;
  actualUsedFeet?: number;
  completedAt?: string;
  completedBy?: string;
}

export interface CaulkRequirementDraftLine {
  id: string;
  requirementId: string;
  phaseKey: string;
  productId: string;
  requiredTubes: string;
  status?: JobRequirementEditorStatus;
  actualUsedTubes?: number;
  completedAt?: string;
  completedBy?: string;
}
