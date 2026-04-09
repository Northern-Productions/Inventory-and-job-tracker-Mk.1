import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../../components/Toast';
import { listCaulkProducts } from '../../../api/features/caulkClient';
import { type JobLifecycleFilter } from '../../../api/features/jobsClient';
import type { JobListEntry } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { todayDateString } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobEditorDialog } from '../components/JobEditorDialog';
import { LaborOnlyJobConfirmDialog } from '../components/LaborOnlyJobConfirmDialog';
import {
  useCreateJob,
  useFilmCatalog,
  useJobsCalendarEntries,
  useJobsList,
  useJobsSearch
} from '../hooks/useInventoryQueries';
import {
  formatCalendarPeriodLabel,
  getCurrentCalendarAnchorDate
} from '../utils/jobCalendar';
import { sortSearchedJobs, sortJobs, type JobSortOption } from '../utils/jobSorts';
import { JobsHeroSection } from './allocations-page/JobsHeroSection';
import { JobsResultsSection } from './allocations-page/JobsResultsSection';
import { useJobCreationWorkflow } from './allocations-page/useJobCreationWorkflow';
import { useJobsCalendarWorkflow } from './allocations-page/useJobsCalendarWorkflow';

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
  const [jobSearchInput, setJobSearchInput] = useState(initialJobSearchInput);
  const [jobSort, setJobSort] = useState<JobSortOption>(initialJobSort);

  const selectedLifecycleStatus: JobLifecycleFilter =
    jobsWorkflowView === 'completed' ? 'COMPLETED' : 'ACTIVE';
  const deferredJobSearchInput = useDeferredValue(jobSearchInput);
  const isCalendarView = jobsViewMode === 'calendar';
  const isCompletedWorkflow = jobsWorkflowView === 'completed';
  const listSearchQuery = isCalendarView ? '' : deferredJobSearchInput;
  const isSearchingListJobs = Boolean(listSearchQuery.trim());

  const jobsQuery = useJobsList(25, {
    enabled: !isCalendarView,
    lifecycleStatus: selectedLifecycleStatus
  });
  const jobsSearchQuery = useJobsSearch(listSearchQuery, 25, {
    enabled: isSearchingListJobs,
    lifecycleStatus: selectedLifecycleStatus
  });
  const activeCalendarSearchQuery = useJobsSearch(jobSearchInput, 1, {
    enabled: isCalendarView && Boolean(jobSearchInput.trim()),
    lifecycleStatus: 'ACTIVE'
  });
  const completedCalendarSearchQuery = useJobsSearch(jobSearchInput, 1, {
    enabled: isCalendarView && Boolean(jobSearchInput.trim()),
    lifecycleStatus: 'COMPLETED'
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

  const jobCreationWorkflow = useJobCreationWorkflow({
    auth,
    createJobMutation,
    navigate,
    toast
  });
  const calendarWorkflow = useJobsCalendarWorkflow({
    initialJobsViewMode,
    initialJobSearchInput,
    isCalendarView,
    selectedLifecycleStatus,
    calendarGranularity,
    calendarAnchorDate,
    jobsCalendarQuery,
    activeCalendarSearchQuery,
    completedCalendarSearchQuery,
    queryClient,
    toast,
    onWorkflowViewChange: setJobsWorkflowView,
    onCalendarAnchorDateChange: setCalendarAnchorDate,
    onCalendarGranularityChange: setCalendarGranularity
  });

  const listJobsSource = isSearchingListJobs
    ? jobsSearchQuery.data || []
    : jobsQuery.data || [];
  const listJobs = useMemo(() => {
    const scopedEntries = isCompletedWorkflow
      ? listJobsSource.filter((entry) => entry.status === 'COMPLETED')
      : listJobsSource;

    return isSearchingListJobs
      ? sortSearchedJobs(scopedEntries, listSearchQuery, jobSort)
      : sortJobs(scopedEntries, jobSort);
  }, [
    isCompletedWorkflow,
    isSearchingListJobs,
    jobSort,
    listJobsSource,
    listSearchQuery
  ]);

  const listJobsLoading =
    (isSearchingListJobs ? jobsSearchQuery.isLoading : jobsQuery.isLoading) && !listJobs.length;
  const listJobsError = isSearchingListJobs ? jobsSearchQuery.error : jobsQuery.error;
  const workflowSummaryLabel = isCompletedWorkflow ? 'completed jobs' : 'active jobs';
  const workflowTitle = isCompletedWorkflow ? 'Completed Job History' : 'Recent Jobs';
  const workflowDescription = isCalendarView
    ? isCompletedWorkflow
      ? `Browse completed install dates by ${calendarWorkflow.displayedCalendarGranularity}.`
      : `Browse active install dates by ${calendarWorkflow.displayedCalendarGranularity}.`
    : isCompletedWorkflow
      ? 'Showing completed job history (up to 25).'
      : 'Showing active jobs only (up to 25).';
  const calendarPeriodLabel = formatCalendarPeriodLabel(
    calendarWorkflow.displayedCalendarGranularity,
    calendarWorkflow.displayedCalendarAnchorDate
  );
  const calendarPeriodPreposition =
    calendarWorkflow.displayedCalendarGranularity === 'week' ? 'for' : 'in';
  const jobsLoadingLabel = isSearchingListJobs
    ? `Searching ${workflowSummaryLabel}...`
    : `Loading ${workflowSummaryLabel}...`;
  const jobsEmptyState = isSearchingListJobs
    ? `No ${workflowSummaryLabel} match ${listSearchQuery}.`
    : isCompletedWorkflow
      ? 'No completed job history yet.'
      : 'No active jobs found yet.';
  const calendarSummaryCopy = `scheduled ${workflowSummaryLabel} ${calendarPeriodPreposition} ${calendarPeriodLabel}`;
  const calendarEmptyState = isCompletedWorkflow
    ? `No completed jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`
    : `No active jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`;

  function handleJobSearchInputChange(rawValue: string) {
    const nextValue = rawValue.replace(/[^0-9]/g, '');
    setJobSearchInput(nextValue);

    if (isCalendarView && !nextValue) {
      calendarWorkflow.clearCalendarSearch();
    }
  }

  function handleCalendarSearchSubmit() {
    const normalizedQuery = jobSearchInput.trim();
    if (!normalizedQuery) {
      return;
    }

    calendarWorkflow.submitCalendarSearch(normalizedQuery);
  }

  return (
    <>
      <JobsHeroSection
        jobsViewMode={jobsViewMode}
        isCompletedWorkflow={isCompletedWorkflow}
        workflowDescription={workflowDescription}
        jobSearchInput={jobSearchInput}
        isCalendarView={isCalendarView}
        jobSort={jobSort}
        isCalendarSearchPending={calendarWorkflow.isCalendarSearchPending}
        calendarVisibleCount={calendarWorkflow.calendarVisibleCount}
        listJobsLength={listJobs.length}
        calendarSummaryCopy={calendarSummaryCopy}
        isSearchingListJobs={isSearchingListJobs}
        workflowSummaryLabel={workflowSummaryLabel}
        onSetJobsViewMode={setJobsViewMode}
        onSetWorkflowView={setJobsWorkflowView}
        onJobSearchInputChange={handleJobSearchInputChange}
        onSubmitCalendarSearch={handleCalendarSearchSubmit}
        onSetJobSort={setJobSort}
        onOpenNewJob={() => jobCreationWorkflow.setIsNewJobOpen(true)}
      />

      <JobsResultsSection
        isCalendarView={isCalendarView}
        workflowTitle={workflowTitle}
        calendarVisibleCount={calendarWorkflow.calendarVisibleCount}
        listJobsLength={listJobs.length}
        calendarPeriodPreposition={calendarPeriodPreposition}
        calendarPeriodLabel={calendarPeriodLabel}
        listJobsLoading={listJobsLoading}
        jobsLoadingLabel={jobsLoadingLabel}
        calendarLoading={calendarWorkflow.calendarLoading}
        workflowSummaryLabel={workflowSummaryLabel}
        displayedCalendarGranularity={calendarWorkflow.displayedCalendarGranularity}
        listJobsError={listJobsError}
        calendarError={calendarWorkflow.calendarError}
        jobsEmptyState={jobsEmptyState}
        listJobs={listJobs}
        isPhoneLayout={isPhoneLayout}
        calendarJobs={calendarWorkflow.calendarJobs}
        calendarEmptyState={calendarEmptyState}
        displayedCalendarAnchorDate={calendarWorkflow.displayedCalendarAnchorDate}
        visibleCalendarTargetJobNumber={calendarWorkflow.visibleCalendarTargetJobNumber}
        visibleCalendarTargetDate={calendarWorkflow.visibleCalendarTargetDate}
        calendarTargetNavigationToken={calendarWorkflow.calendarTargetNavigationToken}
        calendarGranularity={calendarGranularity}
        calendarAnchorDate={calendarAnchorDate}
        calendarNavigationStatus={calendarWorkflow.calendarNavigationStatus}
        calendarTransitionToken={calendarWorkflow.calendarTransitionToken}
        onOpenJob={(nextJobNumber) =>
          navigate(`/allocations/${encodeURIComponent(nextJobNumber)}`)
        }
        onViewChange={calendarWorkflow.requestCalendarGranularity}
        onAnchorDateChange={calendarWorkflow.requestCalendarAnchorDate}
      />

      <JobEditorDialog
        open={jobCreationWorkflow.isNewJobOpen}
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
        onCancel={() => jobCreationWorkflow.setIsNewJobOpen(false)}
        onSubmit={(payload) => void jobCreationWorkflow.handleCreateJob(payload)}
      />

      <LaborOnlyJobConfirmDialog
        open={Boolean(jobCreationWorkflow.pendingLaborOnlyCreate)}
        jobNumber={jobCreationWorkflow.pendingLaborOnlyCreate?.jobNumber || ''}
        pending={createJobMutation.isPending}
        onCancel={() => jobCreationWorkflow.setPendingLaborOnlyCreate(null)}
        onConfirmLaborOnly={jobCreationWorkflow.confirmLaborOnlyCreate}
      />
    </>
  );
}
