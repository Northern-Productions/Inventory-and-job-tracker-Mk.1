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
const useCheckinCaulkJobAllocationMock = vi.fn();
const useRemoveCaulkJobAllocationMock = vi.fn();
const useCompleteJobMock = vi.fn();
const useDeleteJobMock = vi.fn();
const useReopenJobMock = vi.fn();
const useDeleteFilmOrderMock = vi.fn();
const useRemoveJobBoxAllocationsMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
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
  listCaulkProducts: vi.fn()
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useJob: () => useJobMock(),
  useUpdateJob: () => useUpdateJobMock(),
  useAddCaulkJobAllocation: () => useAddCaulkJobAllocationMock(),
  useUpdateCaulkJobAllocation: () => useUpdateCaulkJobAllocationMock(),
  useCheckoutCaulkJobAllocation: () => useCheckoutCaulkJobAllocationMock(),
  useCheckinCaulkJobAllocation: () => useCheckinCaulkJobAllocationMock(),
  useRemoveCaulkJobAllocation: () => useRemoveCaulkJobAllocationMock(),
  useCompleteJob: () => useCompleteJobMock(),
  useDeleteJob: () => useDeleteJobMock(),
  useReopenJob: () => useReopenJobMock(),
  useDeleteFilmOrder: () => useDeleteFilmOrderMock(),
  useRemoveJobBoxAllocations: () => useRemoveJobBoxAllocationsMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
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
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
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
      isAdmin: false
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
    useCheckinCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useRemoveCaulkJobAllocationMock.mockReturnValue(buildMutationState());
    useCompleteJobMock.mockReturnValue(buildMutationState());
    useDeleteJobMock.mockReturnValue(buildMutationState());
    useReopenJobMock.mockReturnValue(buildMutationState());
    useDeleteFilmOrderMock.mockReturnValue(buildMutationState());
    useRemoveJobBoxAllocationsMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
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
      isAdmin: false
    });

    const html = renderPage(baseDetail);

    expect(html).not.toContain('Delete');
    expect(html).toContain('Allocate Film');
    expect(html).toContain('Allocate Caulk');
  });
});
