const SUMMARY_FIELDS = Object.freeze([
  'status',
  'lifecycleStatus',
  'hasOrderedAllocations',
  'requiredFeet',
  'allocatedFeet',
  'remainingFeet',
  'requiredTubes',
  'allocatedTubes',
  'remainingTubes',
  'requirementCount',
  'allocationCount',
  'filmOrderCount',
]);

export const JOB_SUMMARY_COMPARISON_MODES = Object.freeze({
  CANONICAL_UUID: 'canonical UUID',
  LEGACY_JOB_NUMBER: 'legacy job-number',
  LEGACY_ROUTE_OBSERVATION: 'legacy-route historical observation',
});

export class JobSummaryParityDiagnosticError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobSummaryParityDiagnosticError';
  }
}

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function incrementFieldCounts(target, fields) {
  for (const field of fields) {
    target[field] = (target[field] || 0) + 1;
  }
}

function requireDetailSummary(detail, comparisonMode) {
  if (!detail || !detail.summary || typeof detail.summary !== 'object') {
    throw new JobSummaryParityDiagnosticError(
      `${comparisonMode} detail lookup returned no summary.`,
    );
  }
  return detail.summary;
}

async function loadDetailForEntry({
  client,
  orgId,
  entry,
  comparisonMode,
  buildJobDetail,
  buildJobDetailById,
}) {
  try {
    if (comparisonMode === JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID) {
      const jobId = asTrimmedString(entry?.jobId);
      return requireDetailSummary(
        await buildJobDetailById(client, orgId, jobId),
        comparisonMode,
      );
    }

    const jobNumber = asTrimmedString(entry?.jobNumber);
    return requireDetailSummary(
      await buildJobDetail(client, orgId, jobNumber),
      comparisonMode,
    );
  } catch (error) {
    if (error instanceof JobSummaryParityDiagnosticError) {
      throw error;
    }
    throw new JobSummaryParityDiagnosticError(`${comparisonMode} detail lookup failed.`);
  }
}

export function buildComparableJobSummary(summary) {
  return {
    status: asTrimmedString(summary?.status),
    lifecycleStatus: asTrimmedString(summary?.lifecycleStatus),
    hasOrderedAllocations: Boolean(summary?.hasOrderedAllocations),
    requiredFeet: Number(summary?.requiredFeet ?? 0),
    allocatedFeet: Number(summary?.allocatedFeet ?? 0),
    remainingFeet: Number(summary?.remainingFeet ?? 0),
    requiredTubes: Number(summary?.requiredTubes ?? 0),
    allocatedTubes: Number(summary?.allocatedTubes ?? 0),
    remainingTubes: Number(summary?.remainingTubes ?? 0),
    requirementCount: Number(summary?.requirementCount ?? 0),
    allocationCount: Number(summary?.allocationCount ?? 0),
    filmOrderCount: Number(summary?.filmOrderCount ?? 0),
  };
}

export function getJobSummaryDifferenceFields(left, right) {
  const leftComparable = buildComparableJobSummary(left);
  const rightComparable = buildComparableJobSummary(right);
  return SUMMARY_FIELDS.filter(
    (field) => JSON.stringify(leftComparable[field]) !== JSON.stringify(rightComparable[field]),
  );
}

export function selectJobSummaryComparisonMode(entry) {
  return asTrimmedString(entry?.jobId)
    ? JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID
    : JOB_SUMMARY_COMPARISON_MODES.LEGACY_JOB_NUMBER;
}

export async function compareJobSummaryEntries({
  client,
  orgId,
  entries,
  buildJobDetail,
  buildJobDetailById,
}) {
  const result = {
    comparedCount: 0,
    canonicalComparedCount: 0,
    legacyComparedCount: 0,
    mismatchCount: 0,
    canonicalMismatchCount: 0,
    legacyMismatchCount: 0,
    differingFields: {},
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const comparisonMode = selectJobSummaryComparisonMode(entry);
    const detailSummary = await loadDetailForEntry({
      client,
      orgId,
      entry,
      comparisonMode,
      buildJobDetail,
      buildJobDetailById,
    });
    const differingFields = getJobSummaryDifferenceFields(entry, detailSummary);

    result.comparedCount += 1;
    if (comparisonMode === JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID) {
      result.canonicalComparedCount += 1;
    } else {
      result.legacyComparedCount += 1;
    }

    if (!differingFields.length) {
      continue;
    }

    result.mismatchCount += 1;
    if (comparisonMode === JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID) {
      result.canonicalMismatchCount += 1;
    } else {
      result.legacyMismatchCount += 1;
    }
    incrementFieldCounts(result.differingFields, differingFields);
  }

  return result;
}

export function assertJobSummaryParity(result) {
  if (!result?.mismatchCount) {
    return;
  }

  const differingFields = Object.keys(result.differingFields || {}).sort().join(', ') || 'unknown';
  throw new JobSummaryParityDiagnosticError(
    `Found ${result.mismatchCount} job summary parity mismatch(es) ` +
      `(${JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID}: ${result.canonicalMismatchCount}; ` +
      `${JOB_SUMMARY_COMPARISON_MODES.LEGACY_JOB_NUMBER}: ${result.legacyMismatchCount}; ` +
      `differing fields: ${differingFields}).`,
  );
}

export async function observeLegacyRouteDivergences({
  client,
  orgId,
  entries,
  buildJobDetail,
}) {
  const result = {
    classification: JOB_SUMMARY_COMPARISON_MODES.LEGACY_ROUTE_OBSERVATION,
    observedCount: 0,
    divergenceCount: 0,
    differingFields: {},
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (selectJobSummaryComparisonMode(entry) !== JOB_SUMMARY_COMPARISON_MODES.CANONICAL_UUID) {
      continue;
    }

    let detailSummary;
    try {
      detailSummary = requireDetailSummary(
        await buildJobDetail(client, orgId, asTrimmedString(entry?.jobNumber)),
        JOB_SUMMARY_COMPARISON_MODES.LEGACY_ROUTE_OBSERVATION,
      );
    } catch (error) {
      if (error instanceof JobSummaryParityDiagnosticError) {
        throw error;
      }
      throw new JobSummaryParityDiagnosticError(
        `${JOB_SUMMARY_COMPARISON_MODES.LEGACY_ROUTE_OBSERVATION} lookup failed.`,
      );
    }

    result.observedCount += 1;
    const differingFields = getJobSummaryDifferenceFields(entry, detailSummary);
    if (!differingFields.length) {
      continue;
    }

    result.divergenceCount += 1;
    incrementFieldCounts(result.differingFields, differingFields);
  }

  return result;
}
