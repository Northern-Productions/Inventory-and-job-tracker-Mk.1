import type { QueryClient } from '@tanstack/react-query';
import type { CaulkProductEntry, FilmOrderEntry, JobDetail, UpdateJobPayload } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { isUnresolvedFilmOrder } from '../utils/filmOrders';
import { syncJobDetailCaches } from './jobCacheCollections';
import { createOptimisticJobDetailAfterJobUpdate } from './jobRequirementCoverage';

function patchUnresolvedFilmOrderSchedules(
  current: FilmOrderEntry[] | undefined,
  payload: Pick<UpdateJobPayload, 'jobNumber' | 'installDate' | 'crewLeader'>
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
    entry.jobNumber === payload.jobNumber && isUnresolvedFilmOrder(entry)
      ? {
          ...entry,
          ...(nextInstallDate !== undefined ? { installDate: nextInstallDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        }
      : entry
  );
}

export function applyOptimisticJobUpdateToCaches(queryClient: QueryClient, payload: UpdateJobPayload) {
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber));
  if (!currentJob) {
    queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
      patchUnresolvedFilmOrderSchedules(current, payload)
    );
    return;
  }

  const caulkProducts =
    queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || [];
  const nextJob = createOptimisticJobDetailAfterJobUpdate(currentJob, payload, caulkProducts);

  syncJobDetailCaches(queryClient, nextJob, { syncAllocationJobDetail: true });
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    patchUnresolvedFilmOrderSchedules(current, payload)
  );
}
