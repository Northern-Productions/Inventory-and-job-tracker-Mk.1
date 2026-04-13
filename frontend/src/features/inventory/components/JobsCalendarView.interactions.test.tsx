// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import type { CalendarJob } from '../utils/jobCalendar';
import { JobsCalendarView } from './JobsCalendarView';

vi.mock('react-router-dom', () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    ComponentPropsWithoutRef<'a'> & { to: string }
  >(({ to, children, onClick, ...props }, ref) => (
    <a
      ref={ref}
      href={to}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ))
}));

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

describe('JobsCalendarView interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('prefetches job details when a calendar job link is focused', () => {
    const onPrefetchJob = vi.fn();

    render(
      <JobsCalendarView
        view="week"
        anchorDate="2026-03-24"
        jobs={[buildJob({ jobNumber: '12345', installDate: '2026-03-24' })]}
        onPrefetchJob={onPrefetchJob}
        onViewChange={() => {}}
        onAnchorDateChange={() => {}}
      />
    );

    fireEvent.focus(screen.getByRole('link', { name: /12345/i }));

    expect(onPrefetchJob).toHaveBeenCalledWith('12345');
  });

  it('still prefetches on click as a fallback when hover never happened', () => {
    const onPrefetchJob = vi.fn();

    render(
      <JobsCalendarView
        view="week"
        anchorDate="2026-03-24"
        jobs={[buildJob({ jobNumber: '12345', installDate: '2026-03-24' })]}
        onPrefetchJob={onPrefetchJob}
        onViewChange={() => {}}
        onAnchorDateChange={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: /12345/i }));

    expect(onPrefetchJob).toHaveBeenCalledWith('12345');
  });
});
