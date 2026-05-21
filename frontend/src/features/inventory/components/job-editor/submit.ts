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
  JobPhaseEditorLine,
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
  phases: JobPhaseEditorLine[];
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
  phases,
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

  const normalizedPhases: Array<Omit<JobPhaseEditorLine, 'phaseNumber'> & { phaseNumber: number }> = [];
  const seenPhaseNumbers = new Set<number>();
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const rawPhaseNumber = String(phase.phaseNumber ?? '').trim();
    const phaseNumber = Number(rawPhaseNumber);
    if (!/^\d+$/.test(rawPhaseNumber) || !Number.isSafeInteger(phaseNumber) || phaseNumber <= 0) {
      return {
        error: `Phase ${index + 1}: Phase number must be a positive whole number.`,
        payload: null
      };
    }
    if (seenPhaseNumbers.has(phaseNumber)) {
      return {
        error: `Phase ${phaseNumber} already exists on this job.`,
        payload: null
      };
    }
    seenPhaseNumbers.add(phaseNumber);
    const normalizedInstallDate = phase.installDate.trim();
    const normalizedInstallEndDate = String(phase.installEndDate || '').trim();
    if (normalizedInstallEndDate && !normalizedInstallDate) {
      return {
        error: `Phase ${phaseNumber}: Install End Date requires an Install Date.`,
        payload: null
      };
    }
    if (normalizedInstallEndDate && normalizedInstallEndDate < normalizedInstallDate) {
      return {
        error: `Phase ${phaseNumber}: Install End Date must be the same day as or later than Install Date.`,
        payload: null
      };
    }
    normalizedPhases.push({
      ...phase,
      phaseNumber,
      workScope: phase.workScope.trim(),
      sections: phase.sections.trim(),
      installDate: normalizedInstallDate,
      installEndDate: normalizedInstallEndDate,
      crewLeader: phase.crewLeader.trim(),
      isPrimary: phase.isPrimary === true || index === 0
    });
  }

  const primaryPhase = normalizedPhases.find((phase) => phase.isPrimary) || normalizedPhases[0];
  const phaseByKey = new Map(normalizedPhases.map((phase) => [phase.id, phase]));

  const normalizedLines: JobRequirementEditorLine[] = [];
  for (let index = 0; index < requirements.length; index += 1) {
    const line = requirements[index];
    const parsedWidth = Number(line.widthIn);
    const parsedRequiredFeet = Number(line.requiredFeet);
    const phase = phaseByKey.get(line.phaseKey) || primaryPhase;

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
      phaseId: phase?.phaseId || undefined,
      phaseNumber: phase?.phaseNumber,
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
    const phase = phaseByKey.get(line.phaseKey) || primaryPhase;

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
      phaseId: phase?.phaseId || undefined,
      phaseNumber: phase?.phaseNumber,
      productId: line.productId,
      requiredTubes: Math.floor(parsedRequiredTubes)
    });
  }

  return {
    error: null,
    payload: {
      jobNumber: mode === 'edit' ? initialJobNumber : normalizedJobNumber,
      warehouse,
      workScope: primaryPhase?.workScope ?? sections,
      sections: primaryPhase?.sections ?? sections,
      installDate: primaryPhase?.installDate ?? installDate,
      crewLeader: primaryPhase?.crewLeader ?? crewLeader.trim(),
      requirements: mergeRequirementLines(normalizedLines),
      caulkRequirements: normalizedCaulkLines,
      phases: normalizedPhases.map((phase) => ({
        ...phase,
        requirements: mergeRequirementLines(
          normalizedLines.filter((line) =>
            phase.phaseId
              ? line.phaseId === phase.phaseId
              : line.phaseNumber === phase.phaseNumber
          )
        ),
        caulkRequirements: normalizedCaulkLines.filter((line) =>
          phase.phaseId
            ? line.phaseId === phase.phaseId
            : line.phaseNumber === phase.phaseNumber
        )
      }))
    }
  };
}
