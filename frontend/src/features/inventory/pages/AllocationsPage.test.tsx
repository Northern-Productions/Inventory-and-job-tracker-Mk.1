import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import AllocationsPage from './AllocationsPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useJobsListMock = vi.fn();
const useJobsSearchMock = vi.fn();
const useCreateJobMock = vi.fn();
const useFilmCatalogMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
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

vi.mock('../../../api/features/caulkClient', () => ({
  listCaulkProducts: vi.fn()
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useJobsList: () => useJobsListMock(),
  useJobsSearch: () => useJobsSearchMock(),
  useCreateJob: () => useCreateJobMock(),
  useFilmCatalog: () => useFilmCatalogMock()
}));

function buildMutationState() {
  return {
    mutateAsync: vi.fn(),
    isPending: false
  };
}

function buildJob(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '16961',
    warehouse: 'IL1',
    sections: '260',
    dueDate: '2026-03-24',
    crewLeader: '',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    requiredFeet: 12,
    allocatedFeet: 12,
    remainingFeet: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    createdAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
    notes: '',
    ...overrides
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  queryClient.setQueryData(['caulk', 'products'], []);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AllocationsPage />
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

describe('AllocationsPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true
    });
    useJobsListMock.mockReturnValue({
      data: [buildJob()],
      isLoading: false,
      error: null
    });
    useJobsSearchMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useCreateJobMock.mockReturnValue(buildMutationState());
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
  });

  it('renders the jobs sort dropdown with the requested options', () => {
    const html = renderPage();

    expect(html).toContain('Sort Jobs');
    expect(html).toContain('Install Date');
    expect(html).toContain('Job Number: Low To High');
    expect(html).toContain('Job Number: High To Low');
    expect(html).toContain('Date Added: Newest First');
    expect(html).toContain('Date Added: Oldest First');
    expect(html).toContain('Status: Allocate First');
    expect(html).toContain('Status: Film Order First');
  });
});
