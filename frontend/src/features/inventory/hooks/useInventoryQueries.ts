import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue, type OptimisticOperationController } from '../../../components/OptimisticQueue';
import {
  applyAllocationPlan,
  cancelJob,
  createJob,
  deleteFilmOrder,
  createFilmOrder,
  getAllocationJob,
  getAllocationJobs,
  getJob,
  getJobs,
  getAllocationsByBox,
  getFilmCatalog,
  getFilmOrders,
  previewAllocationPlan,
  addBox,
  getAuditByBox,
  getBox,
  getReportsSummary,
  getRollHistoryByBox,
  listAudit,
  searchBoxes,
  syncAllOfflineInventorySnapshots,
  setBoxStatus,
  undoAudit,
  updateJob,
  updateBox
} from '../../../api/client';
import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  AllocateBoxPayload,
  ApplyAllocationPlanPayload,
  AddBoxPayload,
  AuditListParams,
  Box,
  CreateJobPayload,
  CreateFilmOrderPayload,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
  ReportsSummaryFilters,
  SearchBoxesParams,
  SetBoxStatusPayload,
  UndoAuditPayload,
  UpdateJobPayload,
  UpdateBoxPayload
} from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { upsertOfflineInventoryBox } from '../../../lib/offlineInventory';

export const inventoryKeys = {
  root: ['inventory'] as const,
  listRoot: ['inventory', 'list'] as const,
  list: (params: SearchBoxesParams) => ['inventory', 'list', params] as const,
  boxRoot: ['inventory', 'box'] as const,
  box: (boxId: string) => ['inventory', 'box', boxId] as const,
  historyRoot: ['inventory', 'history'] as const,
  history: (boxId: string) => ['inventory', 'history', boxId] as const,
  allocationsRoot: ['inventory', 'allocations'] as const,
  allocations: (boxId: string) => ['inventory', 'allocations', boxId] as const,
  jobs: ['inventory', 'jobs'] as const,
  jobRoot: ['inventory', 'job'] as const,
  job: (jobNumber: string) => ['inventory', 'job', jobNumber] as const,
  allocationJobs: ['inventory', 'allocation-jobs'] as const,
  allocationJobRoot: ['inventory', 'allocation-job'] as const,
  allocationJob: (jobNumber: string) => ['inventory', 'allocation-job', jobNumber] as const,
  allocationPreview: (params: AllocateBoxPayload | null) => ['inventory', 'allocation-preview', params] as const,
  addBoxMutation: ['inventory', 'mutation', 'add-box'] as const,
  filmOrders: ['inventory', 'film-orders'] as const,
  filmCatalog: ['inventory', 'film-catalog'] as const,
  activityRoot: ['inventory', 'activity'] as const,
  activity: (params: AuditListParams) => ['inventory', 'activity', params] as const,
  rollHistory: (boxId: string) => ['inventory', 'roll-history', boxId] as const,
  reportsRoot: ['inventory', 'reports'] as const,
  reports: (filters: ReportsSummaryFilters) => ['inventory', 'reports', filters] as const
};

interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

interface MutationOptimisticContext {
  operation?: OptimisticOperationController;
  snapshots: QuerySnapshot[];
}

function captureSnapshots(queryClient: ReturnType<typeof useQueryClient>, queryKey: readonly unknown[]) {
  return queryClient
    .getQueriesData({ queryKey })
    .map(([key, data]) => ({ queryKey: key, data }));
}

function restoreSnapshots(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshots: QuerySnapshot[] | undefined
) {
  if (!snapshots) {
    return;
  }

  for (let index = 0; index < snapshots.length; index += 1) {
    queryClient.setQueryData(snapshots[index].queryKey, snapshots[index].data);
  }
}

async function refreshOfflineInventoryQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ['inventory', 'offline'] });
}

async function syncOfflineInventorySnapshot(queryClient: ReturnType<typeof useQueryClient>) {
  try {
    await syncAllOfflineInventorySnapshots();
  } catch (_error) {
    // Keep the last good offline snapshot if the refresh fails.
  }

  await refreshOfflineInventoryQueries(queryClient);
}

