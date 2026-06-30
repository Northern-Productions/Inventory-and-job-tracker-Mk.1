// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobDetail } from '../../../domain';
import AllocationJobPage from './AllocationJobPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const searchBoxesMock = vi.fn();
const listCaulkStockMock = vi.fn();
const useParamsMock = vi.fn();
const useSearchParamsMock = vi.fn();
const setSearchParamsMock = vi.fn();
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
const useCompleteJobMock = vi.fn();
const useDeleteJobMock = vi.fn();
const useReopenJobMock = vi.fn();
const useDeleteFilmOrderMock = vi.fn();
const usePendingDeleteFilmOrderIdsMock = vi.fn();
const usePendingRemoveJobBoxAllocationIdsMock = vi.fn();
const useRemoveJobBoxAllocationsMock = vi.fn();
const useClearAllocationPlannerSuppressionMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
const useSetJobPhaseStateMock = vi.fn();
const useSetJobStagedForPickupMock = vi.fn();
const useBoxMock = vi.fn();
const useAllocateBoxMock = vi.fn();
const useCreateFilmOrderMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useCaulkProductsMock = vi.fn();
const useAllocationPreviewMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock()
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

vi.mock('../../../api/features/inventoryClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/features/inventoryClient')>();

  return {
    ...actual,
    searchBoxes: (...args: unknown[]) => searchBoxesMock(...args)
  };
});

vi.mock('../../../api/features/caulkClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/features/caulkClient')>();

  return {
    ...actual,
    listCaulkStock: (...args: unknown[]) => listCaulkStockMock(...args)
  };
});

vi.mock('../hooks/useInventoryQueries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useInventoryQueries')>();

  return {
    ...actual,
    useJob: (...args: unknown[]) => useJobMock(...args),
    useJobById: (...args: unknown[]) => useJobByIdMock(...args),
    useAllocationPreview: () => useAllocationPreviewMock(),
    useSearchBoxesWithOptions: () => ({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null
    }),
    useUpdateJob: () => useUpdateJobMock(),
    useAddCaulkJobAllocation: () => useAddCaulkJobAllocationMock(),
    useUpdateCaulkJobAllocation: () => useUpdateCaulkJobAllocationMock(),
    useCheckoutCaulkJobAllocation: () => useCheckoutCaulkJobAllocationMock(),
    useCheckoutAllJobMaterials: () => useCheckoutAllJobMaterialsMock(),
    useCheckinCaulkJobAllocation: () => useCheckinCaulkJobAllocationMock(),
    useRemoveCaulkJobAllocation: () => useRemoveCaulkJobAllocationMock(),
    useCompleteJob: () => useCompleteJobMock(),
    useDeleteJob: () => useDeleteJobMock(),
    useReopenJob: () => useReopenJobMock(),
    useDeleteFilmOrder: () => useDeleteFilmOrderMock(),
    usePendingDeleteFilmOrderIds: () => usePendingDeleteFilmOrderIdsMock(),
    usePendingRemoveJobBoxAllocationIds: () => usePendingRemoveJobBoxAllocationIdsMock(),
    usePendingSetBoxStatusBoxIds: () => new Set(),
    useRemoveJobBoxAllocations: () => useRemoveJobBoxAllocationsMock(),
    useClearAllocationPlannerSuppression: () => useClearAllocationPlannerSuppressionMock(),
    useSetBoxStatus: () => useSetBoxStatusMock(),
    useSetJobPhaseState: () => useSetJobPhaseStateMock(),
    useSetJobStagedForPickup: () => useSetJobStagedForPickupMock(),
    useBox: () => useBoxMock(),
    useAllocateBox: () => useAllocateBoxMock(),
    useCreateFilmOrder: () => useCreateFilmOrderMock(),
    useFilmCatalog: (...args: unknown[]) => useFilmCatalogMock(...args),
    useCaulkProducts: (...args: unknown[]) => useCaulkProductsMock(...args)
  };
});

function buildSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '000123',
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-03-20',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 8,
    allocatedFeet: 8,
    remainingFeet: 0,
    requiredTubes: 12,
    allocatedTubes: 12,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    notes: '',
    ...overrides
  };
}

const baseDetail: JobDetail = {
  summary: buildSummary() as JobDetail['summary'],
  requirements: [],
  allocations: [],
  usage: [],
  usageTimeline: [],
  caulkRequirements: [],
  caulkAllocations: [],
  caulkCheckouts: [],
  filmOrders: []
};

const caulkProducts = [
  {
    productId: 'p1',
    manufacturerId: 'm1',
    manufacturer: 'DOW',
    productName: '790 Black',
    productCode: '790-BLK',
    lookupKey: 'dow-790-black',
    tubesPerCase: 12,
    isActive: true,
    notes: '',
    updatedAt: '2026-03-20T00:00:00Z'
  }
];

function buildMutationState() {
  return {
    mutateAsync: vi.fn(),
    isPending: false
  };
}

function buildMaterialJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    ...baseDetail,
    summary: buildSummary({
      status: 'READY',
      requiredFeet: 8,
      allocatedFeet: 8,
      remainingFeet: 0
    }) as JobDetail['summary'],
    requirements: [
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }
    ],
    allocations: [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        warehouse: 'IL1',
        jobNumber: '000123',
        installDate: '2026-03-20',
        crewLeader: 'Crew',
        allocatedFeet: 8,
        coveredFeet: 8,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocationSource: 'MANUAL' as const,
        createdAt: '2026-03-20T00:00:00Z',
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
    ...overrides
  };
}

