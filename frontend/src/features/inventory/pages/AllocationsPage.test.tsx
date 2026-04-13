import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PropsWithChildren } from 'react';
import AllocationsPage from './AllocationsPage';
import type { JobSortOption } from '../utils/jobSorts';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useJobsListMock = vi.fn();
const useJobsSearchMock = vi.fn();
const useJobsCalendarEntriesMock = vi.fn();
const useCreateJobMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useCaulkProductsMock = vi.fn();

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }: PropsWithChildren<{ to: string }>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
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

vi.mock('../hooks/useInventoryQueries', () => ({
  useJobsList: (...args: unknown[]) => useJobsListMock(...args),
  useJobsSearch: (...args: unknown[]) => useJobsSearchMock(...args),
  useJobsCalendarEntries: (...args: unknown[]) => useJobsCalendarEntriesMock(...args),
  useCreateJob: (...args: unknown[]) => useCreateJobMock(...args),
  useFilmCatalog: (...args: unknown[]) => useFilmCatalogMock(...args),
  useCaulkProducts: (...args: unknown[]) => useCaulkProductsMock(...args)
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
    installDate: '2026-03-24',
    crewLeader: '',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
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

function buildCalendarQueryState(
  entries: ReturnType<typeof buildJob>[],
  overrides: Record<string, unknown> = {}
) {
  return {
    data: entries,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    fetchStatus: 'idle',
    error: null,
    ...overrides
  };
}

function renderPage(props: {
  initialWorkflowView?: 'active' | 'completed';
  initialJobsViewMode?: 'list' | 'calendar';
  initialCalendarGranularity?: 'week' | 'month';
  initialJobSearchInput?: string;
  initialJobSort?: JobSortOption;
  initialCalendarAnchorDate?: string;
  initialCalendarMonth?: string;
} = {}) {
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
      <AllocationsPage
        initialWorkflowView={props.initialWorkflowView}
        initialJobsViewMode={props.initialJobsViewMode}
        initialCalendarGranularity={props.initialCalendarGranularity}
        initialJobSearchInput={props.initialJobSearchInput}
        initialJobSort={props.initialJobSort}
        initialCalendarAnchorDate={props.initialCalendarAnchorDate ?? '2026-03-26'}
        initialCalendarMonth={props.initialCalendarMonth}
      />
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

function findRenderedJobButtonIndex(html: string, jobNumber: string) {
  return html.indexOf(`>${jobNumber}</button>`);
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
    useJobsCalendarEntriesMock.mockImplementation(
      (_anchorDate?: unknown, options?: { lifecycleStatus?: string; view?: string }) =>
        buildCalendarQueryState([
          buildJob({
            jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '32345' : '12345',
            lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
            status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
          })
        ])
    );
    useCreateJobMock.mockReturnValue(buildMutationState());
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useCaulkProductsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
  });

  it('defaults to calendar week mode and uses the period query', () => {
    const html = renderPage();

    expect(html).toContain('aria-pressed="true">Calendar</button>');
    expect(html).toContain('option value="week" selected=""');
    expect(html).toContain('Browse active install dates by week.');
    expect(html).toContain('Install Calendar');
    expect(html).toContain('Mar 22 - Mar 28, 2026');
    expect(useJobsListMock).toHaveBeenCalledWith(25, { enabled: false, lifecycleStatus: 'ACTIVE' });
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-26', {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      view: 'week'
    });
  });

  it('renders list mode with the jobs sort dropdown when requested', () => {
    const html = renderPage({ initialJobsViewMode: 'list' });

    expect(html).toContain('Sort Jobs');
    expect(html).toContain('Install Date');
    expect(html).toContain('Job Number: Low To High');
    expect(html).toContain('Job Number: High To Low');
    expect(html).toContain('Date Added: Newest First');
    expect(html).toContain('Date Added: Oldest First');
    expect(html).toContain('Status: Allocate First');
    expect(html).toContain('Status: Film Order First');
    expect(useJobsListMock).toHaveBeenCalledWith(25, { enabled: true, lifecycleStatus: 'ACTIVE' });
  });

  it('renders the completed workflow copy and data when list mode is selected', () => {
    const html = renderPage({ initialWorkflowView: 'completed', initialJobsViewMode: 'list' });

    expect(html).toContain('Showing completed job history (up to 25).');
    expect(html).toContain('Completed Job History');
    expect(html).toContain('aria-pressed="true">Completed jobs</button>');
    expect(useJobsListMock).toHaveBeenCalledWith(25, {
      enabled: true,
      lifecycleStatus: 'COMPLETED'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('', 25, {
      enabled: false,
      lifecycleStatus: 'COMPLETED'
    });
  });

  it('keeps the shared search and sort controls when viewing completed list history', () => {
    const html = renderPage({
      initialWorkflowView: 'completed',
      initialJobsViewMode: 'list',
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

  it('keeps the closest job-number match first while searching in list mode', () => {
    useJobsSearchMock.mockImplementation((query?: unknown, _limit?: unknown, options?: { lifecycleStatus?: string }) => ({
      data: query
        ? [
            buildJob({
              jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '2171705' : '2171705',
              installDate: '2026-04-20',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            }),
            buildJob({
              jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '171700' : '171700',
              installDate: '2026-04-22',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            }),
            buildJob({
              jobNumber: options?.lifecycleStatus === 'COMPLETED' ? '17170' : '17170',
              installDate: '2026-04-01',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            })
          ]
        : [],
      isLoading: false,
      error: null
    }));

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSearchInput: '17170',
      initialJobSort: 'install_date'
    });

    expect(findRenderedJobButtonIndex(html, '17170')).toBeLessThan(findRenderedJobButtonIndex(html, '171700'));
    expect(findRenderedJobButtonIndex(html, '171700')).toBeLessThan(findRenderedJobButtonIndex(html, '2171705'));
  });

  it('uses the selected sort as a tie-breaker within the same search match tier', () => {
    useJobsSearchMock.mockImplementation((query?: unknown, _limit?: unknown, options?: { lifecycleStatus?: string }) => ({
      data: query
        ? [
            buildJob({
              jobNumber: '171701',
              installDate: '2026-04-09',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            }),
            buildJob({
              jobNumber: '171700',
              installDate: '2026-04-12',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            }),
            buildJob({
              jobNumber: '17170',
              installDate: '2026-04-01',
              lifecycleStatus: options?.lifecycleStatus || 'ACTIVE',
              status: options?.lifecycleStatus === 'COMPLETED' ? 'COMPLETED' : 'READY'
            })
          ]
        : [],
      isLoading: false,
      error: null
    }));

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSearchInput: '17170',
      initialJobSort: 'install_date'
    });

    expect(findRenderedJobButtonIndex(html, '17170')).toBeLessThan(findRenderedJobButtonIndex(html, '171700'));
    expect(findRenderedJobButtonIndex(html, '171700')).toBeLessThan(findRenderedJobButtonIndex(html, '171701'));
  });

  it('shows the completed-history empty state when no completed list jobs are returned', () => {
    useJobsListMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    const html = renderPage({ initialWorkflowView: 'completed', initialJobsViewMode: 'list' });

    expect(html).toContain('Completed Job History');
    expect(html).toContain('No completed job history yet.');
  });

  it('renders only completed-status rows in completed list history', () => {
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

    const html = renderPage({ initialWorkflowView: 'completed', initialJobsViewMode: 'list' });

    expect(html).toContain('Showing completed job history (up to 25).');
    expect(html).toContain('Showing</span><strong class="hero-metric-value inventory-summary-value">1</strong>');
    expect(html).toContain('19339');
    expect(html).not.toContain('16961');
  });

  it('restores normal list sorting when the search is empty', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({ jobNumber: '200' }),
        buildJob({ jobNumber: '15' }),
        buildJob({ jobNumber: '1000' })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSort: 'job_number_asc'
    });

    expect(findRenderedJobButtonIndex(html, '15')).toBeLessThan(findRenderedJobButtonIndex(html, '200'));
    expect(findRenderedJobButtonIndex(html, '200')).toBeLessThan(findRenderedJobButtonIndex(html, '1000'));
  });

  it('renders calendar week mode with an explicit search button and cross-workflow search queries', () => {
    const html = renderPage({
      initialJobsViewMode: 'calendar',
      initialCalendarGranularity: 'week',
      initialCalendarAnchorDate: '2026-03-24',
      initialJobSearchInput: '12345'
    });

    expect(html).toContain('aria-pressed="true">Calendar</button>');
    expect(html).toContain('option value="week" selected=""');
    expect(html).toContain('>Search</button>');
    expect(html).not.toContain('Calendar Search');
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-24', {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      view: 'week'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('', 25, {
      enabled: false,
      lifecycleStatus: 'ACTIVE'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('12345', 1, {
      enabled: true,
      lifecycleStatus: 'ACTIVE'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('12345', 1, {
      enabled: true,
      lifecycleStatus: 'COMPLETED'
    });
  });

  it('supports month calendar mode and keeps the explicit search button in completed workflow too', () => {
    const html = renderPage({
      initialWorkflowView: 'completed',
      initialJobsViewMode: 'calendar',
      initialCalendarGranularity: 'month',
      initialCalendarAnchorDate: '2026-03-24',
      initialJobSearchInput: '22345'
    });

    expect(html).toContain('option value="month" selected=""');
    expect(html).toContain('March 2026');
    expect(html).toContain('Browse completed install dates by month.');
    expect(html).toContain('>Search</button>');
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-24', {
      enabled: true,
      lifecycleStatus: 'COMPLETED',
      view: 'month'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('22345', 1, {
      enabled: true,
      lifecycleStatus: 'ACTIVE'
    });
    expect(useJobsSearchMock).toHaveBeenCalledWith('22345', 1, {
      enabled: true,
      lifecycleStatus: 'COMPLETED'
    });
  });
});
