import { useCallback, useEffect, useDeferredValue, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import { type JobLifecycleFilter } from '../../../../api/features/jobsClient';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { todayDateString } from '../../../../lib/date';
import { useAuth } from '../../../auth/AuthContext';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
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
import {
  patchJobsRouteState,
  readJobsRouteState,
  writeJobsRouteState,
  type JobsRouteState
} from '../../utils/jobsRouteState';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseRegistrySettled =
    warehouseRegistry.scopeReady === true && warehouseRegistry.isSuccess;
  const routeDefaults = useMemo<Partial<JobsRouteState>>(
    () => ({
      view: initialJobsViewMode,
      workflow: initialWorkflowView,
      search: initialJobSearchInput,
      sort: initialJobSort,
      calendarView: initialCalendarGranularity,
      calendarDate: initialCalendarMonth
        ? `${initialCalendarMonth}-01`
        : initialCalendarAnchorDate
    }),
    [
      initialCalendarAnchorDate,
      initialCalendarGranularity,
      initialCalendarMonth,
      initialJobSearchInput,
      initialJobSort,
      initialJobsViewMode,
      initialWorkflowView
    ]
  );
  const routeOptions = useMemo(
    () => ({
      defaultWarehouse,
      warehouseEntries: warehouseRegistry.entries,
      warehouseRegistrySettled,
      defaults: routeDefaults
    }),
    [
      defaultWarehouse,
      routeDefaults,
      warehouseRegistry.entries,
      warehouseRegistrySettled
    ]
  );
  const routeState = useMemo(
    () => readJobsRouteState(searchParams, routeOptions),
    [routeOptions, searchParams]
  );
  const canonicalSearchParams = useMemo(
    () => writeJobsRouteState(routeState, routeOptions),
    [routeOptions, routeState]
  );
  const routeParsed = canonicalSearchParams.toString() === searchParams.toString();
  const jobsWorkflowView = routeState.workflow;
  const jobsViewMode = routeState.view;
  const warehouseFilter = routeState.warehouse;
  const safeWarehouseFilter = warehouseFilter;
  const calendarGranularity = routeState.calendarView;
  const calendarAnchorDate = routeState.calendarDate;
  const jobSearchInput = routeState.search;
  const jobSort = routeState.sort;

  useEffect(() => {
    if (!routeParsed) {
      setSearchParams(canonicalSearchParams, { replace: true });
    }
  }, [canonicalSearchParams, routeParsed, setSearchParams]);

  const patchRoute = useCallback(
    (patch: Partial<JobsRouteState>) => {
      setSearchParams(
        writeJobsRouteState(patchJobsRouteState(routeState, patch), routeOptions),
        { replace: true }
      );
    },
    [routeOptions, routeState, setSearchParams]
  );
  const setJobsWorkflowView = useCallback(
    (workflow: 'active' | 'completed') => patchRoute({ workflow }),
    [patchRoute]
  );
  const setJobsViewMode = useCallback(
    (view: 'list' | 'calendar') => patchRoute({ view }),
    [patchRoute]
  );
  const setWarehouseFilter = useCallback(
    (warehouse: string) => patchRoute({ warehouse }),
    [patchRoute]
  );
  const setCalendarGranularity = useCallback(
    (calendarView: 'week' | 'month') => patchRoute({ calendarView }),
    [patchRoute]
  );
  const setCalendarAnchorDate = useCallback(
    (calendarDate: string) => patchRoute({ calendarDate }),
    [patchRoute]
  );
  const setJobSort = useCallback(
    (sort: JobSortOption) => patchRoute({ sort }),
    [patchRoute]
  );

  const selectedLifecycleStatus: JobLifecycleFilter =
    jobsWorkflowView === 'completed' ? 'COMPLETED' : 'ACTIVE';
  const deferredJobSearchInput = useDeferredValue(jobSearchInput);
  const isCalendarView = jobsViewMode === 'calendar';
  const isCompletedWorkflow = jobsWorkflowView === 'completed';
  const listSearchQuery = isCalendarView ? '' : deferredJobSearchInput;
  const isSearchingListJobs = Boolean(listSearchQuery.trim());

  const jobsQuery = useJobsList(0, {
    enabled: warehouseRegistrySettled && !isCalendarView,
    lifecycleStatus: selectedLifecycleStatus,
    warehouse: safeWarehouseFilter
  });
  const jobsCalendarQuery = useJobsCalendarEntries(calendarAnchorDate, {
    enabled: warehouseRegistrySettled && isCalendarView,
    view: calendarGranularity,
    lifecycleStatus: selectedLifecycleStatus,
    warehouse: safeWarehouseFilter
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
    selectedWarehouse: safeWarehouseFilter,
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
    patchRoute({ search: nextValue });
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
    warehouseFilter: safeWarehouseFilter,
    setWarehouseFilter,
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
    routeParsed,
    warehouseAuthorizationResolved: warehouseRegistrySettled,
    listLayoutDataReady:
      !isCalendarView && !jobsQuery.isLoading && !jobsQuery.isError,
    calendarLayoutDataReady:
      isCalendarView &&
      !calendarWorkflow.calendarLoading &&
      !calendarWorkflow.calendarError &&
      !calendarWorkflow.calendarNavigationStatus,
    setJobsWorkflowView,
    handleJobSearchInputChange,
    handlePrefetchJob,
    handleOpenJob
  };
}
