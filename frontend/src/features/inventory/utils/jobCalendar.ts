import type { JobListEntry } from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { getJobListDisplayStatus } from './jobSorts';

export type CalendarJob = JobListEntry;
export type JobCalendarView = 'week' | 'month';
type JobLifecycleStatus = 'ACTIVE' | 'COMPLETED';

export interface JobCalendarDay {
  dateKey: string;
  date: string;
  dayOfMonth: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  jobs: CalendarJob[];
}

export interface JobCalendarEventSegment {
  job: CalendarJob;
  weekIndex: number;
  startDate: string;
  endDate: string;
  startIndex: number;
  spanDays: number;
  isRangeStart: boolean;
  isRangeEnd: boolean;
  isMultiDay: boolean;
}

export interface JobCalendarPeriod {
  view: JobCalendarView;
  anchorDate: string;
  periodLabel: string;
  monthKey: string;
  monthLabel: string;
  days: JobCalendarDay[];
  weeks: JobCalendarDay[][];
  weekSegments: JobCalendarEventSegment[][];
  unscheduledJobs: CalendarJob[];
  rangeStart: string;
  rangeEnd: string;
}

export type JobCalendarMonth = JobCalendarPeriod;

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseMonthKey(monthKey: string) {
  const match = String(monthKey || '').trim().match(MONTH_KEY_PATTERN);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }

  return { year, monthIndex };
}

function parseDateKey(dateKey: string) {
  const match = String(dateKey || '').trim().match(DATE_KEY_PATTERN);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(monthIndex) ||
    !Number.isInteger(day) ||
    monthIndex < 0 ||
    monthIndex > 11 ||
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }

  return { year, monthIndex, day, date };
}

