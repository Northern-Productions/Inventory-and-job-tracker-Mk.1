import type { QueryClient } from '@tanstack/react-query';
import type { OptimisticOperationController } from '../../../components/OptimisticQueue';
import type { Box } from '../../../domain';

export interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

export interface MutationOptimisticContext {
  operation?: OptimisticOperationController;
  snapshots: QuerySnapshot[];
  deletedBox?: Box;
  pendingFilmOrderId?: string;
  pendingCaulkAllocationId?: string;
  optimisticAllocationJobNumber?: string;
  optimisticAllocationIds?: string[];
}

export function captureSnapshots(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient
    .getQueriesData({ queryKey })
    .map(([key, data]) => ({ queryKey: key, data }));
}

export function restoreSnapshots(
  queryClient: QueryClient,
  snapshots: QuerySnapshot[] | undefined
) {
  if (!snapshots) {
    return;
  }

  for (let index = 0; index < snapshots.length; index += 1) {
    queryClient.setQueryData(snapshots[index].queryKey, snapshots[index].data);
  }
}

export function beginDelayedOptimisticMutation(
  queryClient: QueryClient,
  _optimisticQueue: { begin: (label: string, apply: () => void) => OptimisticOperationController },
  _label: string,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}

export function beginImmediateOptimisticMutation(
  queryClient: QueryClient,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}
