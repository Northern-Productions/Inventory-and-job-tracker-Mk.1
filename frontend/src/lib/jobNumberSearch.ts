import type { JobListEntry } from '../domain';
import { rankJobNumberSearchCandidates } from '../domain/jobNumberSearchMatcher.mjs';

function compareJobsByDateAndId(left: JobListEntry, right: JobListEntry): number {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
    return left.dueDate > right.dueDate ? -1 : 1;
  }

  if (left.dueDate && !right.dueDate) {
    return -1;
  }

  if (!left.dueDate && right.dueDate) {
    return 1;
  }

  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }

  if (left.updatedAt && !right.updatedAt) {
    return -1;
  }

  if (!left.updatedAt && right.updatedAt) {
    return 1;
  }

  return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
}

export function rankActiveJobsByNumericCloseness(
  entries: JobListEntry[],
  query: string,
  limit = 25
): JobListEntry[] {
  if (!Number.isFinite(limit) || limit <= 0 || !String(query || '').trim()) {
    return [];
  }

  return rankJobNumberSearchCandidates(
    entries.filter((entry) => String(entry.lifecycleStatus || 'ACTIVE').toUpperCase() === 'ACTIVE'),
    query,
    {
      compareWithinMatch: compareJobsByDateAndId,
      limit
    }
  );
}

