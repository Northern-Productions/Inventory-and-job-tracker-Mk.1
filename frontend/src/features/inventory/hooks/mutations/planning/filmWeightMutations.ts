import { useMutation, useQueryClient } from '@tanstack/react-query';
import { resolveFilmWeightPendingReview } from '../../../../../api/features/filmWeightClient';
import type { ResolveFilmWeightPendingReviewPayload } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';

export function useResolveFilmWeightPendingReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: ResolveFilmWeightPendingReviewPayload) =>
      resolveFilmWeightPendingReview(payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmWeightProfiles }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmWeightPendingReviews }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.appAttentionSummary })
      ]);
    }
  });
}
