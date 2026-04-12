import type { Warehouse } from '../../../../domain';

export interface JobRequirementEditorLine {
  requirementId?: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
}

export interface JobEditorSubmitPayload {
  jobNumber: string;
  warehouse: Warehouse;
  sections: string;
  installDate: string;
  crewLeader: string;
  requirements: JobRequirementEditorLine[];
  caulkRequirements: JobCaulkRequirementEditorLine[];
}

export interface JobCaulkRequirementEditorLine {
  requirementId?: string;
  productId: string;
  requiredTubes: number;
}

export interface RequirementDraftLine {
  id: string;
  requirementId: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  requiredFeet: string;
}

export interface CaulkRequirementDraftLine {
  id: string;
  requirementId: string;
  productId: string;
  requiredTubes: string;
}
