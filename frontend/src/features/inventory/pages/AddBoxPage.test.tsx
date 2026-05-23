// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetail, Box, FilmOrderEntry, JobDetail } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import AddBoxPage from './AddBoxPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const searchBoxesMock = vi.fn();
const addBoxMock = vi.fn();
const listBoxDealersMock = vi.fn();
const upsertBoxDealerMock = vi.fn();
const getFilmCatalogMock = vi.fn();
const getFilmOrdersMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock
  };
});

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }]
  })
}));

vi.mock('../../../api/features/inventoryClient', () => ({
  searchBoxes: (...args: unknown[]) => searchBoxesMock(...args),
  addBox: (...args: unknown[]) => addBoxMock(...args),
  listBoxDealers: (...args: unknown[]) => listBoxDealersMock(...args),
  upsertBoxDealer: (...args: unknown[]) => upsertBoxDealerMock(...args),
  getBox: vi.fn(),
  updateBox: vi.fn(),
  deleteBox: vi.fn(),
  setBoxStatus: vi.fn(),
  syncOfflineInventorySnapshot: vi.fn()
}));

vi.mock('../../../api/features/filmOrdersClient', () => ({
  getFilmCatalog: () => getFilmCatalogMock(),
  getFilmOrders: () => getFilmOrdersMock(),
  getFilmOrderDetail: () => Promise.reject(new Error('not used')),
  createFilmOrder: vi.fn(),
  cancelJob: vi.fn(),
  deleteFilmOrder: vi.fn()
}));

