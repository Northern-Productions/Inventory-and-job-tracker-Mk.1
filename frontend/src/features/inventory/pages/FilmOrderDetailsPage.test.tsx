// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilmOrderDetail } from '../../../domain';
import FilmOrderDetailsPage from './FilmOrderDetailsPage';

const getFilmOrderDetailMock = vi.fn();
const manualFulfillFilmOrderMock = vi.fn();
const toastPushMock = vi.fn();

vi.mock('../../../api/features/filmOrdersClient', () => ({
  getFilmOrderDetail: (...args: unknown[]) => getFilmOrderDetailMock(...args),
  getFilmCatalog: vi.fn(),
  getFilmOrders: vi.fn(),
  createFilmOrder: vi.fn(),
  cancelJob: vi.fn(),
  deleteFilmOrder: vi.fn(),
  manualFulfillFilmOrder: (...args: unknown[]) => manualFulfillFilmOrderMock(...args)
}));

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function buildDetail(overrides: Partial<FilmOrderDetail> = {}): FilmOrderDetail {
  return {
    filmOrderId: 'FO-1',
    jobId: '11111111-1111-4111-8111-111111111111',
    requirementId: '22222222-2222-4222-8222-222222222222',
    jobNumber: '4024',
    warehouse: 'IL1',
    workScope: 'Section 1',
    sections: 'Section 1',
    manufacturer: '3M',
    filmName: 'Security',
    widthIn: 60,
    requestedFeet: 230,
    linkedFeet: 100,
    coveredFeet: 0,
    orderedFeet: 100,
    receivedFeet: 100,
    onTheWayFeet: 0,
    remainingToOrderFeet: 130,
    orderOverageFeet: 0,
    completedFeet: 100,
    orderLedgerVersion: 'film-order-ledger-v1',
    installDate: '2026-05-21',
    crewLeader: 'Napo',
    status: 'FILM_ORDER',
    storedStatus: 'FILM_ORDER',
    displayStatus: 'FILM_ORDER',
    needSource: 'ORDER_REQUEST',
    neededFeet: 230,
    fulfilledFeet: 100,
    remainingFeet: 130,
    overageFeet: 0,
    requirementContextStatus: 'CURRENT',
    currentRequirement: {
      availability: 'CURRENT',
      requirementId: '22222222-2222-4222-8222-222222222222',
      requiredFeet: 230,
      allocatedFeet: 100,
      onTheWayFeet: 0,
      stillShortFeet: 130,
      status: 'ACTIVE'
    },
    sourceBoxId: '',
    createdAt: '2026-05-18T12:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    orderedDate: '2026-05-18',
    receivedDate: '2026-05-20',
    notes: '',
    job: {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4024',
      warehouse: 'IL1',
      workScope: 'Section 1',
      sections: 'Section 1'
    },
    phase: {
      phaseId: '33333333-3333-4333-8333-333333333333',
      phaseNumber: 1,
      workScope: 'Section 1',
      sections: 'Section 1',
      installDate: '2026-05-21',
      crewLeader: 'Napo'
    },
    requirement: {
      requirementId: '22222222-2222-4222-8222-222222222222',
      phaseId: '33333333-3333-4333-8333-333333333333',
      manufacturer: '3M',
      filmName: 'Security',
      widthIn: 60,
      requiredFeet: 230,
      status: 'ACTIVE',
      matchesFilmOrder: true
    },
    linkedBoxes: [
      {
        linkId: 'link-1',
        boxId: 'IL1-100',
        dealer: 'Dealer One',
        orderedFeet: 230,
        linkedFeet: 100,
        receivedFeet: 100,
        onTheWayFeet: 0,
        autoAllocatedFeet: 0,
        isReceived: true,
        isDirectToJobSite: false,
        initialFeet: 100,
        feetAvailable: 100,
        status: 'IN_STOCK',
        orderDate: '2026-05-18',
        receivedDate: '2026-05-20',
        initialCost: 1200
      }
    ],
    history: [
      {
        eventId: 'event-1',
        eventType: 'LINKED_BOX_INITIAL_FEET_CHANGED',
        filmOrderId: 'FO-1',
        relatedBoxId: 'IL1-100',
        actor: 'tester',
        note: 'Linked box initial LF changed.',
        createdAt: '2026-05-20T12:00:00Z',
        before: { boxId: 'IL1-100', initialFeet: 230, status: 'IN_STOCK' },
        after: { boxId: 'IL1-100', initialFeet: 100, status: 'IN_STOCK' }
      }
    ],
    ...overrides
  };
}

