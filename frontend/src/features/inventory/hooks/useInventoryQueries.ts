import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue, type OptimisticOperationController } from '../../../components/OptimisticQueue';
import {
  applyAllocationPlan,
  cancelJob,
  createFilmOrder,
  getAllocationJob,
  getAllocationJobs,
  getAllocationsByBox,
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
  CreateFilmOrderPayload,
  ReportsSummaryFilters,
  SearchBoxesParams,
  SetBoxStatusPayload,
  UndoAuditPayload,
  UpdateBoxPayload
} from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { upsertOfflineInventoryBox } from '../../../lib/offlineInventory';

export const inventoryKeys = {
  root: ['inventory'] as const,
  list: (params: SearchBoxesParams) => ['inventory', 'list', params] as const,
  box: (boxId: string) => ['inventory', 'box', boxId] as const,
  history: (boxId: string) => ['inventory', 'history', boxId] as const,
  allocations: (boxId: string) => ['inventory', 'allocations', boxId] as const,
  allocationJobs: ['inventory', 'allocation-jobs'] as const,
  allocationJob: (jobNumber: string) => ['inventory', 'allocation-job', jobNumber] as const,
  allocationPreview: (params: AllocateBoxPayload | null) => ['inventory', 'allocation-preview', params] as const,
  filmOrders: ['inventory', 'film-orders'] as const,
  activity: (params: AuditListParams) => ['inventory', 'activity', params] as const,
  rollHistory: (boxId: string) => ['inventory', 'roll-history', boxId] as const,
  reports: (filters: ReportsSummaryFilters) => ['inventory', 'reports', filters] as const
};

interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

interface MutationOptimisticContext {
  operation: OptimisticOperationController;
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

function compareAllocationJobSummaries(a: AllocationJobSummary, b: AllocationJobSummary) {
  if (a.jobDate && b.jobDate && a.jobDate !== b.jobDate) {
    return a.jobDate < b.jobDate ? -1 : 1;
  }

  if (a.jobDate && !b.jobDate) {
    return -1;
  }

  if (!a.jobDate && b.jobDate) {
    return 1;
  }

  return a.jobNumber < b.jobNumber ? -1 : a.jobNumber > b.jobNumber ? 1 : 0;
}

function updateBoxCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  boxId: string,
  updater: (box: Box) => Box
) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), (current) =>
    current ? updater(current) : current
  );

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: ['inventory', 'list'] });
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

function upsertAllocationJobSummary(
  queryClient: ReturnType<typeof useQueryClient>,
  nextSummary: AllocationJobSummary
) {
  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) => {
    const next = current ? [...current] : [];
    const existingIndex = next.findIndex((entry) => entry.jobNumber === nextSummary.jobNumber);

    if (existingIndex >= 0) {
      next[existingIndex] = nextSummary;
    } else {
      next.push(nextSummary);
    }

    next.sort(compareAllocationJobSummaries);
    return next;
  });
}

function setAllocationJobDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  jobNumber: string,
  updater: (detail: AllocationJobDetail | undefined) => AllocationJobDetail | undefined
) {
  queryClient.setQueryData<AllocationJobDetail | undefined>(inventoryKeys.allocationJob(jobNumber), updater);
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
  return useQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => searchBoxes(params)
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

export function useAllocationJobs() {
  return useQuery({
    queryKey: inventoryKeys.allocationJobs,
    queryFn: () => getAllocationJobs()
  });
}

export function useAllocationJob(jobNumber: string) {
  return useQuery({
    queryKey: inventoryKeys.allocationJob(jobNumber),
    queryFn: () => getAllocationJob(jobNumber),
    enabled: Boolean(jobNumber)
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

export function useAddBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: AddBoxPayload) => addBox(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) });

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Creating ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId)],
        () => {
          queryClient.setQueryData(inventoryKeys.box(payload.boxId), createOptimisticBoxFromAddPayload(payload));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.root }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
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
      const sourceAllocatedFeet = sourceBox
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
          ['inventory', 'list'],
          inventoryKeys.allocations(payload.boxId),
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

          const existingSummary =
            queryClient
              .getQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs)
              ?.find((entry) => entry.jobNumber === payload.jobNumber) || null;
          const nextSummary: AllocationJobSummary = existingSummary
            ? {
                ...existingSummary,
                jobDate: existingSummary.jobDate || payload.jobDate || '',
                crewLeader: existingSummary.crewLeader || payload.crewLeader || '',
                status:
                  existingSummary.status === 'CANCELLED' ? 'READY' : existingSummary.status,
                activeAllocatedFeet: existingSummary.activeAllocatedFeet + sourceAllocatedFeet,
                boxCount: sourceAllocatedFeet > 0 ? existingSummary.boxCount + 1 : existingSummary.boxCount
              }
            : {
                jobNumber: payload.jobNumber,
                jobDate: payload.jobDate || '',
                crewLeader: payload.crewLeader || '',
                status: 'READY',
                activeAllocatedFeet: sourceAllocatedFeet,
                fulfilledAllocatedFeet: 0,
                openFilmOrderCount: 0,
                boxCount: sourceAllocatedFeet > 0 ? 1 : 0
              };
          upsertAllocationJobSummary(queryClient, nextSummary);

          if (!optimisticAllocation || !sourceBox) {
            return;
          }

          setAllocationJobDetail(queryClient, payload.jobNumber, (current) => ({
            summary: current ? { ...current.summary, ...nextSummary } : nextSummary,
            allocations: [
              ...(current?.allocations || []),
              {
                ...optimisticAllocation,
                manufacturer: sourceBox.manufacturer,
                filmName: sourceBox.filmName,
                widthIn: sourceBox.widthIn,
                boxStatus: sourceBox.status
              }
            ],
            filmOrders: current?.filmOrders || []
          }));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.root }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      for (let index = 0; index < result.allocations.length; index += 1) {
        await queryClient.invalidateQueries({
          queryKey: inventoryKeys.allocations(result.allocations[index].boxId)
        });
      }

      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
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
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      const resolvedAt = new Date().toISOString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Cancelling ${payload.jobNumber}`,
        [
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber),
          inventoryKeys.filmOrders
        ],
        () => {
          const currentSummary =
            queryClient
              .getQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs)
              ?.find((entry) => entry.jobNumber === payload.jobNumber) || null;

          if (currentSummary) {
            upsertAllocationJobSummary(queryClient, {
              ...currentSummary,
              status: 'CANCELLED',
              activeAllocatedFeet: 0,
              openFilmOrderCount: 0
            });
          }

          setAllocationJobDetail(queryClient, payload.jobNumber, (current) =>
            current
              ? {
                  summary: {
                    ...current.summary,
                    status: 'CANCELLED',
                    activeAllocatedFeet: 0,
                    openFilmOrderCount: 0
                  },
                  allocations: current.allocations.map((entry) =>
                    entry.status === 'ACTIVE'
                      ? {
                          ...entry,
                          status: 'CANCELLED',
                          resolvedAt,
                          resolvedBy: 'Pending...'
                        }
                      : entry
                  ),
                  filmOrders: current.filmOrders.map((order) =>
                    order.status === 'FILM_ORDER' || order.status === 'FILM_ON_THE_WAY'
                      ? {
                          ...order,
                          status: 'CANCELLED',
                          resolvedAt,
                          resolvedBy: 'Pending...'
                        }
                      : order
                  )
                }
              : current
          );

          queryClient.setQueryData(inventoryKeys.filmOrders, (current: any) =>
            Array.isArray(current)
              ? current.map((order) =>
                  order.jobNumber === payload.jobNumber &&
                  (order.status === 'FILM_ORDER' || order.status === 'FILM_ON_THE_WAY')
                    ? {
                        ...order,
                        status: 'CANCELLED',
                        resolvedAt,
                        resolvedBy: 'Pending...'
                      }
                    : order
                )
              : current
          );
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async (_data, variables, context) => {
      await context?.operation.waitForApply();
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.root });
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs });
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) });
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders });
      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
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
        queryClient.cancelQueries({ queryKey: ['inventory', 'list'] })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Saving ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), ['inventory', 'list']],
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
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation.waitForApply();
      if (!variables.moveToZeroed) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.root }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
        ]);
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'activity'] })
      ]);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
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
        queryClient.cancelQueries({ queryKey: ['inventory', 'list'] })
      ]);

      const nextDate = todayDateString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `${payload.status === 'CHECKED_OUT' ? 'Checking out' : 'Checking in'} ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), ['inventory', 'list']],
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
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.root }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
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
      context?.operation.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.root }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      if (result.box) {
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      void syncOfflineInventorySnapshot(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation.finish();
    }
  });
}
