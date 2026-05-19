// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const checkJobDuplicateMock = vi.fn();

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

vi.mock('../../../api/features/jobsClient', () => ({
  checkJobDuplicate: (...args: unknown[]) => checkJobDuplicateMock(...args)
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

function buildDuplicateResult(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    allowed: false,
    canCreate: false,
    duplicatesEnabled: false,
    reason: 'SAME_JOB_SCOPE_ACTIVE',
    blockingReason: 'SAME_JOB_SCOPE_ACTIVE',
    duplicateScopeMode: 'EXACT_SCOPE',
    job: null,
    existingJob: null,
    sameJobNumberJobs: [],
    exactScopeJobs: [],
    differentScopeJobs: [],
    exactScopeDuplicateExists: false,
    sameJobNumberDifferentScopeExists: false,
    futureCanCreateAfterEnablement: false,
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

async function openNewJobAndSaveDraft({
  jobNumber = '81234',
  workScope = ''
}: {
  jobNumber?: string;
  workScope?: string;
} = {}) {
  fireEvent.click(screen.getByRole('button', { name: 'New Job +' }));
  await screen.findByRole('heading', { name: 'New Job' });
  fireEvent.change(screen.getByLabelText(/Job ID number/), {
    target: { value: jobNumber }
  });
  if (workScope) {
    fireEvent.change(screen.getByLabelText(/Work Scope/), {
      target: { value: workScope }
    });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save Job' }));
}

describe('AllocationsPage interactions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    checkJobDuplicateMock.mockReset();
    checkJobDuplicateMock.mockResolvedValue({
      exists: false,
      allowed: true,
      canCreate: true,
      duplicatesEnabled: false,
      reason: 'NO_MATCH',
      job: null,
      sameJobNumberJobs: [],
      exactScopeJobs: [],
      differentScopeJobs: []
    });
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
    expect(Boolean(screen.getByRole('button', { name: 'IL1-16961 · 260' }))).toBe(true);
  });

  it('opens list jobs with the canonical jobId route when available', () => {
    renderPage({ initialJobsViewMode: 'list' });

    fireEvent.click(screen.getByRole('button', { name: 'IL1-16961 · 260' }));

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

  it('creates a unique labor-only job after duplicate preflight succeeds', async () => {
    const createMutation = buildMutationState();
    createMutation.mutateAsync.mockResolvedValue({
      result: {
        summary: {
          jobId: '33333333-3333-4333-8333-333333333333',
          jobNumber: '81234'
        }
      }
    });
    useCreateJobMock.mockReturnValue(createMutation);
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234', workScope: 'Lobby' });

    await waitFor(() => expect(checkJobDuplicateMock).toHaveBeenCalledWith('81234', {
      workScope: 'Lobby',
      sections: 'Lobby'
    }));
    expect(screen.getByRole('heading', { name: 'Labor-Only Job 81234?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Labor Only' }));

    await waitFor(() => expect(createMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        jobNumber: '81234',
        workScope: 'Lobby',
        isLaborOnly: true
      })
    ));
    expect(navigateMock).toHaveBeenCalledWith('/allocations/81234');
    expect(navigateMock).toHaveBeenCalledWith(
      '/allocations/jobs/33333333-3333-4333-8333-333333333333',
      { replace: true }
    );
  });

  it('blocks active duplicate job creation before mutation and keeps the draft editable', async () => {
    const createMutation = buildMutationState();
    const exactJob = buildJob({
      jobId: '44444444-4444-4444-8444-444444444444',
      jobNumber: '81234',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5',
      workScopeKey: 'section:4+section:5',
      lifecycleStatus: 'ACTIVE',
      status: 'READY'
    });
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue(buildDuplicateResult({
      job: exactJob,
      existingJob: exactJob,
      sameJobNumberJobs: [exactJob],
      exactScopeJobs: [exactJob],
      exactScopeDuplicateExists: true
    }));
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234', workScope: 'Sections 4, 5' });

    expect(await screen.findByRole('heading', {
      name: 'This job number already exists for this Work Scope.'
    })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Exact Work Scope match' })).toBeTruthy();
    expect(screen.getAllByText('Sections 4, 5').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /Labor-Only Job/ })).toBeNull();
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit New Job' }));

    expect(screen.getByRole('heading', { name: 'New Job' })).toBeTruthy();
    expect((screen.getByLabelText(/Job ID number/) as HTMLInputElement).value).toBe('81234');
    expect((screen.getByLabelText(/Work Scope/) as HTMLInputElement).value).toBe('Sections 4, 5');
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows different-scope duplicate context while keeping creation blocked', async () => {
    const createMutation = buildMutationState();
    const differentJob = buildJob({
      jobId: '47474747-4747-4747-8747-474747474747',
      jobNumber: '81234',
      workScope: 'Lobby',
      sections: 'Lobby',
      workScopeKey: 'scope:lobby',
      lifecycleStatus: 'ACTIVE',
      status: 'READY'
    });
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue(buildDuplicateResult({
      reason: 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED',
      blockingReason: 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED',
      duplicateScopeMode: 'DIFFERENT_SCOPE',
      job: differentJob,
      existingJob: differentJob,
      sameJobNumberJobs: [differentJob],
      differentScopeJobs: [differentJob],
      sameJobNumberDifferentScopeExists: true,
      futureCanCreateAfterEnablement: true
    }));
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234', workScope: 'Penthouse' });

    expect(await screen.findByRole('heading', {
      name: 'This job number exists with a different Work Scope.'
    })).toBeTruthy();
    expect(screen.getByText(
      'Same-number jobs with different Work Scopes are not enabled yet, so this job cannot be created. Edit the new job or open the existing job.'
    )).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Same number, different Work Scope' })).toBeTruthy();
    expect(screen.getAllByText('Lobby').length).toBeGreaterThan(0);
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('prioritizes exact-scope copy and shows different-scope jobs for mixed duplicate candidates', async () => {
    const createMutation = buildMutationState();
    const exactJob = buildJob({
      jobId: '48484848-4848-4848-8848-484848484848',
      jobNumber: '81234',
      workScope: 'Penthouse',
      sections: 'Penthouse',
      workScopeKey: 'scope:penthouse',
      lifecycleStatus: 'ACTIVE',
      status: 'READY'
    });
    const differentJob = buildJob({
      jobId: '49494949-4949-4949-8949-494949494949',
      jobNumber: '81234',
      workScope: 'Lobby',
      sections: 'Lobby',
      workScopeKey: 'scope:lobby',
      lifecycleStatus: 'ACTIVE',
      status: 'READY'
    });
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue(buildDuplicateResult({
      duplicateScopeMode: 'MIXED_SCOPE',
      job: exactJob,
      existingJob: exactJob,
      sameJobNumberJobs: [exactJob, differentJob],
      exactScopeJobs: [exactJob],
      differentScopeJobs: [differentJob],
      exactScopeDuplicateExists: true,
      sameJobNumberDifferentScopeExists: true
    }));
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234', workScope: 'Penthouse' });

    expect(await screen.findByRole('heading', {
      name: 'This job number already exists for this Work Scope.'
    })).toBeTruthy();
    expect(screen.getByText(
      'An exact Work Scope match exists, so creation is blocked. Other jobs with this number are shown for context.'
    )).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Exact Work Scope match' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Same number, different Work Scope' })).toBeTruthy();
    expect(screen.getAllByText('Penthouse').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Lobby').length).toBeGreaterThan(0);
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('labels blank work scope duplicates and keeps creation blocked', async () => {
    const createMutation = buildMutationState();
    const blankScopeJob = buildJob({
      jobId: '50505050-5050-4050-8050-505050505050',
      jobNumber: '81234',
      workScope: '',
      sections: '',
      workScopeKey: 'blank:',
      lifecycleStatus: 'ACTIVE',
      status: 'READY'
    });
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue(buildDuplicateResult({
      job: blankScopeJob,
      existingJob: blankScopeJob,
      sameJobNumberJobs: [blankScopeJob],
      exactScopeJobs: [blankScopeJob],
      exactScopeDuplicateExists: true
    }));
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234' });

    expect(await screen.findByRole('heading', {
      name: 'This job number already exists for this Work Scope.'
    })).toBeTruthy();
    expect(screen.getByText('Blank Work Scope')).toBeTruthy();
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('routes active duplicates to the canonical jobId route when requested', async () => {
    const createMutation = buildMutationState();
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue({
      exists: true,
      job: buildJob({
        jobId: '55555555-5555-4555-8555-555555555555',
        jobNumber: '81234',
        lifecycleStatus: 'ACTIVE',
        status: 'READY'
      })
    });
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234' });

    expect(await screen.findByRole('button', { name: 'Go to Existing Job' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Existing Job' }));

    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/allocations/jobs/55555555-5555-4555-8555-555555555555');
  });

  it('routes duplicate jobs by job number when jobId is missing', async () => {
    checkJobDuplicateMock.mockResolvedValue({
      exists: true,
      job: buildJob({
        jobId: undefined,
        jobNumber: '81234',
        lifecycleStatus: 'ACTIVE',
        status: 'READY'
      })
    });
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234' });

    expect(await screen.findByRole('button', { name: 'Go to Existing Job' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Existing Job' }));

    expect(navigateMock).toHaveBeenCalledWith('/allocations/81234');
  });

  it('blocks completed duplicate job creation with completed-job guidance', async () => {
    const createMutation = buildMutationState();
    const completedJob = buildJob({
      jobId: '66666666-6666-4666-8666-666666666666',
      jobNumber: '81234',
      workScope: 'Sections 9',
      sections: 'Sections 9',
      workScopeKey: 'section:9',
      lifecycleStatus: 'COMPLETED',
      status: 'COMPLETED'
    });
    useCreateJobMock.mockReturnValue(createMutation);
    checkJobDuplicateMock.mockResolvedValue(buildDuplicateResult({
      reason: 'SAME_JOB_SCOPE_COMPLETED',
      blockingReason: 'SAME_JOB_SCOPE_COMPLETED',
      job: completedJob,
      existingJob: completedJob,
      sameJobNumberJobs: [completedJob],
      exactScopeJobs: [completedJob],
      exactScopeDuplicateExists: true
    }));
    renderPage({ initialJobsViewMode: 'calendar' });

    await openNewJobAndSaveDraft({ jobNumber: '81234', workScope: 'Sections 9' });

    expect(await screen.findByRole('heading', {
      name: 'This job number was already completed for this Work Scope.'
    })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Exact Work Scope match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to Completed Job' })).toBeTruthy();
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });
});
