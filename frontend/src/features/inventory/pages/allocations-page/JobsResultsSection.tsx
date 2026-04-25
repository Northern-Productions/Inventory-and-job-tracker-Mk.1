import { DeferredLoadingState } from '../../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { JobListEntry } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { formatJobDisplayNumber } from '../../../../lib/jobDisplay';
import { JobsCalendarView } from '../../components/JobsCalendarView';
import { getJobListDisplayStatus } from '../../utils/jobSorts';

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

function renderStatusBadges(entry: JobListEntry) {
  const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);

  return (
    <div className="detail-actions">
      <span className={`badge badge-${displayStatus}`}>{formatStatusLabel(displayStatus)}</span>
      {entry.hasOrderedAllocations ? (
        <span className="badge badge-ON_ORDER">ON ORDER</span>
      ) : null}
    </div>
  );
}

interface JobsResultsSectionProps {
  isCalendarView: boolean;
  workflowTitle: string;
  calendarVisibleCount: number;
  listJobsLength: number;
  calendarPeriodPreposition: string;
  calendarPeriodLabel: string;
  listJobsLoading: boolean;
  jobsLoadingLabel: string;
  calendarLoading: boolean;
  workflowSummaryLabel: string;
  displayedCalendarGranularity: 'week' | 'month';
  listJobsError: unknown;
  calendarError: unknown;
  jobsEmptyState: string;
  listJobs: JobListEntry[];
  isPhoneLayout: boolean;
  calendarJobs: JobListEntry[];
  calendarEmptyState: string;
  displayedCalendarAnchorDate: string;
  visibleCalendarTargetJobNumber: string;
  visibleCalendarTargetDate: string;
  calendarTargetNavigationToken: number;
  calendarGranularity: 'week' | 'month';
  calendarAnchorDate: string;
  calendarNavigationStatus: {
    kind: 'loading' | 'error';
    label: string;
  } | null;
  calendarTransitionToken: number;
  onOpenJob: (jobNumber: string) => void;
  onPrefetchJob?: (jobNumber: string) => void;
  onViewChange: (view: 'week' | 'month') => void;
  onAnchorDateChange: (anchorDate: string) => void;
}

