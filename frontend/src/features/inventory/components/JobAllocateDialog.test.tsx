import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobAllocateDialog } from './JobAllocateDialog';

const toastPushMock = vi.fn();
const useAllocateBoxMock = vi.fn();
const useCreateFilmOrderMock = vi.fn();

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isOwner: true,
    isAdmin: true,
    hasFeatureAccess: () => true
  })
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1' }, { code: 'MS1' }]
  })
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useAllocateBox: () => useAllocateBoxMock(),
  useCreateFilmOrder: () => useCreateFilmOrderMock()
}));

vi.mock('../../../api/features/inventoryClient', () => ({
  searchBoxes: vi.fn(async () => [])
}));

function buildMutationState() {
  return {
    isPending: false,
    mutateAsync: vi.fn()
  };
}

describe('JobAllocateDialog', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    useAllocateBoxMock.mockReset();
    useCreateFilmOrderMock.mockReset();
    useAllocateBoxMock.mockReturnValue(buildMutationState());
    useCreateFilmOrderMock.mockReturnValue(buildMutationState());
  });

  it('uses the shared sticky footer action class for the final allocate row', () => {
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
        <JobAllocateDialog
          open
          jobNumber="55555"
          warehouse="IL1"
          dueDate=""
          crewLeader=""
          requirements={[
            {
              requirementId: 'req-1',
              manufacturer: '3M Solar',
              filmName: 'Prestige 50',
              widthIn: 48,
              requiredFeet: 10,
              allocatedFeet: 0,
              remainingFeet: 10
            }
          ]}
          filmOrders={[]}
          onCancel={() => undefined}
        />
      </QueryClientProvider>
    );

    expect(html).toContain('dialog-actions dialog-actions-sticky-footer');
    queryClient.clear();
  });

  it('only renders unmet requirement lines in the selector', () => {
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
        <JobAllocateDialog
          open
          jobNumber="18959"
          warehouse="IL1"
          dueDate=""
          crewLeader=""
          requirements={[
            {
              requirementId: 'req-50',
              manufacturer: '3M Solar',
              filmName: 'Affinity 15',
              widthIn: 50,
              requiredFeet: 2,
              allocatedFeet: 2,
              remainingFeet: 0
            },
            {
              requirementId: 'req-72',
              manufacturer: '3M Solar',
              filmName: 'Affinity 15',
              widthIn: 72,
              requiredFeet: 12,
              allocatedFeet: 10,
              remainingFeet: 2
            }
          ]}
          filmOrders={[]}
          onCancel={() => undefined}
        />
      </QueryClientProvider>
    );

    expect(html).not.toContain('Affinity 15 50&quot; (0 LF remaining)');
    expect(html).toContain('Affinity 15 72&quot; (2 LF remaining)');
    queryClient.clear();
  });
});
