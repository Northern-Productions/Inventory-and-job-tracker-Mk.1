import { describe, expect, it } from 'vitest';
import type { CalendarJob } from './jobCalendar';
import {
  buildMonthCalendar,
  buildWeekCalendar,
  compareCalendarSearchMatches,
  findBestCalendarSearchMatch,
  formatWeekRangeLabel,
  getCalendarJobStatusClass,
  isDateInCalendarPeriod,
  selectCalendarHighlightJobNumbers,
  shiftCalendarAnchorDate,
  shiftMonthKey,
  sortCalendarJobsWithinDay
} from './jobCalendar';

function buildJob(overrides: Partial<CalendarJob> & Pick<CalendarJob, 'jobNumber'>): CalendarJob {
  const { jobNumber, ...rest } = overrides;

  return {
    jobNumber,
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-03-24',
    crewLeader: '',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...rest
  };
}

describe('jobCalendar', () => {
  it('builds a 6-week month calendar and groups jobs by date', () => {
    const month = buildMonthCalendar('2026-03', [
      buildJob({ jobNumber: '10001', installDate: '2026-03-01' }),
      buildJob({ jobNumber: '10002', installDate: '2026-03-24' }),
      buildJob({ jobNumber: '10003', installDate: '' })
    ]);

    expect(month.monthLabel).toBe('March 2026');
    expect(month.periodLabel).toBe('March 2026');
    expect(month.days).toHaveLength(42);
    expect(month.weeks).toHaveLength(6);
    expect(month.days.find((day) => day.dateKey === '2026-03-24')?.jobs.map((job) => job.jobNumber)).toEqual([
      '10002'
    ]);
    expect(month.unscheduledJobs.map((job) => job.jobNumber)).toEqual(['10003']);
  });

  it('builds a Sunday-start week range and keeps cross-month jobs visible', () => {
    const week = buildWeekCalendar('2026-03-31', [
      buildJob({ jobNumber: '10001', installDate: '2026-03-29' }),
      buildJob({ jobNumber: '10002', installDate: '2026-04-04' }),
      buildJob({ jobNumber: '10003', installDate: '2026-04-05' })
    ]);

    expect(week.periodLabel).toBe('Mar 29 - Apr 4, 2026');
    expect(week.days).toHaveLength(7);
    expect(week.rangeStart).toBe('2026-03-29');
    expect(week.rangeEnd).toBe('2026-04-04');
    expect(week.days[0].dateKey).toBe('2026-03-29');
    expect(week.days[6].dateKey).toBe('2026-04-04');
    expect(week.days[6].jobs.map((job) => job.jobNumber)).toEqual(['10002']);
  });

  it('returns only the exact match when a numeric search finds one', () => {
    const jobs = [
      buildJob({ jobNumber: '06881' }),
      buildJob({ jobNumber: '06895' }),
      buildJob({ jobNumber: '06900' })
    ];

    expect(selectCalendarHighlightJobNumbers(jobs, '6881')).toEqual(['06881']);
  });

  it('returns the closest three jobs when there is no exact match', () => {
    const jobs = [
      buildJob({ jobNumber: '06881' }),
      buildJob({ jobNumber: '06895' }),
      buildJob({ jobNumber: '06810' }),
      buildJob({ jobNumber: '07001' })
    ];

    expect(selectCalendarHighlightJobNumbers(jobs, '689')).toEqual(['06895', '06810', '06881']);
  });

  it('finds the best match, preserves highlighted ordering, and formats calendar shifts', () => {
    const jobs = [
      buildJob({ jobNumber: '20000', installDate: '2026-04-01' }),
      buildJob({ jobNumber: '10000', installDate: '2026-04-01', isStagedForPickup: true }),
      buildJob({ jobNumber: '30000', installDate: '2026-04-01' })
    ];

    expect(findBestCalendarSearchMatch(jobs, '10000')?.jobNumber).toBe('10000');
    expect(
      sortCalendarJobsWithinDay(jobs, ['30000']).map((job) => `${job.jobNumber}:${job.isStagedForPickup ? 'staged' : 'open'}`)
    ).toEqual(['30000:open', '10000:staged', '20000:open']);
    expect(shiftMonthKey('2026-03', 1)).toBe('2026-04');
    expect(shiftCalendarAnchorDate('2026-03-29', 'week', 1)).toBe('2026-04-05');
    expect(shiftCalendarAnchorDate('2026-03-29', 'month', 1)).toBe('2026-04-29');
    expect(formatWeekRangeLabel('2026-03-31')).toBe('Mar 29 - Apr 4, 2026');
    expect(isDateInCalendarPeriod('week', '2026-03-31', '2026-04-03')).toBe(true);
    expect(isDateInCalendarPeriod('week', '2026-03-31', '2026-04-05')).toBe(false);
    expect(isDateInCalendarPeriod('month', '2026-03-31', '2026-03-05')).toBe(true);
    expect(
      getCalendarJobStatusClass(
        buildJob({ jobNumber: '40000', lifecycleStatus: 'COMPLETED', status: 'READY' })
      )
    ).toBe('job-calendar-job-link-status-completed');
    expect(
      getCalendarJobStatusClass(
        buildJob({ jobNumber: '50000', status: 'ALLOCATE', isStagedForPickup: true })
      )
    ).toBe('job-calendar-job-link-status-ready');
  });

  it('prefers the current workflow when cross-workflow search results tie', () => {
    const active = buildJob({ jobNumber: '12340', lifecycleStatus: 'ACTIVE', status: 'READY' });
    const completed = buildJob({
      jobNumber: '12360',
      lifecycleStatus: 'COMPLETED',
      status: 'COMPLETED'
    });

    expect(
      compareCalendarSearchMatches(active, completed, '12350', {
        preferredLifecycleStatus: 'ACTIVE'
      })
    ).toBeLessThan(0);
    expect(
      findBestCalendarSearchMatch([completed, active], '12350', {
        preferredLifecycleStatus: 'ACTIVE'
      })?.jobNumber
    ).toBe('12340');
  });
});
