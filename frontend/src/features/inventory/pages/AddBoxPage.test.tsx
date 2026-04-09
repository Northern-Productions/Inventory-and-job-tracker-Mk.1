// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const getFilmCatalogMock = vi.fn();

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
  getBox: vi.fn(),
  updateBox: vi.fn(),
  deleteBox: vi.fn(),
  setBoxStatus: vi.fn(),
  syncOfflineInventorySnapshot: vi.fn()
}));

vi.mock('../../../api/features/filmOrdersClient', () => ({
  getFilmCatalog: () => getFilmCatalogMock(),
  getFilmOrders: vi.fn(),
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
    jobNumber: '2941',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 72,
    requestedFeet: 123,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 123,
    jobDate: '2026-04-13',
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
      dueDate: filmOrder.jobDate,
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
      jobDate: filmOrder.jobDate,
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

describe('AddBoxPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    toastPushMock.mockReset();
    searchBoxesMock.mockReset();
    addBoxMock.mockReset();
    getFilmCatalogMock.mockReset();
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      hasFeatureAccess: () => true
    });
    getFilmCatalogMock.mockResolvedValue([]);
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

  it('keeps the ordinary add-box flow seeded at 100 LF', async () => {
    const queryClient = createQueryClient();
    searchBoxesMock.mockResolvedValue([buildBox()]);

    renderPage(queryClient);

    await waitFor(() => {
      expect(getInput('BoxID').value).toBe('IL1-0006');
    });
    expect(getInput('Initial Linear Feet').value).toBe('100');
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
        orderedFeet: 100,
        autoAllocatedFeet: 0
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
    ).toBe('ON_ORDER');

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
});
