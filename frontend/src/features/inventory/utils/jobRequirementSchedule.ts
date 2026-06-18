import type { JobRequirementLine } from '../../../domain';

type ScheduleContext = {
  installDate?: string | null;
  crewLeader?: string | null;
};

function hasPhaseScheduleScope(requirement: JobRequirementLine | null | undefined) {
  if (!requirement) {
    return false;
  }

  return Boolean(
    String(requirement.phaseId || '').trim() ||
      requirement.phaseNumber ||
      String(requirement.phaseWorkScope || '').trim() ||
      requirement.phaseInstallDate !== undefined ||
      requirement.phaseCrewLeader !== undefined
  );
}

export function resolveRequirementScheduleContext(
  requirement: JobRequirementLine | null | undefined,
  fallback: ScheduleContext
) {
  if (!hasPhaseScheduleScope(requirement)) {
    return {
      installDate: String(fallback.installDate || '').trim(),
      crewLeader: String(fallback.crewLeader || '').trim()
    };
  }

  return {
    installDate: String(requirement?.phaseInstallDate || '').trim(),
    crewLeader: String(requirement?.phaseCrewLeader || '').trim()
  };
}
