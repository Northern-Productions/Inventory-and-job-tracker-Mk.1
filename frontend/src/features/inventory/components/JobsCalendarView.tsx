import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import type { JobListEntry } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { buildAllocationJobRoute } from '../utils/jobRoutes';
import {
  buildCalendarPeriod,
  getCalendarJobStatusClass,
  getCalendarPeriodRange,
  shiftCalendarAnchorDate,
  sortCalendarJobsWithinDay,
  type JobCalendarDay,
  type JobCalendarEventSegment,
  type JobCalendarView
} from '../utils/jobCalendar';

function getCalendarJobKey(job: JobListEntry) {
  const jobId = String(job.jobId || '').trim();
  const phaseId = String(job.phaseId || '').trim();
  if (jobId) {
    return phaseId ? `job:${jobId}:phase:${phaseId}` : `job:${jobId}`;
  }

  return [
    'legacy-job',
    job.jobNumber,
    phaseId,
    job.workScopeKey || job.workScope || job.sections || '',
    job.warehouse || ''
  ].join(':');
}

interface JobsCalendarViewProps {
  view: JobCalendarView;
  anchorDate: string;
  jobs: JobListEntry[];
  highlightJobNumbers?: string[];
  targetJobNumber?: string;
  targetInstallDate?: string;
  targetNavigationToken?: number;
  requestedView?: JobCalendarView;
  requestedAnchorDate?: string;
  navigationStatus?: {
    kind: 'loading' | 'error';
    label: string;
  } | null;
  transitionToken?: number;
  onViewChange: (view: JobCalendarView) => void;
  onAnchorDateChange: (anchorDate: string) => void;
  onPrefetchJob?: (jobNumber: string, jobId?: string) => void;
  maxVisibleJobsPerDay?: number;
  isPhoneLayoutOverride?: boolean;
  initialSelectedDayDate?: string;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatWeekdayLabel(dateKey: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${dateKey}T00:00:00`));
}

function buildCalendarNavigationLabel(view: JobCalendarView, anchorDate: string, fallbackLabel: string) {
  const range = getCalendarPeriodRange(view, anchorDate);
  const startDate = new Date(`${range.startDate}T00:00:00`);
  const endDate = new Date(`${range.endDate}T00:00:00`);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return {
      yearLabel: '',
      periodLabel: fallbackLabel
    };
  }

  if (view === 'month') {
    return {
      yearLabel: String(startDate.getFullYear()),
      periodLabel: new Intl.DateTimeFormat(undefined, { month: 'long' }).format(startDate)
    };
  }

  const yearLabel =
    startDate.getFullYear() === endDate.getFullYear()
      ? String(startDate.getFullYear())
      : `${startDate.getFullYear()} - ${endDate.getFullYear()}`;

  return {
    yearLabel,
    periodLabel: `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(startDate)} - ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(endDate)}`
  };
}

function renderJobLink(
  job: JobListEntry,
  options: {
    highlightJobNumbers: Set<string>;
    compact?: boolean;
    onNavigate?: () => void;
    onPrefetchJob?: (jobNumber: string, jobId?: string) => void;
    registerRef?: (job: JobListEntry, node: HTMLAnchorElement | null) => void;
  }
) {
  const isHighlighted = options.highlightJobNumbers.has(job.jobNumber);
  const displayJobLabel = formatJobDisplayLabel(job);
  const handlePrefetch = () => options.onPrefetchJob?.(job.jobNumber, job.jobId);
  const handleClick = () => {
    handlePrefetch();
    options.onNavigate?.();
  };

  return (
    <Link
      key={getCalendarJobKey(job)}
      ref={(node) => options.registerRef?.(job, node)}
      to={buildAllocationJobRoute(job)}
      className={[
        'job-calendar-job-link',
        options.compact ? 'job-calendar-job-link-compact' : '',
        job.isStagedForPickup ? 'job-calendar-job-link-staged' : '',
        isHighlighted ? 'job-calendar-job-link-highlight' : '',
        getCalendarJobStatusClass(job)
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleClick}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
    >
      <span className="job-calendar-job-link-number">{displayJobLabel}</span>
      {job.isStagedForPickup ? (
        <span className="job-calendar-stage-mark" aria-label="Staged for pickup" title="Staged for pickup">
          {'\u2713'}
        </span>
      ) : null}
    </Link>
  );
}

function renderCalendarEventSegment(
  segment: JobCalendarEventSegment,
  options: {
    highlightJobNumbers: Set<string>;
    onPrefetchJob?: (jobNumber: string, jobId?: string) => void;
    registerRef?: (job: JobListEntry, node: HTMLAnchorElement | null) => void;
  }
) {
  const job = segment.job;
  const isHighlighted = options.highlightJobNumbers.has(job.jobNumber);
  const displayJobLabel = formatJobDisplayLabel(job);
  const handlePrefetch = () => options.onPrefetchJob?.(job.jobNumber, job.jobId);
  const handleClick = () => handlePrefetch();

  return (
    <Link
      key={`${getCalendarJobKey(job)}:${segment.startDate}:${segment.endDate}`}
      ref={(node) => options.registerRef?.(job, node)}
      to={buildAllocationJobRoute(job)}
      className={[
        'job-calendar-event-bar',
        segment.isMultiDay ? 'job-calendar-event-bar-multi-day' : 'job-calendar-event-bar-single-day',
        segment.isRangeStart ? 'job-calendar-event-bar-range-start' : 'job-calendar-event-bar-range-middle',
        segment.isRangeEnd ? 'job-calendar-event-bar-range-end' : 'job-calendar-event-bar-range-middle',
        job.isStagedForPickup ? 'job-calendar-event-bar-staged' : '',
        isHighlighted ? 'job-calendar-job-link-highlight' : '',
        getCalendarJobStatusClass(job)
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ gridColumn: `${segment.startIndex + 1} / span ${segment.spanDays}` }}
      onClick={handleClick}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
      title={displayJobLabel}
    >
      <span className="job-calendar-event-label">{displayJobLabel}</span>
      {job.isStagedForPickup ? (
        <span className="job-calendar-stage-mark" aria-label="Staged for pickup" title="Staged for pickup">
          {'\u2713'}
        </span>
      ) : null}
    </Link>
  );
}

export function JobsCalendarView({
  view,
  anchorDate,
  jobs,
  highlightJobNumbers = [],
  targetJobNumber = '',
  targetInstallDate = '',
  targetNavigationToken = 0,
  requestedView,
  requestedAnchorDate,
  navigationStatus = null,
  transitionToken = 0,
  onViewChange,
  onAnchorDateChange,
  onPrefetchJob,
  maxVisibleJobsPerDay = 3,
  isPhoneLayoutOverride,
  initialSelectedDayDate = ''
}: JobsCalendarViewProps) {
  const detectedPhoneLayout = useIsPhoneLayout(768);
  const isPhoneLayout = isPhoneLayoutOverride ?? detectedPhoneLayout;
  const [selectedDayDate, setSelectedDayDate] = useState(initialSelectedDayDate);
  const jobLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const calendar = useMemo(() => buildCalendarPeriod(view, anchorDate, jobs), [anchorDate, jobs, view]);
  const navigationView = requestedView ?? view;
  const navigationAnchorDate = requestedAnchorDate ?? anchorDate;
  const navigationLabel = useMemo(
    () => buildCalendarNavigationLabel(view, anchorDate, calendar.periodLabel),
    [anchorDate, calendar.periodLabel, view]
  );
  const highlightSet = useMemo(() => new Set(highlightJobNumbers.filter(Boolean)), [highlightJobNumbers]);
  const selectedDay = useMemo(
    () => calendar.days.find((day) => day.dateKey === selectedDayDate) || null,
    [calendar.days, selectedDayDate]
  );
  const selectedDayDescriptionId = selectedDay ? `job-calendar-day-description-${selectedDay.dateKey}` : undefined;
  const isPhoneWeekView = isPhoneLayout && view === 'week';

  useEffect(() => {
    if (!targetJobNumber || !targetNavigationToken) {
      return;
    }

    const targetDay = calendar.days.find((day) =>
      day.jobs.some((job) => job.jobNumber === targetJobNumber)
    );

    const frame = window.requestAnimationFrame(() => {
      const targetJob = targetDay?.jobs.find((job) => {
        const installDate = String(job.installDate || '').trim().slice(0, 10);
        return job.jobNumber === targetJobNumber && (!targetInstallDate || installDate === targetInstallDate);
      }) || targetDay?.jobs.find((job) => job.jobNumber === targetJobNumber);
      const targetLink = targetJob ? jobLinkRefs.current.get(getCalendarJobKey(targetJob)) : null;
      if (targetLink) {
        targetLink.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      const fallbackDateKey = targetDay?.dateKey || String(targetInstallDate || '').trim().slice(0, 10);
      if (!fallbackDateKey) {
        return;
      }

      dayRefs.current.get(fallbackDateKey)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [calendar.days, targetInstallDate, targetJobNumber, targetNavigationToken]);

  function openDay(day: JobCalendarDay) {
    if (!day.jobs.length) {
      return;
    }

    setSelectedDayDate(day.dateKey);
  }

  function closeDayDialog() {
    setSelectedDayDate('');
  }

  function registerJobLinkRef(job: JobListEntry, node: HTMLAnchorElement | null) {
    const key = getCalendarJobKey(job);
    if (!node) {
      jobLinkRefs.current.delete(key);
      return;
    }

    jobLinkRefs.current.set(key, node);
  }

  function registerDayRef(dateKey: string, node: HTMLElement | null) {
    if (!node) {
      dayRefs.current.delete(dateKey);
      return;
    }

    dayRefs.current.set(dateKey, node);
  }

  function renderCalendarDay(
    day: JobCalendarDay,
    options: { mobileGrid?: boolean; weekCard?: boolean; hideJobStack?: boolean; gridColumnIndex?: number } = {}
  ) {
    const sortedJobs = sortCalendarJobsWithinDay(day.jobs, highlightJobNumbers);
    const hiddenJobCount = Math.max(sortedJobs.length - maxVisibleJobsPerDay, 0);

    if (options.weekCard) {
      return (
        <section
          key={day.dateKey}
          ref={(node) => registerDayRef(day.dateKey, node)}
          className={[
            'job-calendar-week-card',
            day.isToday ? 'job-calendar-day-today' : ''
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <button
            type="button"
            className="job-calendar-week-card-button"
            disabled={!sortedJobs.length}
            onClick={() => openDay(day)}
          >
            <div className="job-calendar-week-card-copy">
              <span className="job-calendar-week-card-weekday">{formatWeekdayLabel(day.dateKey)}</span>
              <span className="job-calendar-week-card-date">{formatDate(day.date)}</span>
            </div>
            <span className="job-calendar-day-count">
              {sortedJobs.length ? `${sortedJobs.length} job${sortedJobs.length === 1 ? '' : 's'}` : 'No jobs'}
            </span>
          </button>
          {sortedJobs.length ? (
            <div className="job-calendar-job-stack">
              {sortedJobs.slice(0, maxVisibleJobsPerDay).map((job) =>
                renderJobLink(job, {
                  compact: true,
                  highlightJobNumbers: highlightSet,
                  onPrefetchJob,
                  registerRef: registerJobLinkRef
                })
              )}
              {hiddenJobCount > 0 ? (
                <button
                  type="button"
                  className="job-calendar-more-button"
                  onClick={() => openDay(day)}
                >
                  +{hiddenJobCount} more
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted-text job-calendar-week-card-empty">No jobs scheduled.</p>
          )}
        </section>
      );
    }

    return (
      <div
        key={day.dateKey}
        ref={(node) => registerDayRef(day.dateKey, node)}
        className={[
          'job-calendar-day',
          day.inCurrentMonth ? '' : 'job-calendar-day-outside',
          day.isToday ? 'job-calendar-day-today' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        role="gridcell"
        style={options.gridColumnIndex ? { gridColumn: `${options.gridColumnIndex} / span 1` } : undefined}
      >
        <div className="job-calendar-day-header">
          {options.mobileGrid ? (
            <button
              type="button"
              className="job-calendar-day-button"
              disabled={!sortedJobs.length}
              onClick={() => openDay(day)}
            >
              <span className="job-calendar-day-number">{day.dayOfMonth}</span>
              <span className="job-calendar-day-count">
                {sortedJobs.length ? `${sortedJobs.length} job${sortedJobs.length === 1 ? '' : 's'}` : 'No jobs'}
              </span>
            </button>
          ) : (
            <>
              <span className="job-calendar-day-number">{day.dayOfMonth}</span>
              {sortedJobs.length ? (
                <span className="job-calendar-day-count">
                  {sortedJobs.length} job{sortedJobs.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </>
          )}
        </div>

        {!options.mobileGrid && !options.hideJobStack ? (
          <div className="job-calendar-job-stack job-calendar-job-stack-compact">
            {sortedJobs.slice(0, maxVisibleJobsPerDay).map((job) =>
              renderJobLink(job, {
                compact: true,
                highlightJobNumbers: highlightSet,
                onPrefetchJob,
                registerRef: registerJobLinkRef
              })
            )}
            {hiddenJobCount > 0 ? (
              <button
                type="button"
                className="job-calendar-more-button"
                onClick={() => openDay(day)}
              >
                +{hiddenJobCount} more
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="job-calendar">
        <div
          key={transitionToken}
          className={`job-calendar-shell ${transitionToken > 0 ? 'job-calendar-shell-animate' : ''}`.trim()}
          aria-busy={navigationStatus?.kind === 'loading' || undefined}
        >
          <div className="job-calendar-header">
            <div>
              <p className="eyebrow job-calendar-eyebrow">Install schedule</p>
              <h3 className="job-calendar-title">Install Calendar</h3>
            </div>
            <div className="job-calendar-controls-stack">
              <div className="job-calendar-month-controls" aria-label="Calendar navigation">
                <label className="job-calendar-view-select">
                  <span className="job-calendar-view-select-label">View</span>
                  <select
                    className="job-calendar-view-select-input"
                    aria-label="Calendar view"
                    value={navigationView}
                    onChange={(event) => onViewChange(event.target.value as JobCalendarView)}
                  >
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </select>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="job-calendar-month-button"
                  onClick={() =>
                    onAnchorDateChange(shiftCalendarAnchorDate(navigationAnchorDate, navigationView, -1))
                  }
                >
                  Previous
                </Button>
                <span className="job-calendar-period-label">
                  <span className="job-calendar-period-year">{navigationLabel.yearLabel}</span>
                  <span className="job-calendar-month-label">{navigationLabel.periodLabel}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="job-calendar-month-button"
                  onClick={() =>
                    onAnchorDateChange(shiftCalendarAnchorDate(navigationAnchorDate, navigationView, 1))
                  }
                >
                  Next
                </Button>
              </div>
              {navigationStatus ? (
                <div
                  className={`job-calendar-nav-status job-calendar-nav-status-${navigationStatus.kind}`.trim()}
                  role={navigationStatus.kind === 'error' ? 'alert' : 'status'}
                  aria-live="polite"
                >
                  {navigationStatus.kind === 'loading' ? (
                    <span className="loading-spinner job-calendar-nav-status-spinner" aria-hidden="true" />
                  ) : null}
                  <span>{navigationStatus.label}</span>
                </div>
              ) : null}
            </div>
          </div>

          {!isPhoneWeekView ? (
            <>
              <div className="job-calendar-weekday-row" aria-hidden="true">
                {WEEKDAY_LABELS.map((label) => (
                  <div key={label} className="job-calendar-weekday">
                    {label}
                  </div>
                ))}
              </div>

              <div
                className={[
                  'job-calendar-grid',
                  view === 'week' ? 'job-calendar-grid-week' : 'job-calendar-grid-month'
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="grid"
                aria-label={calendar.periodLabel}
              >
                {calendar.weeks.map((week, weekIndex) => (
                  <div className="job-calendar-week-row" role="row" key={week[0]?.dateKey || weekIndex}>
                    <div className="job-calendar-week-days">
                      {week.map((day, dayIndex) =>
                        renderCalendarDay(day, {
                          mobileGrid: isPhoneLayout && view === 'month',
                          hideJobStack: true,
                          gridColumnIndex: dayIndex + 1
                        })
                      )}
                      {calendar.weekSegments[weekIndex]?.length ? (
                        <div className="job-calendar-week-segment-layer">
                          {calendar.weekSegments[weekIndex].map((segment) =>
                            renderCalendarEventSegment(segment, {
                              highlightJobNumbers: highlightSet,
                              onPrefetchJob,
                              registerRef: registerJobLinkRef
                            })
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="job-calendar-week-list">
              {calendar.days.map((day) =>
                renderCalendarDay(day, {
                  weekCard: true
                })
              )}
            </div>
          )}

          {calendar.unscheduledJobs.length ? (
            <div className="job-calendar-unscheduled">
              <div className="panel-title-row">
                <h4>Unscheduled Jobs</h4>
                <span className="muted-text">{calendar.unscheduledJobs.length} job(s)</span>
              </div>
              <div className="job-calendar-unscheduled-list">
                {calendar.unscheduledJobs.map((job) =>
                  renderJobLink(job, {
                    highlightJobNumbers: highlightSet,
                    onPrefetchJob,
                    registerRef: registerJobLinkRef
                  })
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <DialogSurface
        open={Boolean(selectedDay)}
        onClose={closeDayDialog}
        titleId="job-calendar-day-title"
        descriptionId={selectedDayDescriptionId}
        className="job-calendar-dialog"
        backdropClassName="job-calendar-dialog-backdrop"
        closeOnBackdrop
      >
        {selectedDay ? (
          <div className="job-calendar-day-modal">
            <div className="job-calendar-day-modal-header">
              <div>
                <p className="job-calendar-day-modal-eyebrow">Install day</p>
                <h2 id="job-calendar-day-title">{formatDate(selectedDay.date)}</h2>
                <p id={selectedDayDescriptionId} className="job-calendar-day-modal-description">
                  {selectedDay.jobs.length} job{selectedDay.jobs.length === 1 ? '' : 's'} scheduled for install.
                </p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close install day details"
                onClick={closeDayDialog}
              >
                X
              </button>
            </div>

            <div className="job-calendar-day-modal-card">
              <div className="job-calendar-day-header">
                <span className="job-calendar-day-number">{selectedDay.dayOfMonth}</span>
                <span className="job-calendar-day-count">
                  {selectedDay.jobs.length} job{selectedDay.jobs.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="job-calendar-job-stack">
                {sortCalendarJobsWithinDay(selectedDay.jobs, highlightJobNumbers).map((job) =>
                  renderJobLink(job, {
                    highlightJobNumbers: highlightSet,
                    onPrefetchJob,
                    onNavigate: closeDayDialog,
                    registerRef: registerJobLinkRef
                  })
                )}
              </div>
            </div>
          </div>
        ) : null}
      </DialogSurface>
    </>
  );
}
