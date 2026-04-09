import { useEffect, useMemo, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  getJobsCalendarEntries,
  type JobLifecycleFilter
} from '../../../../api/features/jobsClient';
import type { JobListEntry } from '../../../../domain';
import {
  findBestCalendarSearchMatch,
  formatCalendarPeriodLabel,
  isDateInCalendarPeriod,
  shiftCalendarAnchorDate
} from '../../utils/jobCalendar';
import { inventoryKeys } from '../../hooks/inventoryQueryKeys';

type JobsCalendarQueryLike = {
  data?: JobListEntry[];
  isSuccess: boolean;
  isFetching: boolean;
  isLoading: boolean;
  error: unknown;
  fetchStatus: string;
};

type JobsSearchQueryLike = {
  data?: JobListEntry[];
  isLoading: boolean;
  isFetching: boolean;
};

type CalendarDisplaySnapshot = {
  anchorDate: string;
  view: 'week' | 'month';
  lifecycleStatus: JobLifecycleFilter;
  jobs: JobListEntry[];
};

interface ToastLike {
  push: (toast: {
    title: string;
    description?: string;
    variant?: 'success' | 'error' | 'warning';
  }) => void;
}

interface UseJobsCalendarWorkflowOptions {
  initialJobsViewMode: 'list' | 'calendar';
  initialJobSearchInput: string;
  isCalendarView: boolean;
  selectedLifecycleStatus: JobLifecycleFilter;
  calendarGranularity: 'week' | 'month';
  calendarAnchorDate: string;
  jobsCalendarQuery: JobsCalendarQueryLike;
  activeCalendarSearchQuery: JobsSearchQueryLike;
  completedCalendarSearchQuery: JobsSearchQueryLike;
  queryClient: QueryClient;
  toast: ToastLike;
  onWorkflowViewChange: (view: 'active' | 'completed') => void;
  onCalendarAnchorDateChange: (anchorDate: string) => void;
  onCalendarGranularityChange: (granularity: 'week' | 'month') => void;
}

function buildCalendarDisplaySnapshotKey(
  snapshot: Pick<CalendarDisplaySnapshot, 'anchorDate' | 'view' | 'lifecycleStatus'>
) {
  return `${snapshot.lifecycleStatus}:${snapshot.view}:${snapshot.anchorDate}`;
}

