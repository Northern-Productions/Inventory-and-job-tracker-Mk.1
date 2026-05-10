// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { forwardRef, type PropsWithChildren } from 'react';
import AllocationsPage from './AllocationsPage';

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
  Link: forwardRef<HTMLAnchorElement, PropsWithChildren<{ to: string }>>(
    ({ to, children, ...props }, ref) => (
      <a ref={ref} href={to} {...props}>
        {children}
      </a>
    )
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

function buildCalendarQueryState(entries: ReturnType<typeof buildJob>[]) {
  return {
    data: entries,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    fetchStatus: 'idle',
    error: null
  };
}

function renderPage(props: {
  initialWorkflowView?: 'active' | 'completed';
  initialJobsViewMode?: 'list' | 'calendar';
  initialCalendarGranularity?: 'week' | 'month';
  initialJobSearchInput?: string;
  initialCalendarAnchorDate?: string;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AllocationsPage
        initialWorkflowView={props.initialWorkflowView}
        initialJobsViewMode={props.initialJobsViewMode}
        initialCalendarGranularity={props.initialCalendarGranularity}
        initialJobSearchInput={props.initialJobSearchInput}
        initialCalendarAnchorDate={props.initialCalendarAnchorDate ?? '2026-03-26'}
      />
    </QueryClientProvider>
  );

  return {
    ...rendered,
    queryClient
  };
}

describe('AllocationsPage interactions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    const activeListEntries = [
      buildJob({
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '16961',
        lifecycleStatus: 'ACTIVE',
        status: 'READY'
      })
    ];
    const completedListEntries = [
      buildJob({
        jobNumber: '26961',
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED'
      })
    ];
    const activeCalendarEntries = [
      buildJob({
        jobId: '22222222-2222-4222-8222-222222222222',
        jobNumber: '12345',
        lifecycleStatus: 'ACTIVE',
        status: 'READY'
      })
    ];
    const completedCalendarEntries = [
      buildJob({
        jobNumber: '32345',
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED'
      })
    ];
    const activeCalendarQueryState = buildCalendarQueryState(activeCalendarEntries);
    const completedCalendarQueryState = buildCalendarQueryState(completedCalendarEntries);
    const emptySearchQueryState = {
      data: [],
      isLoading: false,
      isFetching: false,
      error: null
    };

    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true
    });
    useJobsListMock.mockImplementation((_limit?: unknown, options?: { lifecycleStatus?: string; enabled?: boolean }) => ({
      data: options?.lifecycleStatus === 'COMPLETED' ? completedListEntries : activeListEntries,
      isLoading: false,
      error: null
    }));
    useJobsSearchMock.mockReturnValue(emptySearchQueryState);
    useJobsCalendarEntriesMock.mockImplementation(
      (_anchorDate?: unknown, options?: { lifecycleStatus?: string }) =>
        options?.lifecycleStatus === 'COMPLETED'
          ? completedCalendarQueryState
          : activeCalendarQueryState
    );
    useCreateJobMock.mockReturnValue(buildMutationState());
    useFilmCatalogMock.mockImplementation((options?: { enabled?: boolean }) => ({
      data: [],
      isLoading: options?.enabled === true,
      error: null
    }));
    useCaulkProductsMock.mockImplementation((options?: { enabled?: boolean }) => ({
      data: [],
      isLoading: options?.enabled === true,
      isError: false,
      error: null
    }));
  });

  it('does not enable the jobs list query until the user switches to list view', () => {
    renderPage({ initialJobsViewMode: 'calendar' });

    expect(useJobsListMock).toHaveBeenLastCalledWith(0, {
      enabled: false,
      lifecycleStatus: 'ACTIVE'
    });
    expect(screen.getByRole('button', { name: 'Calendar' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    expect(useJobsListMock).toHaveBeenLastCalledWith(0, {
      enabled: true,
      lifecycleStatus: 'ACTIVE'
    });
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(Boolean(screen.getByRole('button', { name: 'IL1-16961' }))).toBe(true);
  });

  it('opens list jobs with the canonical jobId route when available', () => {
    renderPage({ initialJobsViewMode: 'list' });

    fireEvent.click(screen.getByRole('button', { name: 'IL1-16961' }));

    expect(navigateMock).toHaveBeenCalledWith(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111'
    );
  });

  it('defers film catalog and caulk products until the New Job dialog opens and shows safe loading states', () => {
    renderPage({ initialJobsViewMode: 'calendar' });

    expect(useFilmCatalogMock).toHaveBeenLastCalledWith({ enabled: false });
    expect(useCaulkProductsMock).toHaveBeenLastCalledWith({ enabled: false });

    fireEvent.click(screen.getByRole('button', { name: 'New Job +' }));

    expect(useFilmCatalogMock).toHaveBeenLastCalledWith({ enabled: true });
    expect(useCaulkProductsMock).toHaveBeenLastCalledWith({ enabled: true });
    expect(Boolean(screen.getByRole('heading', { name: 'New Job' }))).toBe(true);
    expect(Boolean(screen.getByText('Loading film catalog...'))).toBe(true);
    expect((screen.getByRole('button', { name: 'Add Caulk Requirement' }) as HTMLButtonElement).disabled).toBe(true);
    expect(Boolean(screen.getByRole('combobox', { name: 'Manufacturer' }))).toBe(true);
  });
});
