// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobCaulkRequirementLine, JobDetail, JobRequirementLine } from '../../../../domain';
import { useAllocationJobPageModel } from './useAllocationJobPageModel';

const useParamsMock = vi.fn();
const useJobMock = vi.fn();
const useJobByIdMock = vi.fn();
const clearSuppressionMutateAsyncMock = vi.fn();
const createFilmOrderMutateAsyncMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => useParamsMock()
}));

vi.mock('../../../../components/Toast', () => ({
  useToast: () => ({ push: vi.fn() })
}));

vi.mock('../../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({
    clientIdConfigured: true,
    isAuthenticated: true,
    isOwner: true,
    isAdmin: true,
    hasFeatureAccess: () => true
  })
}));

vi.mock('../../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
    ]
  })
}));

function buildMutationState(overrides: Record<string, unknown> = {}) {
  return {
    mutateAsync: vi.fn().mockResolvedValue({ warnings: [] }),
    isPending: false,
    ...overrides
  };
}

vi.mock('../../hooks/useInventoryQueries', () => ({
  useAddCaulkJobAllocation: () => buildMutationState(),
  useCancelCaulkTransfer: () => buildMutationState(),
  useCheckinCaulkJobAllocation: () => buildMutationState(),
  useClearAllocationPlannerSuppression: () =>
    buildMutationState({ mutateAsync: clearSuppressionMutateAsyncMock }),
  useCheckoutAllJobMaterials: () => buildMutationState(),
  useCheckoutCaulkJobAllocation: () => buildMutationState(),
  useCaulkProducts: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useCompleteJob: () => buildMutationState(),
  useCreateFilmOrder: () =>
    buildMutationState({ mutateAsync: createFilmOrderMutateAsyncMock }),
  useDeleteJob: () => buildMutationState(),
  useDeleteFilmOrder: () => buildMutationState(),
  useFilmCatalog: () => ({ data: [], isLoading: false, error: null }),
  useJob: (...args: unknown[]) => useJobMock(...args),
  useJobById: (...args: unknown[]) => useJobByIdMock(...args),
  usePendingCancelCaulkTransferIds: () => new Set(),
  usePendingAddCaulkAllocationJobNumbers: () => new Set(),
  usePendingCheckinCaulkCheckoutIds: () => new Set(),
  usePendingCheckoutCaulkAllocationIds: () => new Set(),
  usePendingDeleteFilmOrderIds: () => new Set(),
  usePendingReceiveCaulkTransferIds: () => new Set(),
  usePendingRemoveCaulkAllocationIds: () => new Set(),
  usePendingRemoveJobBoxAllocationIds: () => new Set(),
  usePendingSetBoxStatusBoxIds: () => new Set(),
  usePendingUpdateCaulkAllocationIds: () => new Set(),
  useReceiveCaulkTransfer: () => buildMutationState(),
  useRemoveCaulkJobAllocation: () => buildMutationState(),
  useRemoveJobBoxAllocations: () => buildMutationState(),
  useReopenJob: () => buildMutationState(),
  useSetBoxStatus: () => buildMutationState(),
  useSetJobRequirementState: () => buildMutationState(),
  useSetJobStagedForPickup: () => buildMutationState(),
  useUpdateCaulkJobAllocation: () => buildMutationState(),
  useUpdateJob: () => buildMutationState(),
  useBox: () => ({ data: null, isLoading: false, isError: false, error: null })
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function buildFilmRequirement(
  overrides: Partial<JobRequirementLine> = {}
): JobRequirementLine {
  return {
    requirementId: 'req-film-1',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    requiredFeet: 100,
    allocatedFeet: 0,
    remainingFeet: 100,
    autoPlanningSuppressed: true,
    ...overrides
  };
}

function buildCaulkRequirement(
  overrides: Partial<JobCaulkRequirementLine> = {}
): JobCaulkRequirementLine {
  return {
    requirementId: 'req-caulk-1',
    jobNumber: '000123',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: 'Dow',
    productName: '790 Black',
    productCode: '790-BLK',
    tubesPerCase: 12,
    requiredTubes: 12,
    allocatedTubes: 0,
    remainingTubes: 12,
    autoPlanningSuppressed: true,
    notes: '',
    updatedAt: '',
    ...overrides
  };
}

function buildDetail(): JobDetail {
  return {
    summary: {
      jobId: JOB_ID,
      jobNumber: '000123',
      routeTarget: `/allocations/jobs/${JOB_ID}`,
      warehouse: 'IL1',
      sections: 'Section 1',
      workScope: 'Section 1',
      installDate: '2026-05-01',
      crewLeader: 'Crew A',
      status: 'FILM_ORDER',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 100,
      allocatedFeet: 0,
      allocatedWithInstallDateFeet: 0,
      allocatedWithoutInstallDateFeet: 0,
      remainingFeet: 100,
      requiredTubes: 12,
      allocatedTubes: 0,
      remainingTubes: 12,
      requirementCount: 1,
      allocationCount: 0,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '',
      updatedAt: '',
      notes: ''
    },
    requirements: [buildFilmRequirement()],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [buildCaulkRequirement()],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderModel({ canonical = true } = {}) {
  const detail = buildDetail();
  useParamsMock.mockReturnValue(canonical ? { jobId: JOB_ID } : { jobNumber: '000123' });
  useJobMock.mockReturnValue({
    data: canonical ? undefined : detail,
    isLoading: false,
    isError: false,
    error: null
  });
  useJobByIdMock.mockReturnValue({
    data: canonical ? detail : undefined,
    isLoading: false,
    isError: false,
    error: null
  });

  return renderHook(() => useAllocationJobPageModel(), {
    wrapper: createWrapper()
  });
}

describe('useAllocationJobPageModel planner suppression identity', () => {
  beforeEach(() => {
    useParamsMock.mockReset();
    useJobMock.mockReset();
    useJobByIdMock.mockReset();
    clearSuppressionMutateAsyncMock.mockReset();
    clearSuppressionMutateAsyncMock.mockResolvedValue({ warnings: [] });
    createFilmOrderMutateAsyncMock.mockReset();
    createFilmOrderMutateAsyncMock.mockResolvedValue({ warnings: [] });
  });

  it('canonical film resume sends jobId, jobNumber, requirementId, and materialType', async () => {
    const { result } = renderModel({ canonical: true });

    await act(async () => {
      await result.current.handleResumeAutoPlanning(buildFilmRequirement());
    });

    expect(clearSuppressionMutateAsyncMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '000123',
      requirementId: 'req-film-1',
      materialType: 'FILM',
      reason: 'User resumed auto-planning from job detail page.'
    });
  });

  it('canonical caulk resume sends jobId, jobNumber, requirementId, and materialType', async () => {
    const { result } = renderModel({ canonical: true });

    await act(async () => {
      await result.current.handleResumeCaulkAutoPlanning(buildCaulkRequirement());
    });

    expect(clearSuppressionMutateAsyncMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '000123',
      requirementId: 'req-caulk-1',
      materialType: 'CAULK',
      reason: 'User resumed caulk auto-planning from job detail page.'
    });
  });

  it('legacy resume keeps jobNumber-only suppression clear payload', async () => {
    const { result } = renderModel({ canonical: false });

    await act(async () => {
      await result.current.handleResumeAutoPlanning(buildFilmRequirement());
    });

    expect(clearSuppressionMutateAsyncMock).toHaveBeenCalledWith({
      jobNumber: '000123',
      requirementId: 'req-film-1',
      materialType: 'FILM',
      reason: 'User resumed auto-planning from job detail page.'
    });
  });

  it('canonical film order create sends jobId, jobNumber, and requirementId', async () => {
    const { result } = renderModel({ canonical: true });

    await act(async () => {
      await result.current.handleOrderFilmRequirement(buildFilmRequirement());
    });

    expect(createFilmOrderMutateAsyncMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '000123',
      requirementId: 'req-film-1',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 100
    });
  });

  it('legacy film order create keeps jobNumber-only payload', async () => {
    const { result } = renderModel({ canonical: false });

    await act(async () => {
      await result.current.handleOrderFilmRequirement(buildFilmRequirement());
    });

    expect(createFilmOrderMutateAsyncMock).toHaveBeenCalledWith({
      jobNumber: '000123',
      requirementId: 'req-film-1',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 100
    });
    expect(createFilmOrderMutateAsyncMock.mock.calls[0][0]).not.toHaveProperty('jobId');
  });
});
