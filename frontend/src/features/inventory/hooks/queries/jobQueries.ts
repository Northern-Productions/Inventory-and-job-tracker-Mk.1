import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getJob,
  getJobById,
  getJobs,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  searchJobsByNumber,
  type JobLifecycleFilter,
  type JobsCalendarView
} from '../../../../api/features/jobsClient';
import type { JobDetail, JobListEntry } from '../../../../domain';
import { syncJobSummaryCachesFromDetail } from '../../cache/jobs';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useCachedInventoryReadQuery } from './shared';

export function useJobsList(
  limit = 25,
  options: {
    enabled?: boolean;
    refetchOnWindowFocus?: boolean;
    lifecycleStatus?: JobLifecycleFilter;
    jobNumbers?: string[];
  } = {}
) {
  const normalizedJobNumbers = useMemo(
    () =>
      Array.from(
        new Set(
          (options.jobNumbers || [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        )
      ).sort(),
    [options.jobNumbers]
  );

  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsList({
      limit,
      lifecycleStatus: options.lifecycleStatus,
      jobNumbers: normalizedJobNumbers
    }),
    queryFn: () =>
      getJobs(limit, {
        lifecycleStatus: options.lifecycleStatus,
        jobNumbers: normalizedJobNumbers
      }),
    enabled: options.enabled ?? true,
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false
  });
}

export function useJobSummariesByNumbers(jobNumbers: string[], options: { enabled?: boolean } = {}) {
  const normalizedJobNumbers = useMemo(
    () =>
      Array.from(
        new Set(
          (jobNumbers || [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        )
      ).sort(),
    [jobNumbers]
  );

  return useCachedInventoryReadQuery<JobListEntry[]>({
    queryKey: inventoryKeys.jobsList({
      limit: 0,
      jobNumbers: normalizedJobNumbers
    }),
    queryFn: () =>
      getJobs(0, {
        jobNumbers: normalizedJobNumbers
      }),
    enabled: (options.enabled ?? true) && normalizedJobNumbers.length > 0,
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJobsSearch(
  query: string,
  limit = 25,
  options: { enabled?: boolean; lifecycleStatus?: JobLifecycleFilter } = {}
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsSearchResults({
      query,
      limit,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () => searchJobsByNumber(query, limit, { lifecycleStatus: options.lifecycleStatus }),
    enabled: (options.enabled ?? true) && Boolean(query.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJobsCalendarMonth(
  month: string,
  options: { enabled?: boolean; lifecycleStatus?: JobLifecycleFilter } = {}
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsCalendarMonth({
      month,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () => getJobsCalendarMonth(month, { lifecycleStatus: options.lifecycleStatus }),
    enabled: (options.enabled ?? true) && Boolean(month.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJobsCalendarEntries(
  anchorDate: string,
  options: {
    enabled?: boolean;
    lifecycleStatus?: JobLifecycleFilter;
    view: JobsCalendarView;
  }
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsCalendarPeriod({
      view: options.view,
      anchorDate,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () =>
      getJobsCalendarEntries({
        view: options.view,
        anchorDate,
        lifecycleStatus: options.lifecycleStatus
      }),
    enabled: (options.enabled ?? true) && Boolean(anchorDate.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJob(jobNumber: string) {
  const queryClient = useQueryClient();
  const lastSyncedKeyRef = useRef('');
  const query = useCachedInventoryReadQuery<JobDetail>({
    queryKey: inventoryKeys.job(jobNumber),
    queryFn: () => getJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (!jobNumber || !query.data || query.dataUpdatedAt <= 0) {
      return;
    }

    const syncKey = `${jobNumber}:${query.dataUpdatedAt}`;
    if (lastSyncedKeyRef.current === syncKey) {
      return;
    }

    lastSyncedKeyRef.current = syncKey;
    syncJobSummaryCachesFromDetail(queryClient, query.data, { syncAllocationJobDetail: true });
  }, [jobNumber, query.data, query.dataUpdatedAt, queryClient]);

  return query;
}

export function useJobById(jobId: string) {
  const queryClient = useQueryClient();
  const lastSyncedKeyRef = useRef('');
  const query = useCachedInventoryReadQuery<JobDetail>({
    queryKey: inventoryKeys.jobById(jobId),
    queryFn: () => getJobById(jobId),
    enabled: Boolean(jobId),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (!jobId || !query.data || query.dataUpdatedAt <= 0) {
      return;
    }

    const syncKey = `${jobId}:${query.dataUpdatedAt}`;
    if (lastSyncedKeyRef.current === syncKey) {
      return;
    }

    lastSyncedKeyRef.current = syncKey;
    syncJobSummaryCachesFromDetail(queryClient, query.data, { syncAllocationJobDetail: true });
    const loadedJobNumber = String(query.data.summary?.jobNumber || '').trim();
    if (loadedJobNumber) {
      queryClient.setQueryData(inventoryKeys.job(loadedJobNumber), query.data);
    }
  }, [jobId, query.data, query.dataUpdatedAt, queryClient]);

  return query;
}