async function persistOfflineInventoryBox(
  queryClient: ReturnType<typeof useQueryClient>,
  box: Box
) {
  try {
    await upsertOfflineInventoryBox(box);
  } catch (_error) {
    // The online mutation already succeeded. A local cache write failure should not block it.
  }

  await refreshOfflineInventoryQueries(queryClient);
}

function updateBoxCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  boxId: string,
  updater: (box: Box) => Box
) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), (current) =>
    current ? updater(current) : current
  );

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<Box[]>(
      queryKey,
      current.map((box) => (box.boxId === boxId ? updater(box) : box))
    );
  }
}

function beginDelayedOptimisticMutation(
  queryClient: ReturnType<typeof useQueryClient>,
  optimisticQueue: ReturnType<typeof useOptimisticQueue>,
  label: string,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));

  return {
    operation: optimisticQueue.begin(label, apply),
    snapshots
  };
}

function beginImmediateOptimisticMutation(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}

function createOptimisticBoxFromAddPayload(payload: AddBoxPayload): Box {
  const isReceived = Boolean(payload.receivedDate);

  return {
    boxId: payload.boxId,
    warehouse: payload.boxId.startsWith('M') ? 'MS' : 'IL',
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    initialFeet: payload.initialFeet,
    feetAvailable: payload.feetAvailable,
    lotRun: payload.lotRun || '',
    status: isReceived ? 'IN_STOCK' : 'ORDERED',
    orderDate: payload.orderDate,
    receivedDate: payload.receivedDate,
    initialWeightLbs: payload.initialWeightLbs ?? null,
    lastRollWeightLbs: payload.lastRollWeightLbs ?? null,
    lastWeighedDate: payload.lastWeighedDate || '',
    filmKey: payload.filmKey || '',
    coreType: payload.coreType || '',
    coreWeightLbs: payload.coreWeightLbs ?? null,
    lfWeightLbsPerFt: payload.lfWeightLbsPerFt ?? null,
    purchaseCost: payload.purchaseCost ?? null,
    notes: payload.notes || '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

export function useSearchBoxes(params: SearchBoxesParams) {
  return useSearchBoxesWithOptions(params, { enabled: true });
}

export function useSearchBoxesWithOptions(
  params: SearchBoxesParams,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => searchBoxes(params),
    enabled: options.enabled ?? true
  });
}

export function useBox(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.box(boxId),
    queryFn: () => getBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxHistory(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.history(boxId),
    queryFn: () => getAuditByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxAllocations(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.allocations(boxId),
    queryFn: () => getAllocationsByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useJobsList(limit = 25) {
  return useQuery({
    queryKey: [...inventoryKeys.jobs, { limit }],
    queryFn: () => getJobs(limit),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJob(jobNumber: string) {
  return useQuery({
    queryKey: inventoryKeys.job(jobNumber),
    queryFn: () => getJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationJobs() {
  return useQuery({
    queryKey: inventoryKeys.allocationJobs,
    queryFn: () => getAllocationJobs(),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationJob(jobNumber: string) {
  return useQuery({
    queryKey: inventoryKeys.allocationJob(jobNumber),
    queryFn: () => getAllocationJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationPreview(payload: AllocateBoxPayload | null) {
  return useQuery({
    queryKey: inventoryKeys.allocationPreview(payload),
    queryFn: () => previewAllocationPlan(payload as AllocateBoxPayload),
    enabled: Boolean(payload)
  });
}

export function useFilmOrders() {
  return useQuery({
    queryKey: inventoryKeys.filmOrders,
    queryFn: () => getFilmOrders()
  });
}

export function useFilmCatalog() {
  return useQuery({
    queryKey: inventoryKeys.filmCatalog,
    queryFn: () => getFilmCatalog(),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000
  });
}

export function useCreateFilmOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateFilmOrderPayload) => createFilmOrder(payload),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })
      ]);
    }
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateJobPayload) => createJob(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.summary.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
    }
  });
}

export function useUpdateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateJobPayload) => updateJob(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.summary.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
    }
  });
}

export function useAuditList(params: AuditListParams) {
  return useQuery({
    queryKey: inventoryKeys.activity(params),
    queryFn: () => listAudit(params)
  });
}

export function useRollHistory(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.rollHistory(boxId),
    queryFn: () => getRollHistoryByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useReportsSummary(filters: ReportsSummaryFilters) {
  return useQuery({
    queryKey: inventoryKeys.reports(filters),
    queryFn: () => getReportsSummary(filters)
  });
}

export function useIsAddBoxPending(boxId: string) {
  const pendingBoxIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.addBoxMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables = mutation.state.variables as AddBoxPayload | undefined;
      return variables?.boxId || '';
    }
  });
  const normalizedBoxId = boxId.trim().toUpperCase();

  if (!normalizedBoxId) {
    return false;
  }

  return pendingBoxIds.some((pendingBoxId) => pendingBoxId.trim().toUpperCase() === normalizedBoxId);
}

