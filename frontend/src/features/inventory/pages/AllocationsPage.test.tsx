import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import AllocationsPage from './AllocationsPage';
import type { JobSortOption } from '../utils/jobSorts';

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
  useJobsList: (...args: unknown[]) => useJobsListMock(...args),
  useJobsSearch: (...args: unknown[]) => useJobsSearchMock(...args),
  useCreateJob: (...args: unknown[]) => useCreateJobMock(...args),
  useFilmCatalog: (...args: unknown[]) => useFilmCatalogMock(...args)
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
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 1,
    filmOrderCount: 0,
    createdAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
    notes: '',
    ...overrides
  };
}

function renderPage(props: {
  initialWorkflowView?: 'active' | 'completed';
  initialJobSearchInput?: string;
  initialJobSort?: JobSortOption;
} = {}) {
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
      <AllocationsPage
        initialWorkflowView={props.initialWorkflowView}
        initialJobSearchInput={props.initialJobSearchInput}
        initialJobSort={props.initialJobSort}
      />
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
    useJobsListMock.mockImplementation((_limit?: unknown, options?: { lifecycleStatus?: string }) => ({
      data: [
        buildJob({
          jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '26961' : '16961',
          lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
          status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
        })
      ],
      isLoading: false,
      error: null
    }));
    useJobsSearchMock.mockImplementation(
      (query?: unknown, _limit?: unknown, options?: { lifecycleStatus?: string }) => ({
        data: query
          ? [
              buildJob({
                jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '22345' : '12345',
                lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
                status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
              })
            ]
          : [],
        isLoading: false,
        error: null
      })
    );
    useCreateJobMock.mockReturnValue(buildMutationState());
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
  });

  it('defaults to the active workflow view and keeps the job controls visible', () => {
    const html = renderPage();

    expect(html).toContain('Active workflow');
    expect(html).toContain('Showing active jobs only (up to 25).');
    expect(html).toContain('Recent Jobs');
    expect(html).toContain('New Job +');
    expect(html).toContain('aria-pressed="true">Active workflow</button>');
    expect(useJobsListMock).toHaveBeenCalledWith(25, { lifecycleStatus: 'ACTIVE' });
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

  it('renders the completed workflow copy and data when that toggle is selected', () => {
    const html = renderPage({ initialWorkflowView: 'completed' });

    expect(html).toContain('Showing completed job history (up to 25).');
    expect(html).toContain('Completed Job History');
    expect(html).toContain('aria-pressed="true">Completed jobs</button>');
    expect(useJobsListMock).toHaveBeenCalledWith(25, { lifecycleStatus: 'COMPLETED' });
    expect(useJobsSearchMock).toHaveBeenCalledWith('', 25, {
      enabled: false,
      lifecycleStatus: 'COMPLETED'
    });
  });

  it('keeps the shared search and sort controls when viewing completed job history', () => {
    const html = renderPage({
      initialWorkflowView: 'completed',
      initialJobSearchInput: '2345',
      initialJobSort: 'job_number_desc'
    });

    expect(html).toContain('value="2345"');
    expect(html).toContain('Sort Jobs');
    expect(html).toContain('matching completed jobs');
    expect(useJobsSearchMock).toHaveBeenCalledWith('2345', 25, {
      enabled: true,
      lifecycleStatus: 'COMPLETED'
    });
  });

  it('shows the completed-history empty state when no completed jobs are returned', () => {
    useJobsListMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    const html = renderPage({ initialWorkflowView: 'completed' });

    expect(html).toContain('Completed Job History');
    expect(html).toContain('No completed job history yet.');
  });

  it('renders only completed-status rows in completed job history', () => {
    useJobsListMock.mockImplementation((_limit?: unknown, options?: { lifecycleStatus?: string }) => ({
      data:
        options?.lifecycleStatus === 'COMPLETED'
          ? [
              buildJob({
                jobNumber: '19339',
                lifecycleStatus: 'COMPLETED',
                status: 'COMPLETED'
              }),
              buildJob({
                jobNumber: '16961',
                lifecycleStatus: 'COMPLETED',
                status: 'READY'
              })
            ]
          : [buildJob()],
      isLoading: false,
      error: null
    }));

    const html = renderPage({ initialWorkflowView: 'completed' });

    expect(html).toContain('Showing completed job history (up to 25).');
    expect(html).toContain('Showing</span><strong class="hero-metric-value inventory-summary-value">1</strong>');
    expect(html).toContain('19339');
    expect(html).not.toContain('16961');
  });
});
