import type { JobListEntry } from '../../../domain';
import { rankJobNumberSearchCandidates } from '../../../domain/jobNumberSearchMatcher.mjs';

export type JobSortOption =
  | 'install_date'
  | 'job_number_asc'
  | 'job_number_desc'
  | 'date_added_newest'
  | 'date_added_oldest'
  | 'allocate'
  | 'film_order';

export const JOB_SORT_OPTIONS: Array<{ label: string; value: JobSortOption }> = [
  { label: 'Install Date', value: 'install_date' },
  { label: 'Job Number: Low To High', value: 'job_number_asc' },
  { label: 'Job Number: High To Low', value: 'job_number_desc' },
  { label: 'Date Added: Newest First', value: 'date_added_newest' },
  { label: 'Date Added: Oldest First', value: 'date_added_oldest' },
  { label: 'Status: Allocate First', value: 'allocate' },
  { label: 'Status: Film Order First', value: 'film_order' }
];

function parseJobNumber(jobNumber: string) {
  const digits = Number(String(jobNumber || '').replace(/\D+/g, ''));
  return Number.isFinite(digits) ? digits : Number.MAX_SAFE_INTEGER;
}

function parseTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
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

function compareTimestampDescending(leftValue: string, rightValue: string) {
  return compareNumbers(parseTimestamp(rightValue), parseTimestamp(leftValue));
}

function compareTimestampAscending(leftValue: string, rightValue: string) {
  return compareNumbers(parseTimestamp(leftValue), parseTimestamp(rightValue));
}

function fallbackJobSort(left: JobListEntry, right: JobListEntry) {
  return compareTimestampDescending(left.dueDate, right.dueDate) || compareJobNumberDescending(left, right);
}

export function getJobListDisplayStatus(status: string, filmOrderCount: number) {
  if (status === 'ALLOCATE' && filmOrderCount > 0) {
    return 'FILM_ORDER';
  }

  return status;
}

export function describeJobSort(sort: JobSortOption) {
  switch (sort) {
    case 'install_date':
      return 'install date';
    case 'job_number_asc':
      return 'job number, low to high';
    case 'job_number_desc':
      return 'job number, high to low';
    case 'date_added_newest':
      return 'date added, newest first';
    case 'date_added_oldest':
      return 'date added, oldest first';
    case 'allocate':
      return 'allocate status first';
    case 'film_order':
      return 'film order status first';
    default:
      return 'install date';
  }
}

export function compareJobsBySort(left: JobListEntry, right: JobListEntry, sort: JobSortOption) {
  switch (sort) {
    case 'job_number_asc':
      return compareJobNumberAscending(left, right);
    case 'job_number_desc':
      return compareJobNumberDescending(left, right);
    case 'date_added_newest':
      return (
        compareTimestampDescending(left.createdAt || left.updatedAt, right.createdAt || right.updatedAt) ||
        compareJobNumberDescending(left, right)
      );
    case 'date_added_oldest':
      return (
        compareTimestampAscending(left.createdAt || left.updatedAt, right.createdAt || right.updatedAt) ||
        compareJobNumberAscending(left, right)
      );
    case 'allocate': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = leftDisplayStatus === 'ALLOCATE' ? 0 : 1;
      const rightRank = rightDisplayStatus === 'ALLOCATE' ? 0 : 1;
      return compareNumbers(leftRank, rightRank) || fallbackJobSort(left, right);
    }
    case 'film_order': {
      const leftDisplayStatus = getJobListDisplayStatus(left.status, left.filmOrderCount);
      const rightDisplayStatus = getJobListDisplayStatus(right.status, right.filmOrderCount);
      const leftRank = leftDisplayStatus === 'FILM_ORDER' ? 0 : 1;
      const rightRank = rightDisplayStatus === 'FILM_ORDER' ? 0 : 1;
      return compareNumbers(leftRank, rightRank) || fallbackJobSort(left, right);
    }
    case 'install_date':
    default:
      return fallbackJobSort(left, right);
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
