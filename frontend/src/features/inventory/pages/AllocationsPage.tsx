import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import { listCaulkProducts } from '../../../api/features/caulkClient';
import {
  getJobsCalendarEntries,
  type JobLifecycleFilter
} from '../../../api/features/jobsClient';
import type { CreateJobPayload, JobListEntry } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, todayDateString } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { JobsCalendarView } from '../components/JobsCalendarView';
import { LaborOnlyJobConfirmDialog } from '../components/LaborOnlyJobConfirmDialog';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import {
  useCreateJob,
  useFilmCatalog,
  useJobsCalendarEntries,
  useJobsList,
  useJobsSearch
} from '../hooks/useInventoryQueries';
import {
  formatCalendarPeriodLabel,
  findBestCalendarSearchMatch,
  getCurrentCalendarAnchorDate,
  isDateInCalendarPeriod,
  selectCalendarHighlightJobNumbers,
  shiftCalendarAnchorDate
} from '../utils/jobCalendar';
import { shouldPromptForLaborOnlyConfirmation } from '../utils/laborOnlyJobs';
import {
  getJobListDisplayStatus,
  JOB_SORT_OPTIONS,
  sortJobs,
  type JobSortOption
} from '../utils/jobSorts';

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

type CalendarDisplaySnapshot = {
  anchorDate: string;
  view: 'week' | 'month';
  lifecycleStatus: JobLifecycleFilter;
  jobs: JobListEntry[];
};

function buildCalendarDisplaySnapshotKey(
  snapshot: Pick<CalendarDisplaySnapshot, 'anchorDate' | 'view' | 'lifecycleStatus'>
) {
  return `${snapshot.lifecycleStatus}:${snapshot.view}:${snapshot.anchorDate}`;
}

type AllocationsPageProps = {
  initialWorkflowView?: 'active' | 'completed';
  initialJobsViewMode?: 'list' | 'calendar';
  initialCalendarGranularity?: 'week' | 'month';
  initialJobSearchInput?: string;
  initialJobSort?: JobSortOption;
  initialCalendarAnchorDate?: string;
  initialCalendarMonth?: string;
};

