import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobDetail } from '../../../domain';
import AllocationJobPage from './AllocationJobPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useJobMock = vi.fn();
const useJobByIdMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useCaulkProductsMock = vi.fn();
const useJobLifecycleWorkflowMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    pathname: '/allocations/000123',
    search: '',
    hash: '',
    state: null,
    key: 'job-detail-test'
  }),
  useNavigate: () => navigateMock,
  useParams: () => ({ jobNumber: '000123' }),
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

vi.mock('../hooks/useActionAccess', () => ({
  useActionAccess: () => () => true
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }]
  })
}));

vi.mock('./allocation-job/useJobLifecycleWorkflow', () => ({
  useJobLifecycleWorkflow: (...args: unknown[]) => useJobLifecycleWorkflowMock(...args)
}));

vi.mock('./allocation-job/useJobFilmWorkflow', () => ({
  useJobFilmWorkflow: () => ({
    allocationToRemove: null,
    setAllocationToRemove: vi.fn(),
    filmCheckinEntry: null,
    filmCheckinDraftOverride: null,
    filmCheckinBox: null,
    filmCheckinBoxLoading: false,
    filmCheckinBoxError: '',
    setFilmCheckinEntry: vi.fn(),
    isBoxStatusPending: vi.fn(() => false),
    isAllocateOpen: false,
    openAllocateDialog: vi.fn(),
    closeAllocateDialog: vi.fn(),
    openFilmCheckinDialog: vi.fn(),
    handleCheckoutAllocation: vi.fn(),
    handleRemoveAllocation: vi.fn(),
    handleFilmCheckinConfirm: vi.fn(),
    isAllocationRemovalPending: vi.fn(() => false)
  })
}));

vi.mock('./allocation-job/useCaulkWorkflow', () => ({
  useCaulkWorkflow: () => ({
    caulkAllocationToRemove: null,
    setCaulkAllocationToRemove: vi.fn(),
    caulkAllocationEditor: null,
    setCaulkAllocationEditor: vi.fn(),
    caulkAllocationEditorError: '',
    setCaulkAllocationEditorError: vi.fn(),
    caulkCheckoutDraft: null,
    setCaulkCheckoutDraft: vi.fn(),
    caulkCheckoutError: '',
    setCaulkCheckoutError: vi.fn(),
    caulkCheckinDraft: null,
    setCaulkCheckinDraft: vi.fn(),
    caulkCheckinError: '',
    setCaulkCheckinError: vi.fn(),
    warehouseOptions: [],
    pendingCaulkMutation: false,
    isCaulkAllocationPending: vi.fn(() => false),
    isCaulkCheckoutPending: vi.fn(() => false),
    openAddCaulkAllocationDialog: vi.fn(),
    openEditCaulkAllocationDialog: vi.fn(),
    handleSubmitCaulkAllocationDialog: vi.fn(),
    openCaulkCheckoutDialog: vi.fn(),
    handleSubmitCaulkCheckoutDialog: vi.fn(),
    openCaulkCheckinDialog: vi.fn(),
    handleSubmitCaulkCheckinDialog: vi.fn(),
    handleRemoveCaulkAllocation: vi.fn()
  })
}));

function buildMutationState() {
  return {
    mutateAsync: vi.fn(),
    isPending: false
  };
}

const baseDetail: JobDetail = {
  summary: {
    jobNumber: '000123',
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-03-20',
    crewLeader: 'Crew',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    notes: ''
  },
  requirements: [],
  allocations: [],
  usage: [],
  usageTimeline: [],
  caulkRequirements: [],
  caulkAllocations: [],
  caulkCheckouts: [],
  filmOrders: []
};