vi.mock('../hooks/useInventoryOfflineSync', () => ({
  persistOfflineInventoryBox: vi.fn(),
  refreshOfflineInventoryQueries: vi.fn(),
  removeOfflineInventoryBox: vi.fn(),
  syncOfflineInventoryQueries: vi.fn()
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      },
      mutations: {
        retry: false
      }
    }
  });
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-0005',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 72,
    initialFeet: 100,
    feetAvailable: 100,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'ORDERED',
    orderDate: '2026-04-06',
    receivedDate: '',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function buildFilmOrderEntry(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    requirementId: 'req-1',
    jobNumber: '2941',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 72,
    requestedFeet: 123,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 123,
    installDate: '2026-04-13',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: '2026-04-06T00:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

function buildJobDetail(filmOrder: FilmOrderEntry): JobDetail {
  return {
    summary: {
      jobNumber: filmOrder.jobNumber,
      warehouse: filmOrder.warehouse,
      sections: null,
      installDate: filmOrder.installDate,
      crewLeader: filmOrder.crewLeader,
      status: 'FILM_ORDER' as JobDetail['summary']['status'],
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: filmOrder.requestedFeet,
      allocatedFeet: 0,
      remainingFeet: filmOrder.requestedFeet,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 1,
      allocationCount: 0,
      filmOrderCount: 1,
      hasOrderedAllocations: false,
      createdAt: '2026-04-06T00:00:00Z',
      updatedAt: '2026-04-06T00:00:00Z',
      notes: ''
    },
    requirements: [
      {
        requirementId: 'req-1',
        manufacturer: filmOrder.manufacturer,
        filmName: filmOrder.filmName,
        widthIn: filmOrder.widthIn,
        requiredFeet: filmOrder.requestedFeet,
        allocatedFeet: 0,
        remainingFeet: filmOrder.requestedFeet
      }
    ],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [filmOrder]
  };
}

function buildAllocationJobDetail(filmOrder: FilmOrderEntry): AllocationJobDetail {
  return {
    summary: {
      jobNumber: filmOrder.jobNumber,
      installDate: filmOrder.installDate,
      crewLeader: filmOrder.crewLeader,
      status: 'FILM_ORDER',
      activeAllocatedFeet: 0,
      fulfilledAllocatedFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      openFilmOrderCount: 1,
      boxCount: 0,
      hasOrderedAllocations: false
    },
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [filmOrder]
  };
}

function renderPage(
  queryClient: QueryClient,
  initialEntry = '/inventory/add'
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/inventory/add" element={<AddBoxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function getInput(label: string) {
  return screen.getAllByLabelText(label)[0] as HTMLInputElement;
}

const MISSING_DEALER_MESSAGE =
  "You didn't enter the dealer this film was purchased through. Enter a dealer or explain why there is no dealer.";

function fillRequiredCreateFields() {
  fireEvent.change(screen.getByLabelText('New Manufacturer'), {
    target: { value: '3M Solar' }
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Film Name' }), {
    target: { value: 'Prestige 60' }
  });
}

function submitMissingDealerDialog(options?: { comment?: string; dealerName?: string }) {
  const dialog = within(screen.getByRole('dialog'));

  if (options?.dealerName) {
    fireEvent.change(dialog.getByRole('combobox', { name: 'Dealer' }), {
      target: { value: '__add_new_dealer__' }
    });
    fireEvent.change(dialog.getByRole('textbox', { name: 'New Dealer' }), {
      target: { value: options.dealerName }
    });
  }

  if (options?.comment !== undefined) {
    fireEvent.change(dialog.getByRole('textbox', { name: 'Comment' }), {
      target: { value: options.comment }
    });
  }

  fireEvent.click(dialog.getByRole('button', { name: 'Submit' }));
}

describe('AddBoxPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    searchBoxesMock.mockReset();
    addBoxMock.mockReset();
    listBoxDealersMock.mockReset();
    upsertBoxDealerMock.mockReset();
    getFilmCatalogMock.mockReset();
    getFilmOrdersMock.mockReset();
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      hasFeatureAccess: () => true
    });
    getFilmCatalogMock.mockResolvedValue([]);
    getFilmOrdersMock.mockResolvedValue([]);
    listBoxDealersMock.mockResolvedValue([]);
    upsertBoxDealerMock.mockImplementation(async ({ name }: { name: string }) => ({
      dealerId: `dealer-${String(name).trim().toLowerCase().replace(/\s+/g, '-')}`,
      name: String(name).trim(),
      lookupKey: String(name).trim().toLowerCase().replace(/\s+/g, '-'),
      updatedAt: '2026-04-18T10:00:00Z'
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows remaining-to-order footage as reference and leaves the film-order LF input blank', async () => {
    const queryClient = createQueryClient();
    const existingBoxes = [buildBox()];
    searchBoxesMock.mockResolvedValue(existingBoxes);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    expect(await screen.findByText('Film Order Intake')).toBeTruthy();
    expect(screen.getByText('Remaining To Order LF')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy();
    expect((screen.getByLabelText('Initial Linear Feet') as HTMLInputElement).value).toBe('');
  });

  it('shows Work Scope from film-order prefill query params', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&workScope=Sections%204%2C%205&sections=Sections%204%2C%205&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    expect((await screen.findAllByText(/IL1-2941.*Sections 4, 5/)).length).toBeGreaterThan(0);
  });

  it('prefers Work Scope from the loaded linked film order over query params', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);
    getFilmOrdersMock.mockResolvedValue([
      buildFilmOrderEntry({
        workScope: 'Lobby Glass',
        sections: 'Lobby Glass'
      })
    ]);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&workScope=Old%20Scope&sections=Old%20Scope&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    expect((await screen.findAllByText(/IL1-2941.*Lobby Glass/)).length).toBeGreaterThan(0);
  });

  it('keeps the ordinary add-box flow seeded at 100 LF', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });
    expect(getInput('Initial Linear Feet').value).toBe('100');
  });

  it('auto-populates BoxID for normal Add Box even when the warehouse list is already cached', async () => {
    const queryClient = createQueryClient();
    const cachedBoxes = [buildBox()];
    queryClient.setQueryData(inventoryKeys.list({ warehouse: 'IL1', showRetired: false }), cachedBoxes);
    searchBoxesMock.mockResolvedValue(cachedBoxes);

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });
    expect(getInput('Initial Linear Feet').value).toBe('100');
  });

  it('auto-populates BoxID for film-order intake when the warehouse list is already cached and keeps the prefilled fields', async () => {
    const queryClient = createQueryClient();
    const cachedBoxes = [buildBox()];
    queryClient.setQueryData(inventoryKeys.list({ warehouse: 'IL1', showRetired: false }), cachedBoxes);
    searchBoxesMock.mockResolvedValue(cachedBoxes);
    getFilmOrdersMock.mockResolvedValue([buildFilmOrderEntry()]);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });
    expect(screen.getByText('Film Order Intake')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement).value).toBe('Prestige 60');
    expect((screen.getByRole('checkbox', { name: 'Ship Directly to Job Site' }) as HTMLInputElement).checked).toBe(false);
  });

  it('lets film-order intake users manually edit BoxID after the next BoxID is suggested', async () => {
    const queryClient = createQueryClient();
    const cachedBoxes = [buildBox()];
    queryClient.setQueryData(inventoryKeys.list({ warehouse: 'IL1', showRetired: false }), cachedBoxes);
    searchBoxesMock.mockResolvedValue(cachedBoxes);
    getFilmOrdersMock.mockResolvedValue([buildFilmOrderEntry()]);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fireEvent.change(getInput('BoxID'), {
      target: { value: 'IL1-0099' }
    });

    expect(getInput('BoxID').value).toBe('IL1-0099');
    expect((screen.getByRole('checkbox', { name: 'Ship Directly to Job Site' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement).value).toBe('Prestige 60');
  });

  it('keeps film-order intake on the form after a partial receipt, updates caches, and advances the next box id', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const initialBoxes = [buildBox()];
    let boxSearchResults = [...initialBoxes];
    const searchKey = inventoryKeys.list({ warehouse: 'IL1', showRetired: false });
    const deferred = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();

    queryClient.setQueryData(searchKey, initialBoxes);
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job(filmOrder.jobNumber), buildJobDetail(filmOrder));
    queryClient.setQueryData(
      inventoryKeys.allocationJob(filmOrder.jobNumber),
      buildAllocationJobDetail(filmOrder)
    );
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      buildAllocationJobDetail(filmOrder).summary
    ]);

    searchBoxesMock.mockImplementation(async () => [...boxSearchResults]);
    addBoxMock.mockImplementation(() =>
      deferred.promise.then((response) => {
        boxSearchResults = [...boxSearchResults, response.result.box];
        return response;
      })
    );

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fireEvent.change(getInput('Initial Linear Feet'), {
      target: { value: '100' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(await screen.findByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog();

    await waitFor(() => {
      const optimisticBoxes = queryClient.getQueryData<Box[]>(searchKey) || [];
      expect(optimisticBoxes.some((entry) => entry.boxId === 'IL1-0006')).toBe(true);
    });

    const optimisticFilmOrder = queryClient
      .getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)
      ?.find((entry) => entry.filmOrderId === 'FO-1');
    expect(optimisticFilmOrder?.orderedFeet).toBe(100);
    expect(optimisticFilmOrder?.remainingToOrderFeet).toBe(23);
    expect(optimisticFilmOrder?.status).toBe('FILM_ORDER');
    expect(optimisticFilmOrder?.linkedBoxes).toEqual([
      {
        boxId: 'IL1-0006',
        dealer: '',
        orderedFeet: 100,
        autoAllocatedFeet: 0,
        isReceived: false
      }
    ]);
    expect(
      queryClient.getQueryData<JobDetail>(inventoryKeys.job('2941'))?.filmOrders[0].remainingToOrderFeet
    ).toBe(23);

    deferred.resolve({
      result: {
        box: buildBox({
          boxId: 'IL1-0006',
          initialFeet: 100,
          feetAvailable: 100,
          notes: 'Ordered for job 2941 via FO-1'
        }),
        logId: 'log-1'
      },
      warnings: []
    });

    await waitFor(() => {
      expect(getInput('Initial Linear Feet').value).toBe('');
    });
    expect(screen.getByText('23')).toBeTruthy();
    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0007');
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows the covered toast and redirects to the job page after 2 seconds when the receipt closes the order', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const initialBoxes = [buildBox()];
    let boxSearchResults = [...initialBoxes];
    const searchKey = inventoryKeys.list({ warehouse: 'IL1', showRetired: false });
    const deferred = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();

    queryClient.setQueryData(searchKey, initialBoxes);
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job(filmOrder.jobNumber), buildJobDetail(filmOrder));
    queryClient.setQueryData(
      inventoryKeys.allocationJob(filmOrder.jobNumber),
      buildAllocationJobDetail(filmOrder)
    );
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      buildAllocationJobDetail(filmOrder).summary
    ]);

    searchBoxesMock.mockImplementation(async () => [...boxSearchResults]);
    addBoxMock.mockImplementation(() =>
      deferred.promise.then((response) => {
        boxSearchResults = [...boxSearchResults, response.result.box];
        return response;
      })
    );

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    vi.useFakeTimers();

    fireEvent.change(getInput('Initial Linear Feet'), {
      target: { value: '125' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(screen.getByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog();

    await act(async () => {
      await Promise.resolve();
    });

    expect(queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)?.[0].status).toBe(
      'FILM_ON_THE_WAY'
    );
    expect(
      queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)?.[0].remainingToOrderFeet
    ).toBe(0);
    expect(
      queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob('2941'))?.summary.status
    ).toBe('ORDERED');

    deferred.resolve({
      result: {
        box: buildBox({
          boxId: 'IL1-0006',
          initialFeet: 125,
          feetAvailable: 125,
          notes: 'Ordered for job 2941 via FO-1'
        }),
        logId: 'log-1'
      },
      warnings: []
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Film Order Covered',
        description: 'closing order',
        durationMs: 2000,
        variant: 'success'
      })
    );
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(navigateMock).toHaveBeenCalledWith('/allocations/2941', { replace: true });
  });

  it('uses canonical job identity for film-order cover invalidation and redirect when jobId is prefilled', async () => {
    const queryClient = createQueryClient();
    const jobId = '11111111-1111-4111-8111-111111111111';
    const filmOrder = buildFilmOrderEntry({ jobId });
    const initialBoxes = [buildBox()];
    const searchKey = inventoryKeys.list({ warehouse: 'IL1', showRetired: false });
    const deferred = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    queryClient.setQueryData(searchKey, initialBoxes);
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job(filmOrder.jobNumber), buildJobDetail(filmOrder));
    queryClient.setQueryData(
      inventoryKeys.allocationJob(filmOrder.jobNumber),
      buildAllocationJobDetail(filmOrder)
    );

    searchBoxesMock.mockResolvedValue(initialBoxes);
    addBoxMock.mockImplementation(() => deferred.promise);

    renderPage(
      queryClient,
      `/inventory/add?filmOrderId=FO-1&jobId=${jobId}&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1`
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    vi.useFakeTimers();

    fireEvent.change(getInput('Initial Linear Feet'), {
      target: { value: '125' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(screen.getByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog();

    deferred.resolve({
      result: {
        box: buildBox({
          boxId: 'IL1-0006',
          initialFeet: 125,
          feetAvailable: 125,
          notes: 'Ordered for job 2941 via FO-1'
        }),
        logId: 'log-1'
      },
      warnings: []
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: inventoryKeys.jobById(jobId) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: inventoryKeys.job('2941') });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(navigateMock).toHaveBeenCalledWith(`/allocations/jobs/${jobId}`, { replace: true });
  });

  it('keeps the draft on the film-order intake page and rolls optimistic changes back when the add fails', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const initialBoxes = [buildBox()];
    const searchKey = inventoryKeys.list({ warehouse: 'IL1', showRetired: false });
    const deferred = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();

    queryClient.setQueryData(searchKey, initialBoxes);
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job(filmOrder.jobNumber), buildJobDetail(filmOrder));
    queryClient.setQueryData(
      inventoryKeys.allocationJob(filmOrder.jobNumber),
      buildAllocationJobDetail(filmOrder)
    );

    searchBoxesMock.mockImplementation(async () => [...initialBoxes]);
    addBoxMock.mockImplementation(() => deferred.promise);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fireEvent.change(getInput('Initial Linear Feet'), {
      target: { value: '100' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(await screen.findByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog();

    await waitFor(() => {
      const optimisticBoxes = queryClient.getQueryData<Box[]>(searchKey) || [];
      expect(optimisticBoxes.some((entry) => entry.boxId === 'IL1-0006')).toBe(true);
    });

    deferred.reject(new Error('The request failed.'));

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Unable to add box',
          variant: 'error'
        })
      );
    });

    expect(getInput('Initial Linear Feet').value).toBe('100');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<Box[]>(searchKey)).toEqual(initialBoxes);
    expect(
      queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)?.[0].remainingToOrderFeet
    ).toBe(123);
    expect(
      queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)?.[0].linkedBoxes
    ).toEqual([]);
  });

  it('shows Ship Directly to Job Site only for film-order intake and submits the approved flag without optimistic stock changes', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const initialBoxes = [buildBox()];
    const searchKey = inventoryKeys.list({ warehouse: 'IL1', showRetired: false });
    const deferred = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();

    queryClient.setQueryData(searchKey, initialBoxes);
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    getFilmOrdersMock.mockResolvedValue([filmOrder]);
    searchBoxesMock.mockResolvedValue(initialBoxes);
    addBoxMock.mockImplementation(() => deferred.promise);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    expect(await screen.findByRole('checkbox', { name: 'Ship Directly to Job Site' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Ship Directly to Job Site' })).toBeTruthy();

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship Directly to Job Site' }));
    fireEvent.change(getInput('Initial Linear Feet'), {
      target: { value: '100' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(await screen.findByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog();

    await waitFor(() => {
      expect(addBoxMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filmOrderId: 'FO-1',
          shipDirectToJobSite: true
        })
      );
    });
    expect(queryClient.getQueryData<Box[]>(searchKey)).toEqual(initialBoxes);

    deferred.resolve({
      result: {
        box: buildBox({
          boxId: 'IL1-0006',
          status: 'CHECKED_OUT',
          directToJobSite: true,
          initialFeet: 100,
          feetAvailable: 0,
          lastCheckoutJob: '2941',
          lastCheckoutDate: '2026-04-13'
        }),
        logId: 'log-direct-1'
      },
      warnings: []
    });

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Added IL1-0006',
          variant: 'success'
        })
      );
    });
  });

  it('disables Ship Directly to Job Site when the linked Film Order has no install date', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry({ installDate: '' });

    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    getFilmOrdersMock.mockResolvedValue([filmOrder]);
    searchBoxesMock.mockResolvedValue([buildBox()]);

    renderPage(
      queryClient,
      '/inventory/add?filmOrderId=FO-1&jobNumber=2941&warehouse=IL1&manufacturer=3M%20Solar&filmName=Prestige%2060&width=72&remainingToOrderFeet=123&notes=Ordered%20for%20job%202941%20via%20FO-1'
    );

    const checkbox = (await screen.findByRole('checkbox', {
      name: 'Ship Directly to Job Site'
    })) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(
      screen.getByText(
        'Film Order FO-1 needs an Install Date before Ship Directly to Job Site can be used.'
      )
    ).toBeTruthy();
  });

  it('saves a new dealer before creating the box and carries the saved name into the add payload', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);
    addBoxMock.mockResolvedValue({
      result: {
        box: buildBox({ boxId: 'IL1-0006', dealer: 'Decorative Films' }),
        logId: 'log-1'
      },
      warnings: []
    });

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fireEvent.change(screen.getByLabelText('New Manufacturer'), {
      target: { value: '3M Solar' }
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Film Name' }), {
      target: { value: 'Prestige 60' }
    });
    fireEvent.change(screen.getByRole('combobox', { name: /Dealer/ }), {
      target: { value: '__add_new_dealer__' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: /New Dealer/ }), {
      target: { value: '  Decorative Films  ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));

    await waitFor(() => {
      expect(upsertBoxDealerMock).toHaveBeenCalledWith({ name: 'Decorative Films' });
    });
    await waitFor(() => {
      expect(addBoxMock).toHaveBeenCalledWith(expect.objectContaining({ dealer: 'Decorative Films' }));
    });
  });

  it('forwards the no-dealer modal comment as audit history text on create', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);
    addBoxMock.mockResolvedValue({
      result: {
        box: buildBox({ boxId: 'IL1-0006' }),
        logId: 'log-1'
      },
      warnings: []
    });

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fillRequiredCreateFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(screen.getByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog({ comment: 'Purchased from inherited stock with no vendor listed.' });

    await waitFor(() => {
      expect(addBoxMock).toHaveBeenCalledWith(
        expect.objectContaining({
          dealer: '',
          auditNote: 'Purchased from inherited stock with no vendor listed.'
        })
      );
    });
  });

  it('uses the modal-entered dealer through the existing dealer upsert flow', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);
    addBoxMock.mockResolvedValue({
      result: {
        box: buildBox({ boxId: 'IL1-0006', dealer: 'Decorative Films' }),
        logId: 'log-1'
      },
      warnings: []
    });

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fillRequiredCreateFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    expect(screen.getByText(MISSING_DEALER_MESSAGE)).toBeTruthy();
    submitMissingDealerDialog({ dealerName: 'Decorative Films' });

    await waitFor(() => {
      expect(upsertBoxDealerMock).toHaveBeenCalledWith({ name: 'Decorative Films' });
    });
    await waitFor(() => {
      expect(addBoxMock).toHaveBeenCalledWith(expect.objectContaining({ dealer: 'Decorative Films' }));
    });
  });

  it('keeps the regular add flow navigating to Box Details after a successful create', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);
    listBoxDealersMock.mockResolvedValue([
      {
        dealerId: 'dealer-1',
        name: 'Eastman Performance Films',
        lookupKey: 'eastman-performance-films',
        updatedAt: '2026-04-18T10:00:00Z'
      }
    ]);
    addBoxMock.mockResolvedValue({
      result: {
        box: buildBox({ boxId: 'IL1-0006', dealer: 'Eastman Performance Films' }),
        logId: 'log-1'
      },
      warnings: []
    });

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });

    fillRequiredCreateFields();
    fireEvent.change(screen.getByRole('combobox', { name: /Dealer/ }), {
      target: { value: 'Eastman Performance Films' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/inventory/IL1-0006?showQr=1');
    });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/inventory/IL1-0006?showQr=1', { replace: true });
    });
  });
});
