// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JobListEntry } from '../../../../domain';
import { JobsResultsSection } from './JobsResultsSection';

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobNumber: '16961',
    warehouse: 'IL1',
    sections: '260',
    installDate: '2026-03-24',
    crewLeader: '',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 12,
    allocatedFeet: 12,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
    notes: '',
    ...overrides
  };
}

describe('JobsResultsSection interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('prefetches job details when a list job row is hovered', () => {
    const onPrefetchJob = vi.fn();

    render(
      <JobsResultsSection
        isCalendarView={false}
        workflowTitle="Recent Jobs"
        calendarVisibleCount={0}
        listJobsLength={1}
        calendarPeriodPreposition="for"
        calendarPeriodLabel="Mar 22 - Mar 28, 2026"
        listJobsLoading={false}
        jobsLoadingLabel="Loading active jobs..."
        calendarLoading={false}
        workflowSummaryLabel="active jobs"
        displayedCalendarGranularity="week"
        listJobsError={null}
        calendarError={null}
        jobsEmptyState="No active jobs found yet."
        listJobs={[buildJob()]}
        isPhoneLayout={false}
        calendarJobs={[]}
        calendarEmptyState="No active jobs are scheduled."
        displayedCalendarAnchorDate="2026-03-24"
        visibleCalendarTargetJobNumber=""
        visibleCalendarTargetDate=""
        calendarTargetNavigationToken={0}
        calendarGranularity="week"
        calendarAnchorDate="2026-03-24"
        calendarNavigationStatus={null}
        calendarTransitionToken={0}
        onOpenJob={() => {}}
        onPrefetchJob={onPrefetchJob}
        onViewChange={() => {}}
        onAnchorDateChange={() => {}}
      />
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'IL1-16961' }));

    expect(onPrefetchJob).toHaveBeenCalledWith('16961', undefined);
  });
});
