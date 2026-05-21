import type { Warehouse } from '../../../../domain';

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
  crewLeader: string;
  requirements: JobRequirementEditorLine[];
  caulkRequirements: JobCaulkRequirementEditorLine[];
  phases?: Array<Omit<JobPhaseEditorLine, 'phaseNumber'> & { phaseNumber: number }>;
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
  crewLeader: string;
  laborStatus?: 'ACTIVE' | 'COMPLETE';
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