export function useAddBox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.addBoxMutation,
    mutationFn: (payload: AddBoxPayload) => addBox(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) });

      return beginImmediateOptimisticMutation(
        queryClient,
        [inventoryKeys.box(payload.boxId)],
        () => {
          queryClient.setQueryData(inventoryKeys.box(payload.boxId), createOptimisticBoxFromAddPayload(payload));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useAllocateBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: ApplyAllocationPlanPayload) => applyAllocationPlan(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocations(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      const sourceBox = queryClient.getQueryData<Box>(inventoryKeys.box(payload.boxId));
      const sourceAllocatedFeet =
        payload.crossWarehouse === true
          ? 0
          : sourceBox
            ? Math.min(sourceBox.feetAvailable, payload.requestedFeet)
            : payload.requestedFeet;
      const now = new Date().toISOString();
      const optimisticAllocation: AllocationEntry | null =
        sourceAllocatedFeet > 0
          ? {
              allocationId: `pending-${Date.now()}-${payload.boxId}`,
              boxId: payload.boxId,
              warehouse: sourceBox?.warehouse || (payload.boxId.startsWith('M') ? 'MS' : 'IL'),
              jobNumber: payload.jobNumber,
              jobDate: payload.jobDate || '',
              crewLeader: payload.crewLeader || '',
              allocatedFeet: sourceAllocatedFeet,
              status: 'ACTIVE',
              createdAt: now,
              createdBy: 'Pending...',
              resolvedAt: '',
              resolvedBy: '',
              filmOrderId: '',
              notes: 'Pending server confirmation'
            }
          : null;

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Allocating film for ${payload.jobNumber}`,
        [
          inventoryKeys.box(payload.boxId),
          inventoryKeys.listRoot,
          inventoryKeys.allocations(payload.boxId),
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          if (sourceAllocatedFeet > 0) {
            updateBoxCaches(queryClient, payload.boxId, (box) => ({
              ...box,
              feetAvailable: Math.max(box.feetAvailable - sourceAllocatedFeet, 0)
            }));
          }

          if (optimisticAllocation) {
            queryClient.setQueryData<AllocationEntry[] | undefined>(
              inventoryKeys.allocations(payload.boxId),
              (current) => [...(current || []), optimisticAllocation]
            );
          }
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);

      const touchedBoxIds = Array.from(
        new Set(result.allocations.map((entry) => entry.boxId).filter(Boolean))
      );
      await Promise.all(
        touchedBoxIds.flatMap((boxId) => [
          queryClient.invalidateQueries({ queryKey: inventoryKeys.box(boxId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(boxId) })
        ])
      );

      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: { jobNumber: string; reason?: string }) => cancelJob(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Cancelling ${payload.jobNumber}`,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.filmOrders
        ],
        () => {}
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async (_data, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);
      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useDeleteFilmOrder() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: { filmOrderId: string; reason?: string; jobNumber?: string }) =>
      deleteFilmOrder(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Deleting ${payload.filmOrderId}`,
        [
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.filmOrders,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot,
          inventoryKeys.listRoot
        ],
        () => {
          queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
            current ? current.filter((entry) => entry.filmOrderId !== payload.filmOrderId) : current
          );

          const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
          for (let index = 0; index < jobQueries.length; index += 1) {
            const [queryKey, current] = jobQueries[index];
            if (!current) {
              continue;
            }

            const nextFilmOrders = current.filmOrders.filter(
              (entry) => entry.filmOrderId !== payload.filmOrderId
            );
            const removedCount = current.filmOrders.length - nextFilmOrders.length;
            if (!removedCount) {
              continue;
            }

            queryClient.setQueryData<JobDetail>(queryKey, {
              ...current,
              summary: {
                ...current.summary,
                filmOrderCount: Math.max(current.summary.filmOrderCount - removedCount, 0)
              },
              filmOrders: nextFilmOrders
            });
          }

          const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
            queryKey: inventoryKeys.allocationJobRoot
          });
          for (let index = 0; index < allocationJobQueries.length; index += 1) {
            const [queryKey, current] = allocationJobQueries[index];
            if (!current) {
              continue;
            }

            const nextFilmOrders = current.filmOrders.filter(
              (entry) => entry.filmOrderId !== payload.filmOrderId
            );
            const removedCount = current.filmOrders.length - nextFilmOrders.length;
            if (!removedCount) {
              continue;
            }

            queryClient.setQueryData<AllocationJobDetail>(queryKey, {
              ...current,
              summary: {
                ...current.summary,
                openFilmOrderCount: Math.max(current.summary.openFilmOrderCount - removedCount, 0)
              },
              filmOrders: nextFilmOrders
            });
          }

          if (!payload.jobNumber) {
            return;
          }

          const jobsListQueries = queryClient.getQueriesData<JobListEntry[]>({
            queryKey: inventoryKeys.jobs
          });
          for (let index = 0; index < jobsListQueries.length; index += 1) {
            const [queryKey, current] = jobsListQueries[index];
            if (!current) {
              continue;
            }

            queryClient.setQueryData<JobListEntry[]>(
              queryKey,
              current.map((entry) =>
                entry.jobNumber === payload.jobNumber
                  ? { ...entry, filmOrderCount: Math.max(entry.filmOrderCount - 1, 0) }
                  : entry
              )
            );
          }

          queryClient.setQueryData<AllocationJobSummary[] | undefined>(
            inventoryKeys.allocationJobs,
            (current) =>
              current
                ? current.map((entry) =>
                    entry.jobNumber === payload.jobNumber
                      ? { ...entry, openFilmOrderCount: Math.max(entry.openFilmOrderCount - 1, 0) }
                      : entry
                  )
                : current
          );
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async (_data, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);

      if (variables.jobNumber) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
          queryClient.invalidateQueries({
            queryKey: inventoryKeys.allocationJob(variables.jobNumber)
          })
        ]);
      }

      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useUpdateBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: UpdateBoxPayload) => updateBox(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Saving ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot],
        () => {
          updateBoxCaches(queryClient, payload.boxId, (box) => ({
            ...box,
            ...payload,
            status: payload.moveToZeroed ? 'ZEROED' : box.status
          }));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation?.waitForApply();
      if (!variables.moveToZeroed) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
        ]);
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useSetBoxStatus() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: SetBoxStatusPayload) => setBoxStatus(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      const nextDate = todayDateString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `${payload.status === 'CHECKED_OUT' ? 'Checking out' : 'Checking in'} ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot],
        () => {
          updateBoxCaches(queryClient, payload.boxId, (box) => ({
            ...box,
            status:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs === 0 && box.receivedDate
                ? 'ZEROED'
                : payload.status,
            lastRollWeightLbs:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs !== undefined
                ? payload.lastRollWeightLbs
                : box.lastRollWeightLbs,
            lastWeighedDate:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs !== undefined
                ? nextDate
                : box.lastWeighedDate
          }));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useUndoAudit() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: UndoAuditPayload) => undoAudit(payload),
    onMutate: async (payload) =>
      beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Undoing ${payload.logId}`,
        [],
        () => {}
      ),
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.historyRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot })
      ]);

      if (result.box) {
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}
