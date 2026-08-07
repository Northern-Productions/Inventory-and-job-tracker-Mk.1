// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Box, FilmOrderDetail } from '../../../domain';
import FilmOrderDetailsPage from './FilmOrderDetailsPage';

const getFilmOrderDetailMock = vi.fn();
const getBoxMock = vi.fn();
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

vi.mock('../../../api/features/inventoryClient', () => ({
  getBox: (...args: unknown[]) => getBoxMock(...args)
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
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 230,
    installDate: '2026-05-21',
    crewLeader: 'Napo',
    status: 'FILM_ORDER',
    storedStatus: 'FILM_ORDER',
    displayStatus: 'INCOMPLETE',
    needSource: 'CURRENT_REQUIREMENT',
    neededFeet: 230,
    fulfilledFeet: 100,
    remainingFeet: 130,
    overageFeet: 0,
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
        autoAllocatedFeet: 0,
        isReceived: true,
        isDirectToJobSite: false,
        initialFeet: 100,
        feetAvailable: 100,
        status: 'IN_STOCK',
        orderDate: '2026-05-18',
        receivedDate: '2026-05-20'
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

function buildBoxCost(boxId: string, purchaseCost: number | null): Box {
  return {
    boxId,
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Security',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 100,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-05-18',
    receivedDate: '2026-05-20',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3m|security',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
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
    getBoxMock.mockReset();
    manualFulfillFilmOrderMock.mockReset();
    toastPushMock.mockReset();
    getFilmOrderDetailMock.mockResolvedValue(buildDetail());
    getBoxMock.mockImplementation((boxId: string) => Promise.resolve(buildBoxCost(boxId, 1200)));
    manualFulfillFilmOrderMock.mockResolvedValue({
      result: {
        ...buildDetail(),
        status: 'FULFILLED'
      },
      warnings: ['Film order manually marked fulfilled. Linked boxes and physical LF were not changed.']
    });
  });

  it('renders dynamic need, fulfillment, box links, job link, and history', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'FO-1' })).toBeTruthy();
    expect(getFilmOrderDetailMock).toHaveBeenCalledWith('FO-1');
    await waitFor(() => expect(screen.getByText('Incomplete')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Fulfill Order' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Fulfill Order' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add Box' })).toBeNull();
    expect(screen.getByText('Current Needed LF')).toBeTruthy();
    expect(screen.getAllByText('230').length).toBeGreaterThan(0);
    expect(screen.getByText('130')).toBeTruthy();
    expect(screen.getByRole('link', { name: /IL1-4024 \/ Section 1/i }).getAttribute('href')).toBe(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getAllByRole('link', { name: 'IL1-100' }).some((link) => link.getAttribute('href') === '/inventory/IL1-100')
    ).toBe(true);
    expect(screen.getAllByRole('link', { name: 'IL1-100' })).toHaveLength(2);
    expect(screen.getByText('LINKED BOX INITIAL FEET CHANGED')).toBeTruthy();
  });

  it('does not offer manual fulfillment when canonical coverage already resolves the order', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        displayStatus: 'FULFILLED_COVERED',
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
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 100,
            feetAvailable: 100,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20'
          },
          {
            linkId: 'link-2',
            boxId: 'IL1-101',
            dealer: 'Dealer One',
            orderedFeet: 75,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20'
          }
        ]
      })
    );
    getBoxMock.mockImplementation((boxId: string) =>
      Promise.resolve(buildBoxCost(boxId, boxId === 'IL1-100' ? 1250 : 675.5))
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
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 100,
            feetAvailable: 100,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20'
          },
          {
            linkId: 'link-missing',
            boxId: 'IL1-MISSING',
            dealer: 'Dealer One',
            orderedFeet: 75,
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20'
          }
        ]
      })
    );
    getBoxMock.mockImplementation((boxId: string) =>
      Promise.resolve(buildBoxCost(boxId, boxId === 'IL1-ZERO' ? 0 : null))
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
            autoAllocatedFeet: 0,
            isReceived: true,
            isDirectToJobSite: false,
            initialFeet: 75,
            feetAvailable: 75,
            status: 'IN_STOCK',
            orderDate: '2026-05-18',
            receivedDate: '2026-05-20'
          }
        ]
      })
    );
    getBoxMock.mockResolvedValue(buildBoxCost('IL1-MISSING', null));

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

  it('shows no longer needed status when the linked requirement no longer matches', async () => {
    getFilmOrderDetailMock.mockResolvedValue(
      buildDetail({
        displayStatus: 'NO_LONGER_NEEDED',
        needSource: 'NO_LONGER_NEEDED',
        neededFeet: 0,
        fulfilledFeet: 100,
        remainingFeet: 0,
        overageFeet: 100,
        requirement: {
          requirementId: '22222222-2222-4222-8222-222222222222',
          phaseId: '33333333-3333-4333-8333-333333333333',
          manufacturer: '3M',
          filmName: 'Different Film',
          widthIn: 60,
          requiredFeet: 230,
          status: 'ACTIVE',
          matchesFilmOrder: false
        }
      })
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('No Longer Needed')).toBeTruthy());
    expect(screen.getByText(/not counted as current job demand/i)).toBeTruthy();
  });

  it('shows an empty connected-box state', async () => {
    getFilmOrderDetailMock.mockResolvedValue(buildDetail({ linkedBoxes: [], fulfilledFeet: 0 }));

    renderPage();

    const section = await screen.findByRole('heading', { name: 'Connected Boxes' });
    expect(within(section.closest('section') as HTMLElement).getByText(/No boxes are connected/i)).toBeTruthy();
  });
});
