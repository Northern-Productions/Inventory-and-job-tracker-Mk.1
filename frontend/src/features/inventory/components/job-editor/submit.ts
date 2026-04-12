import type { Warehouse } from '../../../../domain';
import { canonicalizeManufacturerLabel } from '../../utils/boxHelpers';
import {
  buildPendingJobEditorDraftMessage,
  getPendingJobEditorDrafts
} from '../../utils/jobEditorDrafts';
import { mergeRequirementLines } from './helpers';
import type {
  CaulkRequirementDraftLine,
  JobCaulkRequirementEditorLine,
  JobEditorSubmitPayload,
  JobRequirementEditorLine,
  RequirementDraftLine
} from './types';

interface BuildJobEditorSubmitPayloadArgs {
  mode: 'create' | 'edit';
  initialJobNumber: string;
  jobNumber: string;
  warehouse: Warehouse;
  sections: string;
  installDate: string;
  crewLeader: string;
  requirements: RequirementDraftLine[];
  caulkRequirements: CaulkRequirementDraftLine[];
  filmNameDraft: string;
  widthDraft: string;
  requiredFeetDraft: string;
  caulkRequiredTubesDraft: string;
}

interface BuildJobEditorSubmitPayloadResult {
  error: string | null;
  payload: JobEditorSubmitPayload | null;
}

export function buildJobEditorSubmitPayload({
  mode,
  initialJobNumber,
  jobNumber,
  warehouse,
  sections,
  installDate,
  crewLeader,
  requirements,
  caulkRequirements,
  filmNameDraft,
  widthDraft,
  requiredFeetDraft,
  caulkRequiredTubesDraft
}: BuildJobEditorSubmitPayloadArgs): BuildJobEditorSubmitPayloadResult {
  const normalizedJobNumber = jobNumber.replace(/[^0-9]/g, '');
  if (!normalizedJobNumber) {
    return {
      error: 'Job ID number is required.',
      payload: null
    };
  }

  const pendingDrafts = getPendingJobEditorDrafts({
    filmName: filmNameDraft,
    widthIn: widthDraft,
    requiredFeet: requiredFeetDraft,
    caulkRequiredTubes: caulkRequiredTubesDraft
  });
  const pendingDraftMessage = buildPendingJobEditorDraftMessage(pendingDrafts);
  if (pendingDraftMessage) {
    return {
      error: pendingDraftMessage,
      payload: null
    };
  }

  const normalizedLines: JobRequirementEditorLine[] = [];
  for (let index = 0; index < requirements.length; index += 1) {
    const line = requirements[index];
    const parsedWidth = Number(line.widthIn);
    const parsedRequiredFeet = Number(line.requiredFeet);

    if (!line.manufacturer.trim() || !line.filmName.trim()) {
      return {
        error: `Line ${index + 1}: Manufacturer and Film Name are required.`,
        payload: null
      };
    }

    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
      return {
        error: `Line ${index + 1}: Width must be greater than zero.`,
        payload: null
      };
    }

    if (!Number.isFinite(parsedRequiredFeet) || parsedRequiredFeet <= 0) {
      return {
        error: `Line ${index + 1}: LF Required must be greater than zero.`,
        payload: null
      };
    }

    normalizedLines.push({
      requirementId: line.requirementId || undefined,
      manufacturer: canonicalizeManufacturerLabel(line.manufacturer).trim(),
      filmName: line.filmName.trim(),
      widthIn: parsedWidth,
      requiredFeet: Math.floor(parsedRequiredFeet)
    });
  }

  const normalizedCaulkLines: JobCaulkRequirementEditorLine[] = [];
  for (let index = 0; index < caulkRequirements.length; index += 1) {
    const line = caulkRequirements[index];
    const parsedRequiredTubes = Number(line.requiredTubes);

    if (!line.productId.trim()) {
      return {
        error: `Caulk line ${index + 1}: product is required.`,
        payload: null
      };
    }

    if (!Number.isFinite(parsedRequiredTubes) || parsedRequiredTubes <= 0) {
      return {
        error: `Caulk line ${index + 1}: required tubes must be greater than zero.`,
        payload: null
      };
    }

    normalizedCaulkLines.push({
      requirementId: line.requirementId || undefined,
      productId: line.productId,
      requiredTubes: Math.floor(parsedRequiredTubes)
    });
  }

  return {
    error: null,
    payload: {
      jobNumber: mode === 'edit' ? initialJobNumber : normalizedJobNumber,
      warehouse,
      sections,
      installDate,
      crewLeader: crewLeader.trim(),
      requirements: mergeRequirementLines(normalizedLines),
      caulkRequirements: normalizedCaulkLines
    }
  };
}
