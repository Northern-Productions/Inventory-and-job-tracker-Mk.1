import type { JobListEntry } from '../../../domain';
import { rankJobNumberSearchCandidates } from '../../../domain/jobNumberSearchMatcher.mjs';

export type JobSortOption =
  | 'install_date_asc'
  | 'install_date_desc'
  | 'ready'
  | 'film_order';

export const JOB_SORT_OPTIONS: Array<{ label: string; value: JobSortOption }> = [
  { label: 'Install Date Ascending', value: 'install_date_asc' },
  { label: 'Install Date Descending', value: 'install_date_desc' },
  { label: 'Ready', value: 'ready' },
  { label: 'Film Order', value: 'film_order' }
];

function parseJobNumber(jobNumber: string) {
  const digits = Number(String(jobNumber || '').replace(/\D+/g, ''));
  return Number.isFinite(digits) ? digits : Number.MAX_SAFE_INTEGER;
}

function compareNumbers(left: number, right: number) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareJobNumberAscending(left: JobListEntry, right: JobListEntry) {
  return (
    compareNumbers(parseJobNumber(left.jobNumber), parseJobNumber(right.jobNumber)) ||
    compareStrings(left.jobNumber, right.jobNumber)
  );
}

function compareJobNumberDescending(left: JobListEntry, right: JobListEntry) {
  return compareJobNumberAscending(right, left);
}

function compareInstallDateAscending(left: JobListEntry, right: JobListEntry) {
  const leftInstallDate = String(left.installDate || '').trim();
  const rightInstallDate = String(right.installDate || '').trim();

  if (leftInstallDate && rightInstallDate && leftInstallDate !== rightInstallDate) {
    return leftInstallDate < rightInstallDate ? -1 : 1;
  }

  if (leftInstallDate && !rightInstallDate) {
    return -1;
  }

  if (!leftInstallDate && rightInstallDate) {
    return 1;
  }

  return compareJobNumberAscending(left, right);
}

function compareInstallDateDescending(left: JobListEntry, right: JobListEntry) {
  const leftInstallDate = String(left.installDate || '').trim();
  const rightInstallDate = String(right.installDate || '').trim();

  if (leftInstallDate && rightInstallDate && leftInstallDate !== rightInstallDate) {
    return leftInstallDate > rightInstallDate ? -1 : 1;
  }

  if (leftInstallDate && !rightInstallDate) {
    return -1;
  }

  if (!leftInstallDate && rightInstallDate) {
    return 1;
  }

  return compareJobNumberDescending(left, right);
}

export function getJobListDisplayStatus(status: string, _filmOrderCount: number) {
  if (status === 'ORDERED') {
    return 'ORDERED';
  }

  return status;
}

export function describeJobSort(sort: JobSortOption) {
  switch (sort) {
    case 'install_date_asc':
      return 'install date ascending';
    case 'install_date_desc':
      return 'install date descending';
    case 'ready':
      return 'ready first';
    case 'film_order':
      return 'film order first';
    default:
      return 'install date ascending';
  }
}

function rankJobForFilmOrderSort(displayStatus: string) {
  if (displayStatus === 'FILM_ORDER') {
    return 0;
  }
  if (displayStatus === 'NEEDS_ALLOCATION') {
    return 1;
  }
  if (displayStatus === 'ORDERED') {
    return 2;
  }
  return 3;
}

export function compareJobsBySort(left: JobListEntry, right: JobListEntry, sort: JobSortOption) {
  switch (sort) {
    case 'install_date_asc':
      return compareInstallDateAscending(left, right);
    case 'install_date_desc':
      return compareInstallDateDescending(left, right);
    case 'ready': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = leftDisplayStatus === 'READY' ? 0 : leftDisplayStatus === 'ORDERED' ? 1 : 2;
      const rightRank = rightDisplayStatus === 'READY' ? 0 : rightDisplayStatus === 'ORDERED' ? 1 : 2;
      return compareNumbers(leftRank, rightRank) || compareInstallDateAscending(left, right);
    }
    case 'film_order': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = rankJobForFilmOrderSort(leftDisplayStatus);
      const rightRank = rankJobForFilmOrderSort(rightDisplayStatus);
      return compareNumbers(leftRank, rightRank) || compareInstallDateAscending(left, right);
    }
    default:
      return compareInstallDateAscending(left, right);
  }
}

export function sortJobs(entries: JobListEntry[], sort: JobSortOption) {
  return entries.slice().sort((left, right) => compareJobsBySort(left, right, sort));
}

export function sortSearchedJobs(entries: JobListEntry[], query: string, sort: JobSortOption) {
  return rankJobNumberSearchCandidates(entries, query, {
    compareWithinMatch: (left: JobListEntry, right: JobListEntry) =>
      compareJobsBySort(left, right, sort)
  }) as JobListEntry[];
}
