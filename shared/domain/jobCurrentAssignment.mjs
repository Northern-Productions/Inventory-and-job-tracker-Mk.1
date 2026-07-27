function asTrimmedString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function integerOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** @returns {number} */
function defaultCompareStrings(left, right) {
  const leftValue = asTrimmedString(left);
  const rightValue = asTrimmedString(right);
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

function getJobPhaseWorkflowStatus(phase) {
  return asTrimmedString(phase?.workflowStatus || phase?.workflow_status).toUpperCase() === 'PLACEHOLDER'
    ? 'PLACEHOLDER'
    : 'ACTIVE';
}

function isJobPhaseWorkflowActive(phase) {
  return getJobPhaseWorkflowStatus(phase) === 'ACTIVE';
}

function isJobRequirementComplete(requirement) {
  return asTrimmedString(requirement?.status).toUpperCase() === 'COMPLETE';
}

function isJobPhaseComplete(phase, filmRequirements = [], caulkRequirements = []) {
  const filmEntries = Array.isArray(filmRequirements) ? filmRequirements : [];
  const caulkEntries = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  if (filmEntries.length > 0 || caulkEntries.length > 0) {
    return (
      filmEntries.every(isJobRequirementComplete) &&
      caulkEntries.every(isJobRequirementComplete)
    );
  }

  return asTrimmedString(phase?.laborStatus || phase?.labor_status || phase?.status).toUpperCase() === 'COMPLETE';
}

function compareJobPhasesByNumber(left, right, compareStrings = defaultCompareStrings) {
  const leftNumber = integerOrZero(left?.phaseNumber ?? left?.phase_number) || 1;
  const rightNumber = integerOrZero(right?.phaseNumber ?? right?.phase_number) || 1;
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return compareStrings(
    left?.phaseId ?? left?.phase_id ?? left?.id,
    right?.phaseId ?? right?.phase_id ?? right?.id,
  );
}

function chooseCurrentJobPhaseGroup(
  phases,
  {
    today = new Date().toISOString().slice(0, 10),
    /** @type {(left: unknown, right: unknown) => number} */
    compareStrings = defaultCompareStrings,
  } = {},
) {
  const comparePhases = (left, right) => compareJobPhasesByNumber(left, right, compareStrings);
  const incomplete = (Array.isArray(phases) ? phases : [])
    .filter((phase) => !phase?.isComplete && isJobPhaseWorkflowActive(phase))
    .slice();
  if (!incomplete.length) {
    return [];
  }

  const dated = incomplete.filter((phase) => asTrimmedString(phase?.installDate ?? phase?.install_date));
  const compareDatedPhases = (left, right) => {
    const leftDate = asTrimmedString(left?.installDate ?? left?.install_date);
    const rightDate = asTrimmedString(right?.installDate ?? right?.install_date);
    if (leftDate !== rightDate) {
      return leftDate < rightDate ? -1 : 1;
    }
    return comparePhases(left, right);
  };
  const pastOrToday = dated
    .filter((phase) => asTrimmedString(phase?.installDate ?? phase?.install_date) <= today)
    .sort(compareDatedPhases);
  const future = dated
    .filter((phase) => asTrimmedString(phase?.installDate ?? phase?.install_date) > today)
    .sort(compareDatedPhases);
  const source = pastOrToday.length
    ? pastOrToday
    : future.length
      ? future
      : incomplete.sort(comparePhases);
  const first = source[0];
  const installDate = asTrimmedString(first?.installDate ?? first?.install_date);
  if (!installDate) {
    return [first];
  }

  return source.filter(
    (phase) => asTrimmedString(phase?.installDate ?? phase?.install_date) === installDate,
  );
}

function selectCurrentJobPhase(phases, options = {}) {
  const entries = Array.isArray(phases) ? phases : [];
  const currentGroup = chooseCurrentJobPhaseGroup(entries, options);
  const activeEntries = entries.filter(isJobPhaseWorkflowActive);
  return currentGroup[0] || activeEntries[0] || entries[0] || null;
}

function resolveCurrentJobCrewLeader({
  currentPhase,
  jobCrewLeader,
  legacyCrewLeader,
}) {
  return (
    asTrimmedString(currentPhase?.crewLeader || currentPhase?.crew_leader) ||
    asTrimmedString(jobCrewLeader) ||
    asTrimmedString(legacyCrewLeader)
  );
}

export {
  chooseCurrentJobPhaseGroup,
  compareJobPhasesByNumber,
  getJobPhaseWorkflowStatus,
  isJobPhaseComplete,
  isJobPhaseWorkflowActive,
  isJobRequirementComplete,
  resolveCurrentJobCrewLeader,
  selectCurrentJobPhase,
};
