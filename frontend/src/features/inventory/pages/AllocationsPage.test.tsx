import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PropsWithChildren } from 'react';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import AllocationsPage from './AllocationsPage';
import type { JobSortOption } from '../utils/jobSorts';
import { warehouseRegistryScopedQueryKey } from '../hooks/useWarehouseRegistry';

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
    hasOrderedAllocations: false,
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
  queryClient.setQueryData(
    warehouseRegistryScopedQueryKey({ userId: 'test-user', orgId: 'test-org' }),
    [
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
    ]
  );

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
  return html.indexOf(`>${formatJobDisplayLabel({ jobNumber, warehouse: 'IL1', sections: '260' })}</button>`);
}

describe('AllocationsPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    useAuthMock.mockReturnValue({
      accessContext: {
        orgId: 'test-org',
        defaultWarehouse: ''
      },
      clientIdConfigured: true,
      isAuthenticated: true,
      isAccessReady: true,
      isApproved: true,
      session: { user: { sub: 'test-user' } }
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

  it('keeps the list query disabled while defaulting to calendar week mode', () => {
    const html = renderPage();

    expect(html).toContain('aria-pressed="true">Calendar</button>');
    expect(html).toContain('option value="week" selected=""');
    expect(html).toContain('Browse active install dates by week.');
    expect(html).toContain('Install Calendar');
    expect(html).toContain('Mar 22 - Mar 28, 2026');
    expect(useJobsListMock).toHaveBeenCalledWith(0, {
      enabled: false,
      lifecycleStatus: 'ACTIVE',
      warehouse: ''
    });
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-26', {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      warehouse: '',
      view: 'week'
    });
    expect(useFilmCatalogMock).toHaveBeenCalledWith({ enabled: false });
    expect(useCaulkProductsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('renders list mode with the refreshed sort options', () => {
    const html = renderPage({ initialJobsViewMode: 'list' });

    expect(html).toContain('Sort Jobs');
    expect(html).toContain('Install Date Ascending');
    expect(html).toContain('Install Date Descending');
    expect(html).toContain('Allocate');
    expect(html).toContain('Film Order');
    expect(useJobsListMock).toHaveBeenCalledWith(0, {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      warehouse: ''
    });
    expect(useFilmCatalogMock).toHaveBeenCalledWith({ enabled: false });
    expect(useCaulkProductsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('renders same-number jobs as distinct list rows by job id and work scope', () => {
    const sectionOneJob = buildJob({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '9327001',
      sections: 'Sections 1',
      workScope: 'Sections 1',
      workScopeKey: 'section:1',
      requiredFeet: 11
    });
    const sectionTwoJob = buildJob({
      jobId: '22222222-2222-4222-8222-222222222222',
      jobNumber: '9327001',
      sections: 'Sections 2',
      workScope: 'Sections 2',
      workScopeKey: 'section:2',
      requiredFeet: 22
    });
    useJobsListMock.mockReturnValue({
      data: [sectionOneJob, sectionTwoJob],
      isLoading: false,
      error: null
    });

    const html = renderPage({ initialJobsViewMode: 'list' });

    expect(html).toContain('Showing</span><strong class="hero-metric-value inventory-summary-value">2</strong>');
    expect(html).toContain(formatJobDisplayLabel(sectionOneJob));
    expect(html).toContain(formatJobDisplayLabel(sectionTwoJob));
    expect(html).toContain('<td>Sections 1</td>');
    expect(html).toContain('<td>Sections 2</td>');
  });

  it('renders the completed workflow copy and data when list mode is selected', () => {
    const html = renderPage({ initialWorkflowView: 'completed', initialJobsViewMode: 'list' });

    expect(html).toContain('Showing all completed jobs.');
    expect(html).toContain('Completed Jobs');
    expect(html).toContain('aria-pressed="true">Completed jobs</button>');
    expect(useJobsListMock).toHaveBeenCalledWith(0, {
      enabled: true,
      lifecycleStatus: 'COMPLETED',
      warehouse: ''
    });
  });

  it('initializes job list and calendar filters from the saved default warehouse', () => {
    useAuthMock.mockReturnValue({
      accessContext: {
        orgId: 'test-org',
        defaultWarehouse: 'MS1'
      },
      clientIdConfigured: true,
      isAuthenticated: true,
      isAccessReady: true,
      isApproved: true,
      session: { user: { sub: 'test-user' } }
    });

    const html = renderPage({ initialJobsViewMode: 'list' });

    expect(html).toContain('value="MS1" selected=""');
    expect(useJobsListMock).toHaveBeenCalledWith(0, {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      warehouse: 'MS1'
    });
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-26', {
      enabled: false,
      lifecycleStatus: 'ACTIVE',
      warehouse: 'MS1',
      view: 'week'
    });
  });

  it('keeps the shared search control while list-mode search stays local', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({
          jobNumber: '2345',
          installDate: '2026-03-20',
          lifecycleStatus: 'COMPLETED',
          status: 'COMPLETED'
        })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({
      initialWorkflowView: 'completed',
      initialJobsViewMode: 'list',
      initialJobSearchInput: '2345',
      initialJobSort: 'install_date_desc'
    });

    expect(html).toContain('value="2345"');
    expect(html).toContain('Sort Jobs');
    expect(html).toContain('matching completed jobs');
    expect(html).toContain('2345');
    expect(useJobsSearchMock).not.toHaveBeenCalled();
  });

  it('keeps the closest job-number match first while searching in list mode', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({ jobNumber: '2171705', installDate: '2026-04-20' }),
        buildJob({ jobNumber: '171700', installDate: '2026-04-22' }),
        buildJob({ jobNumber: '17170', installDate: '2026-04-01' })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSearchInput: '17170',
      initialJobSort: 'install_date_asc'
    });

    expect(findRenderedJobButtonIndex(html, '17170')).toBeLessThan(findRenderedJobButtonIndex(html, '171700'));
    expect(findRenderedJobButtonIndex(html, '171700')).toBeLessThan(findRenderedJobButtonIndex(html, '2171705'));
  });

  it('uses the selected sort as a tie-breaker within the same search match tier', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({ jobNumber: '171701', installDate: '2026-04-09' }),
        buildJob({ jobNumber: '171700', installDate: '2026-04-12' }),
        buildJob({ jobNumber: '17170', installDate: '2026-04-01' })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSearchInput: '17170',
      initialJobSort: 'install_date_asc'
    });

    expect(findRenderedJobButtonIndex(html, '17170')).toBeLessThan(findRenderedJobButtonIndex(html, '171701'));
    expect(findRenderedJobButtonIndex(html, '171701')).toBeLessThan(findRenderedJobButtonIndex(html, '171700'));
  });

  it('shows the completed empty state when no completed list jobs are returned', () => {
    useJobsListMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });

    const html = renderPage({ initialWorkflowView: 'completed', initialJobsViewMode: 'list' });

    expect(html).toContain('Completed Jobs');
    expect(html).toContain('No completed jobs found yet.');
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

    expect(html).toContain('Showing all completed jobs.');
    expect(html).toContain('Showing</span><strong class="hero-metric-value inventory-summary-value">1</strong>');
    expect(html).toContain('19339');
    expect(html).not.toContain('IL1-16961');
  });

  it('restores normal list sorting when the search is empty', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({ jobNumber: '200', installDate: '2026-03-22' }),
        buildJob({ jobNumber: '15', installDate: '2026-03-20' }),
        buildJob({ jobNumber: '1000', installDate: '2026-03-21' })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({
      initialJobsViewMode: 'list',
      initialJobSort: 'install_date_asc'
    });

    expect(findRenderedJobButtonIndex(html, '15')).toBeLessThan(findRenderedJobButtonIndex(html, '1000'));
    expect(findRenderedJobButtonIndex(html, '1000')).toBeLessThan(findRenderedJobButtonIndex(html, '200'));
  });

  it('shows all active jobs in list mode instead of a capped recent list', () => {
    useJobsListMock.mockReturnValue({
      data: [
        buildJob({ jobNumber: '1001', installDate: '2026-03-20' }),
        buildJob({ jobNumber: '1002', installDate: '2026-03-21' }),
        buildJob({ jobNumber: '1003', installDate: '2026-03-22' })
      ],
      isLoading: false,
      error: null
    });

    const html = renderPage({ initialJobsViewMode: 'list' });

    expect(html).toContain('All Active Jobs');
    expect(html).toContain('Showing all active jobs.');
    expect(html).toContain('Showing</span><strong class="hero-metric-value inventory-summary-value">3</strong>');
    expect(html).toContain('1001');
    expect(html).toContain('1002');
    expect(html).toContain('1003');
  });

  it('renders calendar week mode without calendar search controls', () => {
    const html = renderPage({
      initialJobsViewMode: 'calendar',
      initialCalendarGranularity: 'week',
      initialCalendarAnchorDate: '2026-03-24',
      initialJobSearchInput: '12345'
    });

    expect(html).toContain('aria-pressed="true">Calendar</button>');
    expect(html).toContain('option value="week" selected=""');
    expect(html).not.toContain('Search Job ID Number');
    expect(html).not.toContain('>Search</button>');
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-24', {
      enabled: true,
      lifecycleStatus: 'ACTIVE',
      warehouse: '',
      view: 'week'
    });
    expect(useJobsSearchMock).not.toHaveBeenCalled();
  });

  it('supports month calendar mode and keeps calendar search removed in completed workflow too', () => {
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
    expect(html).not.toContain('Search Job ID Number');
    expect(html).not.toContain('>Search</button>');
    expect(useJobsCalendarEntriesMock).toHaveBeenCalledWith('2026-03-24', {
      enabled: true,
      lifecycleStatus: 'COMPLETED',
      warehouse: '',
      view: 'month'
    });
    expect(useJobsSearchMock).not.toHaveBeenCalled();
  });
});
