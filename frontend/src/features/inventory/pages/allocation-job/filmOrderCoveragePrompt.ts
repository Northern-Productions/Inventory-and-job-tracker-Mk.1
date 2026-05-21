import type {
  AllocationJobDetailEntry,
  FilmOrderEntry,
  JobDetail,
  JobRequirementLine
} from '../../../../domain';
import { normalizeFilmRequirementOrderKey } from './filmRequirementOrders';

export interface FilmOrderCoverageSnapshot {
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  allocations?: AllocationJobDetailEntry[];
}

type DismissedPromptKeys = ReadonlySet<string> | string[];

function normalizeOrderId(value: string) {
  return String(value || '').trim().toUpperCase();
}

function getDismissedPromptKeySet(dismissedPromptKeys: DismissedPromptKeys = new Set()) {
  return Array.isArray(dismissedPromptKeys)
    ? new Set(dismissedPromptKeys.map((entry) => String(entry || '').trim()).filter(Boolean))
    : dismissedPromptKeys;
}

function hasDownstreamFilmOrderState(order: FilmOrderEntry, allocations: AllocationJobDetailEntry[] = []) {
  const filmOrderId = normalizeOrderId(order.filmOrderId);
  if (Number(order.coveredFeet || 0) > 0 || Number(order.orderedFeet || 0) > 0) {
    return true;
  }

  if (Array.isArray(order.linkedBoxes) && order.linkedBoxes.length > 0) {
    return true;
  }

  return allocations.some(
    (entry) =>
      normalizeOrderId(entry.filmOrderId || '') === filmOrderId &&
      String(entry.status || '').trim().toUpperCase() !== 'CANCELLED'
  );
}

function isManualPlainOpenFilmOrder(order: FilmOrderEntry, allocations: AllocationJobDetailEntry[] = []) {
  const status = String(order.status || '').trim().toUpperCase();
  const origin = String(order.origin || '').trim().toUpperCase();
  const sourceBoxId = String(order.sourceBoxId || '').trim();

  if (status !== 'FILM_ORDER') {
    return false;
  }

  if (origin ? origin !== 'MANUAL' : Boolean(sourceBoxId)) {
    return false;
  }

  return !hasDownstreamFilmOrderState(order, allocations);
}

function groupRequirementsByFilmKey(requirements: JobRequirementLine[]) {
  const grouped = new Map<string, JobRequirementLine[]>();

  for (const requirement of requirements || []) {
    if (requirement.status === 'COMPLETE') {
      continue;
    }
    const key = normalizeFilmRequirementOrderKey(requirement);
    const entries = grouped.get(key) || [];
    entries.push(requirement);
    grouped.set(key, entries);
  }

  return grouped;
}

function groupRequiredFeetByFilmKey(requirements: JobRequirementLine[]) {
  const grouped = new Map<string, number>();

  for (const requirement of requirements || []) {
    if (requirement.status === 'COMPLETE') {
      continue;
    }
    const key = normalizeFilmRequirementOrderKey(requirement);
    grouped.set(key, (grouped.get(key) || 0) + Math.max(0, Number(requirement.requiredFeet || 0)));
  }

  return grouped;
}

function hasUnmetRequirement(requirements: JobRequirementLine[] | undefined) {
  return Boolean(
    requirements?.some((entry) => Math.max(0, Number(entry.remainingFeet || 0)) > 0)
  );
}

function hasOnlyFullyCoveredRequirements(requirements: JobRequirementLine[] | undefined) {
  return Boolean(
    requirements?.length &&
      requirements.every((entry) => Math.max(0, Number(entry.remainingFeet || 0)) <= 0)
  );
}

export function buildStaleFilmOrderPromptKey(order: Pick<FilmOrderEntry, 'filmOrderId'>) {
  return normalizeOrderId(order.filmOrderId);
}

export function createFilmOrderCoverageSnapshot(
  detail:
    | Partial<Pick<JobDetail, 'requirements' | 'filmOrders' | 'allocations'>>
    | null
    | undefined
): FilmOrderCoverageSnapshot {
  return {
    requirements: (detail?.requirements || []).map((entry) => ({ ...entry })),
    filmOrders: (detail?.filmOrders || []).map((entry) => ({
      ...entry,
      linkedBoxes: Array.isArray(entry.linkedBoxes)
        ? entry.linkedBoxes.map((linkedBox) => ({ ...linkedBox }))
        : []
    })),
    allocations: (detail?.allocations || []).map((entry) => ({ ...entry }))
  };
}

export function didFilmRequirementDemandChange(
  before: FilmOrderCoverageSnapshot | null | undefined,
  after: FilmOrderCoverageSnapshot | null | undefined
) {
  const beforeGroups = groupRequiredFeetByFilmKey(before?.requirements || []);
  const afterGroups = groupRequiredFeetByFilmKey(after?.requirements || []);
  const keys = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);

  for (const key of keys) {
    if ((beforeGroups.get(key) || 0) !== (afterGroups.get(key) || 0)) {
      return true;
    }
  }

  return false;
}

/**
 * PURPOSE:
 * Finds manual film orders that became stale because an explicit user action
 * moved all matching requirement rows from unmet to fully covered.
 *
 * AFFECTS:
 * Allocation Job confirmation prompts, manual film-order cancellation, job
 * requirement edits, and delete mutation eligibility expectations.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * JobAllocateDialog success callbacks, useJobLifecycleWorkflow edit handling,
 * runtimeAllocationCleanup.mjs, api_film_orders_delete migrations, and
 * FilmRequirementsSection order actions.
 *
 * COMMON FAILURE MODES:
 * Prompting after planner-only changes, repeatedly prompting after Keep,
 * cancelling an order with downstream fulfillment, or treating one covered
 * split requirement as covering every related row.
 */
export function findStaleManualFilmOrdersAfterCoverageTransition({
  before,
  after,
  dismissedPromptKeys = new Set()
}: {
  before: FilmOrderCoverageSnapshot | null | undefined;
  after: FilmOrderCoverageSnapshot | null | undefined;
  dismissedPromptKeys?: DismissedPromptKeys;
}): FilmOrderEntry[] {
  if (!before || !after) {
    return [];
  }

  const dismissed = getDismissedPromptKeySet(dismissedPromptKeys);
  const beforeGroups = groupRequirementsByFilmKey(before.requirements || []);
  const afterGroups = groupRequirementsByFilmKey(after.requirements || []);
  const afterAllocations = after.allocations || [];
  const candidates: FilmOrderEntry[] = [];
  const seenOrderIds = new Set<string>();

  for (const order of after.filmOrders || []) {
    const promptKey = buildStaleFilmOrderPromptKey(order);
    if (!promptKey || dismissed.has(promptKey) || seenOrderIds.has(promptKey)) {
      continue;
    }

    if (!isManualPlainOpenFilmOrder(order, afterAllocations)) {
      continue;
    }

    const requirementKey = normalizeFilmRequirementOrderKey(order);
    if (
      !hasUnmetRequirement(beforeGroups.get(requirementKey)) ||
      !hasOnlyFullyCoveredRequirements(afterGroups.get(requirementKey))
    ) {
      continue;
    }

    candidates.push(order);
    seenOrderIds.add(promptKey);
  }

  return candidates.sort((left, right) => {
    const leftLabel = `${left.filmName} ${left.widthIn} ${left.filmOrderId}`;
    const rightLabel = `${right.filmName} ${right.widthIn} ${right.filmOrderId}`;
    return leftLabel.localeCompare(rightLabel);
  });
}
