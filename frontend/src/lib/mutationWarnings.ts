export const PLANNER_WARNING_SUMMARY =
  'Allocation planner completed with warnings. Some legacy reservations need review.';

export const DEFAULT_VISIBLE_MUTATION_WARNING_LIMIT = 3;

export interface MutationWarningFormatOptions {
  maxVisibleWarnings?: number;
  plannerSummary?: string;
}

const PLANNER_WARNING_PATTERNS = [
  /\bskipped\s+auto\b.*\bplanning\b/i,
  /\bskipped\s+auto\s+planning\b/i,
  /\bauto\s+planning\b/i,
  /\bauto\s+caulk\s+planning\b/i,
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
  const seenUserWarnings = new Set<string>();
  const seenPlannerWarnings = new Set<string>();

  for (const value of warnings) {
    const warning = normalizeWarning(value);
    if (!warning) {
      continue;
    }

    if (isPlannerDiagnosticWarning(warning)) {
      if (!seenPlannerWarnings.has(warning)) {
        seenPlannerWarnings.add(warning);
        plannerWarnings.push(warning);
      }
    } else {
      if (!seenUserWarnings.has(warning)) {
        seenUserWarnings.add(warning);
        userWarnings.push(warning);
      }
    }
  }

  return {
    userWarnings,
    plannerWarnings
  };
}

function pluralizeWarning(count: number) {
  return count === 1 ? 'warning' : 'warnings';
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
 * 0085/0086, and toast tests for mutation workflows.
 *
 * COMMON FAILURE MODES:
 * Raw planner warnings can create giant green toasts; over-filtering warnings
 * can hide actionable user warnings; missing console logging hurts diagnosis.
 */
export function formatMutationWarningDescription(
  warnings: readonly unknown[] = [],
  fallbackDescription: string,
  context = 'mutation',
  options: MutationWarningFormatOptions = {}
) {
  const { userWarnings, plannerWarnings } = splitMutationWarnings(warnings);
  const maxVisibleWarnings = Math.max(
    0,
    Math.floor(options.maxVisibleWarnings ?? DEFAULT_VISIBLE_MUTATION_WARNING_LIMIT)
  );
  const plannerSummary = options.plannerSummary ?? PLANNER_WARNING_SUMMARY;

  if (plannerWarnings.length > 0 && typeof console !== 'undefined') {
    console.warn(`[${context}] Allocation planner warnings`, plannerWarnings);
  }

  const visibleWarnings = userWarnings.slice(0, maxVisibleWarnings);
  const hiddenUserWarningCount = Math.max(0, userWarnings.length - visibleWarnings.length);
  if (hiddenUserWarningCount > 0) {
    visibleWarnings.push(
      `${hiddenUserWarningCount} more ${pluralizeWarning(hiddenUserWarningCount)} hidden.`
    );
  }

  if (plannerWarnings.length > 0) {
    visibleWarnings.push(
      `${plannerSummary} ${plannerWarnings.length} planner ${pluralizeWarning(
        plannerWarnings.length
      )} hidden.`
    );
  }

  return visibleWarnings.join(' ') || fallbackDescription;
}