export function useJobsCalendarWorkflow({
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
  onWorkflowViewChange,
  onCalendarAnchorDateChange,
  onCalendarGranularityChange
}: UseJobsCalendarWorkflowOptions) {
  const [submittedCalendarSearch, setSubmittedCalendarSearch] = useState<{
    query: string;
    requestId: number;
  } | null>(() =>
    initialJobsViewMode === 'calendar' && initialJobSearchInput.trim()
      ? {
          query: initialJobSearchInput.trim(),
          requestId: 1
        }
      : null
  );
  const [calendarSearchTarget, setCalendarSearchTarget] = useState<{
    jobNumber: string;
    lifecycleStatus: JobLifecycleFilter;
    dueDate: string;
  } | null>(null);
  const [calendarTargetNavigationToken, setCalendarTargetNavigationToken] = useState(0);
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
  const handledCalendarSearchKeyRef = useRef('');

  const calendarSearchQuery = submittedCalendarSearch?.query || '';
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
  const displayedCalendarAnchorDate =
    displayedCalendarSnapshot?.anchorDate || calendarAnchorDate;
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
  const calendarSearchMatches = useMemo(
    () => [
      ...(activeCalendarSearchQuery.data || []),
      ...(completedCalendarSearchQuery.data || [])
    ],
    [activeCalendarSearchQuery.data, completedCalendarSearchQuery.data]
  );
  const bestCalendarSearchMatch = useMemo(
    () =>
      findBestCalendarSearchMatch(calendarSearchMatches, calendarSearchQuery, {
        preferredLifecycleStatus: selectedLifecycleStatus
      }),
    [calendarSearchMatches, calendarSearchQuery, selectedLifecycleStatus]
  );
  const isCalendarSearchPending =
    isCalendarView &&
    Boolean(calendarSearchQuery) &&
    (activeCalendarSearchQuery.isLoading ||
      activeCalendarSearchQuery.isFetching ||
      completedCalendarSearchQuery.isLoading ||
      completedCalendarSearchQuery.isFetching);
  const showCalendarTransitionError =
    Boolean(calendarTransitionErrorMessage) &&
    hasDisplayedCalendarSnapshot &&
    requestedCalendarKey !== displayedCalendarKey;
  const requestedCalendarPeriodLabel = formatCalendarPeriodLabel(
    calendarGranularity,
    calendarAnchorDate
  );
  const calendarNavigationStatus = useMemo(
    () =>
      requestedCalendarKey !== displayedCalendarKey &&
      hasDisplayedCalendarSnapshot &&
      jobsCalendarQuery.fetchStatus === 'fetching'
        ? {
            kind: 'loading' as const,
            label: `Loading ${requestedCalendarPeriodLabel}...`
          }
        : showCalendarTransitionError
          ? {
              kind: 'error' as const,
              label: calendarTransitionErrorMessage
            }
          : null,
    [
      calendarTransitionErrorMessage,
      displayedCalendarKey,
      hasDisplayedCalendarSnapshot,
      jobsCalendarQuery.fetchStatus,
      requestedCalendarKey,
      requestedCalendarPeriodLabel,
      showCalendarTransitionError
    ]
  );
  const visibleCalendarTargetJobNumber =
    calendarSearchTarget?.lifecycleStatus === selectedLifecycleStatus
      ? calendarSearchTarget.jobNumber
      : '';
  const visibleCalendarTargetDate =
    calendarSearchTarget?.lifecycleStatus === selectedLifecycleStatus
      ? calendarSearchTarget.dueDate
      : '';

  function requestCalendarAnchorDate(nextAnchorDate: string) {
    setCalendarTransitionErrorMessage('');
    onCalendarAnchorDateChange(nextAnchorDate);
  }

  function requestCalendarGranularity(nextGranularity: 'week' | 'month') {
    setCalendarTransitionErrorMessage('');
    onCalendarGranularityChange(nextGranularity);
  }

  function clearCalendarSearch() {
    handledCalendarSearchKeyRef.current = '';
    setSubmittedCalendarSearch(null);
    setCalendarSearchTarget(null);
  }

  function submitCalendarSearch(query: string) {
    setCalendarTransitionErrorMessage('');
    setSubmittedCalendarSearch((current) => ({
      query,
      requestId: (current?.requestId || 0) + 1
    }));
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
      ? displayedCalendarSnapshotState.lifecycleStatus ===
          requestedCalendarSnapshot.lifecycleStatus &&
        displayedSnapshotKey !== requestedSnapshotKey
      : false;

    setDisplayedCalendarSnapshotState(requestedCalendarSnapshot);
    setCalendarTransitionErrorMessage('');
    if (shouldAnimate) {
      setCalendarTransitionToken((currentToken) => currentToken + 1);
    }
  }, [
    calendarTransitionErrorMessage,
    displayedCalendarSnapshotState,
    requestedCalendarSnapshot
  ]);

  useEffect(() => {
    if (
      !hasDisplayedCalendarSnapshot ||
      requestedCalendarKey === displayedCalendarKey ||
      !jobsCalendarQuery.error
    ) {
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
      shiftCalendarAnchorDate(
        displayedCalendarSnapshot.anchorDate,
        displayedCalendarSnapshot.view,
        -1
      ),
      shiftCalendarAnchorDate(
        displayedCalendarSnapshot.anchorDate,
        displayedCalendarSnapshot.view,
        1
      )
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
    if (!isCalendarView || !submittedCalendarSearch) {
      return;
    }

    if (
      activeCalendarSearchQuery.isLoading ||
      activeCalendarSearchQuery.isFetching ||
      completedCalendarSearchQuery.isLoading ||
      completedCalendarSearchQuery.isFetching
    ) {
      return;
    }

    const handledKey = `${submittedCalendarSearch.query}:${submittedCalendarSearch.requestId}`;
    if (handledCalendarSearchKeyRef.current === handledKey) {
      return;
    }

    handledCalendarSearchKeyRef.current = handledKey;

    if (!bestCalendarSearchMatch) {
      setCalendarSearchTarget(null);
      toast.push({
        title: 'No matching jobs found',
        description: `No jobs in history matched ${submittedCalendarSearch.query}.`,
        variant: 'error'
      });
      return;
    }

    const targetLifecycleStatus: JobLifecycleFilter =
      String(bestCalendarSearchMatch.lifecycleStatus || '').trim().toUpperCase() === 'COMPLETED'
        ? 'COMPLETED'
        : 'ACTIVE';
    const targetAnchorDate = String(bestCalendarSearchMatch.dueDate || '')
      .trim()
      .slice(0, 10);
    const hasTargetAnchorDate = /^\d{4}-\d{2}-\d{2}$/.test(targetAnchorDate);

    if (targetLifecycleStatus !== selectedLifecycleStatus) {
      setCalendarTransitionErrorMessage('');
      onWorkflowViewChange(targetLifecycleStatus === 'COMPLETED' ? 'completed' : 'active');
    }

    if (
      hasTargetAnchorDate &&
      !isDateInCalendarPeriod(calendarGranularity, calendarAnchorDate, targetAnchorDate)
    ) {
      requestCalendarAnchorDate(targetAnchorDate);
    }

    setCalendarSearchTarget({
      jobNumber: bestCalendarSearchMatch.jobNumber,
      lifecycleStatus: targetLifecycleStatus,
      dueDate: hasTargetAnchorDate ? targetAnchorDate : ''
    });
    setCalendarTargetNavigationToken((currentToken) => currentToken + 1);
  }, [
    activeCalendarSearchQuery.isFetching,
    activeCalendarSearchQuery.isLoading,
    bestCalendarSearchMatch,
    calendarAnchorDate,
    calendarGranularity,
    completedCalendarSearchQuery.isFetching,
    completedCalendarSearchQuery.isLoading,
    isCalendarView,
    onWorkflowViewChange,
    selectedLifecycleStatus,
    submittedCalendarSearch,
    toast
  ]);

  return {
    calendarJobs,
    calendarLoading: jobsCalendarQuery.isLoading && !hasDisplayedCalendarSnapshot,
    calendarError: !hasDisplayedCalendarSnapshot ? jobsCalendarQuery.error : null,
    calendarNavigationStatus,
    calendarTargetNavigationToken,
    calendarTransitionToken,
    calendarVisibleCount: calendarJobs.length,
    displayedCalendarAnchorDate,
    displayedCalendarGranularity,
    isCalendarSearchPending,
    requestCalendarAnchorDate,
    requestCalendarGranularity,
    submitCalendarSearch,
    clearCalendarSearch,
    visibleCalendarTargetDate,
    visibleCalendarTargetJobNumber
  };
}