function formatMonthKey(year: number, monthIndex: number) {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function formatDateKey(date: Date) {
  return `${formatMonthKey(date.getFullYear(), date.getMonth())}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeAnchorDate(anchorDate: string) {
  const parsed = parseDateKey(anchorDate);
  if (!parsed) {
    return todayDateString();
  }

  return formatDateKey(parsed.date);
}

function createDateFromKey(dateKey: string) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) {
    return parseDateKey(todayDateString())?.date || new Date();
  }

  return parsed.date;
}

function addDays(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

function getLastDayOfMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function shiftDateByMonths(date: Date, delta: number) {
  const targetMonthIndex = date.getMonth() + delta;
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(date.getDate(), getLastDayOfMonth(targetYear, normalizedMonthIndex));
  return new Date(targetYear, normalizedMonthIndex, day);
}

function extractDigits(value: string) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function canonicalizeDigits(value: string) {
  const withoutLeadingZeros = value.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function compareJobNumbers(left: CalendarJob, right: CalendarJob) {
  return left.jobNumber.localeCompare(right.jobNumber, undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function normalizeLifecycleStatus(value: string) {
  return String(value || '').trim().toUpperCase() === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';
}

function compareBigInt(left: bigint, right: bigint) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function absoluteBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

function chunkDays(days: JobCalendarDay[]) {
  const weeks: JobCalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return weeks;
}

function isValidDateKey(value: string) {
  return Boolean(parseDateKey(value));
}

function getCalendarJobDateRange(job: CalendarJob) {
  const startDate = String(job.installDate || '').trim().slice(0, 10);
  if (!isValidDateKey(startDate)) {
    return null;
  }

  const rawEndDate = String(job.installEndDate || '').trim().slice(0, 10);
  const endDate = isValidDateKey(rawEndDate) && rawEndDate >= startDate ? rawEndDate : startDate;
  return { startDate, endDate };
}

function formatWeekRangeSegment(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatWeekRangeFull(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function buildJobsByDate(jobs: CalendarJob[], rangeStart: string, rangeEnd: string) {
  const jobsByDate = new Map<string, CalendarJob[]>();

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const range = getCalendarJobDateRange(job);
    if (!range) {
      continue;
    }

    if (range.startDate > rangeEnd || range.endDate < rangeStart) {
      continue;
    }

    const startDate = range.startDate > rangeStart ? range.startDate : rangeStart;
    const endDate = range.endDate < rangeEnd ? range.endDate : rangeEnd;
    for (
      let cursor = createDateFromKey(startDate);
      formatDateKey(cursor) <= endDate;
      cursor = addDays(cursor, 1)
    ) {
      const dateKey = formatDateKey(cursor);
      if (!jobsByDate.has(dateKey)) {
        jobsByDate.set(dateKey, []);
      }
      jobsByDate.get(dateKey)?.push(job);
    }
  }

  return {
    jobsByDate,
    unscheduledJobs: [] as CalendarJob[]
  };
}

function buildCalendarWeekSegments(
  weeks: JobCalendarDay[][],
  jobs: CalendarJob[],
  rangeStart: string,
  rangeEnd: string,
) {
  const weekSegments = weeks.map(() => [] as JobCalendarEventSegment[]);
  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const job = jobs[jobIndex];
    const jobRange = getCalendarJobDateRange(job);
    if (!jobRange || jobRange.startDate > rangeEnd || jobRange.endDate < rangeStart) {
      continue;
    }

    for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
      const week = weeks[weekIndex];
      const weekStart = week[0]?.dateKey || '';
      const weekEnd = week[week.length - 1]?.dateKey || '';
      if (!weekStart || !weekEnd || jobRange.startDate > weekEnd || jobRange.endDate < weekStart) {
        continue;
      }

      const startDate = [jobRange.startDate, weekStart, rangeStart].sort()[2];
      const endDate = [jobRange.endDate, weekEnd, rangeEnd].sort()[0];
      if (startDate > endDate) {
        continue;
      }

      const startIndex = week.findIndex((day) => day.dateKey === startDate);
      const endIndex = week.findIndex((day) => day.dateKey === endDate);
      if (startIndex < 0 || endIndex < startIndex) {
        continue;
      }

      weekSegments[weekIndex].push({
        job,
        weekIndex,
        startDate,
        endDate,
        startIndex,
        spanDays: endIndex - startIndex + 1,
        isRangeStart: startDate === jobRange.startDate,
        isRangeEnd: endDate === jobRange.endDate,
        isMultiDay: jobRange.endDate > jobRange.startDate
      });
    }
  }

  return weekSegments.map((segments) =>
    segments.sort((left, right) => {
      if (left.startIndex !== right.startIndex) {
        return left.startIndex - right.startIndex;
      }
      if (left.spanDays !== right.spanDays) {
        return right.spanDays - left.spanDays;
      }
      return compareJobNumbers(left.job, right.job);
    })
  );
}

export function getCurrentMonthKey(today = todayDateString()) {
  return getMonthKeyFromDate(today) || formatMonthKey(new Date().getFullYear(), new Date().getMonth());
}

export const getCurrentJobCalendarMonth = getCurrentMonthKey;

export function getCurrentCalendarAnchorDate(today = todayDateString()) {
  return normalizeAnchorDate(today);
}

export function getMonthKeyFromDate(dateValue: string) {
  const normalized = String(dateValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return '';
  }

  return normalized.slice(0, 7);
}

export function shiftMonthKey(monthKey: string, delta: number) {
  const parsed = parseMonthKey(monthKey) || parseMonthKey(getCurrentMonthKey());
  if (!parsed) {
    return getCurrentMonthKey();
  }

  return getMonthKeyFromDate(
    shiftCalendarAnchorDate(`${formatMonthKey(parsed.year, parsed.monthIndex)}-01`, 'month', delta)
  );
}

export const shiftJobCalendarMonth = shiftMonthKey;

export function formatMonthKeyLabel(monthKey: string) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) {
    return monthKey;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric'
  }).format(new Date(parsed.year, parsed.monthIndex, 1));
}

export const formatJobCalendarMonthLabel = formatMonthKeyLabel;

export function getWeekStartDate(anchorDate: string) {
  const date = createDateFromKey(normalizeAnchorDate(anchorDate));
  return formatDateKey(addDays(date, -date.getDay()));
}

export function getCalendarPeriodRange(view: JobCalendarView, anchorDate: string) {
  const normalizedAnchorDate = normalizeAnchorDate(anchorDate);
  if (view === 'week') {
    const startDate = getWeekStartDate(normalizedAnchorDate);
    return {
      startDate,
      endDate: formatDateKey(addDays(createDateFromKey(startDate), 6))
    };
  }

  const monthKey = getMonthKeyFromDate(normalizedAnchorDate) || getCurrentMonthKey();
  const parsed = parseMonthKey(monthKey) || parseMonthKey(getCurrentMonthKey());
  if (!parsed) {
    const today = getCurrentCalendarAnchorDate();
    return {
      startDate: `${getMonthKeyFromDate(today)}-01`,
      endDate: today
    };
  }

  return {
    startDate: `${formatMonthKey(parsed.year, parsed.monthIndex)}-01`,
    endDate: formatDateKey(new Date(parsed.year, parsed.monthIndex + 1, 0))
  };
}

export function isDateInCalendarPeriod(view: JobCalendarView, anchorDate: string, dateValue: string) {
  const candidateDate = String(dateValue || '').trim().slice(0, 10);
  if (!parseDateKey(candidateDate)) {
    return false;
  }

  const range = getCalendarPeriodRange(view, anchorDate);
  return candidateDate >= range.startDate && candidateDate <= range.endDate;
}

export function shiftCalendarAnchorDate(anchorDate: string, view: JobCalendarView, delta: number) {
  const normalizedAnchorDate = normalizeAnchorDate(anchorDate);
  const date = createDateFromKey(normalizedAnchorDate);
  return formatDateKey(view === 'week' ? addDays(date, delta * 7) : shiftDateByMonths(date, delta));
}

export function formatWeekRangeLabel(anchorDate: string) {
  const startDate = createDateFromKey(getWeekStartDate(anchorDate));
  const endDate = addDays(startDate, 6);
  if (startDate.getFullYear() === endDate.getFullYear()) {
    return `${formatWeekRangeSegment(startDate)} - ${formatWeekRangeSegment(endDate)}, ${startDate.getFullYear()}`;
  }

  return `${formatWeekRangeFull(startDate)} - ${formatWeekRangeFull(endDate)}`;
}

export function formatCalendarPeriodLabel(view: JobCalendarView, anchorDate: string) {
  return view === 'week'
    ? formatWeekRangeLabel(anchorDate)
    : formatMonthKeyLabel(getMonthKeyFromDate(normalizeAnchorDate(anchorDate)) || getCurrentMonthKey());
}

export function getCalendarJobStatusClass(
  entry: Pick<CalendarJob, 'status' | 'lifecycleStatus' | 'filmOrderCount' | 'hasOrderedAllocations'>
) {
  const lifecycleStatus = String(entry.lifecycleStatus || '').trim().toUpperCase();
  const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);

  if (lifecycleStatus === 'COMPLETED' || displayStatus === 'COMPLETED') {
    return 'job-calendar-job-link-status-completed';
  }

  if (lifecycleStatus === 'CANCELLED' || displayStatus === 'CANCELLED') {
    return 'job-calendar-job-link-status-cancelled';
  }

  if (displayStatus === 'ORDERED') {
    return 'job-calendar-job-link-status-ordered';
  }

  if (displayStatus === 'FILM_ORDER') {
    return 'job-calendar-job-link-status-film-order';
  }

  if (displayStatus === 'NEEDS_ALLOCATION') {
    return 'job-calendar-job-link-status-allocate';
  }

  if (displayStatus === 'READY') {
    return 'job-calendar-job-link-status-ready';
  }

  if (entry.hasOrderedAllocations) {
    return 'job-calendar-job-link-status-ordered';
  }

  return 'job-calendar-job-link-status-neutral';
}

export const getJobCalendarStatusClassName = getCalendarJobStatusClass;

export function selectCalendarHighlightJobNumbers(matches: CalendarJob[], query: string) {
  const queryDigits = canonicalizeDigits(extractDigits(query));
  if (!queryDigits || !matches.length) {
    return [];
  }

  const exactMatches = matches.filter(
    (entry) => canonicalizeDigits(extractDigits(entry.jobNumber)) === queryDigits
  );

  if (exactMatches.length) {
    return exactMatches.map((entry) => entry.jobNumber);
  }

  const queryValue = BigInt(queryDigits);
  return matches
    .slice()
    .sort((left, right) => {
      const leftDigits = canonicalizeDigits(extractDigits(left.jobNumber));
      const rightDigits = canonicalizeDigits(extractDigits(right.jobNumber));
      const leftPrefix = leftDigits.startsWith(queryDigits);
      const rightPrefix = rightDigits.startsWith(queryDigits);
      if (leftPrefix !== rightPrefix) {
        return leftPrefix ? -1 : 1;
      }

      const distanceOrder = compareBigInt(
        absoluteBigInt(BigInt(leftDigits) - queryValue),
        absoluteBigInt(BigInt(rightDigits) - queryValue)
      );
      if (distanceOrder !== 0) {
        return distanceOrder;
      }

      return compareJobNumbers(left, right);
    })
    .slice(0, 3)
    .map((entry) => entry.jobNumber);
}

export const deriveJobCalendarHighlightJobNumbers = selectCalendarHighlightJobNumbers;

export function compareCalendarSearchMatches(
  left: CalendarJob,
  right: CalendarJob,
  query: string,
  options: { preferredLifecycleStatus?: JobLifecycleStatus } = {}
) {
  const queryDigits = canonicalizeDigits(extractDigits(query));
  if (!queryDigits) {
    return compareJobNumbers(left, right);
  }

  const queryValue = BigInt(queryDigits);
  const leftDigits = canonicalizeDigits(extractDigits(left.jobNumber));
  const rightDigits = canonicalizeDigits(extractDigits(right.jobNumber));
  const leftExact = leftDigits === queryDigits;
  const rightExact = rightDigits === queryDigits;
  if (leftExact !== rightExact) {
    return leftExact ? -1 : 1;
  }

  const leftPrefix = leftDigits.startsWith(queryDigits);
  const rightPrefix = rightDigits.startsWith(queryDigits);
  if (leftPrefix !== rightPrefix) {
    return leftPrefix ? -1 : 1;
  }

  if (leftPrefix && rightPrefix) {
    const leftLengthDelta = Math.abs(leftDigits.length - queryDigits.length);
    const rightLengthDelta = Math.abs(rightDigits.length - queryDigits.length);
    if (leftLengthDelta !== rightLengthDelta) {
      return leftLengthDelta - rightLengthDelta;
    }
  }

  const distanceOrder = compareBigInt(
    absoluteBigInt(BigInt(leftDigits) - queryValue),
    absoluteBigInt(BigInt(rightDigits) - queryValue)
  );
  if (distanceOrder !== 0) {
    return distanceOrder;
  }

  if (options.preferredLifecycleStatus) {
    const leftPreferred =
      normalizeLifecycleStatus(left.lifecycleStatus) === options.preferredLifecycleStatus;
    const rightPreferred =
      normalizeLifecycleStatus(right.lifecycleStatus) === options.preferredLifecycleStatus;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1;
    }
  }

  return compareJobNumbers(left, right);
}

export function findBestCalendarSearchMatch(
  matches: CalendarJob[],
  query: string,
  options: { preferredLifecycleStatus?: JobLifecycleStatus } = {}
) {
  if (!matches.length) {
    return null;
  }

  const queryDigits = canonicalizeDigits(extractDigits(query));
  if (!queryDigits) {
    return null;
  }

  return matches
    .slice()
    .sort((left, right) => compareCalendarSearchMatches(left, right, query, options))[0] || null;
}

export function sortCalendarJobsWithinDay(jobs: CalendarJob[], highlightJobNumbers: string[] = []) {
  const highlighted = new Set(highlightJobNumbers);
  return jobs.slice().sort((left, right) => {
    const leftHighlighted = highlighted.has(left.jobNumber);
    const rightHighlighted = highlighted.has(right.jobNumber);
    if (leftHighlighted !== rightHighlighted) {
      return leftHighlighted ? -1 : 1;
    }

    if (left.isStagedForPickup !== right.isStagedForPickup) {
      return left.isStagedForPickup ? -1 : 1;
    }

    return compareJobNumbers(left, right);
  });
}

export function buildCalendarPeriod(
  view: JobCalendarView,
  anchorDate: string,
  jobs: CalendarJob[]
): JobCalendarPeriod {
  const normalizedView: JobCalendarView = view === 'month' ? 'month' : 'week';
  const normalizedAnchorDate = normalizeAnchorDate(anchorDate);
  const monthKey = getMonthKeyFromDate(normalizedAnchorDate) || getCurrentMonthKey();
  const monthLabel = formatMonthKeyLabel(monthKey);
  const range = getCalendarPeriodRange(normalizedView, normalizedAnchorDate);
  const { jobsByDate, unscheduledJobs } = buildJobsByDate(jobs, range.startDate, range.endDate);
  const today = todayDateString();

  const days: JobCalendarDay[] = [];
  if (normalizedView === 'week') {
    const weekStartDate = createDateFromKey(range.startDate);
    for (let index = 0; index < 7; index += 1) {
      const cursor = addDays(weekStartDate, index);
      const dateKey = formatDateKey(cursor);
      days.push({
        dateKey,
        date: dateKey,
        dayOfMonth: cursor.getDate(),
        inCurrentMonth: true,
        isToday: dateKey === today,
        jobs: sortCalendarJobsWithinDay(jobsByDate.get(dateKey) || [])
      });
    }
  } else {
    const parsedMonth = parseMonthKey(monthKey) || parseMonthKey(getCurrentMonthKey());
    if (parsedMonth) {
      const monthStart = new Date(parsedMonth.year, parsedMonth.monthIndex, 1);
      const monthEnd = new Date(parsedMonth.year, parsedMonth.monthIndex + 1, 0);
      const firstGridDate = new Date(
        parsedMonth.year,
        parsedMonth.monthIndex,
        1 - monthStart.getDay()
      );
      const lastGridDate = new Date(
        parsedMonth.year,
        parsedMonth.monthIndex,
        monthEnd.getDate() + (6 - monthEnd.getDay())
      );
      const minimumGridDayCount = 42;

      for (
        let cursor = new Date(firstGridDate.getFullYear(), firstGridDate.getMonth(), firstGridDate.getDate());
        cursor <= lastGridDate || days.length < minimumGridDayCount;
        cursor = addDays(cursor, 1)
      ) {
        const dateKey = formatDateKey(cursor);
        days.push({
          dateKey,
          date: dateKey,
          dayOfMonth: cursor.getDate(),
          inCurrentMonth: cursor.getMonth() === parsedMonth.monthIndex,
          isToday: dateKey === today,
          jobs: sortCalendarJobsWithinDay(jobsByDate.get(dateKey) || [])
        });
      }
    }
  }

  const weeks = chunkDays(days);

  return {
    view: normalizedView,
    anchorDate: normalizedAnchorDate,
    periodLabel: formatCalendarPeriodLabel(normalizedView, normalizedAnchorDate),
    monthKey,
    monthLabel,
    days,
    weeks,
    weekSegments: buildCalendarWeekSegments(weeks, jobs, range.startDate, range.endDate),
    unscheduledJobs,
    rangeStart: range.startDate,
    rangeEnd: range.endDate
  };
}

export function buildWeekCalendar(anchorDate: string, jobs: CalendarJob[]) {
  return buildCalendarPeriod('week', anchorDate, jobs);
}

export function buildMonthCalendar(monthKey: string, jobs: CalendarJob[]): JobCalendarMonth {
  const parsed = parseMonthKey(monthKey) || parseMonthKey(getCurrentMonthKey());
  const normalizedMonthKey = parsed ? formatMonthKey(parsed.year, parsed.monthIndex) : getCurrentMonthKey();
  return buildCalendarPeriod('month', `${normalizedMonthKey}-01`, jobs);
}

export function buildJobCalendarDays(monthKey: string, jobs: CalendarJob[]) {
  return buildMonthCalendar(monthKey, jobs).days;
}
