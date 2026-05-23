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

    fireEvent.focus(screen.getByRole('link', { name: /IL1-12345/i }));

    expect(onPrefetchJob).toHaveBeenCalledWith('12345', undefined);
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

    fireEvent.click(screen.getByRole('link', { name: /IL1-12345/i }));

    expect(onPrefetchJob).toHaveBeenCalledWith('12345', undefined);
  });

  it('navigates calendar phase links with jobId and phaseId identity', () => {
    render(
      <JobsCalendarView
        view="week"
        anchorDate="2026-03-24"
        jobs={[
          buildJob({
            jobId: '11111111-1111-4111-8111-111111111111',
            phaseId: '22222222-2222-4222-8222-222222222222',
            jobNumber: '12345',
            installDate: '2026-03-24',
            phaseNumber: 2,
            phaseCount: 2,
            workScope: 'Section 7'
          })
        ]}
        onViewChange={() => {}}
        onAnchorDateChange={() => {}}
      />
    );

    expect(screen.getByRole('link', { name: /IL1-12345/i }).getAttribute('href')).toBe(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111?phaseId=22222222-2222-4222-8222-222222222222'
    );
  });

  it('renders event bars inside the week day-card grid instead of a floating row above cards', () => {
    const { container } = render(
      <JobsCalendarView
        view="week"
        anchorDate="2026-05-21"
        jobs={[
          buildJob({
            jobNumber: '4024',
            installDate: '2026-05-21',
            workScope: 'A very long scope label that needs to stay clipped inside the Thursday card'
          }),
          buildJob({
            jobNumber: '4316',
            installDate: '2026-05-22',
            isStagedForPickup: true
          }),
          buildJob({
            jobNumber: '5143',
            installDate: '2026-05-20',
            installEndDate: '2026-05-22',
            phaseNumber: 2,
            phaseCount: 2,
            workScope: 'Sections 1, 2, 3'
          }),
          buildJob({
            jobNumber: '19066',
            installDate: '2026-05-18',
            status: 'COMPLETED',
            lifecycleStatus: 'COMPLETED'
          })
        ]}
        onViewChange={() => {}}
        onAnchorDateChange={() => {}}
      />
    );

    const weekDays = container.querySelector('.job-calendar-week-days');
    const containedLayer = container.querySelector('.job-calendar-week-days > .job-calendar-week-segment-layer');
    const floatingLayer = container.querySelector('.job-calendar-week-row > .job-calendar-week-segment-layer');
    const firstDayCard = weekDays?.querySelector('.job-calendar-day');
    const dayCards = Array.from(
      weekDays?.querySelectorAll(':scope > .job-calendar-day') || []
    ) as HTMLElement[];

    expect(weekDays).not.toBeNull();
    expect(containedLayer).not.toBeNull();
    expect(floatingLayer).toBeNull();
    expect(firstDayCard).not.toBeNull();
    expect(dayCards).toHaveLength(7);
    expect(dayCards.map((card) => card.style.gridColumn)).toEqual([
      '1 / span 1',
      '2 / span 1',
      '3 / span 1',
      '4 / span 1',
      '5 / span 1',
      '6 / span 1',
      '7 / span 1'
    ]);
    expect(weekDays?.contains(containedLayer)).toBe(true);
    expect(Array.from(weekDays?.children || []).indexOf(containedLayer as Element)).toBeGreaterThan(
      Array.from(weekDays?.children || []).indexOf(firstDayCard as Element)
    );
    expect(containedLayer?.querySelector('.job-calendar-event-bar-single-day')).not.toBeNull();
    expect(containedLayer?.querySelector('.job-calendar-event-bar-multi-day')).not.toBeNull();
    expect(containedLayer?.querySelector('.job-calendar-event-label')?.textContent).toContain('IL1-');
    expect(containedLayer?.querySelectorAll('.job-calendar-stage-mark')).toHaveLength(1);
    expect(containedLayer?.querySelector('.job-calendar-job-link-status-completed')).not.toBeNull();
    expect(containedLayer?.querySelector('.job-calendar-job-link-status-ready')).not.toBeNull();
  });
});
