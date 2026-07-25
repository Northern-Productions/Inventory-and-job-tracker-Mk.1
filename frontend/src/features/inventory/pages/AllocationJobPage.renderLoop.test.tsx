// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '../../../domain';
import AllocationJobPage from './AllocationJobPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useJobMock = vi.fn();
const useJobByIdMock = vi.fn();
const useUpdateJobMock = vi.fn();
const useAddCaulkJobAllocationMock = vi.fn();
const useUpdateCaulkJobAllocationMock = vi.fn();
const useCheckoutCaulkJobAllocationMock = vi.fn();
const useCheckoutAllJobMaterialsMock = vi.fn();
const useCheckinCaulkJobAllocationMock = vi.fn();
const useRemoveCaulkJobAllocationMock = vi.fn();
const useReceiveCaulkTransferMock = vi.fn();
const useCancelCaulkTransferMock = vi.fn();
const useCompleteJobMock = vi.fn();
const useDeleteJobMock = vi.fn();
const useReopenJobMock = vi.fn();
const useDeleteFilmOrderMock = vi.fn();
const usePendingDeleteFilmOrderIdsMock = vi.fn();
const usePendingRemoveJobBoxAllocationIdsMock = vi.fn();
const usePendingReceiveCaulkTransferIdsMock = vi.fn();
const usePendingCancelCaulkTransferIdsMock = vi.fn();
const useRemoveJobBoxAllocationsMock = vi.fn();
const useClearAllocationPlannerSuppressionMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
const useSetJobRequirementStateMock = vi.fn();
const useSetJobPhaseStateMock = vi.fn();
const useSetJobStagedForPickupMock = vi.fn();
const useBoxMock = vi.fn();
const useAllocateBoxMock = vi.fn();
const useCreateFilmOrderMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useCaulkProductsMock = vi.fn();
const useAllocationPreviewMock = vi.fn();
const useSearchBoxesWithOptionsMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    pathname: '/allocations/9874651321',
    search: '',
    hash: '',
    state: null,
    key: 'job-detail-test'
  }),
  useNavigate: () => navigateMock,
  useParams: () => ({ jobNumber: '9874651321' }),
  useSearchParams: () => [new URLSearchParams()]
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
    ]
  })
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useJob: () => useJobMock(),
  useJobById: () => useJobByIdMock(),
  useUpdateJob: () => useUpdateJobMock(),
  useAddCaulkJobAllocation: () => useAddCaulkJobAllocationMock(),
  useUpdateCaulkJobAllocation: () => useUpdateCaulkJobAllocationMock(),
  useCheckoutCaulkJobAllocation: () => useCheckoutCaulkJobAllocationMock(),
  useCheckoutAllJobMaterials: () => useCheckoutAllJobMaterialsMock(),
  useCheckinCaulkJobAllocation: () => useCheckinCaulkJobAllocationMock(),
  useRemoveCaulkJobAllocation: () => useRemoveCaulkJobAllocationMock(),
  useReceiveCaulkTransfer: () => useReceiveCaulkTransferMock(),
  useCancelCaulkTransfer: () => useCancelCaulkTransferMock(),
  useStartBoxTransfer: () => buildMutationState(),
  useCancelBoxTransfer: () => buildMutationState(),
  useCompleteJob: () => useCompleteJobMock(),
  useDeleteJob: () => useDeleteJobMock(),
  useReopenJob: () => useReopenJobMock(),
  useDeleteFilmOrder: () => useDeleteFilmOrderMock(),
  usePendingDeleteFilmOrderIds: () => usePendingDeleteFilmOrderIdsMock(),
  usePendingAddCaulkAllocationJobNumbers: () => new Set<string>(),
  usePendingCheckinCaulkCheckoutIds: () => new Set<string>(),
  usePendingCheckoutCaulkAllocationIds: () => new Set<string>(),
  usePendingRemoveCaulkAllocationIds: () => new Set<string>(),
  usePendingRemoveJobBoxAllocationIds: () => usePendingRemoveJobBoxAllocationIdsMock(),
  usePendingReceiveCaulkTransferIds: () => usePendingReceiveCaulkTransferIdsMock(),
  usePendingCancelCaulkTransferIds: () => usePendingCancelCaulkTransferIdsMock(),
  usePendingSetBoxStatusBoxIds: () => new Set<string>(),
  usePendingUpdateCaulkAllocationIds: () => new Set<string>(),
  useRemoveJobBoxAllocations: () => useRemoveJobBoxAllocationsMock(),
  useClearAllocationPlannerSuppression: () => useClearAllocationPlannerSuppressionMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
  useSetJobRequirementState: () => useSetJobRequirementStateMock(),
  useSetJobPhaseState: () => useSetJobPhaseStateMock(),
  useSetJobStagedForPickup: () => useSetJobStagedForPickupMock(),
  useBox: () => useBoxMock(),
  useAllocateBox: () => useAllocateBoxMock(),
  useCreateFilmOrder: () => useCreateFilmOrderMock(),
  useFilmCatalog: (...args: unknown[]) => useFilmCatalogMock(...args),
  useCaulkProducts: (...args: unknown[]) => useCaulkProductsMock(...args),
  useAllocationPreview: (...args: unknown[]) => useAllocationPreviewMock(...args),
  useSearchBoxesWithOptions: (...args: unknown[]) => useSearchBoxesWithOptionsMock(...args)
}));

