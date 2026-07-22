import { listOwnerCompanies } from '../../../../api/features/ownershipClient';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useCachedInventoryReadQuery } from './shared';

export interface OwnerCompanyQueryScope {
  userId: string;
  orgId: string;
}

export function ownerCompaniesScopedQueryKey(
  scope: OwnerCompanyQueryScope | null,
  params: { includeInactive?: boolean } = {}
) {
  return [
    ...inventoryKeys.ownerCompanies(params),
    'scope',
    scope?.userId || 'NO_USER',
    scope?.orgId || 'NO_ORG'
  ] as const;
}

export function useOwnerCompanies(
  options: {
    enabled?: boolean;
    includeInactive?: boolean;
    scope?: OwnerCompanyQueryScope | null;
  } = {}
) {
  const includeInactive = options.includeInactive === true;
  const usesExplicitScope = options.scope !== undefined;
  const scope = options.scope || null;
  const scopeReady = Boolean(scope?.userId && scope?.orgId);
  return useCachedInventoryReadQuery({
    queryKey: usesExplicitScope
      ? ownerCompaniesScopedQueryKey(scope, { includeInactive })
      : inventoryKeys.ownerCompanies({ includeInactive }),
    queryFn: () => listOwnerCompanies({ includeInactive }),
    enabled: (options.enabled ?? true) && (!usesExplicitScope || scopeReady),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}
