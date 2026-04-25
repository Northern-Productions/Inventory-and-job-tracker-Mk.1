export const PLANNER_WARNING_SUMMARY =
  'Allocation planner completed with warnings. Some legacy reservations need review.';

const PLANNER_WARNING_PATTERNS = [
  /\bskipped\s+auto\s+planning\b/i,
  /\bauto\s+planning\b/i,
  /\bauto_planned\b/i,
  /\bplanner\s+capacity\b/i,
  /\breconcile_auto_planned_allocations\b/i
];

function normalizeWarning(value: unknown) {
  return String(value || '').trim();
}

export function isPlannerDiagnosticWarning(value: unknown) {
  const warning = normalizeWarning(value);
  return Boolean(warning) && PLANNER_WARNING_PATTERNS.some((pattern) => pattern.test(warning));
}

export function splitMutationWarnings(warnings: readonly unknown[] = []) {
  const userWarnings: string[] = [];
  const plannerWarnings: string[] = [];

  for (const value of warnings) {
    const warning = normalizeWarning(value);
    if (!warning) {
      continue;
    }

    if (isPlannerDiagnosticWarning(warning)) {
      plannerWarnings.push(warning);
    } else {
      userWarnings.push(warning);
    }
  }

  return {
    userWarnings,
    plannerWarnings
  };
}

/**
 * PURPOSE:
 * Formats mutation warnings for success toasts while keeping verbose allocation
 * planner diagnostics out of normal user-facing copy.
 *
 * AFFECTS:
 * Inventory, job, film-order, box, and caulk mutation success notifications.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Backend/Edge warning payload conventions, planner warning text in migration
 * 0085, and toast tests for mutation workflows.
 *
 * COMMON FAILURE MODES:
 * Raw planner warnings can create giant green toasts; over-filtering warnings
 * can hide actionable user warnings; missing console logging hurts diagnosis.
 */
export function formatMutationWarningDescription(
  warnings: readonly unknown[] = [],
  fallbackDescription: string,
  context = 'mutation'
) {
  const { userWarnings, plannerWarnings } = splitMutationWarnings(warnings);

  if (plannerWarnings.length > 0 && typeof console !== 'undefined') {
    console.warn(`[${context}] Allocation planner warnings`, plannerWarnings);
  }

  const visibleWarnings = [...userWarnings];
  if (plannerWarnings.length > 0) {
    visibleWarnings.push(PLANNER_WARNING_SUMMARY);
  }

  return visibleWarnings.join(' ') || fallbackDescription;
}
