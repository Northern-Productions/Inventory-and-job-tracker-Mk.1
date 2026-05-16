// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReportsPageModel } from './useReportsPageModel';

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}));

vi.mock('../../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

vi.mock('../../../../lib/offlineInventory', () => ({
  searchOfflineBoxes: vi.fn().mockResolvedValue([])
}));

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({
    orgId: 'org-1',
    accessStatus: 'approved',
    role: 'admin',
    permissions: {},
    isAdminConsoleAllowed: false,
    pendingCount: 0,
    receivesInAppNotifications: false,
    isOwner: false
  })
}));

vi.mock('../../hooks/useInventoryQueries', () => ({
  useReportsSummary: () => ({
    data: {
      availableFeetByWidth: [],
      neverCheckedOut: [],
      zeroedByMonth: [],
      zeroedBoxes: [],
      completedJobs: [],
      cancelledJobs: []
    },
    isLoading: false,
    error: null
  }),
  useOwnerAssetTotalCostReport: () => ({
    data: null,
    isLoading: false,
    error: null
  }),
  useFilmCatalog: () => ({
    data: [],
    isLoading: false,
    error: null
  })
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useReportsPageModel', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens report job links with canonical jobId routes when available', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    result.current.openAllocationJob({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953'
    });

    expect(navigateMock).toHaveBeenCalledWith(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111'
    );
  });

  it('keeps legacy report job links when jobId is unavailable', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    result.current.openAllocationJob({
      jobNumber: '4953'
    });

    expect(navigateMock).toHaveBeenCalledWith('/allocations/4953');
  });
});
