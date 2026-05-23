import type { JobDetail } from '../../../domain';

type StagingDetail = Pick<
  JobDetail,
  | 'summary'
  | 'requirements'
  | 'allocations'
  | 'caulkRequirements'
  | 'caulkAllocations'
  | 'filmOrders'
  | 'filmTransferAlerts'
  | 'caulkTransferAlerts'
>;

export function getJobStagingBlockingMessage(detail: StagingDetail | null | undefined) {
  return getJobStagingBlockingMessageWithOptions(detail);
}

function hasActiveOrderedRequirementAllocations(detail: StagingDetail | null | undefined) {
  return (detail?.allocations || []).some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocationKind !== 'EXTRA' &&
      entry.allocatedFeet > 0 &&
      entry.boxStatus === 'ORDERED'
  );
}

function getPhaseId(entry: { phaseId?: string | null } | null | undefined) {
  return String(entry?.phaseId || '').trim();
}

function getRequirementId(entry: { requirementId?: string | null } | null | undefined) {
  return String(entry?.requirementId || '').trim();
}

function isWorkflowActivePhase(phase: { workflowStatus?: string | null }) {
  return String(phase.workflowStatus || '').trim().toUpperCase() !== 'PLACEHOLDER';
}

function getActivePhaseScope(detail: StagingDetail | null | undefined) {
  const phases = detail?.summary?.phases || [];
  if (!phases.length) {
    return {
      hasPhaseScope: false,
      activePhaseIds: new Set<string>(),
      fallbackPhaseId: ''
    };
  }

  const activePhases = phases.filter(isWorkflowActivePhase);
  return {
    hasPhaseScope: true,
    activePhaseIds: new Set(activePhases.map(getPhaseId).filter(Boolean)),
    fallbackPhaseId: getPhaseId(phases.find((phase) => phase.isPrimary) || phases[0])
  };
}

function isEntryInActivePhase(
  entry: { phaseId?: string | null } | null | undefined,
  scope: ReturnType<typeof getActivePhaseScope>
) {
  if (!scope.hasPhaseScope) {
    return true;
  }
  const phaseId = getPhaseId(entry);
  if (phaseId) {
    return scope.activePhaseIds.has(phaseId);
  }
  return Boolean(scope.fallbackPhaseId && scope.activePhaseIds.has(scope.fallbackPhaseId));
}

function getActiveScopedDetail(detail: StagingDetail | null | undefined) {
  const scope = getActivePhaseScope(detail);
  const requirements = (detail?.requirements || []).filter((entry) => isEntryInActivePhase(entry, scope));
  const caulkRequirements = (detail?.caulkRequirements || []).filter((entry) => isEntryInActivePhase(entry, scope));
  const filmRequirementIds = new Set(requirements.map(getRequirementId).filter(Boolean));
  const caulkRequirementIds = new Set(caulkRequirements.map(getRequirementId).filter(Boolean));
  const allocations = (detail?.allocations || []).filter((entry) => {
    const requirementId = getRequirementId(entry);
    return requirementId ? filmRequirementIds.has(requirementId) : isEntryInActivePhase(entry as { phaseId?: string | null }, scope);
  });
  const caulkAllocations = (detail?.caulkAllocations || []).filter((entry) => {
    const requirementId = getRequirementId(entry);
    return requirementId ? caulkRequirementIds.has(requirementId) : isEntryInActivePhase(entry as { phaseId?: string | null }, scope);
  });
  const activeBoxIds = new Set(allocations.map((entry) => entry.boxId).filter(Boolean));
  const activeCaulkAllocationIds = new Set(caulkAllocations.map((entry) => entry.caulkAllocationId).filter(Boolean));
  return {
    requirements,
    caulkRequirements,
    allocations,
    caulkAllocations,
    filmTransferAlerts: (detail?.filmTransferAlerts || []).filter((entry) => activeBoxIds.has(entry.boxId)),
    caulkTransferAlerts: (detail?.caulkTransferAlerts || []).filter((entry) =>
      activeCaulkAllocationIds.has(entry.caulkAllocationId)
    )
  };
}

export function getJobStagingBlockingMessageWithOptions(
  detail: StagingDetail | null | undefined,
  _options: { allowAutoCheckout?: boolean } = {}
) {
  const summary = detail?.summary;
  if (!summary || summary.lifecycleStatus !== 'ACTIVE') {
    return '';
  }

  const scoped = getActiveScopedDetail(detail);
  const requirements = scoped.requirements;
  const caulkRequirements = scoped.caulkRequirements;
  const hasMaterialRequirements =
    requirements.some((entry) => entry.requiredFeet > 0) ||
    caulkRequirements.some((entry) => entry.requiredTubes > 0);
  if (!hasMaterialRequirements) {
    return '';
  }

  const hasRemainingFilm = requirements.some((entry) => entry.remainingFeet > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => entry.remainingTubes > 0);
  if (hasRemainingFilm || hasRemainingCaulk) {
    return 'Allocate all required film and caulk before staging this job.';
  }

  const filmTransferAlertCount = scoped.filmTransferAlerts.length;
  const caulkTransferAlertCount = scoped.caulkTransferAlerts.length;
  if (filmTransferAlertCount > 0 && caulkTransferAlertCount > 0) {
    return 'Receive transferred film and caulk before staging this job.';
  }

  if (filmTransferAlertCount > 0) {
    return 'Receive transferred film before staging this job.';
  }

  if (caulkTransferAlertCount > 0) {
    return 'Receive transferred caulk before staging/checking out this job.';
  }

  if (hasActiveOrderedRequirementAllocations({ ...detail, allocations: scoped.allocations } as StagingDetail)) {
    return 'Receive ordered film before staging this job.';
  }

  const hasUncheckedOutFilm = scoped.allocations.some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocationKind !== 'EXTRA' &&
      entry.allocatedFeet > 0 &&
      !String(entry.resolvedAt || '').trim()
  );
  if (hasUncheckedOutFilm) {
    return 'Check out the allocated film before staging this job.';
  }

  const hasUncheckedOutCaulk = scoped.caulkAllocations.some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocatedTubes > 0 &&
      entry.reservedTubesRemaining > 0
  );
  if (hasUncheckedOutCaulk) {
    return 'Check out the allocated caulk before staging this job.';
  }

  return '';
}

export function canMarkJobStagedForPickup(detail: StagingDetail | null | undefined) {
  return !getJobStagingBlockingMessageWithOptions(detail);
}

export function canMarkJobStagedForPickupWithAutoCheckout(detail: StagingDetail | null | undefined) {
  return !getJobStagingBlockingMessageWithOptions(detail);
}

export function isLaborOnlyJob(detail: StagingDetail | null | undefined) {
  const summary = detail?.summary;
  if (!summary || summary.lifecycleStatus !== 'ACTIVE') {
    return false;
  }

  if (summary.isLaborOnly) {
    return true;
  }

  return Number(summary.requiredFeet || 0) <= 0 && Number(summary.requiredTubes || 0) <= 0;
}
