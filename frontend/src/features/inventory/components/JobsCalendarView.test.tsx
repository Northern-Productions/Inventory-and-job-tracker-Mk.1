import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CalendarJob } from '../utils/jobCalendar';
import { JobsCalendarView } from './JobsCalendarView';

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

describe('JobsCalendarView', () => {
  it('renders week mode with navigation, dropdown, clickable links, and the day modal markup', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <JobsCalendarView
          view="week"
          anchorDate="2026-03-24"
          jobs={[
            buildJob({ jobNumber: '10001', installDate: '2026-03-24', isStagedForPickup: true }),
            buildJob({
              jobNumber: '10002',
              installDate: '2026-03-24',
              status: 'COMPLETED',
              lifecycleStatus: 'COMPLETED'
            }),
            buildJob({ jobNumber: '10003', installDate: '2026-03-24', status: 'ALLOCATE' }),
            buildJob({ jobNumber: '10004', installDate: '2026-03-24' })
          ]}
          navigationStatus={{ kind: 'loading', label: 'Loading Mar 29 - Apr 4, 2026...' }}
          transitionToken={1}
          onViewChange={() => {}}
          onAnchorDateChange={() => {}}
          highlightJobNumbers={['10001']}
          initialSelectedDayDate="2026-03-24"
        />
      </MemoryRouter>
    );

    expect(html).toContain('2026');
    expect(html).toContain('Mar 22 - Mar 28');
    expect(html).toContain('Previous');
    expect(html).toContain('Next');
    expect(html).toContain('job-calendar-grid-week');
    expect(html).toContain('job-calendar-shell-animate');
    expect(html).toContain('Calendar view');
    expect(html).toContain('option value="week" selected=""');
    expect(html).toContain('job-calendar-nav-status-loading');
    expect(html).toContain('Loading Mar 29 - Apr 4, 2026...');
    expect(html).toContain('href="/allocations/10001"');
    expect(html).toContain('job-calendar-job-link-highlight');
    expect(html).toContain('job-calendar-job-link-status-ready');
    expect(html).toContain('job-calendar-stage-mark');
    expect(html).toContain('job-calendar-job-link-status-completed');
    expect(html).toContain('job-calendar-day-modal');
    expect(html).toContain('X');
  });

  it('shows a +N more affordance for crowded desktop month days', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <JobsCalendarView
          view="month"
          anchorDate="2026-03-01"
          jobs={[
            buildJob({ jobNumber: '10001', installDate: '2026-03-24' }),
            buildJob({ jobNumber: '10002', installDate: '2026-03-24' }),
            buildJob({ jobNumber: '10003', installDate: '2026-03-24' }),
            buildJob({ jobNumber: '10004', installDate: '2026-03-24' }),
            buildJob({ jobNumber: '10005', installDate: '2026-03-24' })
          ]}
          onViewChange={() => {}}
          onAnchorDateChange={() => {}}
          maxVisibleJobsPerDay={3}
          isPhoneLayoutOverride={false}
        />
      </MemoryRouter>
    );

    expect(html).toContain('job-calendar-grid-month');
    expect(html).toContain('+2 more');
  });

  it('renders stacked phone cards in week mode', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <JobsCalendarView
          view="week"
          anchorDate="2026-03-24"
          jobs={[
            buildJob({ jobNumber: '10001', installDate: '2026-03-22' }),
            buildJob({ jobNumber: '10002', installDate: '2026-03-24', isStagedForPickup: true })
          ]}
          onViewChange={() => {}}
          onAnchorDateChange={() => {}}
          isPhoneLayoutOverride
        />
      </MemoryRouter>
    );

    expect(html).toContain('job-calendar-week-list');
    expect(html).toContain('job-calendar-week-card');
    expect(html).toContain('job-calendar-week-card-weekday');
    expect(html).toContain('job-calendar-week-card-date');
    expect(html).toContain('Sun');
    expect(html).toContain('Tue');
    expect(html).toContain('Mar 22, 2026');
    expect(html).toContain('Mar 24, 2026');
  });

  it('renders inline navigation errors without replacing the calendar shell', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <JobsCalendarView
          view="month"
          anchorDate="2026-03-01"
          jobs={[buildJob({ jobNumber: '10001', installDate: '2026-03-24' })]}
          navigationStatus={{ kind: 'error', label: 'Unable to load April 2026.' }}
          onViewChange={() => {}}
          onAnchorDateChange={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).toContain('job-calendar-nav-status-error');
    expect(html).toContain('Unable to load April 2026.');
    expect(html).toContain('job-calendar-grid-month');
  });
});
