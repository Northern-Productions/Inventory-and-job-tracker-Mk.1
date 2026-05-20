import type { QueryClient } from '@tanstack/react-query';
import type { CaulkProductEntry, FilmOrderEntry, JobDetail, UpdateJobPayload } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { isUnresolvedFilmOrder } from '../utils/filmOrders';
import { syncJobDetailCaches } from './jobCacheCollections';
import { createOptimisticJobDetailAfterJobUpdate } from './jobRequirementCoverage';

function matchesFilmOrderScheduleIdentity(
  entry: Pick<FilmOrderEntry, 'jobId' | 'jobNumber'>,
  payload: Pick<UpdateJobPayload, 'jobId' | 'jobNumber'>,
  options: { allowLegacyJobNumberFallback?: boolean } = {}
) {
  const payloadJobId = String(payload.jobId || '').trim();
  const entryJobId = String(entry.jobId || '').trim();
  if (payloadJobId) {
    return entryJobId === payloadJobId || (options.allowLegacyJobNumberFallback === true && !entryJobId);
  }

  const payloadJobNumber = String(payload.jobNumber || '').trim();
  const entryJobNumber = String(entry.jobNumber || '').trim();
  return Boolean(payloadJobNumber && entryJobNumber && payloadJobNumber === entryJobNumber);
}

function patchUnresolvedFilmOrderSchedules(
  current: FilmOrderEntry[] | undefined,
  payload: Pick<UpdateJobPayload, 'jobId' | 'jobNumber' | 'installDate' | 'crewLeader'>,
  options: { allowLegacyJobNumberFallback?: boolean } = {}
) {
  if (!current) {
    return current;
  }

  const nextInstallDate =
    payload.installDate !== undefined ? String(payload.installDate || '').trim() : undefined;
  const nextCrewLeader =
    payload.crewLeader !== undefined ? String(payload.crewLeader || '').trim() : undefined;

  if (nextInstallDate === undefined && nextCrewLeader === undefined) {
    return current;
  }

  return current.map((entry) =>
    matchesFilmOrderScheduleIdentity(entry, payload, options) && isUnresolvedFilmOrder(entry)
      ? {
          ...entry,
          ...(nextInstallDate !== undefined ? { installDate: nextInstallDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        }
      : entry
  );
}

export function applyOptimisticJobUpdateToCaches(queryClient: QueryClient, payload: UpdateJobPayload) {
  const jobId = String(payload.jobId || '').trim();
  const currentJob = queryClient.getQueryData<JobDetail>(
    jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(payload.jobNumber)
  );
  if (!currentJob) {
    // Phase 3A-4a-2 guardrail: film orders still carry jobNumber schedule
    // identity, so this optimistic patch is not duplicate-ready until that
    // workflow moves to jobId in a later slice.
    queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
      patchUnresolvedFilmOrderSchedules(current, payload)
    );
    return;
  }

  const caulkProducts =
    queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || [];
  const nextJob = createOptimisticJobDetailAfterJobUpdate(currentJob, payload, caulkProducts);

  syncJobDetailCaches(queryClient, nextJob, {
    syncAllocationJobDetail: !jobId,
    syncLegacyJobDetail: !jobId
  });
  // Job detail film-order rows are already scoped to the selected job. The
  // global film-order list must stay jobId-strict for canonical duplicate jobs.
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    patchUnresolvedFilmOrderSchedules(current, payload)
  );
}
