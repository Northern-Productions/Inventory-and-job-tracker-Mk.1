import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../../components/OptimisticQueue';
import { undoAudit } from '../../../../api/features/auditClient';
import type { UndoAuditPayload } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  beginDelayedOptimisticMutation,
  restoreSnapshots
} from '../../cache/shared';
import { invalidateGlobalPlanningQueries } from '../inventoryInvalidation';
import {
  persistOfflineInventoryBox,
  syncOfflineInventoryQueries
} from '../useInventoryOfflineSync';

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
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.historyRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot })
      ]);

      if (result.box) {
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}
