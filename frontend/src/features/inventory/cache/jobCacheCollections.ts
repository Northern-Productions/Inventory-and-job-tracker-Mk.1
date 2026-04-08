import type { QueryClient } from '@tanstack/react-query';
import type {
  AllocationJobDetail,
  AllocationJobSummary,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
  UpdateJobPayload
} from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { isUnresolvedFilmOrder } from '../utils/filmOrders';
import { buildAllocationJobSummaryFromJobDetail } from './jobSummaryMath';

function updateCachedJobSummaryCollections(
  queryClient: QueryClient,
  jobNumber: string,
  updater: (entry: JobListEntry) => JobListEntry
) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobs
  });

  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!Array.isArray(current) || !current.some((entry) => entry.jobNumber === jobNumber)) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.map((entry) => (entry.jobNumber === jobNumber ? updater(entry) : entry))
    );
  }
}

export function applyOptimisticJobScheduleSyncToCaches(
  queryClient: QueryClient,
  payload: Pick<UpdateJobPayload, 'jobNumber' | 'dueDate' | 'crewLeader'>
) {
  const normalizedJobNumber = String(payload.jobNumber || '').trim();
  if (!normalizedJobNumber) {
    return;
  }

  const hasDueDateUpdate = payload.dueDate !== undefined;
  const hasCrewLeaderUpdate = payload.crewLeader !== undefined;
  if (!hasDueDateUpdate && !hasCrewLeaderUpdate) {
    return;
  }

  const nextDueDate = hasDueDateUpdate ? String(payload.dueDate || '').trim() : undefined;
  const nextCrewLeader = hasCrewLeaderUpdate ? String(payload.crewLeader || '').trim() : undefined;
  const patchFilmOrder = (entry: FilmOrderEntry): FilmOrderEntry =>
    entry.jobNumber === normalizedJobNumber && isUnresolvedFilmOrder(entry)
      ? {
          ...entry,
          ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        }
      : entry;

  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(normalizedJobNumber));
  if (currentJob) {
    syncJobDetailCaches(
      queryClient,
      {
        ...currentJob,
        summary: {
          ...currentJob.summary,
          ...(nextDueDate !== undefined ? { dueDate: nextDueDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        },
        filmOrders: currentJob.filmOrders.map(patchFilmOrder)
      },
      { syncAllocationJobDetail: true }
    );
  }

  updateCachedJobSummaryCollections(queryClient, normalizedJobNumber, (entry) => ({
    ...entry,
    ...(nextDueDate !== undefined ? { dueDate: nextDueDate } : {}),
    ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
  }));

  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
    current
      ? current.map((entry) =>
          entry.jobNumber === normalizedJobNumber
            ? {
                ...entry,
                ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
                ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
              }
            : entry
        )
      : current
  );

  queryClient.setQueryData<AllocationJobDetail | undefined>(
    inventoryKeys.allocationJob(normalizedJobNumber),
    (current) =>
      current
        ? {
            ...current,
            summary: {
              ...current.summary,
              ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
              ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
            },
            filmOrders: current.filmOrders.map(patchFilmOrder)
          }
        : current
  );

  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current ? current.map(patchFilmOrder) : current
  );
}

function extractLifecycleFilterFromQueryKey(queryKey: readonly unknown[]) {
  const queryParams =
    Array.isArray(queryKey) && queryKey.length > 0
      ? (queryKey[queryKey.length - 1] as { lifecycleStatus?: string } | undefined)
      : undefined;

  return String(queryParams?.lifecycleStatus || '').toUpperCase();
}

export function upsertJobListCaches(queryClient: QueryClient, entry: JobListEntry) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsListRoot
  });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    const lifecycleFilter = extractLifecycleFilterFromQueryKey(queryKey);
    if (lifecycleFilter && lifecycleFilter !== entry.lifecycleStatus) {
      queryClient.setQueryData<JobListEntry[]>(
        queryKey,
        current.filter((job) => job.jobNumber !== entry.jobNumber)
      );
      continue;
    }

    const existingIndex = current.findIndex((job) => job.jobNumber === entry.jobNumber);
    const next =
      existingIndex === -1 ? [entry, ...current] : current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job));
    queryClient.setQueryData<JobListEntry[]>(queryKey, next);
  }
}