function buildMutationState(overrides: Record<string, unknown> = {}) {
  return {
    mutateAsync: vi.fn(),
    isPending: false,
    ...overrides
  };
}

function buildJobDetail(): JobDetail {
  return {
    summary: {
      jobNumber: '9874651321',
      warehouse: 'IL1',
      sections: 'A',
      installDate: '2026-04-26',
      crewLeader: 'Crew',
      status: 'READY',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 20,
      allocatedFeet: 20,
      remainingFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 1,
      allocationCount: 1,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '2026-04-26T00:00:00Z',
      updatedAt: '2026-04-26T00:00:00Z',
      notes: ''
    },
    requirements: [
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requiredFeet: 20,
        allocatedFeet: 20,
        remainingFeet: 0
      }
    ],
    allocations: [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        warehouse: 'IL1',
        jobNumber: '9874651321',
        installDate: '2026-04-26',
        crewLeader: 'Crew',
        allocatedFeet: 20,
        coveredFeet: 20,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocationSource: 'MANUAL',
        createdAt: '2026-04-26T00:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      },
      mutations: {
        retry: false
      }
    }
  });
}

function renderPage() {
  const queryClient = createQueryClient();
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AllocationJobPage />
    </QueryClientProvider>
  );

  return {
    queryClient,
    ...rendered
  };
}

function expectNoMaximumDepthError(consoleErrorSpy: ReturnType<typeof vi.spyOn>) {
  expect(
    consoleErrorSpy.mock.calls.some((call) =>
      call.some((entry) => String(entry).includes('Maximum update depth exceeded'))
    )
  ).toBe(false);
}

describe('AllocationJobPage render loop regressions', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      isOwner: true,
      isAdmin: false,
      isApproved: true,
      accessContext: {
        accessStatus: 'approved',
        role: 'owner',
        permissions: {}
      },
      hasFeatureAccess: () => true
    });
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildJobDetail(),
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: buildJobDetail() })
    });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
      error: null,
      refetch: vi.fn()
    });
    useUpdateJobMock.mockReturnValue(buildMutationState());
    useAddCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useUpdateCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCheckoutCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCheckoutAllJobMaterialsMock.mockReturnValue(buildMutationState());
    useCheckinCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useRemoveCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useReceiveCaulkTransferMock.mockReturnValue(buildMutationState());
    useCancelCaulkTransferMock.mockReturnValue(buildMutationState());
    useCompleteJobMock.mockReturnValue(buildMutationState());
    useDeleteJobMock.mockReturnValue(buildMutationState());
    useReopenJobMock.mockReturnValue(buildMutationState());
    useDeleteFilmOrderMock.mockReturnValue(buildMutationState());
    usePendingDeleteFilmOrderIdsMock.mockReturnValue(new Set<string>());
    usePendingRemoveJobBoxAllocationIdsMock.mockReturnValue(new Set<string>());
    usePendingReceiveCaulkTransferIdsMock.mockReturnValue(new Set<string>());
    usePendingCancelCaulkTransferIdsMock.mockReturnValue(new Set<string>());
    useRemoveJobBoxAllocationsMock.mockReturnValue(buildMutationState());
    useClearAllocationPlannerSuppressionMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
    useSetJobRequirementStateMock.mockReturnValue(buildMutationState());
    useSetJobPhaseStateMock.mockReturnValue(buildMutationState());
    useSetJobStagedForPickupMock.mockReturnValue(buildMutationState());
    useBoxMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null
    });
    useAllocateBoxMock.mockReturnValue(buildMutationState());
    useCreateFilmOrderMock.mockReturnValue(buildMutationState());
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
    useCaulkProductsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
    useAllocationPreviewMock.mockReturnValue({
      data: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null
    });
    useSearchBoxesWithOptionsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the job lookup error visible without entering a render loop', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: new Error('Job 9874651321 was not found.'),
      refetch: vi.fn()
    });

    const { queryClient } = renderPage();

    expect(screen.getByText('Job 9874651321 was not found.')).toBeTruthy();
    expectNoMaximumDepthError(consoleErrorSpy);
    queryClient.clear();
  });

  it('surfaces remove-box failures without retrying through a render loop', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const removeJobBoxAllocations = vi
      .fn()
      .mockRejectedValue(new Error('Allocation has already changed.'));
    useRemoveJobBoxAllocationsMock.mockReturnValue(
      buildMutationState({ mutateAsync: removeJobBoxAllocations })
    );

    const { queryClient } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Box Allocation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(removeJobBoxAllocations).toHaveBeenCalledTimes(1);
      expect(toastPushMock).toHaveBeenCalledWith({
        title: 'Unable to remove allocation',
        description: 'Allocation has already changed.',
        variant: 'error'
      });
    });
    expectNoMaximumDepthError(consoleErrorSpy);
    queryClient.clear();
  });
});