export function JobsResultsSection({
  isCalendarView,
  workflowTitle,
  calendarVisibleCount,
  listJobsLength,
  calendarPeriodPreposition,
  calendarPeriodLabel,
  listJobsLoading,
  jobsLoadingLabel,
  calendarLoading,
  workflowSummaryLabel,
  displayedCalendarGranularity,
  listJobsError,
  calendarError,
  jobsEmptyState,
  listJobs,
  isPhoneLayout,
  calendarJobs,
  calendarEmptyState,
  displayedCalendarAnchorDate,
  visibleCalendarTargetJobNumber,
  visibleCalendarTargetDate,
  calendarTargetNavigationToken,
  calendarGranularity,
  calendarAnchorDate,
  calendarNavigationStatus,
  calendarTransitionToken,
  onOpenJob,
  onPrefetchJob,
  onViewChange,
  onAnchorDateChange
}: JobsResultsSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row allocations-recent-title-row">
        <h2>{isCalendarView ? 'Install Calendar' : workflowTitle}</h2>
        <span className="muted-text allocations-recent-count">
          {isCalendarView
            ? `${calendarVisibleCount} job${calendarVisibleCount === 1 ? '' : 's'} ${calendarPeriodPreposition} ${calendarPeriodLabel}`
            : `${listJobsLength} job(s)`}
        </span>
      </div>
      {!isCalendarView ? (
        <DeferredLoadingState when={listJobsLoading} label={jobsLoadingLabel} />
      ) : (
        <DeferredLoadingState
          when={calendarLoading}
          label={`Loading ${workflowSummaryLabel} ${displayedCalendarGranularity}...`}
        />
      )}
      {!isCalendarView && listJobsError ? (
        <p className="error-text">
          {listJobsError instanceof Error ? listJobsError.message : 'Jobs could not be loaded.'}
        </p>
      ) : null}
      {isCalendarView && calendarError ? (
        <p className="error-text">
          {calendarError instanceof Error ? calendarError.message : 'The jobs calendar could not be loaded.'}
        </p>
      ) : null}
      {!isCalendarView && !listJobsLoading && !listJobsError && !listJobsLength ? (
        <div className="empty-state">{jobsEmptyState}</div>
      ) : null}
      {!isCalendarView && listJobsLength ? (
        isPhoneLayout ? (
          <div className="mobile-record-list">
            {listJobs.map((entry) => {
              const displayJobNumber = formatJobDisplayNumber(entry.jobNumber, entry.warehouse);
              return (
                <MobileRecordCard key={entry.jobNumber}>
                  <MobileRecordHeader
                    title={displayJobNumber}
                    subtitle={`${entry.warehouse} warehouse`}
                    badge={renderStatusBadges(entry)}
                    onTitleClick={() => onOpenJob(entry.jobNumber)}
                    onTitleMouseEnter={() => onPrefetchJob?.(entry.jobNumber)}
                    onTitleFocus={() => onPrefetchJob?.(entry.jobNumber)}
                  />
                  <MobileFieldList>
                    <MobileField label="Install Date" value={formatDate(entry.installDate)} />
                    <MobileField label="Sections" value={entry.sections ?? '--'} />
                    <MobileField label="Required LF" value={entry.requiredFeet} />
                    <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                    <MobileField label="Remaining LF" value={entry.remainingFeet} />
                  </MobileFieldList>
                </MobileRecordCard>
              );
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Install Date</th>
                  <th>Sections</th>
                  <th>Warehouse</th>
                  <th>Status</th>
                  <th>Required LF</th>
                  <th>Allocated LF</th>
                  <th>Remaining LF</th>
                </tr>
              </thead>
              <tbody>
                {listJobs.map((entry) => {
                  const displayJobNumber = formatJobDisplayNumber(entry.jobNumber, entry.warehouse);
                  return (
                    <tr key={entry.jobNumber}>
                      <td>
                        <button
                          type="button"
                          className="row-button"
                          onClick={() => onOpenJob(entry.jobNumber)}
                          onMouseEnter={() => onPrefetchJob?.(entry.jobNumber)}
                          onFocus={() => onPrefetchJob?.(entry.jobNumber)}
                        >
                          {displayJobNumber}
                        </button>
                      </td>
                      <td>{formatDate(entry.installDate)}</td>
                      <td>{entry.sections ?? '--'}</td>
                      <td>{entry.warehouse}</td>
                      <td>{renderStatusBadges(entry)}</td>
                      <td>{entry.requiredFeet}</td>
                      <td>{entry.allocatedFeet}</td>
                      <td>{entry.remainingFeet}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {isCalendarView && !calendarLoading && !calendarError ? (
        <>
          <p className="muted-text jobs-calendar-panel-description">
            {!calendarJobs.length
              ? calendarEmptyState
              : 'Click a job number to open job details. Completed jobs stay clickable, and staged jobs show a check mark.'}
          </p>
          <JobsCalendarView
            view={displayedCalendarGranularity}
            anchorDate={displayedCalendarAnchorDate}
            jobs={calendarJobs}
            highlightJobNumbers={visibleCalendarTargetJobNumber ? [visibleCalendarTargetJobNumber] : []}
            targetJobNumber={visibleCalendarTargetJobNumber || undefined}
            targetInstallDate={visibleCalendarTargetDate}
            targetNavigationToken={visibleCalendarTargetJobNumber ? calendarTargetNavigationToken : 0}
            requestedView={calendarGranularity}
            requestedAnchorDate={calendarAnchorDate}
            navigationStatus={calendarNavigationStatus}
            transitionToken={calendarTransitionToken}
            onPrefetchJob={onPrefetchJob}
            onViewChange={onViewChange}
            onAnchorDateChange={onAnchorDateChange}
          />
        </>
      ) : null}
    </section>
  );
}