function renderPage() {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/film-orders/FO-1']}>
        <Routes>
          <Route path="/film-orders/:filmOrderId" element={<FilmOrderDetailsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('FilmOrderDetailsPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    getFilmOrderDetailMock.mockReset();
    manualFulfillFilmOrderMock.mockReset();
    toastPushMock.mockReset();
    getFilmOrderDetailMock.mockResolvedValue(buildDetail());
    manualFulfillFilmOrderMock.mockResolvedValue({
      result: {
        ...buildDetail(),
        status: 'FULFILLED'
      },
      warnings: ['Film order manually marked fulfilled. Linked boxes and physical LF were not changed.']
    });
  });

  it('renders the historical order ledger, current requirement, links, and history', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'FO-1' })).toBeTruthy();
    expect(getFilmOrderDetailMock).toHaveBeenCalledWith('FO-1');
    await waitFor(() => expect(screen.getByText('Film Order')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Fulfill Order' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Fulfill Order' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add Box' })).toBeNull();
    expect(screen.getByText('Requested LF')).toBeTruthy();
    expect(screen.getByText('Ordered / Linked LF')).toBeTruthy();
    expect(screen.getByText('Received LF')).toBeTruthy();
    expect(screen.getByText('Covered / Allocated LF')).toBeTruthy();
    expect(screen.getByText('Remaining To Order')).toBeTruthy();
    expect(screen.getByText('Order Overage')).toBeTruthy();
    expect(screen.getAllByText('230').length).toBeGreaterThan(0);
    expect(screen.getAllByText('130')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Current Requirement' })).toBeTruthy();
    expect(screen.getByText('Required LF')).toBeTruthy();
    expect(screen.getByText('Allocated LF')).toBeTruthy();
    expect(screen.getByText('Still Short LF')).toBeTruthy();
    expect(screen.getByRole('link', { name: /IL1-4024 \/ Section 1/i }).getAttribute('href')).toBe(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getAllByRole('link', { name: 'IL1-100' }).some((link) => link.getAttribute('href') === '/inventory/IL1-100')
    ).toBe(true);
    expect(screen.getAllByRole('link', { name: 'IL1-100' })).toHaveLength(2);
    expect(screen.getByText('LINKED BOX INITIAL FEET CHANGED')).toBeTruthy();
  });

  it('keeps a fully linked unreceived 12 LF order separate from its 36 LF requirement', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        requestedFeet: 12,
        linkedFeet: 12,
        orderedFeet: 12,
        receivedFeet: 0,
        onTheWayFeet: 12,
        coveredFeet: 0,
        remainingToOrderFeet: 0,
        orderOverageFeet: 0,
        completedFeet: 0,
        status: 'FILM_ON_THE_WAY',
        storedStatus: 'FILM_ON_THE_WAY',
        displayStatus: 'FILM_ON_THE_WAY',
        neededFeet: 12,
        fulfilledFeet: 0,
        remainingFeet: 0,
        currentRequirement: {
          availability: 'CURRENT',
          requirementId: '22222222-2222-4222-8222-222222222222',
          requiredFeet: 36,
          allocatedFeet: 24,
          onTheWayFeet: 12,
          stillShortFeet: 0,
          status: 'ACTIVE'
        },
        linkedBoxes: [
          {
            linkId: 'link-1',
            boxId: 'IL1-100',
            dealer: 'Dealer One',
            orderedFeet: 12,
            linkedFeet: 12,
            receivedFeet: 0,
            onTheWayFeet: 12,
            autoAllocatedFeet: 0,
            isReceived: false,
            isDirectToJobSite: false,
            initialFeet: 12,
            feetAvailable: 12,
            status: 'ORDERED',
            orderDate: '2026-05-18',
            receivedDate: null,
            initialCost: 1200
          }
        ]
      })
    );

    renderPage();

    expect(await screen.findByText('Film On The Way')).toBeTruthy();
    const orderMetrics = screen.getByText('Requested LF').closest('.metric-grid') as HTMLElement;
    expect(within(orderMetrics).getAllByText('12')).toHaveLength(3);
    expect(within(orderMetrics).getAllByText('0').length).toBeGreaterThanOrEqual(4);
    const requirementSection = screen.getByRole('heading', { name: 'Current Requirement' }).closest('section') as HTMLElement;
    expect(within(requirementSection).getByText('36')).toBeTruthy();
    expect(within(requirementSection).getByText('24')).toBeTruthy();
    expect(within(requirementSection).getByText('12')).toBeTruthy();
    expect(within(requirementSection).getByText('0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fulfill Order' })).toBeNull();
  });

  it('does not offer manual fulfillment when canonical coverage already resolves the order', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        displayStatus: 'FULFILLED_COVERED',
        status: 'FULFILLED',
        storedStatus: 'FULFILLED',
        remainingToOrderFeet: 0,
        completedFeet: 230,
        fulfilledFeet: 230,
        remainingFeet: 0
      })
    );

    renderPage();

    expect(await screen.findByText('Fulfilled / Covered')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fulfill Order' })).toBeNull();
  });

  it('renders connected box initial costs and a total for known costs', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        linkedBoxes: [
          {
            linkId: 'link-1',
            boxId: 'IL1-100',
            dealer: 'Dealer One',
            orderedFeet: 100,
            linkedFeet: 100,
            receivedFeet: 100,
            onTheWayFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 100,
            feetAvailable: 100,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20',
            initialCost: 1250
          },
          {
            linkId: 'link-2',
            boxId: 'IL1-101',
            dealer: 'Dealer One',
            orderedFeet: 75,
            linkedFeet: 75,
            receivedFeet: 75,
            onTheWayFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20',
            initialCost: 675.5
          }
        ]
      })
    );
    renderPage();

    const table = (await screen.findByRole('columnheader', { name: 'Initial Cost' })).closest(
      'table'
    ) as HTMLTableElement;
    expect(table).toBeTruthy();
    await waitFor(() => expect(within(table).getByText('$1,250.00')).toBeTruthy());
    expect(within(table).getByText('$675.50')).toBeTruthy();
    expect(within(table).getByText('Total Initial Cost')).toBeTruthy();
    expect(within(table).getByText('$1,925.50')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'IL1-100' }).getAttribute('href')).toBe('/inventory/IL1-100');
    expect(within(table).getByRole('link', { name: 'IL1-101' }).getAttribute('href')).toBe('/inventory/IL1-101');
  });

  it('keeps true zero costs distinct from missing connected box costs', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        linkedBoxes: [
          {
            linkId: 'link-zero',
            boxId: 'IL1-ZERO',
            dealer: 'Dealer One',
            orderedFeet: 100,
            linkedFeet: 100,
            receivedFeet: 100,
            onTheWayFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 100,
            feetAvailable: 100,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20',
            initialCost: 0
          },
          {
            linkId: 'link-missing',
            boxId: 'IL1-MISSING',
            dealer: 'Dealer One',
            orderedFeet: 75,
            linkedFeet: 75,
            receivedFeet: 75,
            onTheWayFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20',
            initialCost: null
          }
        ]
      })
    );
    renderPage();

    const table = (await screen.findByRole('columnheader', { name: 'Initial Cost' })).closest(
      'table'
    ) as HTMLTableElement;
    const zeroRow = within(table).getByRole('link', { name: 'IL1-ZERO' }).closest('tr') as HTMLTableRowElement;
    const missingRow = within(table).getByRole('link', { name: 'IL1-MISSING' }).closest('tr') as HTMLTableRowElement;
    const summaryRow = within(table).getByText('Total Initial Cost').closest('tr') as HTMLTableRowElement;

    await waitFor(() => expect(within(zeroRow).getByText('$0.00')).toBeTruthy());
    expect(within(missingRow).getByText('--')).toBeTruthy();
    expect(within(summaryRow).getByText('$0.00')).toBeTruthy();
    expect(within(summaryRow).getByText('(1 missing)')).toBeTruthy();
  });

  it('does not show a zero-dollar total when all connected box costs are missing', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        linkedBoxes: [
          {
            linkId: 'link-missing',
            boxId: 'IL1-MISSING',
            dealer: 'Dealer One',
            orderedFeet: 75,
            linkedFeet: 75,
            receivedFeet: 75,
            onTheWayFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20',
            initialCost: null
          }
        ]
      })
    );
    renderPage();

    const table = (await screen.findByRole('columnheader', { name: 'Initial Cost' })).closest(
      'table'
    ) as HTMLTableElement;
    const summaryRow = within(table).getByText('Total Initial Cost').closest('tr') as HTMLTableRowElement;

    await waitFor(() => expect(within(summaryRow).getByText('--')).toBeTruthy());
    expect(within(summaryRow).queryByText('$0.00')).toBeNull();
    expect(within(summaryRow).getByText('(1 missing)')).toBeTruthy();
  });

  it('confirms manual fulfillment without navigating to the Add Box flow', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Fulfill Order' }));

    expect(screen.getByRole('heading', { name: 'Fulfill Film Order' })).toBeTruthy();
    expect(screen.getByText('Do you want to consider this film order fulfilled?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(manualFulfillFilmOrderMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Fulfill Order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(manualFulfillFilmOrderMock).toHaveBeenCalledWith({
        filmOrderId: 'FO-1',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4024'
      })
    );
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Film order fulfilled',
        variant: 'success'
      })
    );
  });

  it('keeps the order status historical when the current requirement is unbound', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        status: 'FILM_ON_THE_WAY',
        storedStatus: 'FILM_ON_THE_WAY',
        displayStatus: 'FILM_ON_THE_WAY',
        needSource: 'ORDER_REQUEST',
        linkedFeet: 230,
        orderedFeet: 230,
        receivedFeet: 0,
        onTheWayFeet: 230,
        remainingToOrderFeet: 0,
        neededFeet: 230,
        fulfilledFeet: 0,
        remainingFeet: 0,
        overageFeet: 0,
        requirementContextStatus: 'HISTORICAL_UNBOUND',
        currentRequirement: { availability: 'HISTORICAL_UNBOUND' },
        requirement: null
      })
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Film On The Way')).toBeTruthy());
    expect(screen.getByText(/current requirement context is unavailable/i)).toBeTruthy();
    expect(screen.queryByText('No Longer Needed')).toBeNull();
  });

  it('shows an empty connected-box state', async () => {
    getFilmOrderDetailMock.mockResolvedValue(buildDetail({ linkedBoxes: [], fulfilledFeet: 0 }));

    renderPage();

    const section = await screen.findByRole('heading', { name: 'Connected Boxes' });
    expect(within(section.closest('section') as HTMLElement).getByText(/No boxes are connected/i)).toBeTruthy();
  });
});