function buildCaulkRequirement(
  overrides: Partial<JobDetail['caulkRequirements'][number]> = {}
): JobDetail['caulkRequirements'][number] {
  return {
    requirementId: 'req1',
    jobNumber: '000123',
    productId: 'p1',
    manufacturerId: 'm1',
    manufacturer: 'DOW',
    productName: '790 Black',
    productCode: '790-BLK',
    tubesPerCase: 20,
    requiredTubes: 20,
    allocatedTubes: 20,
    remainingTubes: 0,
    autoPlanningSuppressed: false,
    notes: '',
    updatedAt: '2026-03-20T00:00:00Z',
    ...overrides
  };
}

function buildCaulkAllocation(
  overrides: Partial<JobDetail['caulkAllocations'][number]> = {}
): JobDetail['caulkAllocations'][number] {
  return {
    caulkAllocationId: 'alloc1',
    requirementId: 'req1',
    productId: 'p1',
    manufacturerId: 'm1',
    manufacturer: 'DOW',
    productName: '790 Black',
    productCode: '790-BLK',
    tubesPerCase: 20,
    warehouse: 'IL1',
    allocatedTubes: 20,
    reservedTubesRemaining: 20,
    checkedOutTubesTotal: 0,
    returnedUnusedTubesTotal: 0,
    usedTubesTotal: 0,
    overageTubesTotal: 0,
    outstandingCheckoutTubes: 0,
    openCheckoutCount: 0,
    status: 'ACTIVE',
    allocationSource: 'MANUAL',
    createdAt: '2026-03-20T00:00:00Z',
    createdBy: 'tester',
    updatedAt: '2026-03-20T00:00:00Z',
    updatedBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    ...overrides
  };
}

function buildPhase(
  overrides: Partial<NonNullable<JobDetail['phases']>[number]> = {}
): NonNullable<JobDetail['phases']>[number] {
  return {
    phaseId: 'phase-1',
    phaseNumber: 1,
    workScope: 'Section 1',
    sections: 'Section 1',
    installDate: '2026-03-20',
    crewLeader: 'Crew',
    laborStatus: 'ACTIVE',
    status: 'READY',
    isComplete: false,
    isPrimary: true,
    isNextRelevant: true,
    isExpandedByDefault: true,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    caulkRequirementCount: 0,
    filmOrderCount: 0,
    allocationCount: 0,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    ...overrides
  };
}

function expectOverviewMaterialTotalsHidden(html: string) {
  expect(html).not.toContain('<dt>Required LF</dt>');
  expect(html).not.toContain('<dt>Allocated LF</dt>');
  expect(html).not.toContain('<dt>Remaining LF</dt>');
  expect(html).not.toContain('<dt>Required Tubes</dt>');
  expect(html).not.toContain('<dt>Allocated Tubes</dt>');
  expect(html).not.toContain('<dt>Remaining Tubes</dt>');
}

function expectCaulkRequirementTableTotals(
  html: string,
  requirement: Pick<
    JobDetail['caulkRequirements'][number],
    'allocatedTubes' | 'actualUsedTubes' | 'remainingTubes'
  >
) {
  expect(html).toContain(
    `<td>${requirement.allocatedTubes}</td><td>${requirement.actualUsedTubes ?? 0}</td><td>${requirement.remainingTubes}</td>`
  );
}

function renderPage(detail?: JobDetail) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AllocationJobPage />
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

function renderInteractivePage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  const view = render(
    <QueryClientProvider client={queryClient}>
      <AllocationJobPage />
    </QueryClientProvider>
  );

  return {
    ...view,
    queryClient
  };
}

