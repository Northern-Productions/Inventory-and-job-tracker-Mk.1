import type { JobListEntry } from '../../../domain';
import { rankJobNumberSearchCandidates } from '../../../domain/jobNumberSearchMatcher.mjs';

export type JobSortOption =
  | 'install_date_asc'
  | 'install_date_desc'
  | 'allocate'
  | 'film_order';

export const JOB_SORT_OPTIONS: Array<{ label: string; value: JobSortOption }> = [
  { label: 'Install Date Ascending', value: 'install_date_asc' },
  { label: 'Install Date Descending', value: 'install_date_desc' },
  { label: 'Allocate', value: 'allocate' },
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

export function getJobListDisplayStatus(status: string, filmOrderCount: number) {
  if (status === 'ALLOCATE' && filmOrderCount > 0) {
    return 'FILM_ORDER';
  }

  return status;
}

export function describeJobSort(sort: JobSortOption) {
  switch (sort) {
    case 'install_date_asc':
      return 'install date ascending';
    case 'install_date_desc':
      return 'install date descending';
    case 'allocate':
      return 'allocate first';
    case 'film_order':
      return 'film order first';
    default:
      return 'install date ascending';
  }
}

export function compareJobsBySort(left: JobListEntry, right: JobListEntry, sort: JobSortOption) {
  switch (sort) {
    case 'install_date_asc':
      return compareInstallDateAscending(left, right);
    case 'install_date_desc':
      return compareInstallDateDescending(left, right);
    case 'allocate': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = leftDisplayStatus === 'ALLOCATE' ? 0 : 1;
      const rightRank = rightDisplayStatus === 'ALLOCATE' ? 0 : 1;
      return compareNumbers(leftRank, rightRank) || compareInstallDateAscending(left, right);
    }
    case 'film_order': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = leftDisplayStatus === 'FILM_ORDER' ? 0 : 1;
      const rightRank = rightDisplayStatus === 'FILM_ORDER' ? 0 : 1;
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