vi.mock('../hooks/useInventoryQueries', () => ({
  useJob: () => useJobMock(),
  useJobById: () => useJobByIdMock(),
  useAllocationPreview: () => ({
    data: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null
  }),
  useSearchBoxesWithOptions: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null
  }),
  useUpdateJob: () => buildMutationState(),
  useAddCaulkJobAllocation: () => buildMutationState(),
  useUpdateCaulkJobAllocation: () => buildMutationState(),
  useCheckoutCaulkJobAllocation: () => buildMutationState(),
  useCheckoutAllJobMaterials: () => buildMutationState(),
  useCheckinCaulkJobAllocation: () => buildMutationState(),
  useRemoveCaulkJobAllocation: () => buildMutationState(),
  useReceiveCaulkTransfer: () => buildMutationState(),
  useCancelCaulkTransfer: () => buildMutationState(),
  useStartBoxTransfer: () => buildMutationState(),
  useCancelBoxTransfer: () => buildMutationState(),
  useCompleteJob: () => buildMutationState(),
  useDeleteJob: () => buildMutationState(),
  useReopenJob: () => buildMutationState(),
  useDeleteFilmOrder: () => buildMutationState(),
  usePendingDeleteFilmOrderIds: () => new Set(),
  usePendingReceiveCaulkTransferIds: () => new Set(),
  usePendingCancelCaulkTransferIds: () => new Set(),
  usePendingRemoveJobBoxAllocationIds: () => new Set(),
  useRemoveJobBoxAllocations: () => buildMutationState(),
  useClearAllocationPlannerSuppression: () => buildMutationState(),
  useSetBoxStatus: () => buildMutationState(),
  useSetJobRequirementState: () => buildMutationState(),
  useSetJobPhaseState: () => buildMutationState(),
  useSetJobStagedForPickup: () => buildMutationState(),
  useBox: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null
  }),
  useAllocateBox: () => buildMutationState(),
  useCreateFilmOrder: () => buildMutationState(),
  useFilmCatalog: (...args: unknown[]) => useFilmCatalogMock(...args),
  useCaulkProducts: (...args: unknown[]) => useCaulkProductsMock(...args)
}));

describe('AllocationJobPage loading', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      isOwner: true,
      isAdmin: false,
      hasFeatureAccess: () => true
    });
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseDetail,
      error: null
    });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
      error: null
    });
    useFilmCatalogMock.mockReset();
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useCaulkProductsMock.mockReset();
    useCaulkProductsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
  });

  it('keeps the film catalog query disabled on initial mount', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity
        }
      }
    });
    useJobLifecycleWorkflowMock.mockReturnValue({
      isEditOpen: false,
      setIsEditOpen: vi.fn(),
      editDraftOverride: null,
      pendingLaborOnlyUpdate: null,
      setPendingLaborOnlyUpdate: vi.fn(),
      isCompleteConfirmOpen: false,
      setIsCompleteConfirmOpen: vi.fn(),
      isReturnCompletePromptOpen: false,
      setIsReturnCompletePromptOpen: vi.fn(),
      isDeleteJobConfirmOpen: false,
      setIsDeleteJobConfirmOpen: vi.fn(),
      isReopenConfirmOpen: false,
      setIsReopenConfirmOpen: vi.fn(),
      filmOrderToDelete: null,
      setFilmOrderToDelete: vi.fn(),
      maybeOpenReturnCompletionPrompt: vi.fn(),
      submitUpdateJob: vi.fn(),
      handleUpdateJob: vi.fn(),
      handleCompleteJob: vi.fn(),
      handleDeleteJob: vi.fn(),
      handleCheckoutAllMaterials: vi.fn(),
      handleReopenJob: vi.fn(),
      handleDeleteFilmOrder: vi.fn(),
      handleSetStagedPickup: vi.fn()
    });

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AllocationJobPage />
      </QueryClientProvider>
    );

    expect(useFilmCatalogMock).toHaveBeenLastCalledWith({ enabled: false });
    queryClient.clear();
  });

  it('enables the film catalog query when the edit dialog is open', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity
        }
      }
    });
    useJobLifecycleWorkflowMock.mockReturnValue({
      isEditOpen: true,
      setIsEditOpen: vi.fn(),
      editDraftOverride: null,
      pendingLaborOnlyUpdate: null,
      setPendingLaborOnlyUpdate: vi.fn(),
      isCompleteConfirmOpen: false,
      setIsCompleteConfirmOpen: vi.fn(),
      isReturnCompletePromptOpen: false,
      setIsReturnCompletePromptOpen: vi.fn(),
      isDeleteJobConfirmOpen: false,
      setIsDeleteJobConfirmOpen: vi.fn(),
      isReopenConfirmOpen: false,
      setIsReopenConfirmOpen: vi.fn(),
      filmOrderToDelete: null,
      setFilmOrderToDelete: vi.fn(),
      maybeOpenReturnCompletionPrompt: vi.fn(),
      submitUpdateJob: vi.fn(),
      handleUpdateJob: vi.fn(),
      handleCompleteJob: vi.fn(),
      handleDeleteJob: vi.fn(),
      handleCheckoutAllMaterials: vi.fn(),
      handleReopenJob: vi.fn(),
      handleDeleteFilmOrder: vi.fn(),
      handleSetStagedPickup: vi.fn()
    });

    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AllocationJobPage />
      </QueryClientProvider>
    );

    expect(useFilmCatalogMock).toHaveBeenLastCalledWith({ enabled: true });
    queryClient.clear();
  });
});