describe('AllocationJobPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    searchBoxesMock.mockReset();
    listCaulkStockMock.mockReset();
    useParamsMock.mockReset();
    useSearchParamsMock.mockReset();
    setSearchParamsMock.mockReset();
    useJobMock.mockReset();
    useJobByIdMock.mockReset();
    useParamsMock.mockReturnValue({ jobNumber: '000123' });
    useSearchParamsMock.mockReturnValue([new URLSearchParams(), setSearchParamsMock]);
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
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: baseDetail })
    });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: undefined })
    });
    searchBoxesMock.mockResolvedValue([]);
    listCaulkStockMock.mockResolvedValue([]);
    useUpdateJobMock.mockReturnValue(buildMutationState());
    useAddCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useUpdateCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCheckoutCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCheckoutAllJobMaterialsMock.mockReturnValue(buildMutationState());
    useCheckinCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useRemoveCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCompleteJobMock.mockReturnValue(buildMutationState());
    useDeleteJobMock.mockReturnValue(buildMutationState());
    useReopenJobMock.mockReturnValue(buildMutationState());
    useDeleteFilmOrderMock.mockReturnValue(buildMutationState());
    usePendingDeleteFilmOrderIdsMock.mockReturnValue(new Set());
    usePendingRemoveJobBoxAllocationIdsMock.mockReturnValue(new Set());
    useRemoveJobBoxAllocationsMock.mockReturnValue(buildMutationState());
    useClearAllocationPlannerSuppressionMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
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
    useAllocationPreviewMock.mockReturnValue({
      data: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null
    });
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useCaulkProductsMock.mockReturnValue({
      data: caulkProducts,
      isLoading: false,
      isError: false,
      error: null
    });
  });

  it('loads the canonical jobId route without using the jobNumber route parameter', () => {
    useParamsMock.mockReturnValue({ jobId: '11111111-1111-4111-8111-111111111111' });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...baseDetail,
        summary: buildSummary({
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '000123'
        }) as JobDetail['summary']
      },
      error: null
    });

    const html = renderPage();

    expect(useJobMock).toHaveBeenCalledWith('');
    expect(useJobByIdMock).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(html).toContain('IL1-000123');
  });

  it('uses the route phaseId query target to focus the matching phase', async () => {
    vi.useFakeTimers();
    const scrollIntoViewMock = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock
    });
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    useParamsMock.mockReturnValue({ jobId: '11111111-1111-4111-8111-111111111111' });
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams('phaseId=22222222-2222-4222-8222-222222222222')
    ]);
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '000123'
      }) as JobDetail['summary'],
      phases: [
        buildPhase(),
        buildPhase({
          phaseId: '22222222-2222-4222-8222-222222222222',
          phaseNumber: 2,
          workScope: 'Section 7',
          sections: 'Section 7',
          installDate: '2026-06-01',
          isNextRelevant: false,
          isExpandedByDefault: false,
          isPrimary: false
        })
      ]
    };
    useJobByIdMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });

    const view = renderInteractivePage();

    await act(async () => {});
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    const targetPhase = view.container.querySelector(
      '[data-phase-id="22222222-2222-4222-8222-222222222222"]'
    );
    expect(targetPhase?.className).toContain('job-phase-card-targeted');
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByText('Phase 2 — Section 7')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2400);
    });

    view.queryClient.clear();
    view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView
      });
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('replace-navigates a legacy allocation route to the canonical jobId route when unambiguous', async () => {
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...baseDetail,
        summary: buildSummary({
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '000123'
        }) as JobDetail['summary']
      },
      error: null
    });

    const view = renderInteractivePage();

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/allocations/jobs/11111111-1111-4111-8111-111111111111', {
        replace: true
      });
    });
    view.queryClient.clear();
    view.unmount();
  });

  it('renders legacy jobNumber ambiguity choices and opens the selected canonical route', () => {
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: {
        name: 'APIError',
        message: 'Job number 000123 matches multiple jobs.',
        code: 'JOB_NUMBER_AMBIGUOUS',
        jobNumber: '000123',
        candidates: [
          {
            jobId: '11111111-1111-4111-8111-111111111111',
            jobNumber: '000123',
            routeTarget: '/allocations/jobs/11111111-1111-4111-8111-111111111111',
            workScope: 'Lobby',
            warehouse: 'IL1',
            installDate: '2026-05-01',
            crewLeader: 'Crew A',
            lifecycleStatus: 'ACTIVE',
            updatedAt: '2026-05-01T12:00:00Z'
          },
          {
            jobId: '22222222-2222-4222-8222-222222222222',
            jobNumber: '000123',
            routeTarget: '/allocations/jobs/22222222-2222-4222-8222-222222222222',
            workScope: 'Exterior',
            warehouse: 'MS1',
            installDate: '2026-05-02',
            crewLeader: 'Crew B',
            lifecycleStatus: 'COMPLETED',
            updatedAt: '2026-05-02T12:00:00Z'
          }
        ]
      }
    });

    const view = renderInteractivePage();

    expect(screen.getByText('Choose Job 000123')).toBeTruthy();
    expect(screen.getByText(/IL1-000123.*Lobby/)).toBeTruthy();
    expect(screen.getByText(/MS1-000123.*Exterior/)).toBeTruthy();
    expect(screen.getByText('Lobby')).toBeTruthy();
    expect(screen.getByText('Exterior')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]);

    expect(navigateMock).toHaveBeenCalledWith('/allocations/jobs/22222222-2222-4222-8222-222222222222');
    view.queryClient.clear();
    view.unmount();
  });

  it('renders caulk requirement/allocation sections and unified film+caulk usage timeline', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      caulkRequirements: [
        {
          requirementId: 'req1',
          jobNumber: '000123',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          requiredTubes: 30,
          allocatedTubes: 24,
          remainingTubes: 6,
          notes: '',
          updatedAt: '2026-03-20T00:00:00Z'
        }
      ],
      caulkAllocations: [
        {
          caulkAllocationId: 'alloc1',
          requirementId: 'req1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 24,
          reservedTubesRemaining: 12,
          checkedOutTubesTotal: 12,
          returnedUnusedTubesTotal: 2,
          usedTubesTotal: 10,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 4,
          openCheckoutCount: 1,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          updatedAt: '2026-03-20T00:00:00Z',
          updatedBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: ''
        }
      ],
      caulkCheckouts: [
        {
          caulkCheckoutId: 'checkout1',
          caulkAllocationId: 'alloc1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          checkoutTubes: 12,
          overageTubes: 0,
          status: 'OPEN',
          checkedOutAt: '2026-03-20T10:00:00Z',
          checkedOutBy: 'crew',
          checkedInAt: '',
          checkedInBy: '',
          unusedTubes: 0,
          usedTubes: 0,
          notes: ''
        }
      ],
      usageTimeline: [
        {
          usageType: 'FILM_ORDER',
          occurredAt: '2026-03-20T12:00:00Z',
          actor: 'warehouse',
          warehouse: 'IL1',
          referenceId: 'IL1-LINK',
          manufacturer: '3M',
          itemName: 'Ultra 70',
          itemCode: '',
          unit: 'LF',
          checkedOutQuantity: 30,
          returnedQuantity: 0,
          usedQuantity: 0,
          notes: ''
        },
        {
          usageType: 'FILM',
          occurredAt: '2026-03-20T09:00:00Z',
          actor: 'crew',
          warehouse: 'IL1',
          referenceId: 'IL1-ABC',
          manufacturer: '3M',
          itemName: 'Ultra 70',
          itemCode: '',
          unit: 'LF',
          checkedOutQuantity: 500,
          returnedQuantity: 375,
          usedQuantity: 125,
          notes: ''
        },
        {
          usageType: 'CAULK',
          occurredAt: '2026-03-20T11:00:00Z',
          actor: 'crew',
          warehouse: 'IL1',
          referenceId: 'checkout1',
          manufacturer: 'DOW',
          itemName: '790 Black',
          itemCode: '790-BLK',
          unit: 'TUBES',
          checkedOutQuantity: 12,
          returnedQuantity: 2,
          usedQuantity: 10,
          notes: ''
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('<h2>Caulk</h2>');
    expect(html).toContain('Caulk Allocations');
    expect(html).toContain('Job Material History');
    expect(html).toContain('Locked after checkout');
    expect(html).toContain('Film Order');
    expect(html).toContain('FILM');
    expect(html).toContain('CAULK');
    expect(html).toContain('125 LF');
    expect(html).toContain('10 TUBES');
    expect(html).toContain('24 tubes | 2 full cases | 0 loose tubes');
  });

  it('uses requirement-linked caulk coverage for requirement totals when allocation is bound', () => {
    const requirement = buildCaulkRequirement({
      allocatedTubes: 20,
      remainingTubes: 0
    });
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'READY',
        requiredTubes: 20,
        allocatedTubes: 20,
        remainingTubes: 0
      }) as JobDetail['summary'],
      caulkRequirements: [requirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: requirement.requirementId,
          allocatedTubes: 20,
          reservedTubesRemaining: 20
        })
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, requirement);
  });

  it('row-level film Auto Allocate allocates only the selected requirement by jobId and requirementId', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const requirement = {
      requirementId: 'film-req-1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requiredFeet: 80,
      status: 'ACTIVE' as const,
      isComplete: false,
      actualUsedFeet: 0,
      completionResult: '' as const,
      allocatedFeet: 40,
      remainingFeet: 40,
      autoPlanningSuppressed: false
    };
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        jobId,
        status: 'FILM_ORDER',
        requiredFeet: 80,
        allocatedFeet: 40,
        remainingFeet: 40
      }) as JobDetail['summary'],
      requirements: [requirement],
      caulkRequirements: []
    };
    const allocateBoxMutation = {
      mutateAsync: vi.fn().mockResolvedValue({
        result: {
          allocations: [
            {
              boxId: 'IL1-100',
              allocatedFeet: 40,
              coveredFeet: 40
            }
          ],
          filmOrder: null,
          remainingUncoveredFeet: 0
        },
        warnings: []
      }),
      isPending: false
    };
    useParamsMock.mockReturnValue({ jobId });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });
    useAllocateBoxMock.mockReturnValue(allocateBoxMutation);
    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'IL1-100',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        feetAvailable: 100,
        allocatableNowFeet: 100,
        allocationPlanningFeet: 100,
        status: 'IN_STOCK',
        orderDate: '',
        receivedDate: '2026-03-20'
      }
    ]);

    const view = renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));

    await waitFor(() => expect(allocateBoxMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(searchBoxesMock).toHaveBeenCalledWith({
      warehouses: ['IL1'],
      manufacturer: '3M',
      q: 'Night Vision 35',
      showRetired: false
    });
    expect(allocateBoxMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        jobNumber: '000123',
        boxId: 'IL1-100',
        requestedFeet: 40,
        requestedWidthIn: 60,
        requirementId: 'film-req-1',
        crossWarehouse: false,
        jobWarehouse: 'IL1',
        autoAllocate: true
      })
    );
    view.queryClient.clear();
    view.unmount();
  });

  it('row-level film Auto Allocate blocks safely when the job has no warehouse', async () => {
    const requirement = {
      requirementId: 'film-req-1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requiredFeet: 80,
      status: 'ACTIVE' as const,
      isComplete: false,
      actualUsedFeet: 0,
      completionResult: '' as const,
      allocatedFeet: 40,
      remainingFeet: 40,
      autoPlanningSuppressed: false
    };
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        warehouse: '',
        status: 'FILM_ORDER',
        requiredFeet: 80,
        allocatedFeet: 40,
        remainingFeet: 40
      }) as JobDetail['summary'],
      requirements: [requirement],
      caulkRequirements: []
    };
    const allocateBoxMutation = {
      mutateAsync: vi.fn(),
      isPending: false
    };
    useJobMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });
    useAllocateBoxMock.mockReturnValue(allocateBoxMutation);

    const view = renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));

    expect(searchBoxesMock).not.toHaveBeenCalled();
    expect(allocateBoxMutation.mutateAsync).not.toHaveBeenCalled();
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Warehouse required',
        description: 'Assign a warehouse to this job before auto-allocating material.',
        variant: 'error'
      })
    );
    view.queryClient.clear();
    view.unmount();
  });

  it('row-level caulk Auto Allocate caps the allocation to available stock for the selected requirement', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const requirement = buildCaulkRequirement({
      requirementId: 'caulk-req-1',
      allocatedTubes: 0,
      remainingTubes: 8
    });
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        jobId,
        status: 'FILM_ORDER',
        requiredTubes: 8,
        allocatedTubes: 0,
        remainingTubes: 8
      }) as JobDetail['summary'],
      requirements: [],
      caulkRequirements: [requirement],
      caulkAllocations: []
    };
    const addCaulkAllocationMutation = {
      mutateAsync: vi.fn().mockResolvedValue({
        result: {
          jobId,
          jobNumber: '000123',
          caulkAllocationId: 'caulk-alloc-1',
          warnings: []
        },
        warnings: []
      }),
      isPending: false
    };
    useParamsMock.mockReturnValue({ jobId });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });
    useAddCaulkJobAllocationMock.mockReturnValue(addCaulkAllocationMutation);
    listCaulkStockMock.mockResolvedValue([
      {
        warehouse: 'MS1',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '790 Black',
        productCode: '790-BLK',
        tubesPerCase: 20,
        tubesOnHand: 20,
        casesOnHand: 1,
        looseTubes: 0,
        updatedAt: '2026-03-20T00:00:00Z',
        updatedBy: 'tester'
      },
      {
        warehouse: 'IL1',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '790 Black',
        productCode: '790-BLK',
        tubesPerCase: 20,
        tubesOnHand: 5,
        casesOnHand: 0,
        looseTubes: 5,
        updatedAt: '2026-03-20T00:00:00Z',
        updatedBy: 'tester'
      }
    ]);

    const view = renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));

    await waitFor(() => expect(addCaulkAllocationMutation.mutateAsync).toHaveBeenCalledTimes(1));
    expect(listCaulkStockMock).toHaveBeenCalledWith({
      warehouse: 'IL1',
      productId: 'p1'
    });
    expect(addCaulkAllocationMutation.mutateAsync).toHaveBeenCalledWith({
      jobId,
      jobNumber: '000123',
      requirementId: 'caulk-req-1',
      productId: 'p1',
      warehouse: 'IL1',
      allocatedTubes: 5,
      notes: 'Auto allocated from requirement row.'
    });
    view.queryClient.clear();
    view.unmount();
  });

  it('row-level caulk Auto Allocate blocks safely when the job has no warehouse', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const requirement = buildCaulkRequirement({
      requirementId: 'caulk-req-1',
      allocatedTubes: 0,
      remainingTubes: 8
    });
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        jobId,
        warehouse: '',
        status: 'FILM_ORDER',
        requiredTubes: 8,
        allocatedTubes: 0,
        remainingTubes: 8
      }) as JobDetail['summary'],
      requirements: [],
      caulkRequirements: [requirement],
      caulkAllocations: []
    };
    const addCaulkAllocationMutation = {
      mutateAsync: vi.fn(),
      isPending: false
    };
    useParamsMock.mockReturnValue({ jobId });
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });
    useAddCaulkJobAllocationMock.mockReturnValue(addCaulkAllocationMutation);

    const view = renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Auto Allocate' }));

    expect(listCaulkStockMock).not.toHaveBeenCalled();
    expect(addCaulkAllocationMutation.mutateAsync).not.toHaveBeenCalled();
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Warehouse required',
        description: 'Assign a warehouse to this job before auto-allocating material.',
        variant: 'error'
      })
    );
    view.queryClient.clear();
    view.unmount();
  });

  it('renders fallback caulk coverage from canonical requirement totals when allocation is unbound', () => {
    const requirement = buildCaulkRequirement({
      allocatedTubes: 20,
      remainingTubes: 0
    });
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'READY',
        requiredTubes: 20,
        allocatedTubes: 20,
        remainingTubes: 0
      }) as JobDetail['summary'],
      caulkRequirements: [requirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: '',
          allocatedTubes: 20,
          reservedTubesRemaining: 20
        })
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, requirement);
  });

  it('repairs mixed job detail caulk coverage before rendering requirement totals', () => {
    const staleRequirement = buildCaulkRequirement({
      allocatedTubes: 0,
      remainingTubes: 20
    });
    const detail: JobDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'FILM_ORDER',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0,
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 20
      }) as JobDetail['summary'],
      caulkRequirements: [staleRequirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: staleRequirement.requirementId,
          allocatedTubes: 20,
          reservedTubesRemaining: 20
        })
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);
    const repairedRequirement = {
      ...staleRequirement,
      allocatedTubes: 20,
      remainingTubes: 0
    };

    expect(html).toContain('badge-READY');
    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, repairedRequirement);
  });

  it('repairs mixed job detail with unbound same-product caulk allocation fallback', () => {
    const staleRequirement = buildCaulkRequirement({
      allocatedTubes: 0,
      remainingTubes: 20
    });
    const detail: JobDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'FILM_ORDER',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0,
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 20
      }) as JobDetail['summary'],
      caulkRequirements: [staleRequirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: '',
          allocatedTubes: 20,
          reservedTubesRemaining: 20
        })
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);
    const repairedRequirement = {
      ...staleRequirement,
      allocatedTubes: 20,
      remainingTubes: 0
    };

    expect(html).toContain('badge-READY');
    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, repairedRequirement);
  });

  it('does not count cancelled caulk allocations during mixed detail repair', () => {
    const staleRequirement = buildCaulkRequirement({
      allocatedTubes: 0,
      remainingTubes: 20
    });
    const detail: JobDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'FILM_ORDER',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0,
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 20
      }) as JobDetail['summary'],
      caulkRequirements: [staleRequirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: staleRequirement.requirementId,
          allocatedTubes: 20,
          reservedTubesRemaining: 20,
          status: 'CANCELLED',
          resolvedAt: '2026-03-20T00:10:00Z',
          resolvedBy: 'tester'
        })
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('badge-NEEDS_ALLOCATION');
    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, staleRequirement);
  });

  it('does not render closed consumed caulk allocations in the active caulk allocation section', () => {
    const detail: JobDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'READY',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0,
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 12
      }) as JobDetail['summary'],
      caulkRequirements: [
        buildCaulkRequirement({
          actualUsedTubes: 8,
          allocatedTubes: 0,
          remainingTubes: 12
        })
      ],
      caulkAllocations: [
        buildCaulkAllocation({
          allocatedTubes: 8,
          reservedTubesRemaining: 0,
          checkedOutTubesTotal: 8,
          usedTubesTotal: 8,
          status: 'CANCELLED',
          resolvedAt: '2026-03-20T11:00:00Z',
          resolvedBy: 'tester'
        })
      ],
      caulkCheckouts: [
        {
          caulkCheckoutId: 'checkout1',
          caulkAllocationId: 'alloc1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 20,
          warehouse: 'IL1',
          checkoutTubes: 8,
          overageTubes: 0,
          status: 'CLOSED',
          checkedOutAt: '2026-03-20T10:00:00Z',
          checkedOutBy: 'crew',
          checkedInAt: '2026-03-20T11:00:00Z',
          checkedInBy: 'tester',
          unusedTubes: 0,
          usedTubes: 8,
          notes: ''
        }
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Caulk Allocations');
    expect(html).toContain('No caulk allocations are tied to this job yet.');
    expect(html).not.toContain('badge-CANCELLED');
    expect(html).not.toContain('Caulk Checkout Cycles');
    expect(html).not.toContain('No caulk checkout cycles have been recorded for this job yet.');
    expect(html).toContain('<td>0</td><td>8</td><td>12</td>');
  });

  it('keeps mixed detail in NEEDS_ALLOCATION when caulk coverage is partial without an active film order', () => {
    const staleRequirement = buildCaulkRequirement({
      allocatedTubes: 0,
      remainingTubes: 20
    });
    const detail: JobDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'NEEDS_ALLOCATION',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0,
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 20
      }) as JobDetail['summary'],
      caulkRequirements: [staleRequirement],
      caulkAllocations: [
        buildCaulkAllocation({
          requirementId: staleRequirement.requirementId,
          allocatedTubes: 10,
          reservedTubesRemaining: 10
        })
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);
    const repairedRequirement = {
      ...staleRequirement,
      allocatedTubes: 10,
      remainingTubes: 10
    };

    expect(html).toContain('badge-NEEDS_ALLOCATION');
    expectOverviewMaterialTotalsHidden(html);
    expectCaulkRequirementTableTotals(html, repairedRequirement);
  });

  it('renders paused caulk auto-planning resume affordance for suppressed unmet requirements', () => {
    const requirement = buildCaulkRequirement({
      allocatedTubes: 0,
      remainingTubes: 20,
      autoPlanningSuppressed: true
    });
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'NEEDS_ALLOCATION',
        requiredTubes: 20,
        allocatedTubes: 0,
        remainingTubes: 20
      }) as JobDetail['summary'],
      caulkRequirements: [requirement],
      caulkAllocations: []
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Auto planning paused');
    expect(html).toContain('Resume auto-plan');
    expectCaulkRequirementTableTotals(html, requirement);
  });

  it('renders the labor-only pill alongside the status badge when flagged', () => {
    const detail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'READY',
        isLaborOnly: true,
        isStagedForPickup: true
      }) as JobDetail['summary']
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('LABOR ONLY');
    expect(html).toContain('badge-READY');
  });

  it('renders staged pickup controls for active jobs and preserves the saved state on closed jobs', () => {
    const activeDetail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'READY',
        isStagedForPickup: false,
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }) as JobDetail['summary']
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: activeDetail,
      error: null
    });

    const activeHtml = renderPage(activeDetail);

    expect(activeHtml).toContain('Installer Pickup');
    expect(activeHtml).toContain('badge-READY');
    expect(activeHtml).toContain('Waiting on warehouse staging');
    expect(activeHtml).toContain('Checkout All');
    expect(activeHtml).toContain('Mark Staged for Pickup');
    expect(activeHtml).toContain('Check out the allocated film before staging this job.');

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: {
        ...buildMaterialJobDetail(),
        summary: buildSummary({
          status: 'COMPLETED',
          lifecycleStatus: 'COMPLETED',
          isStagedForPickup: true,
          requiredFeet: 8,
          allocatedFeet: 8,
          remainingFeet: 0
        }) as JobDetail['summary']
      },
      error: null
    });

    const closedHtml = renderPage({
      ...buildMaterialJobDetail(),
      summary: buildSummary({
        status: 'COMPLETED',
        lifecycleStatus: 'COMPLETED',
        isStagedForPickup: true,
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }) as JobDetail['summary']
    });

    expect(closedHtml).toContain('Staged for pickup');
    expect(closedHtml).toContain('Closed jobs keep the saved pickup state for history.');
    expect(closedHtml).not.toContain('Mark Staged for Pickup');
    expect(closedHtml).not.toContain('Checkout All');
  });

  it('renders film transfer alerts and replaces direct checkout with transfer guidance', () => {
    const detail = buildMaterialJobDetail({
      summary: buildSummary({
        warehouse: 'MS1',
        status: 'FILM_ORDER',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }) as JobDetail['summary'],
      filmTransferAlerts: [
        {
          boxId: 'IL1-100',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1',
          state: 'NEEDS_TRANSFER'
        }
      ]
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Film Transfer Alerts');
    expect(html).toContain('Cross-warehouse film still needs movement');
    expect(html).toContain('Needs Transfer');
    expect(html).toContain('Send this box from IL1 to MS1.');
    expect(html).not.toContain('>Check Out</button>');
  });

  it('renders a labor-only pickup display without staging actions when no materials are required', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'READY',
        isLaborOnly: true,
        requiredFeet: 0,
        allocatedFeet: 0,
        remainingFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0
      }) as JobDetail['summary']
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Labor only workflow');
    expect(html).not.toContain('Mark Staged for Pickup');
    expect(html).not.toContain('Checkout All');
  });

  it('keeps Checkout All available while staged pickup waits for checked-out material', () => {
    const detail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'READY',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }) as JobDetail['summary']
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Checkout All');
    expect(html).toContain('Mark Staged for Pickup');
    expect(html).toContain('Check out the allocated film before staging this job.');
    expect(html).toContain('disabled="" type="button">Mark Staged for Pickup</button>');
  });

  it('labels the film allocation action as extra when all film requirements are fulfilled', () => {
    const detail = buildMaterialJobDetail({
      summary: buildSummary({
        status: 'READY',
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }) as JobDetail['summary']
    });

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Allocate Extra');
    expect(html).not.toContain('Allocate Film');
  });

  it('enforces closed-job read-only behavior for caulk allocation actions', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'COMPLETED',
        lifecycleStatus: 'COMPLETED'
      }) as JobDetail['summary'],
      caulkAllocations: [
        {
          caulkAllocationId: 'alloc1',
          requirementId: '',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 6,
          reservedTubesRemaining: 6,
          checkedOutTubesTotal: 0,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 0,
          openCheckoutCount: 0,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          updatedAt: '2026-03-20T00:00:00Z',
          updatedBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: ''
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Read-only');
    expect(html).not.toContain('Add Caulk Allocation');
  });

  it('shows delete plus specific allocation labels for owners and admins', () => {
    const html = renderPage(baseDetail);

    expect(html).toContain('Allocate Film');
    expect(html).toContain('Allocate Caulk');
    expect(html).toContain('Delete');
    expect(html).toContain('Job Completed');
    expect(html).not.toContain('>Allocate<');
    expect(html).not.toContain('Add Caulk Allocation');
  });

  it('hides the delete action for non-admin members', () => {
    useAuthMock.mockReturnValueOnce({
      clientIdConfigured: true,
      isAuthenticated: true,
      isOwner: false,
      isAdmin: false,
      hasFeatureAccess: () => true
    });

    const html = renderPage(baseDetail);

    expect(html).not.toContain('Delete');
    expect(html).toContain('Allocate Film');
    expect(html).toContain('Allocate Caulk');
  });

  it('shows Check In for boxes already checked out on this job and keeps Check Out for in-stock rows', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-checked-out',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        },
        {
          allocationId: 'alloc-in-stock',
          boxId: 'IL1-101',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 60,
          coveredFeet: 60,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
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
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Check In');
    expect(html).toContain('Check Out');
  });

  it('opens the film check-in dialog from a scanned checked-out box on Job Details', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({ jobId, jobNumber: '000123' }) as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-checked-out',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }
      ]
    };

    useParamsMock.mockReturnValue({ jobId });
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams('scanAction=checkin&boxId=IL1-100'),
      setSearchParamsMock
    ]);
    useJobByIdMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      error: null,
      refetch: vi.fn().mockResolvedValue({ data: detail })
    });
    useBoxMock.mockReturnValue({
      data: {
        boxId: 'IL1-100',
        status: 'CHECKED_OUT',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Ultra 70',
        widthIn: 60,
        initialFeet: 100,
        feetAvailable: 0,
        receivedDate: '2026-03-20',
        directToJobSite: false,
        lastRollWeightLbs: 12,
        coreWeightLbs: 2,
        lfWeightLbsPerFt: 0.1,
        coreType: '',
        lastCheckoutJob: '000123',
        lastCheckoutJobId: jobId
      },
      isLoading: false,
      isError: false,
      error: null
    });

    renderInteractivePage();

    const dialog = await screen.findByRole('dialog', { name: 'Check In IL1-100' });
    expect(
      within(dialog).getByText(
        'This return will close the current checkout for job 000123 and record returned roll history.'
      )
    ).toBeTruthy();
    expect(setSearchParamsMock).toHaveBeenCalledWith(expect.any(URLSearchParams), {
      replace: true
    });
  });

  it('hides historical resolved allocation rows from Allocated Boxes while keeping the current checkout row', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-history',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 5,
          coveredFeet: 5,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-19T08:00:00Z',
          createdBy: 'tester',
          resolvedAt: '2026-03-19T09:00:00Z',
          resolvedBy: 'tester',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-current',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 8,
          coveredFeet: 8,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T10:00:00Z',
          createdBy: 'tester',
          resolvedAt: '2026-03-20T10:15:00Z',
          resolvedBy: 'tester',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html.match(/IL1-100/g)).toHaveLength(1);
    expect(html).toContain('Check In');
    expect(html).not.toContain('>Check Out</button>');
  });

  it('shows fulfilled allocation rows only when the box is still checked out to this job', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-fulfilled-current',
          boxId: 'IL1-6922',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 20,
          coveredFeet: 20,
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '2026-03-20T10:00:00Z',
          resolvedBy: 'tester',
          filmOrderId: '',
          notes: 'Checked out for job 000123.',
          manufacturer: '3M',
          filmName: 'Night Vision 35',
          widthIn: 72,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        },
        {
          allocationId: 'alloc-fulfilled-returned',
          boxId: 'IL1-5716',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 5,
          coveredFeet: 5,
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-19T08:00:00Z',
          createdBy: 'tester',
          resolvedAt: '2026-03-20T09:00:00Z',
          resolvedBy: 'tester',
          filmOrderId: '',
          notes: 'Checked in at 0 lbs',
          manufacturer: '3M',
          filmName: 'Night Vision 15',
          widthIn: 36,
          boxStatus: 'ZEROED',
          checkedOutOnThisJob: false
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('IL1-6922');
    expect(html).toContain('Check In');
    expect(html).not.toContain('IL1-5716');
    expect(html).not.toContain('No allocations are tied to this job yet.');
  });

  it('only disables the allocation row that is currently being removed', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-pending',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-ready',
          boxId: 'IL1-101',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 60,
          coveredFeet: 60,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
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
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });
    usePendingRemoveJobBoxAllocationIdsMock.mockReturnValueOnce(new Set(['ALLOC-PENDING']));
    useRemoveJobBoxAllocationsMock.mockReturnValueOnce({
      ...buildMutationState(),
      isPending: true
    });

    const html = renderPage(detail);

    expect(html.match(/disabled=""[^>]*>Remove<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Remove<\/button>/g)).toHaveLength(2);
  });

  it('renders split allocations with both physical and covered LF', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary({
        status: 'READY',
        requiredFeet: 20,
        allocatedFeet: 20,
        remainingFeet: 0
      }) as JobDetail['summary'],
      requirements: [
        {
          requirementId: 'req-36',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 36,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-split',
          boxId: 'MS1-3608',
          warehouse: 'MS1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          coveredFeet: 20,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('10 physical / 20 covered');
  });

  it('disables manual job completion while returned materials are still outstanding', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      allocations: [
        {
          allocationId: 'alloc-checked-out',
          boxId: 'IL1-100',
          warehouse: 'IL1',
          jobNumber: '000123',
          installDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocationSource: 'MANUAL' as const,
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 60,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }
      ],
      caulkCheckouts: [
        {
          caulkCheckoutId: 'checkout1',
          caulkAllocationId: 'alloc1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          checkoutTubes: 12,
          overageTubes: 0,
          status: 'OPEN',
          checkedOutAt: '2026-03-20T10:00:00Z',
          checkedOutBy: 'crew',
          checkedInAt: '',
          checkedInBy: '',
          unusedTubes: 0,
          usedTubes: 0,
          notes: ''
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain(
      'Return 1 checked-out box and 1 open caulk checkout before completing this job.'
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Job Completed<\/button>/);
  });

  it('shows row-level caulk Check In when an allocation has an open checkout cycle', () => {
    const detail: JobDetail = {
      ...baseDetail,
      summary: buildSummary() as JobDetail['summary'],
      caulkAllocations: [
        {
          caulkAllocationId: 'alloc1',
          requirementId: 'req1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 24,
          reservedTubesRemaining: 12,
          checkedOutTubesTotal: 12,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 12,
          openCheckoutCount: 1,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '2026-03-20T00:00:00Z',
          createdBy: 'tester',
          updatedAt: '2026-03-20T00:00:00Z',
          updatedBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: ''
        }
      ],
      caulkCheckouts: [
        {
          caulkCheckoutId: 'checkout1',
          caulkAllocationId: 'alloc1',
          productId: 'p1',
          manufacturerId: 'm1',
          manufacturer: 'DOW',
          productName: '790 Black',
          productCode: '790-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          checkoutTubes: 12,
          overageTubes: 0,
          status: 'OPEN',
          checkedOutAt: '2026-03-20T10:00:00Z',
          checkedOutBy: 'crew',
          checkedInAt: '',
          checkedInBy: '',
          unusedTubes: 0,
          usedTubes: 0,
          notes: ''
        }
      ]
    };

    useJobMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: detail,
      error: null
    });

    const html = renderPage(detail);

    expect(html).toContain('Caulk Allocations');
    expect(html).toContain('Check In');
    expect(html).toContain('Locked after checkout');
  });
});
