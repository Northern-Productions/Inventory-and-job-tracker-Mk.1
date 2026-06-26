import { listOwnerCompanies } from '../../../../api/features/ownershipClient';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useCachedInventoryReadQuery } from './shared';

export function useOwnerCompanies(options: { enabled?: boolean; includeInactive?: boolean } = {}) {
  const includeInactive = options.includeInactive === true;
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.ownerCompanies({ includeInactive }),
    queryFn: () => listOwnerCompanies({ includeInactive }),
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}
