// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilmOrderEntry } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import FilmOrdersPage from './FilmOrdersPage';

const navigateMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const getFilmOrdersMock = vi.fn();
const getFilmCatalogMock = vi.fn();
const createFilmOrderMock = vi.fn();
const cancelJobMock = vi.fn();
const deleteFilmOrderMock = vi.fn();
const useIsPhoneLayoutMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const JOB_ID = '11111111-1111-4111-8111-111111111111';

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

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => useIsPhoneLayoutMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../../../api/features/filmOrdersClient', () => ({
  getFilmOrders: (...args: unknown[]) => getFilmOrdersMock(...args),
  getFilmOrderDetail: () => Promise.reject(new Error('not used')),
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

type RenderPageOptions = {
  route?: string;
};

function renderPage(entries: FilmOrderEntry[], options: RenderPageOptions = {}) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(inventoryKeys.filmOrders, entries);
  queryClient.setQueryData(inventoryKeys.filmCatalog, []);

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route || '/film-orders']}>
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
    navigateMock.mockReset();
    toastPushMock.mockReset();
    getFilmOrdersMock.mockReset();
    getFilmCatalogMock.mockReset();
    createFilmOrderMock.mockReset();
    cancelJobMock.mockReset();
    deleteFilmOrderMock.mockReset();
    useIsPhoneLayoutMock.mockReset();
    useWarehouseRegistryMock.mockReset();
    getFilmOrdersMock.mockResolvedValue([]);
    getFilmCatalogMock.mockResolvedValue([]);
    useIsPhoneLayoutMock.mockReturnValue(false);
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
    useAuthMock.mockReturnValue({
      accessContext: {
        defaultWarehouse: ''
      },
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
      expect(deleteFilmOrderMock).toHaveBeenCalledWith({
        filmOrderId: 'FO-1',
        jobNumber: '2941',
        reason: 'Deleted from Film Orders (FO-1)'
      });
    });

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

  it('initializes the film orders warehouse filter from the saved default warehouse', async () => {
    useAuthMock.mockReturnValue({
      accessContext: {
        defaultWarehouse: 'MS1'
      },
      clientIdConfigured: true,
      isAuthenticated: true
    });

    renderPage([]);

    expect((screen.getByRole('combobox', { name: 'Warehouse' }) as HTMLSelectElement).value).toBe(
      'MS1'
    );
    await waitFor(() => {
      expect(getFilmOrdersMock).toHaveBeenCalledWith({ warehouse: 'MS1' });
    });
  });

  it('defaults the film orders status filter to Film Order when no explicit status is selected', () => {
    const entries = [
      buildFilmOrderEntry({ filmOrderId: 'FO-OPEN', filmName: 'Open Roll', status: 'FILM_ORDER' }),
      buildFilmOrderEntry({
        filmOrderId: 'FO-ON-WAY',
        filmName: 'On Way Roll',
        status: 'FILM_ON_THE_WAY',
        orderedFeet: 20,
        remainingToOrderFeet: 0
      }),
      buildFilmOrderEntry({ filmOrderId: 'FO-DONE', filmName: 'Done Roll', status: 'FULFILLED' })
    ];

    renderPage(entries);

    expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe(
      'FILM_ORDER'
    );
    expect(screen.getByText(/Open Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.queryByText(/On Way Roll/, { selector: 'td' })).toBeNull();
    expect(screen.queryByText(/Done Roll/, { selector: 'td' })).toBeNull();
  });

  it('preserves an explicit status filter from the route on first load', () => {
    const entries = [
      buildFilmOrderEntry({ filmOrderId: 'FO-OPEN', filmName: 'Open Roll', status: 'FILM_ORDER' }),
      buildFilmOrderEntry({
        filmOrderId: 'FO-ON-WAY',
        filmName: 'On Way Roll',
        status: 'FILM_ON_THE_WAY',
        orderedFeet: 20,
        remainingToOrderFeet: 0
      })
    ];

    renderPage(entries, { route: '/film-orders?status=FILM_ON_THE_WAY' });

    expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe(
      'FILM_ON_THE_WAY'
    );
    expect(screen.queryByText(/Open Roll/, { selector: 'td' })).toBeNull();
    expect(screen.getByText(/On Way Roll/, { selector: 'td' })).toBeTruthy();
  });

  it('keeps every film order status option available', () => {
    renderPage([]);

    const options = within(screen.getByRole('combobox', { name: 'Status' })).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      'All statuses',
      'Needs Ordering',
      'Film On The Way',
      'Fulfilled / Covered',
      'Manually Fulfilled',
      'Canceled'
    ]);
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

    const { container } = renderPage(
      [
        onTheWayOrder,
        datedLaterOrder,
        datedSoonerOrder,
        unscheduledShortage,
        resolvedOrder
      ],
      { route: '/film-orders?status=all' }
    );

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent?.trim())
    ).toEqual([
      'Status',
      'Warehouse',
      'Job ID',
      'Film',
      'Width',
      'Requested',
      'Ordered / Linked',
      'On The Way',
      'Received',
      'Covered / Allocated',
      'Remaining To Order',
      'Order Overage',
      'Ordered Box ID',
      'Install Date',
      'Created',
      'Dealer',
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

  it('uses the canonical job route when film order records include jobId', () => {
    renderPage([
      buildFilmOrderEntry({
        jobId: JOB_ID,
        jobNumber: '2941'
      })
    ]);

    expect(screen.getByRole('link', { name: 'IL1-2941' }).getAttribute('href')).toBe(
      `/allocations/jobs/${JOB_ID}`
    );
  });

  it('links compact film order rows to the detail page', () => {
    renderPage([buildFilmOrderEntry({ filmOrderId: 'FO-DETAIL' })]);

    const detailLink = screen.getByRole('link', { name: 'Open film order FO-DETAIL details' });
    expect(detailLink.getAttribute('href')).toBe('/film-orders/FO-DETAIL');
    expect(detailLink.textContent).toBe('Film Order');
    expect(screen.queryByRole('link', { name: 'FO-DETAIL' })).toBeNull();
  });

  it('uses canonical effective status, remaining LF, filters, and actions for list rows', () => {
    const fulfilledOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-COVERED',
      filmName: 'Covered Roll',
      status: 'FILM_ORDER',
      storedStatus: 'FILM_ORDER',
      displayStatus: 'FULFILLED_COVERED',
      linkedFeet: 60,
      orderedFeet: 60,
      receivedFeet: 60,
      onTheWayFeet: 0,
      coveredFeet: 60,
      orderOverageFeet: 0,
      neededFeet: 60,
      fulfilledFeet: 60,
      remainingFeet: 0,
      remainingToOrderFeet: 0
    });
    const incompleteOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-INCOMPLETE',
      filmName: 'Partial Roll',
      status: 'FILM_ORDER',
      storedStatus: 'FILM_ORDER',
      displayStatus: 'FILM_ORDER',
      linkedFeet: 20,
      orderedFeet: 20,
      receivedFeet: 0,
      onTheWayFeet: 20,
      coveredFeet: 0,
      orderOverageFeet: 0,
      neededFeet: 60,
      fulfilledFeet: 0,
      remainingFeet: 40,
      remainingToOrderFeet: 40
    });

    const { container } = renderPage([fulfilledOrder, incompleteOrder], {
      route: '/film-orders?status=all'
    });
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const fulfilledRow = rows.find((row) => row.textContent?.includes('Covered Roll'));
    const incompleteRow = rows.find((row) => row.textContent?.includes('Partial Roll'));

    expect(fulfilledRow).toBeTruthy();
    expect(incompleteRow).toBeTruthy();
    expect(within(fulfilledRow as HTMLTableRowElement).getByText('Fulfilled / Covered')).toBeTruthy();
    expect(fulfilledRow?.querySelector('td:nth-child(11)')?.textContent).toBe('0');
    expect(
      within(fulfilledRow as HTMLTableRowElement).queryByRole('button', { name: 'FILM ORDERED' })
    ).toBeNull();
    expect(within(incompleteRow as HTMLTableRowElement).getByText('Film Order')).toBeTruthy();
    expect(incompleteRow?.querySelector('td:nth-child(11)')?.textContent).toBe('40');
    expect(
      within(incompleteRow as HTMLTableRowElement).getByRole('button', { name: 'FILM ORDERED' })
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'FULFILLED_COVERED' }
    });
    expect(screen.getByText(/Covered Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.queryByText(/Partial Roll/, { selector: 'td' })).toBeNull();
  });

  it('maps the legacy fulfilled route filter to the canonical covered status', () => {
    renderPage(
      [
        buildFilmOrderEntry({
          filmOrderId: 'FO-COVERED',
          filmName: 'Covered Roll',
          status: 'FILM_ORDER',
          displayStatus: 'FULFILLED_COVERED',
          remainingFeet: 0
        })
      ],
      { route: '/film-orders?status=FULFILLED' }
    );

    expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe(
      'FULFILLED_COVERED'
    );
    expect(screen.getByText(/Covered Roll/, { selector: 'td' })).toBeTruthy();
  });

  it('filters film orders by status without changing warehouse query behavior', async () => {
    const entries = [
      buildFilmOrderEntry({ filmOrderId: 'FO-OPEN', filmName: 'Open Roll', status: 'FILM_ORDER' }),
      buildFilmOrderEntry({
        filmOrderId: 'FO-ON-WAY',
        filmName: 'On Way Roll',
        status: 'FILM_ON_THE_WAY',
        orderedFeet: 20,
        remainingToOrderFeet: 0
      }),
      buildFilmOrderEntry({ filmOrderId: 'FO-DONE', filmName: 'Done Roll', status: 'FULFILLED' })
    ];
    getFilmOrdersMock.mockResolvedValue(entries);

    renderPage(entries);

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'FILM_ON_THE_WAY' }
    });

    expect(screen.queryByText(/Open Roll/, { selector: 'td' })).toBeNull();
    expect(screen.getByText(/On Way Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.queryByText(/Done Roll/, { selector: 'td' })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Warehouse' }), {
      target: { value: 'MS1' }
    });

    await waitFor(() => {
      expect(getFilmOrdersMock).toHaveBeenCalledWith({ warehouse: 'MS1' });
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'all' }
    });

    expect(screen.getByText(/Open Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.getByText(/On Way Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.getByText(/Done Roll/, { selector: 'td' })).toBeTruthy();
  });

  it('shows Work Scope in desktop job labels without changing canonical links', () => {
    renderPage([
      buildFilmOrderEntry({
        jobId: JOB_ID,
        jobNumber: '2941',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5'
      })
    ]);

    expect(
      screen.getByRole('link', { name: /IL1-2941.*Sections 4, 5/ }).getAttribute('href')
    ).toBe(`/allocations/jobs/${JOB_ID}`);
  });

  it('sends jobId with Film Orders page delete payloads when available', async () => {
    const order = buildFilmOrderEntry({
      filmOrderId: 'FO-JOB-ID',
      jobId: JOB_ID,
      jobNumber: '2941'
    });
    deleteFilmOrderMock.mockResolvedValueOnce({
      result: order,
      warnings: []
    });

    renderPage([order]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete Film Order' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteFilmOrderMock).toHaveBeenCalledWith({
        jobId: JOB_ID,
        filmOrderId: 'FO-JOB-ID',
        jobNumber: '2941',
        reason: 'Deleted from Film Orders (FO-JOB-ID)'
      });
    });
  });

  it('renders the mobile job ID as a link', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    renderPage([
      buildFilmOrderEntry({
        linkedBoxes: [
          {
            boxId: 'IL1-0042',
            dealer: 'Eastman Performance Films',
            orderedFeet: 42,
            autoAllocatedFeet: 0,
            isReceived: true
          }
        ]
      })
    ]);

    expect(screen.getByRole('link', { name: 'Job IL1-2941' }).getAttribute('href')).toBe(
      '/allocations/2941'
    );
    expect(screen.getByText('Install Date')).toBeTruthy();
    expect(screen.getByText('Ordered Box ID')).toBeTruthy();
    expect(screen.getByText('Dealer')).toBeTruthy();
    expect(screen.getByText('Eastman Performance Films')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'IL1-0042' }).getAttribute('href')).toBe(
      '/inventory/IL1-0042'
    );
    expect(screen.getByLabelText('Received IL1-0042')).toBeTruthy();
  });

  it('renders the mobile job ID as a canonical link when jobId is available', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    renderPage([
      buildFilmOrderEntry({
        jobId: JOB_ID
      })
    ]);

    expect(screen.getByRole('link', { name: 'Job IL1-2941' }).getAttribute('href')).toBe(
      `/allocations/jobs/${JOB_ID}`
    );
  });

  it('shows Work Scope in mobile job labels without changing legacy links', () => {
    useIsPhoneLayoutMock.mockReturnValue(true);

    renderPage([
      buildFilmOrderEntry({
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5'
      })
    ]);

    expect(
      screen.getByRole('link', { name: /Job IL1-2941.*Sections 4, 5/ }).getAttribute('href')
    ).toBe('/allocations/2941');
  });

  it('shows linked ordered box ids and dealer text without exposing origin/source-box display', () => {
    renderPage([
      buildFilmOrderEntry({
        filmOrderId: 'FO-AUTO',
        filmName: 'Auto Roll',
        linkedBoxes: [
          {
            boxId: 'MS1-0042',
            dealer: 'Decorative Films',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0005',
            dealer: 'Accent',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: true
          },
          {
            boxId: 'IL1-0005',
            dealer: 'Accent',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ],
        sourceBoxId: 'IL1-6923'
      }),
      buildFilmOrderEntry({
        filmOrderId: 'FO-PLAIN',
        filmName: 'Plain Roll',
        linkedBoxes: [],
        sourceBoxId: ''
      })
    ]);

    expect(
      screen.getByText(
        'Film orders are created from explicit order actions in Film Orders before incoming boxes are added or received for the job.'
      )
    ).toBeTruthy();
    expect(screen.getAllByRole('columnheader', { name: 'Ordered Box ID' })[0]).toBeTruthy();
    expect(screen.queryByText('Origin')).toBeNull();
    expect(screen.queryByText('Auto shortage')).toBeNull();
    expect(screen.queryByText('Manual')).toBeNull();
    expect(screen.queryByText(/Source box:/)).toBeNull();
    expect(screen.getByText('Decorative Films, Accent')).toBeTruthy();
    expect(screen.getByText(/Plain Roll/, { selector: 'td' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Open film order .* details/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'FILM ORDERED' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getByLabelText('Received IL1-0005')).toBeTruthy();
    expect(screen.queryByLabelText('Received MS1-0042')).toBeNull();
    expect(screen.getByRole('link', { name: 'IL1-0005' }).getAttribute('href')).toBe(
      '/inventory/IL1-0005'
    );
    expect(screen.getByRole('link', { name: 'MS1-0042' }).getAttribute('href')).toBe(
      '/inventory/MS1-0042'
    );
    const manualRow = screen.getByText(/Plain Roll/, { selector: 'td' }).closest('tr');
    expect(manualRow).toBeTruthy();
    expect(within(manualRow as HTMLTableRowElement).getAllByText('--')).toHaveLength(2);
  });

  it('includes jobId in add-box film-order prefill links when available', () => {
    renderPage([
      buildFilmOrderEntry({
        jobId: JOB_ID,
        filmOrderId: 'FO-JOB-ID',
        jobNumber: '2941',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5'
      })
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'FILM ORDERED' }));

    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringContaining(`jobId=${encodeURIComponent(JOB_ID)}`)
    );
    expect(navigateMock).toHaveBeenCalledWith(expect.stringContaining('jobNumber=2941'));
    const target = String(navigateMock.mock.calls[0][0]);
    const params = new URL(target, 'https://example.test').searchParams;
    expect(params.get('workScope')).toBe('Sections 4, 5');
    expect(params.get('sections')).toBe('Sections 4, 5');
  });

  it('navigates into the first outstanding ordered box when RECEIVE is clicked', async () => {
    renderPage(
      [
        buildFilmOrderEntry({
          filmOrderId: 'FO-RECEIVE',
          status: 'FILM_ON_THE_WAY',
          orderedFeet: 60,
          remainingToOrderFeet: 0,
          linkedBoxes: [
            {
              boxId: 'IL1-0009',
              dealer: 'Eastman Performance Films',
              orderedFeet: 30,
              autoAllocatedFeet: 0,
              isReceived: true
            },
            {
              boxId: 'IL1-0010',
              dealer: 'Eastman Performance Films',
              orderedFeet: 30,
              autoAllocatedFeet: 0,
              isReceived: false
            }
          ]
        })
      ],
      { route: '/film-orders?status=FILM_ON_THE_WAY' }
    );

    fireEvent.click(screen.getByRole('button', { name: 'RECEIVE' }));

    expect(navigateMock).toHaveBeenCalledWith(
      '/inventory/IL1-0010?filmOrderId=FO-RECEIVE&receiveOrdered=1&returnTo=film-orders'
    );
  });
});
