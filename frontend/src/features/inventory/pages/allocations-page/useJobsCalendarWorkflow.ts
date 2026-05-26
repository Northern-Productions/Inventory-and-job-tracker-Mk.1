import { useEffect, useMemo, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  getJobsCalendarEntries,
  type JobLifecycleFilter
} from '../../../../api/features/jobsClient';
import type { JobListEntry } from '../../../../domain';
import {
  formatCalendarPeriodLabel,
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

type CalendarDisplaySnapshot = {
  anchorDate: string;
  view: 'week' | 'month';
  lifecycleStatus: JobLifecycleFilter;
  warehouse: string;
  jobs: JobListEntry[];
};

interface UseJobsCalendarWorkflowOptions {
  isCalendarView: boolean;
  selectedLifecycleStatus: JobLifecycleFilter;
  selectedWarehouse: string;
  calendarGranularity: 'week' | 'month';
  calendarAnchorDate: string;
  jobsCalendarQuery: JobsCalendarQueryLike;
  queryClient: QueryClient;
  onCalendarAnchorDateChange: (anchorDate: string) => void;
  onCalendarGranularityChange: (granularity: 'week' | 'month') => void;
}

function buildCalendarDisplaySnapshotKey(
  snapshot: Pick<CalendarDisplaySnapshot, 'anchorDate' | 'view' | 'lifecycleStatus' | 'warehouse'>
) {
  return `${snapshot.lifecycleStatus}:${snapshot.warehouse || 'ALL'}:${snapshot.view}:${snapshot.anchorDate}`;
}

export function useJobsCalendarWorkflow({
  isCalendarView,
  selectedLifecycleStatus,
  selectedWarehouse,
  calendarGranularity,
  calendarAnchorDate,
  jobsCalendarQuery,
  queryClient,
  onCalendarAnchorDateChange,
  onCalendarGranularityChange
}: UseJobsCalendarWorkflowOptions) {
  const [calendarTransitionErrorMessage, setCalendarTransitionErrorMessage] = useState('');
  const [calendarTransitionToken, setCalendarTransitionToken] = useState(0);
  const [displayedCalendarSnapshotState, setDisplayedCalendarSnapshotState] =
    useState<CalendarDisplaySnapshot | null>(() =>
      jobsCalendarQuery.isSuccess
        ? {
            anchorDate: calendarAnchorDate,
            view: calendarGranularity,
            lifecycleStatus: selectedLifecycleStatus,
            warehouse: selectedWarehouse,
            jobs: jobsCalendarQuery.data || []
          }
        : null
    );

  const requestedCalendarSnapshot = useMemo(
    () =>
      jobsCalendarQuery.isSuccess && !jobsCalendarQuery.isFetching
        ? {
            anchorDate: calendarAnchorDate,
            view: calendarGranularity,
            lifecycleStatus: selectedLifecycleStatus,
            warehouse: selectedWarehouse,
            jobs: jobsCalendarQuery.data || []
          }
        : null,
    [
      calendarAnchorDate,
      calendarGranularity,
      jobsCalendarQuery.data,
      jobsCalendarQuery.isFetching,
      jobsCalendarQuery.isSuccess,
      selectedLifecycleStatus,
      selectedWarehouse
    ]
  );
  const displayedCalendarSnapshot =
    displayedCalendarSnapshotState &&
    displayedCalendarSnapshotState.lifecycleStatus === selectedLifecycleStatus &&
    displayedCalendarSnapshotState.warehouse === selectedWarehouse
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
    lifecycleStatus: selectedLifecycleStatus,
    warehouse: selectedWarehouse
  });
  const hasDisplayedCalendarSnapshot = Boolean(displayedCalendarSnapshot);
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
  function requestCalendarAnchorDate(nextAnchorDate: string) {
    setCalendarTransitionErrorMessage('');
    onCalendarAnchorDateChange(nextAnchorDate);
  }

  function requestCalendarGranularity(nextGranularity: 'week' | 'month') {
    setCalendarTransitionErrorMessage('');
    onCalendarGranularityChange(nextGranularity);
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
        lifecycleStatus: displayedCalendarSnapshot.lifecycleStatus,
        ...(displayedCalendarSnapshot.warehouse ? { warehouse: displayedCalendarSnapshot.warehouse } : {})
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

  return {
    calendarJobs,
    calendarLoading: jobsCalendarQuery.isLoading && !hasDisplayedCalendarSnapshot,
    calendarError: !hasDisplayedCalendarSnapshot ? jobsCalendarQuery.error : null,
    calendarNavigationStatus,
    calendarTargetNavigationToken: 0,
    calendarTransitionToken,
    calendarVisibleCount: calendarJobs.length,
    displayedCalendarAnchorDate,
    displayedCalendarGranularity,
    requestCalendarAnchorDate,
    requestCalendarGranularity,
    visibleCalendarTargetDate: '',
    visibleCalendarTargetJobNumber: ''
  };
}
