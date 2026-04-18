// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilmOrderEntry } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import FilmOrdersPage from './FilmOrdersPage';

const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const getFilmOrdersMock = vi.fn();
const getFilmCatalogMock = vi.fn();
const createFilmOrderMock = vi.fn();
const cancelJobMock = vi.fn();
const deleteFilmOrderMock = vi.fn();
const useIsPhoneLayoutMock = vi.fn();

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

vi.mock('../../../api/features/filmOrdersClient', () => ({
  getFilmOrders: () => getFilmOrdersMock(),
  getFilmCatalog: () => getFilmCatalogMock(),
  createFilmOrder: (...args: unknown[]) => createFilmOrderMock(...args),
  cancelJob: (...args: unknown[]) => cancelJobMock(...args),
  deleteFilmOrder: (...args: unknown[]) => deleteFilmOrderMock(...args)
}));

function buildFilmOrderEntry(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '2941',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige Demo',
    widthIn: 72,
    requestedFeet: 60,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 60,
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

function renderPage(entries: FilmOrderEntry[]) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(inventoryKeys.filmOrders, entries);
  queryClient.setQueryData(inventoryKeys.filmCatalog, []);

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/film-orders']}>
        <FilmOrdersPage />
      </MemoryRouter>
    </QueryClientProvider>
  );

  return {
    ...view,
    queryClient
  };
}

