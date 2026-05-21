import { useDeferredValue, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import { type JobLifecycleFilter } from '../../../../api/features/jobsClient';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { todayDateString } from '../../../../lib/date';
import { useAuth } from '../../../auth/AuthContext';
import {
  useCreateJob,
  useCaulkProducts,
  useFilmCatalog,
  useJobsCalendarEntries,
  useJobsList
} from '../../hooks/useInventoryQueries';
import { prefetchJobDetail, prefetchJobDetailById } from '../jobDetailPrefetch';
import {
  formatCalendarPeriodLabel,
  getCurrentCalendarAnchorDate
} from '../../utils/jobCalendar';
import { sortSearchedJobs, sortJobs, type JobSortOption } from '../../utils/jobSorts';
import { buildAllocationJobRoute } from '../../utils/jobRoutes';
import { useJobCreationWorkflow } from './useJobCreationWorkflow';
import { useJobsCalendarWorkflow } from './useJobsCalendarWorkflow';

type AllocationsPageProps = {
  initialWorkflowView?: 'active' | 'completed';
  initialJobsViewMode?: 'list' | 'calendar';
  initialCalendarGranularity?: 'week' | 'month';
  initialJobSearchInput?: string;
  initialJobSort?: JobSortOption;
  initialCalendarAnchorDate?: string;
  initialCalendarMonth?: string;
};

export function useAllocationsPageModel({
  initialWorkflowView = 'active',
  initialJobsViewMode = 'calendar',
  initialCalendarGranularity = 'week',
  initialJobSearchInput = '',
  initialJobSort = 'install_date_asc',
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

  const jobsQuery = useJobsList(0, {
    enabled: !isCalendarView,
    lifecycleStatus: selectedLifecycleStatus
  });
  const jobsCalendarQuery = useJobsCalendarEntries(calendarAnchorDate, {
    enabled: isCalendarView,
    view: calendarGranularity,
    lifecycleStatus: selectedLifecycleStatus
  });
  const createJobMutation = useCreateJob();
  const jobCreationWorkflow = useJobCreationWorkflow({
    auth,
    createJobMutation,
    navigate,
    toast
  });
  const filmCatalogQuery = useFilmCatalog({
    enabled: jobCreationWorkflow.isNewJobOpen
  });
  const caulkProductsQuery = useCaulkProducts({
    enabled: jobCreationWorkflow.isNewJobOpen
  });
  const calendarWorkflow = useJobsCalendarWorkflow({
    isCalendarView,
    selectedLifecycleStatus,
    calendarGranularity,
    calendarAnchorDate,
    jobsCalendarQuery,
    queryClient,
    onCalendarAnchorDateChange: setCalendarAnchorDate,
    onCalendarGranularityChange: setCalendarGranularity
  });

  const listJobsSource = isCalendarView ? [] : jobsQuery.data || [];
  const listJobs = useMemo(() => {
    if (isCalendarView) {
      return [];
    }

    const scopedEntries = isCompletedWorkflow
      ? listJobsSource.filter((entry) => entry.status === 'COMPLETED')
      : listJobsSource;

    return isSearchingListJobs
      ? sortSearchedJobs(scopedEntries, listSearchQuery, jobSort)
      : sortJobs(scopedEntries, jobSort);
  }, [
    isCalendarView,
    isCompletedWorkflow,
    isSearchingListJobs,
    jobSort,
    listJobsSource,
    listSearchQuery
  ]);

  const listJobsLoading = jobsQuery.isLoading && !listJobsSource.length;
  const listJobsError = jobsQuery.error;
  const workflowSummaryLabel = isCompletedWorkflow ? 'completed jobs' : 'active jobs';
  const workflowTitle = isCompletedWorkflow ? 'Completed Jobs' : 'All Active Jobs';
  const workflowDescription = isCalendarView
    ? isCompletedWorkflow
      ? `Browse completed install dates by ${calendarWorkflow.displayedCalendarGranularity}.`
      : `Browse active install dates by ${calendarWorkflow.displayedCalendarGranularity}.`
    : isCompletedWorkflow
      ? 'Showing all completed jobs.'
      : 'Showing all active jobs.';
  const calendarPeriodLabel = formatCalendarPeriodLabel(
    calendarWorkflow.displayedCalendarGranularity,
    calendarWorkflow.displayedCalendarAnchorDate
  );
  const calendarPeriodPreposition =
    calendarWorkflow.displayedCalendarGranularity === 'week' ? 'for' : 'in';
  const jobsLoadingLabel = `Loading ${workflowSummaryLabel}...`;
  const jobsEmptyState = isSearchingListJobs
    ? `No ${workflowSummaryLabel} match ${listSearchQuery}.`
    : isCompletedWorkflow
      ? 'No completed jobs found yet.'
      : 'No active jobs found yet.';
  const calendarSummaryCopy = `scheduled ${workflowSummaryLabel} ${calendarPeriodPreposition} ${calendarPeriodLabel}`;
  const calendarEmptyState = isCompletedWorkflow
    ? `No completed jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`
    : `No active jobs are scheduled ${calendarPeriodPreposition} ${calendarPeriodLabel}.`;

  function handleJobSearchInputChange(rawValue: string) {
    const nextValue = rawValue.replace(/[^0-9]/g, '');
    setJobSearchInput(nextValue);
  }

  function handlePrefetchJob(jobNumber: string, jobId?: string) {
    const normalizedJobId = String(jobId || '').trim();
    void (normalizedJobId
      ? prefetchJobDetailById(queryClient, normalizedJobId)
      : prefetchJobDetail(queryClient, jobNumber)
    ).catch(() => undefined);
  }

  function handleOpenJob(nextJobNumber: string, jobId?: string) {
    handlePrefetchJob(nextJobNumber, jobId);
    navigate(buildAllocationJobRoute({ jobNumber: nextJobNumber, jobId }));
  }

  return {
    createJobMutation,
    filmCatalogQuery,
    caulkProductsQuery,
    jobCreationWorkflow,
    calendarWorkflow,
    jobsViewMode,
    setJobsViewMode,
    isCompletedWorkflow,
    isCalendarView,
    jobSearchInput,
    jobSort,
    setJobSort,
    listJobs,
    listJobsLoading,
    listJobsError,
    workflowSummaryLabel,
    workflowTitle,
    workflowDescription,
    calendarPeriodLabel,
    calendarPeriodPreposition,
    jobsLoadingLabel,
    jobsEmptyState,
    calendarSummaryCopy,
    calendarEmptyState,
    isSearchingListJobs,
    isPhoneLayout,
    calendarGranularity,
    calendarAnchorDate,
    setJobsWorkflowView,
    handleJobSearchInputChange,
    handlePrefetchJob,
    handleOpenJob
  };
}