export function upsertJobsCalendarCaches(queryClient: QueryClient, entry: JobListEntry) {
  const calendarQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsCalendarRoot
  });

  for (let index = 0; index < calendarQueries.length; index += 1) {
    const [queryKey, current] = calendarQueries[index];
    if (!current) {
      continue;
    }

    const lifecycleFilter = extractLifecycleFilterFromQueryKey(queryKey);
    if (lifecycleFilter && lifecycleFilter !== entry.lifecycleStatus) {
      queryClient.setQueryData<JobListEntry[]>(
        queryKey,
        current.filter((job) => job.jobNumber !== entry.jobNumber)
      );
      continue;
    }

    const hasExistingEntry = current.some((job) => job.jobNumber === entry.jobNumber);
    if (!hasExistingEntry) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job))
    );
  }
}

export function removeJobListCaches(queryClient: QueryClient, jobNumber: string) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsListRoot
  });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobsCalendarCaches(queryClient: QueryClient, jobNumber: string) {
  const calendarQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsCalendarRoot
  });

  for (let index = 0; index < calendarQueries.length; index += 1) {
    const [queryKey, current] = calendarQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobsSearchCaches(queryClient: QueryClient, jobNumber: string) {
  const searchQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsSearch
  });

  for (let index = 0; index < searchQueries.length; index += 1) {
    const [queryKey, current] = searchQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobPlanningCaches(queryClient: QueryClient, jobNumber: string) {
  removeJobListCaches(queryClient, jobNumber);
  removeJobsCalendarCaches(queryClient, jobNumber);
  removeJobsSearchCaches(queryClient, jobNumber);
  removeAllocationJobSummaryCaches(queryClient, jobNumber);
  queryClient.removeQueries({ queryKey: inventoryKeys.job(jobNumber), exact: true });
  queryClient.removeQueries({ queryKey: inventoryKeys.allocationJob(jobNumber), exact: true });
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current ? current.filter((entry) => entry.jobNumber !== jobNumber) : current
  );
}

export function upsertAllocationJobSummaryCaches(queryClient: QueryClient, entry: AllocationJobSummary) {
  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) => {
    if (!current) {
      return current;
    }

    const existingIndex = current.findIndex((job) => job.jobNumber === entry.jobNumber);
    if (existingIndex === -1) {
      return [entry, ...current];
    }

    return current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job));
  });
}

export function removeAllocationJobSummaryCaches(queryClient: QueryClient, jobNumber: string) {
  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
    current ? current.filter((entry) => entry.jobNumber !== jobNumber) : current
  );
}

export function syncJobSummaryCachesFromDetail(
  queryClient: QueryClient,
  detail: JobDetail,
  options: { syncAllocationJobDetail?: boolean } = {}
) {
  const jobNumber = detail.summary.jobNumber;
  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob(jobNumber));
  const nextAllocationSummary = buildAllocationJobSummaryFromJobDetail(detail, currentAllocationJob?.summary);

  upsertJobListCaches(queryClient, detail.summary);
  upsertJobsCalendarCaches(queryClient, detail.summary);
  upsertAllocationJobSummaryCaches(queryClient, nextAllocationSummary);

  if (!options.syncAllocationJobDetail) {
    return;
  }

  queryClient.setQueryData<AllocationJobDetail | undefined>(inventoryKeys.allocationJob(jobNumber), (current) =>
    current
      ? {
          ...current,
          summary: buildAllocationJobSummaryFromJobDetail(detail, current.summary),
          allocations: detail.allocations,
          usage: detail.usage,
          usageTimeline: detail.usageTimeline,
          caulkRequirements: detail.caulkRequirements,
          caulkAllocations: detail.caulkAllocations,
          caulkCheckouts: detail.caulkCheckouts,
          filmOrders: detail.filmOrders,
          filmTransferAlerts: detail.filmTransferAlerts || []
        }
      : current
  );
}

export function syncJobDetailCaches(
  queryClient: QueryClient,
  detail: JobDetail,
  options: { syncAllocationJobDetail?: boolean } = {}
) {
  queryClient.setQueryData<JobDetail>(inventoryKeys.job(detail.summary.jobNumber), detail);
  syncJobSummaryCachesFromDetail(queryClient, detail, options);
}