describe('FilmOrdersPage', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    getFilmOrdersMock.mockReset();
    getFilmCatalogMock.mockReset();
    createFilmOrderMock.mockReset();
    cancelJobMock.mockReset();
    deleteFilmOrderMock.mockReset();
    useIsPhoneLayoutMock.mockReset();
    getFilmOrdersMock.mockResolvedValue([]);
    getFilmCatalogMock.mockResolvedValue([]);
    useIsPhoneLayoutMock.mockReturnValue(false);
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('removes the deleted film-order row immediately and keeps the remaining delete action enabled', async () => {
    const firstOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-1',
      filmName: 'Prestige Demo',
      createdAt: '2026-04-06T00:00:00Z'
    });
    const secondOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-2',
      filmName: 'Safety Shield Demo',
      widthIn: 60,
      requestedFeet: 24,
      remainingToOrderFeet: 24,
      createdAt: '2026-04-06T00:05:00Z'
    });
    const deleteDeferred = createDeferred<{ result: FilmOrderEntry; warnings: string[] }>();

    getFilmOrdersMock.mockResolvedValue([secondOrder]);
    deleteFilmOrderMock.mockImplementation(() => deleteDeferred.promise);

    renderPage([firstOrder, secondOrder]);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    const dialog = screen.getByRole('dialog', { name: 'Delete Film Order' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Prestige Demo')).toBeNull();
    });

    expect(screen.getByText(/Safety Shield Demo/, { selector: 'td' })).toBeTruthy();
    const remainingDeleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(remainingDeleteButtons).toHaveLength(1);
    expect(remainingDeleteButtons[0].hasAttribute('disabled')).toBe(false);

    deleteDeferred.resolve({
      result: firstOrder,
      warnings: []
    });

    await waitFor(() => {
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Deleted FO-1',
          variant: 'success'
        })
      );
    });
  });

  it('surfaces film orders that still need ordering before on-the-way entries and renders blue job links on desktop', () => {
    const onTheWayOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-1',
      jobNumber: '2941',
      filmName: 'Prestige On The Way',
      status: 'FILM_ON_THE_WAY',
      remainingToOrderFeet: 0,
      orderedFeet: 60,
      installDate: '2026-04-12',
      createdAt: '2026-04-06T00:00:00Z'
    });
    const datedLaterOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-2',
      jobNumber: '2942',
      filmName: 'Prestige Later',
      installDate: '2026-04-15',
      createdAt: '2026-04-06T00:01:00Z'
    });
    const datedSoonerOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-3',
      jobNumber: '2943',
      filmName: 'Prestige Sooner',
      installDate: '2026-04-13',
      createdAt: '2026-04-06T00:02:00Z'
    });
    const unscheduledShortage = buildFilmOrderEntry({
      filmOrderId: 'FO-4',
      jobNumber: '2944',
      filmName: 'Prestige Unscheduled',
      installDate: '',
      createdAt: '2026-04-06T00:00:30Z'
    });
    const resolvedOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-5',
      jobNumber: '2945',
      filmName: 'Prestige Resolved',
      status: 'FULFILLED',
      resolvedAt: '2026-04-06T05:00:00Z',
      createdAt: '2026-04-06T00:03:00Z'
    });

    const { container } = renderPage([
      onTheWayOrder,
      datedLaterOrder,
      datedSoonerOrder,
      unscheduledShortage,
      resolvedOrder
    ]);

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())
    ).toEqual([
      'Status',
      'Warehouse',
      'Job ID',
      'Film',
      'Width',
      'Need To Order',
      'Ordered Box ID',
      'Install Date',
      'Created',
      'Origin',
      'Actions'
    ]);
    expect(screen.getAllByRole('columnheader', { name: 'Install Date' })[0]).toBeTruthy();
    expect(screen.getByRole('link', { name: 'IL1-2943' }).getAttribute('href')).toBe('/allocations/2943');

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.querySelector('td:nth-child(3)')?.textContent?.trim())).toEqual([
      'IL1-2943',
      'IL1-2942',
      'IL1-2941',
      'IL1-2944',
      'IL1-2945'
    ]);
  });

  it('renders the mobile job ID as a link', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    renderPage([
      buildFilmOrderEntry({
        linkedBoxes: [{ boxId: 'IL1-0042', orderedFeet: 42, autoAllocatedFeet: 0, isReceived: true }]
      })
    ]);

    expect(screen.getByRole('link', { name: 'Job IL1-2941' }).getAttribute('href')).toBe(
      '/allocations/2941'
    );
    expect(screen.getByText('Install Date')).toBeTruthy();
    expect(screen.getByText('Ordered Box ID')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'IL1-0042' }).getAttribute('href')).toBe(
      '/inventory/IL1-0042'
    );
    expect(screen.getByLabelText('Received IL1-0042')).toBeTruthy();
  });

  it('shows linked ordered box ids as box-detail links while keeping shortage source boxes separate', () => {
    renderPage([
      buildFilmOrderEntry({
        filmOrderId: 'FO-AUTO',
        filmName: 'Auto Roll',
        linkedBoxes: [
          { boxId: 'MS1-0042', orderedFeet: 30, autoAllocatedFeet: 0, isReceived: false },
          { boxId: 'IL1-0005', orderedFeet: 30, autoAllocatedFeet: 0, isReceived: true },
          { boxId: 'IL1-0005', orderedFeet: 10, autoAllocatedFeet: 0, isReceived: false }
        ],
        sourceBoxId: 'IL1-6923'
      }),
      buildFilmOrderEntry({
        filmOrderId: 'FO-MANUAL',
        filmName: 'Manual Roll',
        linkedBoxes: [],
        sourceBoxId: ''
      })
    ]);

    expect(
      screen.getByText(
        'Manual orders are created from Film Orders. Auto shortage orders are created after return/weigh or schedule rebalance, not at checkout.'
      )
    ).toBeTruthy();
    expect(screen.getAllByRole('columnheader', { name: 'Ordered Box ID' })[0]).toBeTruthy();
    expect(screen.getByText('Auto shortage')).toBeTruthy();
    expect(screen.getByText('Source box: IL1-6923')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByLabelText('Received IL1-0005')).toBeTruthy();
    expect(screen.queryByLabelText('Received MS1-0042')).toBeNull();
    expect(screen.getByRole('link', { name: 'IL1-0005' }).getAttribute('href')).toBe(
      '/inventory/IL1-0005'
    );
    expect(screen.getByRole('link', { name: 'MS1-0042' }).getAttribute('href')).toBe(
      '/inventory/MS1-0042'
    );
    const manualRow = screen.getByText(/Manual Roll/, { selector: 'td' }).closest('tr');
    expect(manualRow).toBeTruthy();
    expect(within(manualRow as HTMLTableRowElement).getByText('--')).toBeTruthy();
  });
});
