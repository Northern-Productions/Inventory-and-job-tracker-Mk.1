const JOB_SCHEDULE_ALIAS_ROUTES = new Set(['/jobs/create', '/jobs/update']);
const ALLOCATION_SCHEDULE_ALIAS_ROUTES = new Set(['/allocations/add', '/allocations/apply']);

function mirrorAliasField(target, canonicalField, legacyField) {
  if (target[canonicalField] !== undefined && target[legacyField] === undefined) {
    target[legacyField] = target[canonicalField];
    return;
  }

  if (target[canonicalField] === undefined && target[legacyField] !== undefined) {
    target[canonicalField] = target[legacyField];
  }
}

/**
 * Mirrors legacy schedule aliases onto the canonical public payload fields without
 * overwriting explicit caller input when both names are already present.
 *
 * @param {string} logicalPath
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown>}
 */
export function normalizeSchedulePayloadAliases(logicalPath, payload) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {};

  if (JOB_SCHEDULE_ALIAS_ROUTES.has(logicalPath)) {
    mirrorAliasField(next, 'installDate', 'dueDate');
    return next;
  }

  if (ALLOCATION_SCHEDULE_ALIAS_ROUTES.has(logicalPath)) {
    mirrorAliasField(next, 'installDate', 'jobDate');
    return next;
  }

  return next;
}
