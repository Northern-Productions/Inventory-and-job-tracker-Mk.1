// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerCompanyEntry } from '../../../../domain';
import {
  ownerCompaniesScopedQueryKey,
  useOwnerCompanies,
  type OwnerCompanyQueryScope
} from './ownershipQueries';

const listOwnerCompaniesMock = vi.fn<() => Promise<OwnerCompanyEntry[]>>();

vi.mock('../../../../api/features/ownershipClient', () => ({
  listOwnerCompanies: () => listOwnerCompaniesMock()
}));

function owner(ownerCompanyId: string, code: string): OwnerCompanyEntry {
  return {
    ownerCompanyId,
    code,
    displayName: `${code} Holdings`,
    lookupKey: code.toLowerCase(),
    isActive: true,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
    updatedBy: '',
    deactivatedAt: '',
    deactivatedBy: ''
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false }
    }
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

describe('useOwnerCompanies scoped cache', () => {
  beforeEach(() => listOwnerCompaniesMock.mockReset());
  afterEach(cleanup);

  it('does not reuse the previous organization registry during an auth scope transition', async () => {
    const firstScope: OwnerCompanyQueryScope = { userId: 'user-a', orgId: 'org-a' };
    const secondScope: OwnerCompanyQueryScope = { userId: 'user-b', orgId: 'org-b' };
    const firstRegistry = [owner('owner-alpha', 'ALP')];
    const secondRegistry = [owner('owner-beta', 'BET')];
    let resolveSecond!: (entries: OwnerCompanyEntry[]) => void;
    const secondRequest = new Promise<OwnerCompanyEntry[]>((resolve) => {
      resolveSecond = resolve;
    });
    listOwnerCompaniesMock
      .mockResolvedValueOnce(firstRegistry)
      .mockReturnValueOnce(secondRequest);
    const { queryClient, Wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ scope }) => useOwnerCompanies({ includeInactive: true, scope }),
      { wrapper: Wrapper, initialProps: { scope: firstScope } }
    );

    await waitFor(() => expect(result.current.data).toEqual(firstRegistry));
    rerender({ scope: secondScope });

    expect(result.current.data).toBeUndefined();
    expect(
      queryClient.getQueryData(
        ownerCompaniesScopedQueryKey(firstScope, { includeInactive: true })
      )
    ).toEqual(firstRegistry);
    resolveSecond(secondRegistry);
    await waitFor(() => expect(result.current.data).toEqual(secondRegistry));
    expect(
      queryClient.getQueryData(
        ownerCompaniesScopedQueryKey(secondScope, { includeInactive: true })
      )
    ).toEqual(secondRegistry);
  });

  it('does not request or expose registry rows without a complete explicit scope', () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => useOwnerCompanies({ includeInactive: true, scope: null }),
      { wrapper: Wrapper }
    );

    expect(result.current.data).toBeUndefined();
    expect(listOwnerCompaniesMock).not.toHaveBeenCalled();
  });
});