export default function AllocationsPage({
  initialWorkflowView = 'active',
  initialJobsViewMode = 'calendar',
  initialCalendarGranularity = 'week',
  initialJobSearchInput = '',
  initialJobSort = 'install_date',
  initialCalendarAnchorDate = getCurrentCalendarAnchorDate(todayDateString()),
  initialCalendarMonth
}: AllocationsPageProps = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const [jobsWorkflowView, setJobsWorkflowView] = useState<'active' | 'completed'>(
    initialWorkflowView
  );
  const [jobsViewMode, setJobsViewMode] = useState<'list' | 'calendar'>(initialJobsViewMode);
  const [calendarGranularity, setCalendarGranularity] = useState<'week' | 'month'>(
    initialCalendarGranularity
  );
  const [calendarAnchorDate, setCalendarAnchorDate] = useState(
    initialCalendarMonth ? `${initialCalendarMonth}-01` : initialCalendarAnchorDate
  );
  const selectedLifecycleStatus: JobLifecycleFilter =
    jobsWorkflowView === 'completed' ? 'COMPLETED' : 'ACTIVE';
  const [jobSearchInput, setJobSearchInput] = useState(initialJobSearchInput);
  const [jobSort, setJobSort] = useState<JobSortOption>(initialJobSort);
  const deferredJobSearchInput = useDeferredValue(jobSearchInput);
  const isSearchingJobs = Boolean(deferredJobSearchInput.trim());
  const isCalendarView = jobsViewMode === 'calendar';
  const jobsQuery = useJobsList(25, {
    enabled: !isCalendarView,
    lifecycleStatus: selectedLifecycleStatus
  });
  const jobsSearchQuery = useJobsSearch(deferredJobSearchInput, isCalendarView ? 3 : 25, {
    enabled: isSearchingJobs,
    lifecycleStatus: selectedLifecycleStatus
  });
  const jobsCalendarQuery = useJobsCalendarEntries(calendarAnchorDate, {
    enabled: isCalendarView,
    view: calendarGranularity,
    lifecycleStatus: selectedLifecycleStatus
  });
  const createJobMutation = useCreateJob();
  const filmCatalogQuery = useFilmCatalog();
  const caulkProductsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
  });
  const [isNewJobOpen, setIsNewJobOpen] = useState(false);
  const [pendingLaborOnlyCreate, setPendingLaborOnlyCreate] = useState<JobEditorSubmitPayload | null>(null);
  const [calendarTransitionErrorMessage, setCalendarTransitionErrorMessage] = useState('');
  const [calendarTransitionToken, setCalendarTransitionToken] = useState(0);
  const [displayedCalendarSnapshotState, setDisplayedCalendarSnapshotState] =
    useState<CalendarDisplaySnapshot | null>(() =>
      jobsCalendarQuery.isSuccess
        ? {
            anchorDate: calendarAnchorDate,
            view: calendarGranularity,
            lifecycleStatus: selectedLifecycleStatus,
            jobs: jobsCalendarQuery.data || []
          }
        : null
    );
  const isCompletedWorkflow = jobsWorkflowView === 'completed';
  const listJobsSource = isSearchingJobs ? jobsSearchQuery.data || [] : jobsQuery.data || [];
  const listJobs = useMemo(
    () =>
      sortJobs(
        isCompletedWorkflow
          ? listJobsSource.filter((entry) => entry.status === 'COMPLETED')
          : listJobsSource,
        jobSort
      ),
    [isCompletedWorkflow, listJobsSource, jobSort]
  );
  const requestedCalendarSnapshot = useMemo(
    () =>
      jobsCalendarQuery.isSuccess && !jobsCalendarQuery.isFetching
        ? {
            anchorDate: calendarAnchorDate,
            view: calendarGranularity,
            lifecycleStatus: selectedLifecycleStatus,
            jobs: jobsCalendarQuery.data || []
          }
        : null,
    [
      calendarAnchorDate,
      calendarGranularity,
      jobsCalendarQuery.data,
      jobsCalendarQuery.isFetching,
      jobsCalendarQuery.isSuccess,
      selectedLifecycleStatus
    ]
  );
  const displayedCalendarSnapshot =
    displayedCalendarSnapshotState &&
    displayedCalendarSnapshotState.lifecycleStatus === selectedLifecycleStatus
      ? displayedCalendarSnapshotState
      : requestedCalendarSnapshot;
  const displayedCalendarGranularity = displayedCalendarSnapshot?.view || calendarGranularity;
  const displayedCalendarAnchorDate = displayedCalendarSnapshot?.anchorDate || calendarAnchorDate;
  const calendarJobs = displayedCalendarSnapshot?.jobs || [];
  const displayedCalendarKey = displayedCalendarSnapshot
    ? buildCalendarDisplaySnapshotKey(displayedCalendarSnapshot)
    : '';
  const requestedCalendarKey = buildCalendarDisplaySnapshotKey({
    anchorDate: calendarAnchorDate,
    view: calendarGranularity,
    lifecycleStatus: selectedLifecycleStatus
  });
  const hasDisplayedCalendarSnapshot = Boolean(displayedCalendarSnapshot);
  const highlightedCalendarJobNumbers = useMemo(
    () => selectCalendarHighlightJobNumbers(jobsSearchQuery.data || [], deferredJobSearchInput),
    [deferredJobSearchInput, jobsSearchQuery.data]
  );
  const visibleHighlightedCalendarJobNumbers = useMemo(() => {
    const visibleJobNumbers = new Set(calendarJobs.map((entry) => entry.jobNumber));
    return highlightedCalendarJobNumbers.filter((jobNumber) => visibleJobNumbers.has(jobNumber));
  }, [calendarJobs, highlightedCalendarJobNumbers]);
  const bestCalendarSearchMatch = useMemo(
    () => findBestCalendarSearchMatch(jobsSearchQuery.data || [], deferredJobSearchInput),
    [deferredJobSearchInput, jobsSearchQuery.data]
  );
  const autoJumpKeyRef = useRef('');
  const listJobsLoading = (isSearchingJobs ? jobsSearchQuery.isLoading : jobsQuery.isLoading) && !listJobs.length;
  const listJobsError = isSearchingJobs ? jobsSearchQuery.error : jobsQuery.error;
  const calendarLoading = jobsCalendarQuery.isLoading && !hasDisplayedCalendarSnapshot;
  const calendarError = !hasDisplayedCalendarSnapshot ? jobsCalendarQuery.error : null;
  const isCalendarPendingTransition =
    isCalendarView &&
    hasDisplayedCalendarSnapshot &&
    requestedCalendarKey !== displayedCalendarKey &&
    jobsCalendarQuery.fetchStatus === 'fetching';
  const workflowSummaryLabel = isCompletedWorkflow ? 'completed jobs' : 'active jobs';
  const workflowTitle = isCompletedWorkflow ? 'Completed Job History' : 'Recent Jobs';
  const workflowDescription = isCalendarView
    ? isCompletedWorkflow
      ? `Browse completed install dates by ${displayedCalendarGranularity}.`
      : `Browse active install dates by ${displayedCalendarGranularity}.`
    : isCompletedWorkflow
      ? 'Showing completed job history (up to 25).'
      : 'Showing active jobs only (up to 25).';
  const calendarPeriodLabel = formatCalendarPeriodLabel(
    displayedCalendarGranularity,
    displayedCalendarAnchorDate
  );
  const calendarPeriodPreposition = displayedCalendarGranularity === 'week' ? 'for' : 'in';
  const requestedCalendarPeriodLabel = formatCalendarPeriodLabel(calendarGranularity, calendarAnchorDate);
  const jobsLoadingLabel = isSearchingJobs
    ? `Searching ${workflowSummaryLabel}...`
    : `Loading ${workflowSummaryLabel}...`;
  const jobsEmptyState = isSearchingJobs
    ? `No ${workflowSummaryLabel} match ${deferredJobSearchInput}.`
    : isCompletedWorkflow
      ? 'No completed job history yet.'
      : 'No active jobs found yet.';
  const calendarSummaryCopy = isSearchingJobs
    ? visibleHighlightedCalendarJobNumbers.length === 1
      ? `glowing exact match ${calendarPeriodPreposition} ${calendarPeriodLabel}`
      : visibleHighlightedCalendarJobNumbers.length
        ? `glowing ${visibleHighlightedCalendarJobNumbers.length} closest matches ${calendarPeriodPreposition} ${calendarPeriodLabel}`
        : `no matching job numbers visible ${calendarPeriodPreposition} ${calendarPeriodLabel}`
    : `scheduled ${workflowSummaryLabel} ${calendarPeriodPreposition} ${calendarPeriodLabel}`;
  const calendarVisibleCount = isSearchingJobs ? visibleHighlightedCalendarJobNumbers.length : calendarJobs.length;
  const calendarEmptyState = isCompletedWorkflow
    ? `No completed jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`
    : `No active jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`;
  const showCalendarTransitionError =
    Boolean(calendarTransitionErrorMessage) &&
    hasDisplayedCalendarSnapshot &&
    requestedCalendarKey !== displayedCalendarKey;
  const calendarNavigationStatus = isCalendarPendingTransition
    ? {
        kind: 'loading' as const,
        label: `Loading ${requestedCalendarPeriodLabel}...`
      }
    : showCalendarTransitionError
      ? {
          kind: 'error' as const,
          label: calendarTransitionErrorMessage
        }
      : null;

  function requestCalendarAnchorDate(nextAnchorDate: string) {
    setCalendarTransitionErrorMessage('');
    setCalendarAnchorDate(nextAnchorDate);
  }

  function requestCalendarGranularity(nextGranularity: 'week' | 'month') {
    setCalendarTransitionErrorMessage('');
    setCalendarGranularity(nextGranularity);
  }

  useEffect(() => {
    if (!requestedCalendarSnapshot) {
      return;
    }

    const requestedSnapshotKey = buildCalendarDisplaySnapshotKey(requestedCalendarSnapshot);
    const displayedSnapshotKey = displayedCalendarSnapshotState
      ? buildCalendarDisplaySnapshotKey(displayedCalendarSnapshotState)
      : '';
    const isSameSnapshot =
      displayedSnapshotKey === requestedSnapshotKey &&
      displayedCalendarSnapshotState?.jobs === requestedCalendarSnapshot.jobs;

    if (isSameSnapshot) {
      if (calendarTransitionErrorMessage) {
        setCalendarTransitionErrorMessage('');
      }
      return;
    }

    const shouldAnimate = displayedCalendarSnapshotState
      ? displayedCalendarSnapshotState.lifecycleStatus === requestedCalendarSnapshot.lifecycleStatus &&
        displayedSnapshotKey !== requestedSnapshotKey
      : false;

    setDisplayedCalendarSnapshotState(requestedCalendarSnapshot);
    setCalendarTransitionErrorMessage('');
    if (shouldAnimate) {
      setCalendarTransitionToken((currentToken) => currentToken + 1);
    }
  }, [calendarTransitionErrorMessage, displayedCalendarSnapshotState, requestedCalendarSnapshot]);

  useEffect(() => {
    if (!hasDisplayedCalendarSnapshot || requestedCalendarKey === displayedCalendarKey || !jobsCalendarQuery.error) {
      return;
    }

    setCalendarTransitionErrorMessage(
      jobsCalendarQuery.error instanceof Error
        ? jobsCalendarQuery.error.message
        : `Unable to load ${requestedCalendarPeriodLabel}.`
    );
  }, [
    displayedCalendarKey,
    hasDisplayedCalendarSnapshot,
    jobsCalendarQuery.error,
    requestedCalendarKey,
    requestedCalendarPeriodLabel
  ]);

  useEffect(() => {
    if (!isCalendarView || !hasDisplayedCalendarSnapshot || !displayedCalendarSnapshot) {
      return;
    }

    const adjacentAnchorDates = [
      shiftCalendarAnchorDate(displayedCalendarSnapshot.anchorDate, displayedCalendarSnapshot.view, -1),
      shiftCalendarAnchorDate(displayedCalendarSnapshot.anchorDate, displayedCalendarSnapshot.view, 1)
    ];

    adjacentAnchorDates.forEach((anchorDateToPrefetch) => {
      const params = {
        view: displayedCalendarSnapshot.view,
        anchorDate: anchorDateToPrefetch,
        lifecycleStatus: displayedCalendarSnapshot.lifecycleStatus
      };

      void queryClient
        .prefetchQuery({
          queryKey: inventoryKeys.jobsCalendarPeriod(params),
          queryFn: () => getJobsCalendarEntries(params),
          staleTime: 2 * 60 * 1000,
          gcTime: 60 * 60 * 1000
        })
        .catch(() => undefined);
    });
  }, [displayedCalendarSnapshot, hasDisplayedCalendarSnapshot, isCalendarView, queryClient]);

  useEffect(() => {
    if (!isCalendarView || !isSearchingJobs || !bestCalendarSearchMatch) {
      return;
    }

    const targetAnchorDate = String(bestCalendarSearchMatch.dueDate || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetAnchorDate)) {
      return;
    }

    if (isDateInCalendarPeriod(calendarGranularity, calendarAnchorDate, targetAnchorDate)) {
      return;
    }

    const autoJumpKey = `${selectedLifecycleStatus}:${calendarGranularity}:${deferredJobSearchInput.trim()}:${targetAnchorDate}`;
    if (autoJumpKeyRef.current === autoJumpKey) {
      return;
    }

    autoJumpKeyRef.current = autoJumpKey;
    requestCalendarAnchorDate(targetAnchorDate);
  }, [
    bestCalendarSearchMatch,
    calendarAnchorDate,
    calendarGranularity,
    deferredJobSearchInput,
    isCalendarView,
    isSearchingJobs,
    selectedLifecycleStatus
  ]);

  useEffect(() => {
    if (!isSearchingJobs) {
      autoJumpKeyRef.current = '';
    }
  }, [isSearchingJobs, selectedLifecycleStatus]);

  function buildCreateJobPayload(
    submitPayload: JobEditorSubmitPayload,
    isLaborOnly: boolean
  ): CreateJobPayload {
    return {
      jobNumber: submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      crewLeader: submitPayload.crewLeader,
      requirements: submitPayload.requirements,
      caulkRequirements: submitPayload.caulkRequirements,
      isLaborOnly
    };
  }

  async function submitCreateJob(submitPayload: JobEditorSubmitPayload, isLaborOnly: boolean) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a job.',
        variant: 'error'
      });
      return;
    }

    const payload = buildCreateJobPayload(submitPayload, isLaborOnly);

    try {
      setPendingLaborOnlyCreate(null);
      setIsNewJobOpen(false);
      const destination = `/allocations/${encodeURIComponent(payload.jobNumber)}`;
      const savePromise = createJobMutation.mutateAsync(payload);
      navigate(destination);
      const { result } = await savePromise;
      navigate(`/allocations/${encodeURIComponent(result.summary.jobNumber)}`, { replace: true });
    } catch (error) {
      navigate('/allocations', { replace: true });
      toast.push({
        title: 'Unable to save job',
        description: error instanceof Error ? error.message : 'The job could not be saved.',
        variant: 'error'
      });
    }
  }

  async function handleCreateJob(submitPayload: JobEditorSubmitPayload) {
    if (shouldPromptForLaborOnlyConfirmation(submitPayload)) {
      setPendingLaborOnlyCreate(submitPayload);
      return;
    }

    await submitCreateJob(submitPayload, false);
  }

  return (
    <>
      <section className="panel">
        <div className="page-hero-topline">
          <span className="eyebrow">Job Planning</span>
          <div className="jobs-hero-toggle-stack">
            <div className="inventory-view-toggle" role="group" aria-label="Jobs view mode">
              <button
                type="button"
                className={`inventory-view-toggle-button ${jobsViewMode === 'list' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => setJobsViewMode('list')}
                aria-pressed={jobsViewMode === 'list'}
              >
                List
              </button>
              <button
                type="button"
                className={`inventory-view-toggle-button ${jobsViewMode === 'calendar' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => setJobsViewMode('calendar')}
                aria-pressed={jobsViewMode === 'calendar'}
              >
                Calendar
              </button>
            </div>
            <div className="inventory-view-toggle-wrap">
              <div className="inventory-view-toggle" role="group" aria-label="Jobs workflow view">
              <button
                type="button"
                className={`inventory-view-toggle-button ${!isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => {
                  setCalendarTransitionErrorMessage('');
                  setJobsWorkflowView('active');
                }}
                aria-pressed={!isCompletedWorkflow}
              >
                Active workflow
              </button>
              <button
                type="button"
                className={`inventory-view-toggle-button ${isCompletedWorkflow ? 'inventory-view-toggle-button-active' : ''}`.trim()}
                onClick={() => {
                  setCalendarTransitionErrorMessage('');
                  setJobsWorkflowView('completed');
                }}
                aria-pressed={isCompletedWorkflow}
              >
                Completed jobs
              </button>
              </div>
            </div>
          </div>
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Jobs</h2>
            <p className="muted-text">{workflowDescription}</p>
            <div className="jobs-toolbar-grid">
              <label className="field jobs-search-field">
                <span className="field-label">Search Job ID Number</span>
                <input
                  className="field-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={jobSearchInput}
                  onChange={(event) => setJobSearchInput(event.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Enter job number"
                />
              </label>
              {!isCalendarView ? (
                <Select
                  label="Sort Jobs"
                  className="jobs-sort-select"
                  options={JOB_SORT_OPTIONS}
                  value={jobSort}
                  onChange={(event) => setJobSort(event.target.value as JobSortOption)}
                />
              ) : (
                <div className="jobs-calendar-search-note">
                  <span className="field-label">Calendar Search</span>
                  <p className="muted-text">
                    Exact matches glow by themselves. Otherwise the 3 closest jobs glow.
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="page-hero-actions">
            <Button
              type="button"
              className="button-job-new"
              size="lg"
              onClick={() => setIsNewJobOpen(true)}
            >
              New Job +
            </Button>
          </div>
        </div>
        <div className="page-hero-summary inventory-hero-summary">
          <div className="hero-metric">
            <div className="hero-metric-line inventory-summary-line">
              <span className="hero-metric-label">Showing</span>
              <strong className="hero-metric-value inventory-summary-value">
                {isCalendarView ? calendarVisibleCount : listJobs.length}
              </strong>
              <span className="hero-metric-detail hero-metric-inline-copy inventory-summary-copy">
                {isCalendarView
                  ? calendarSummaryCopy
                  : isSearchingJobs
                    ? `matching ${workflowSummaryLabel}`
                    : workflowSummaryLabel}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row allocations-recent-title-row">
          <h2>{isCalendarView ? 'Install Calendar' : workflowTitle}</h2>
          <span className="muted-text allocations-recent-count">
            {isCalendarView
              ? isSearchingJobs
                ? `${calendarVisibleCount} highlighted match${calendarVisibleCount === 1 ? '' : 'es'} ${calendarPeriodPreposition} ${calendarPeriodLabel}`
                : `${calendarVisibleCount} job${calendarVisibleCount === 1 ? '' : 's'} ${calendarPeriodPreposition} ${calendarPeriodLabel}`
              : `${listJobs.length} job(s)`}
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
        {!isCalendarView && !listJobsLoading && !listJobsError && !listJobs.length ? (
          <div className="empty-state">{jobsEmptyState}</div>
        ) : null}
        {!isCalendarView && listJobs.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {listJobs.map((entry) => {
                const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);
                return (
                  <MobileRecordCard key={entry.jobNumber}>
                    <MobileRecordHeader
                      title={entry.jobNumber}
                      subtitle={`${entry.warehouse} warehouse`}
                      badge={<span className={`badge badge-${displayStatus}`}>{formatStatusLabel(displayStatus)}</span>}
                      onTitleClick={() => navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)}
                    />
                    <MobileFieldList>
                      <MobileField label="Install Date" value={formatDate(entry.dueDate)} />
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
                    const displayStatus = getJobListDisplayStatus(entry.status, entry.filmOrderCount);
                    return (
                      <tr key={entry.jobNumber}>
                        <td>
                          <button
                            type="button"
                            className="row-button"
                            onClick={() => navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)}
                          >
                            {entry.jobNumber}
                          </button>
                        </td>
                        <td>{formatDate(entry.dueDate)}</td>
                        <td>{entry.sections ?? '--'}</td>
                        <td>{entry.warehouse}</td>
                        <td>
                          <span className={`badge badge-${displayStatus}`}>{formatStatusLabel(displayStatus)}</span>
                        </td>
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
              {isSearchingJobs
                ? visibleHighlightedCalendarJobNumbers.length === 1
                  ? `The exact job match is glowing ${calendarPeriodPreposition} ${calendarPeriodLabel}.`
                  : visibleHighlightedCalendarJobNumbers.length
                    ? `The ${visibleHighlightedCalendarJobNumbers.length} closest visible job numbers are glowing ${calendarPeriodPreposition} ${calendarPeriodLabel}.`
                    : `No matching job numbers were found. The ${displayedCalendarGranularity} stays visible while you search.`
                : !calendarJobs.length
                  ? calendarEmptyState
                  : 'Click a job number to open job details. Completed jobs stay clickable, and staged jobs show a check mark.'}
            </p>
            <JobsCalendarView
              view={displayedCalendarGranularity}
              anchorDate={displayedCalendarAnchorDate}
              jobs={calendarJobs}
              highlightJobNumbers={visibleHighlightedCalendarJobNumbers}
              requestedView={calendarGranularity}
              requestedAnchorDate={calendarAnchorDate}
              navigationStatus={calendarNavigationStatus}
              transitionToken={calendarTransitionToken}
              onViewChange={requestCalendarGranularity}
              onAnchorDateChange={requestCalendarAnchorDate}
            />
          </>
        ) : null}
      </section>

      <JobEditorDialog
        open={isNewJobOpen}
        mode="create"
        title="New Job"
        submitLabel="Save Job"
        submitting={createJobMutation.isPending}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductEntries={caulkProductsQuery.data}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        onCancel={() => setIsNewJobOpen(false)}
        onSubmit={(payload) => void handleCreateJob(payload)}
      />
      <LaborOnlyJobConfirmDialog
        open={Boolean(pendingLaborOnlyCreate)}
        jobNumber={pendingLaborOnlyCreate?.jobNumber || ''}
        pending={createJobMutation.isPending}
        onCancel={() => setPendingLaborOnlyCreate(null)}
        onConfirmNormal={() => {
          if (!pendingLaborOnlyCreate) {
            return;
          }

          void submitCreateJob(pendingLaborOnlyCreate, false);
        }}
        onConfirmLaborOnly={() => {
          if (!pendingLaborOnlyCreate) {
            return;
          }

          void submitCreateJob(pendingLaborOnlyCreate, true);
        }}
      />
    </>
  );
}
