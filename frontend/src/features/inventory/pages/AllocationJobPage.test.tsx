import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobDetail } from '../../../domain';
import AllocationJobPage from './AllocationJobPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useJobMock = vi.fn();
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
const useRemoveJobBoxAllocationsMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
const useSetJobStagedForPickupMock = vi.fn();
const useBoxMock = vi.fn();
const useAllocateBoxMock = vi.fn();
const useCreateFilmOrderMock = vi.fn();
const useFilmCatalogMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ jobNumber: '000123' })
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

vi.mock('../../../api/features/caulkClient', () => ({
  listCaulkProducts: vi.fn(),
  listCaulkStock: vi.fn()
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useJob: () => useJobMock(),
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
  useRemoveJobBoxAllocations: () => useRemoveJobBoxAllocationsMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
  useSetJobStagedForPickup: () => useSetJobStagedForPickupMock(),
  useBox: () => useBoxMock(),
  useAllocateBox: () => useAllocateBoxMock(),
  useCreateFilmOrder: () => useCreateFilmOrderMock(),
  useFilmCatalog: () => useFilmCatalogMock()
}));

function buildSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '000123',
    warehouse: 'IL1',
    sections: null,
    dueDate: '2026-03-20',
    crewLeader: 'Crew',
    status: 'ALLOCATE',
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
        jobDate: '2026-03-20',
        crewLeader: 'Crew',
        allocatedFeet: 8,
        coveredFeet: 8,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
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

function renderPage(detail: JobDetail) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  queryClient.setQueryData(['caulk', 'products'], caulkProducts);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AllocationJobPage />
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

describe('AllocationJobPage', () => {
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
    useRemoveJobBoxAllocationsMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
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
      error: null
    });
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

    expect(html).toContain('Caulk Requirements');
    expect(html).toContain('Caulk Allocations');
    expect(html).toContain('Job Usage History');
    expect(html).toContain('Locked after checkout');
    expect(html).toContain('FILM');
    expect(html).toContain('CAULK');
    expect(html).toContain('125 LF');
    expect(html).toContain('10 TUBES');
    expect(html).toContain('30 tubes | 2 full cases | 6 loose tubes');
    expect(html).toContain('6 tubes | 0 full cases | 6 loose tubes');
    expect(html).toContain('24 tubes | 2 full cases | 0 loose tubes');
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
    expect(activeHtml).toContain('Staging will check out all allocated material first.');

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

  it('keeps staged pickup available when checkout-all can clear allocated material', () => {
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
    expect(html).toContain('Staging will check out all allocated material first.');
    expect(html).not.toContain('Check out the allocated film before staging this job.');
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
          jobDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
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
          jobDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 60,
          coveredFeet: 60,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
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
          jobDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          coveredFeet: 20,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
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
          jobDate: '2026-03-20',
          crewLeader: 'Crew',
          allocatedFeet: 50,
          coveredFeet: 50,
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
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
