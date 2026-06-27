// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Box, BoxMutationResult, BoxTransferMutationResult, BoxStatus, UpdateBoxPayload } from '../../../domain';
import BoxDetailsPage from './BoxDetailsPage';

const navigateMock = vi.fn();
const setSearchParamsMock = vi.fn();
const toastPushMock = vi.fn();
const useAuthMock = vi.fn();
const useBoxMock = vi.fn();
const useBoxAllocationsMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useIsAddBoxPendingMock = vi.fn();
const useDeleteBoxMock = vi.fn();
const useBoxTransferMock = vi.fn();
const useBoxTransferPlanMock = vi.fn();
const useStartBoxTransferMock = vi.fn();
const useReceiveBoxTransferMock = vi.fn();
const useCancelBoxTransferMock = vi.fn();
const useBoxDealersMock = vi.fn();
const useOwnerCompaniesMock = vi.fn();
const useFilmOrdersMock = vi.fn();
const useJobSummariesByNumbersMock = vi.fn();
const useReceiveOrderedBoxMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
const useUndoAuditMock = vi.fn();
const useUpsertBoxDealerMock = vi.fn();
const useUpdateBoxMock = vi.fn();
const useChangeFilmBoxOwnerMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const parseUpdateBoxDraftMock = vi.fn();
const qrCodeToDataUrlMock = vi.fn();
let nextBoxFormSubmitDraft: unknown = { dealer: '' };
let currentSearchParams = '';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ boxId: 'IL1-1234' }),
    useSearchParams: () => [new URLSearchParams(currentSearchParams), setSearchParamsMock]
  };
});

vi.mock('qrcode', () => ({
  default: {
    toDataURL: (...args: unknown[]) => qrCodeToDataUrlMock(...args)
  }
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
  useBox: () => useBoxMock(),
  useBoxTransfer: () => useBoxTransferMock(),
  useBoxTransferPlan: (params: unknown) => useBoxTransferPlanMock(params),
  useBoxAllocations: () => useBoxAllocationsMock(),
  useBoxDealers: () => useBoxDealersMock(),
  useOwnerCompanies: () => useOwnerCompaniesMock(),
  useFilmCatalog: () => useFilmCatalogMock(),
  useFilmOrders: () => useFilmOrdersMock(),
  useIsAddBoxPending: () => useIsAddBoxPendingMock(),
  useDeleteBox: () => useDeleteBoxMock(),
  useStartBoxTransfer: () => useStartBoxTransferMock(),
  useReceiveBoxTransfer: () => useReceiveBoxTransferMock(),
  useCancelBoxTransfer: () => useCancelBoxTransferMock(),
  useJobSummariesByNumbers: () => useJobSummariesByNumbersMock(),
  useReceiveOrderedBox: () => useReceiveOrderedBoxMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
  useUndoAudit: () => useUndoAuditMock(),
  useUpsertBoxDealer: () => useUpsertBoxDealerMock(),
  useUpdateBox: () => useUpdateBoxMock(),
  useChangeFilmBoxOwner: () => useChangeFilmBoxOwnerMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../schemas/boxSchemas', () => ({
  parseUpdateBoxDraft: (...args: unknown[]) => parseUpdateBoxDraftMock(...args)
}));

vi.mock('../components/BoxForm', () => ({
  BoxForm: ({
    onSubmit,
    onTransferBox
  }: {
    onSubmit: (draft: unknown) => void;
    onTransferBox?: () => void;
  }) => (
    <div data-testid="box-form">
      <button type="button" onClick={() => onSubmit(nextBoxFormSubmitDraft)}>
        Submit Mock Edit
      </button>
      {onTransferBox ? (
        <button type="button" onClick={onTransferBox}>
          Transfer Box
        </button>
      ) : null}
    </div>
  )
}));

vi.mock('../components/AllocationsPanel', () => ({
  AllocationsPanel: ({
    boxId,
    collapsed
  }: {
    boxId: string;
    collapsed: boolean;
  }) => (
    <section data-testid="allocations-panel">
      <h2>Allocations</h2>
      <span>{`${boxId}:${String(collapsed)}`}</span>
    </section>
  )
}));

vi.mock('../components/HistoryPanel', () => ({
  HistoryPanel: ({
    boxId,
    collapsed
  }: {
    boxId: string;
    collapsed: boolean;
  }) => <div data-testid="history-panel">{`${boxId}:${String(collapsed)}`}</div>
}));

afterEach(() => {
  cleanup();
});

function buildMutationState() {
  return {
    mutateAsync: vi.fn(),
    isPending: false
  };
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-1234',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M',
    filmName: 'Ultra 70',
    widthIn: 30,
    initialFeet: 500,
    feetAvailable: 420,
    allocationPlanningFeet: 420,
    lotRun: 'LR-1',
    status: 'IN_STOCK',
    orderDate: '2026-03-20',
    receivedDate: '2026-03-21',
    initialWeightLbs: 12.5,
    lastRollWeightLbs: 11.9,
    lastWeighedDate: '2026-03-22',
    filmKey: '3m-ultra-70',
    coreType: 'Cardboard 1/8"',
    coreWeightLbs: 1.2,
    lfWeightLbsPerFt: 0.08,
    pricePerLf: 1.25,
    purchaseCost: 625,
    notes: 'Keep dry',
    ownerCompanyId: 'owner-mgt',
    ownerCompanyCode: 'MGT',
    ownerCompanyDisplayName: 'MGT',
    ownerCompanyIsActive: true,
    hasEverBeenCheckedOut: true,
    lastCheckoutJob: '000123',
    lastCheckoutDate: '2026-03-22',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function renderPage() {
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
      <MemoryRouter>
        <BoxDetailsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

function renderInteractivePage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BoxDetailsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function buildUpdateBoxResult(overrides: Partial<Box> = {}) {
  return {
    result: {
      box: buildBox(overrides),
      logId: 'log-1'
    } satisfies BoxMutationResult,
    warnings: []
  };
}

function buildTransferResult(overrides: Partial<Box> = {}) {
  return {
    result: {
      box: buildBox({ status: 'TRANSFER', ...overrides }),
      transfer: {
        transferId: 'TRF-1',
        boxId: 'IL1-1234',
        sourceBoxId: 'IL1-1234',
        destinationBoxId: 'MS1-1234-IL1',
        sourceWarehouse: 'IL1',
        destinationWarehouse: 'MS1',
        status: 'PENDING',
        createdAt: '2026-04-07T12:00:00Z',
        createdBy: 'tester',
        receivedAt: '',
        receivedBy: '',
        cancelledAt: '',
        cancelledBy: '',
        notes: 'Move for job 17170'
      },
      logId: 'log-transfer',
      cancelledAllocationCount: 0,
      releasedFeet: 0
    } satisfies BoxTransferMutationResult,
    warnings: []
  };
}

function buildUpdatePayload(
  overrides: Partial<UpdateBoxPayload> = {},
  currentBoxOverrides: Partial<Box> = {}
): UpdateBoxPayload {
  const box = buildBox(currentBoxOverrides);

  return {
    boxId: box.boxId,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    currentFeetOnRoll: box.initialFeet,
    feetAvailable: box.feetAvailable,
    lotRun: box.lotRun,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    initialWeightLbs: box.initialWeightLbs,
    lastRollWeightLbs: box.lastRollWeightLbs,
    lastWeighedDate: box.lastWeighedDate,
    filmKey: '',
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt,
    pricePerLf: box.pricePerLf,
    purchaseCost: box.purchaseCost,
    notes: box.notes,
    ...overrides
  };
}

describe('BoxDetailsPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    setSearchParamsMock.mockReset();
    toastPushMock.mockReset();
    parseUpdateBoxDraftMock.mockReset();
    qrCodeToDataUrlMock.mockReset();
    useBoxTransferPlanMock.mockReset();
    useBoxDealersMock.mockReset();
    useOwnerCompaniesMock.mockReset();
    useFilmOrdersMock.mockReset();
    useUpsertBoxDealerMock.mockReset();
    useChangeFilmBoxOwnerMock.mockReset();
    qrCodeToDataUrlMock.mockResolvedValue('data:image/png;base64,qr');
    nextBoxFormSubmitDraft = { dealer: '' };
    currentSearchParams = '';
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      isOwner: true,
      hasFeatureAccess: () => true
    });
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox(),
      error: null
    });
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
      error: null
    });
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useBoxDealersMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [
        {
          ownerCompanyId: 'owner-mgt',
          code: 'MGT',
          displayName: 'MGT',
          isActive: true,
          createdAt: '2026-06-26T00:00:00Z',
          updatedAt: '2026-06-26T00:00:00Z'
        }
      ],
      isLoading: false,
      error: null
    });
    useFilmOrdersMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
    useBoxTransferMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null
    });
    useBoxTransferPlanMock.mockImplementation((params: unknown) => {
      const source = params as { toWarehouse?: string } | null;
      return {
        data:
          source?.toWarehouse === 'MS1'
            ? {
                destinationBoxId: 'MS1-1234-IL1',
                available: true,
                conflictType: null,
                conflictBoxId: null
              }
            : null,
        isLoading: false,
        isFetching: false,
        error: null
      };
    });
    useIsAddBoxPendingMock.mockReturnValue(false);
    useDeleteBoxMock.mockReturnValue(buildMutationState());
    useStartBoxTransferMock.mockReturnValue(buildMutationState());
    useReceiveBoxTransferMock.mockReturnValue(buildMutationState());
    useCancelBoxTransferMock.mockReturnValue(buildMutationState());
    useJobSummariesByNumbersMock.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null
    });
    useReceiveOrderedBoxMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
    useUndoAuditMock.mockReturnValue(buildMutationState());
    useUpsertBoxDealerMock.mockReturnValue(buildMutationState());
    useChangeFilmBoxOwnerMock.mockReturnValue(buildMutationState());
    useUpdateBoxMock.mockReturnValue(buildMutationState());
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
    currentSearchParams = '';
  });

  it('renders the readable box summary, collapsed admin sections, and view-only actions', () => {
    const html = renderPage();

    expect(html).toContain('BOX DETAILS');
    expect(html).toContain('IL1-1234');
    expect(html).toContain('3M');
    expect(html).toContain('Ultra 70');
    expect(html).toContain('30&quot;');
    expect(html).toContain('Wauconda IL1 warehouse');
    expect(html).toContain('IN STOCK');
    expect(html).toContain('Owner: MGT');
    expect(html).not.toContain('Owner: MGT - MGT');
    expect(html).toContain('>Edit</button>');
    expect(html).toContain('QR Code');
    expect(html).toContain('Feet Summary');
    expect(html).toContain('Physical LF Remaining');
    expect(html).toContain('Available to Allocate');
    expect(html).toContain('Scheduled LF');
    expect(html).toContain('Placeholder LF');
    expect(html).toContain('This box has 420 LF available to allocate.');
    expect(html).not.toContain('On Hand Feet');
    expect(html).not.toContain('Allocatable Now');
    expect(html).not.toContain('Locked Feet');
    expect(html).not.toContain('Placeholder Feet');
    expect(html).not.toContain('Film Identity');
    expect(html).toContain('Allocations');
    expect(html).toContain('Dates &amp; Roll Info');
    expect(html).toContain('Date Ordered');
    expect(html).toContain('Date Received');
    expect(html).toContain('Last Roll Weight');
    expect(html).toContain('Last Weighed Date');
    expect(html).toContain('Notes');
    expect(html).toContain('Keep dry');
    expect(html).toContain('Box Technical Details');
    expect(html).toContain('>Open</button>');
    expect(html).toContain('Open Origin');
    expect(html).toContain('No origin recorded');
    expect(html).toContain('qr-code-card qr-code-card-closed');
    expect(html).toContain('Initial Feet');
    expect(html).toContain('Initial Weight');
    expect(html).toContain('Core Type');
    expect(html).toContain('Core Weight');
    expect(html).toContain('Lot / Run Number');
    expect(html).toContain('Purchase Cost');
    expect(html).toContain('Price / LF');
    expect(html).toContain('On-Hand Asset Cost');
    expect(html).not.toContain('>Transfer Box</button>');
    expect(html).not.toContain('>Check In</button>');
    expect(html).not.toContain('>Allocate</button>');
    expect(html).not.toContain('>Check Out</button>');
    expect(html).not.toContain('Roll Weight History');

    expect(html.indexOf('Notes')).toBeLessThan(html.indexOf('Allocations'));
    expect(html.indexOf('Allocations')).toBeLessThan(html.indexOf('Dates &amp; Roll Info'));
    expect(html.indexOf('Dates &amp; Roll Info')).toBeLessThan(html.indexOf('Box Technical Details'));
  });

  it('combines different owner company code and display name on Box Details', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        ownerCompanyCode: 'MGT',
        ownerCompanyDisplayName: 'Management Group'
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Owner: MGT - Management Group');
    expect(html).not.toContain('Owner: MGT - MGT');
  });

  it('shows inactive owner company state on Box Details without duplicating identical labels', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        ownerCompanyCode: 'EDH',
        ownerCompanyDisplayName: 'EDH',
        ownerCompanyIsActive: false
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Owner: EDH (inactive)');
    expect(html).not.toContain('Owner: EDH - EDH');
  });

  it('shows owner company information to normal users with Box Details read access', () => {
    useAuthMock.mockReturnValue({
      clientIdConfigured: true,
      isAuthenticated: true,
      isOwner: false,
      hasFeatureAccess: () => true
    });

    const html = renderPage();

    expect(html).toContain('Owner: MGT');
    expect(html).not.toContain('Owner: MGT - MGT');
  });

  it('opens and closes Box Technical Details from a labeled button', () => {
    renderInteractivePage();

    const openButton = screen.getByRole('button', { name: 'Open Box Technical Details' });
    const controlledId = openButton.getAttribute('aria-controls');
    expect(openButton.getAttribute('aria-expanded')).toBe('false');
    expect(controlledId).toBeTruthy();
    const detailsBody = document.getElementById(controlledId || '');
    expect(detailsBody?.hasAttribute('hidden')).toBe(true);

    fireEvent.click(openButton);

    const closeButton = screen.getByRole('button', { name: 'Close Box Technical Details' });
    expect(closeButton.getAttribute('aria-expanded')).toBe('true');
    expect(detailsBody?.hasAttribute('hidden')).toBe(false);

    fireEvent.click(closeButton);

    expect(screen.getByRole('button', { name: 'Open Box Technical Details' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(detailsBody?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps allocations open while lower-priority sections are collapsed by default', () => {
    renderInteractivePage();

    expect(screen.getByTestId('allocations-panel').textContent).toContain('IL1-1234:false');
    expect(screen.getByTestId('history-panel').textContent).toContain('IL1-1234:true');

    const originButton = screen.getByRole('button', { name: 'Open Origin' });
    const originBody = document.getElementById(originButton.getAttribute('aria-controls') || '');

    expect(originButton.getAttribute('aria-expanded')).toBe('false');
    expect(originBody?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'QR Code' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps ordered planning feet visible without exposing a Box Details Allocate action', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        feetAvailable: 0,
        allocationPlanningFeet: 35,
        receivedDate: '',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Available to Allocate');
    expect(html).toContain('35');
    expect(html).not.toContain('>Allocate</button>');
  });

  it('starts a transfer from the box details dialog', async () => {
    const startTransferState = buildMutationState();
    startTransferState.mutateAsync.mockResolvedValue(buildTransferResult());
    useStartBoxTransferMock.mockReturnValue(startTransferState);

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Box' }));
    fireEvent.change(screen.getByLabelText('Send To'), { target: { value: 'MS1' } });
    fireEvent.change(screen.getByLabelText('Transfer Notes'), {
      target: { value: 'Move this for the Mississippi crew.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(startTransferState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        toWarehouse: 'MS1',
        notes: 'Move this for the Mississippi crew.',
        destinationBoxIdOverride: undefined
      })
    );
  });

  it('opens the rename dialog when the planned arrival id conflicts and starts with an override', async () => {
    const startTransferState = buildMutationState();
    startTransferState.mutateAsync.mockResolvedValue({
      result: {
        ...buildTransferResult().result,
        transfer: {
          ...buildTransferResult().result.transfer,
          destinationBoxId: 'MS1-1234-IL1-2'
        }
      },
      warnings: []
    });
    useStartBoxTransferMock.mockReturnValue(startTransferState);
    useBoxTransferPlanMock.mockImplementation((params: unknown) => {
      const source = params as { toWarehouse?: string; destinationBoxIdOverride?: string } | null;
      if (source?.toWarehouse !== 'MS1') {
        return {
          data: null,
          isLoading: false,
          isFetching: false,
          error: null
        };
      }

      if (source.destinationBoxIdOverride === 'MS1-1234-IL1-2') {
        return {
          data: {
            destinationBoxId: 'MS1-1234-IL1-2',
            available: true,
            conflictType: null,
            conflictBoxId: null
          },
          isLoading: false,
          isFetching: false,
          error: null
        };
      }

      return {
        data: {
          destinationBoxId: 'MS1-1234-IL1',
          available: false,
          conflictType: 'box',
          conflictBoxId: 'MS1-1234-IL1'
        },
        isLoading: false,
        isFetching: false,
        error: null
      };
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer Box' }));
    fireEvent.change(screen.getByLabelText('Send To'), { target: { value: 'MS1' } });

    await waitFor(() =>
      expect(screen.getByText('Choose A Different Arrival Box ID')).toBeTruthy()
    );

    const renameDialog = screen.getByRole('dialog', { name: 'Choose A Different Arrival Box ID' });

    fireEvent.change(within(renameDialog).getByRole('textbox'), {
      target: { value: 'MS1-1234-IL1-2' }
    });
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Use Arrival ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(startTransferState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        toWarehouse: 'MS1',
        notes: undefined,
        destinationBoxIdOverride: 'MS1-1234-IL1-2'
      })
    );
  });

  it('shows pending transfer actions when a box is already transferring', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({ status: 'TRANSFER' }),
      error: null
    });
    useBoxTransferMock.mockReturnValueOnce({
      data: buildTransferResult().result.transfer,
      isLoading: false,
      isError: false,
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Pending Transfer');
    expect(html).toContain('Receive Box');
    expect(html).toContain('Cancel Transfer');
    expect(html).not.toContain('>Transfer Box</button>');
  });

  it('shows Receive Box instead of Transfer Box for ordered boxes', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Receive Box');
    expect(html).not.toContain('>Transfer Box</button>');
  });

  it('auto-opens the ordered receive dialog during the guided film-order receipt flow', async () => {
    currentSearchParams = 'filmOrderId=FO-1&receiveOrdered=1&returnTo=film-orders';
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });
    useFilmOrdersMock.mockReturnValue({
      data: [
        {
          filmOrderId: 'FO-1',
          jobNumber: '2941',
          warehouse: 'IL1',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 30,
          requestedFeet: 50,
          coveredFeet: 0,
          orderedFeet: 50,
          remainingToOrderFeet: 0,
          installDate: '2026-04-18',
          crewLeader: 'Crew',
          status: 'FILM_ON_THE_WAY',
          sourceBoxId: '',
          origin: 'MANUAL',
          createdAt: '2026-04-18T10:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          linkedBoxes: [
            {
              boxId: 'IL1-1234',
              dealer: 'Accent',
              orderedFeet: 50,
              autoAllocatedFeet: 0,
              isReceived: false
            }
          ]
        }
      ],
      isLoading: false,
      isError: false,
      error: null
    });

    renderInteractivePage();

    expect(await screen.findByRole('dialog', { name: 'Receive IL1-1234' })).toBeTruthy();
  });

  it('redirects guided receipts to the next outstanding linked box when the current route is not the next target', async () => {
    currentSearchParams = 'filmOrderId=FO-1&receiveOrdered=1&returnTo=film-orders';
    useFilmOrdersMock.mockReturnValue({
      data: [
        {
          filmOrderId: 'FO-1',
          jobNumber: '2941',
          warehouse: 'IL1',
          manufacturer: '3M',
          filmName: 'Ultra 70',
          widthIn: 30,
          requestedFeet: 100,
          coveredFeet: 0,
          orderedFeet: 100,
          remainingToOrderFeet: 0,
          installDate: '2026-04-18',
          crewLeader: 'Crew',
          status: 'FILM_ON_THE_WAY',
          sourceBoxId: '',
          origin: 'MANUAL',
          createdAt: '2026-04-18T10:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          linkedBoxes: [
            {
              boxId: 'IL1-0011',
              dealer: 'Accent',
              orderedFeet: 50,
              autoAllocatedFeet: 0,
              isReceived: false
            },
            {
              boxId: 'IL1-1234',
              dealer: 'Accent',
              orderedFeet: 50,
              autoAllocatedFeet: 0,
              isReceived: true
            }
          ]
        }
      ],
      isLoading: false,
      isError: false,
      error: null
    });

    renderInteractivePage();

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        '/inventory/IL1-0011?filmOrderId=FO-1&receiveOrdered=1&returnTo=film-orders',
        { replace: true }
      );
    });
  });

  it('receives an ordered box with blank optional values', async () => {
    const receiveOrderedState = buildMutationState();
    receiveOrderedState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        receivedDate: '2026-04-17',
        feetAvailable: 500,
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      })
    );
    useReceiveOrderedBoxMock.mockReturnValue(receiveOrderedState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        lotRun: '',
        coreType: '',
        coreWeightLbs: null,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Receive Box' }));

    const dialog = await screen.findByRole('dialog', { name: 'Receive IL1-1234' });
    expect(within(dialog).getByRole('spinbutton', { name: /Current LF/i })).toBeTruthy();
    expect(within(dialog).getByRole('spinbutton', { name: /Weight \(lbs\)/i })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: /Lot\/Run Number/i })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: /Core Type/i })).toBeTruthy();
    expect(within(dialog).queryByText(/This receive will save/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive Box' }));

    await waitFor(() =>
      expect(receiveOrderedState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        currentFeetOnRoll: 500
      })
    );
  });

  it('maps ordered receive weight and lot run into the dedicated mutation payload', async () => {
    const receiveOrderedState = buildMutationState();
    receiveOrderedState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        receivedDate: '2026-04-17',
        feetAvailable: 500,
        lotRun: 'LOT-42',
        initialWeightLbs: 18.5,
        lastRollWeightLbs: 18.5,
        lastWeighedDate: '2026-04-17',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      })
    );
    useReceiveOrderedBoxMock.mockReturnValue(receiveOrderedState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        lotRun: '',
        coreType: '',
        coreWeightLbs: null,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Receive Box' }));

    const dialog = await screen.findByRole('dialog', { name: 'Receive IL1-1234' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /Weight \(lbs\)/i }), {
      target: { value: '18.5' }
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Lot\/Run Number/i }), {
      target: { value: 'LOT-42' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive Box' }));

    await waitFor(() =>
      expect(receiveOrderedState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        receivedWeightLbs: 18.5,
        currentFeetOnRoll: 500,
        lotRun: 'LOT-42'
      })
    );
  });

  it('maps corrected ordered receive current LF into the dedicated mutation payload', async () => {
    const receiveOrderedState = buildMutationState();
    receiveOrderedState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        receivedDate: '2026-04-17',
        initialFeet: 80,
        feetAvailable: 0,
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      })
    );
    useReceiveOrderedBoxMock.mockReturnValue(receiveOrderedState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        initialFeet: 82,
        feetAvailable: 0,
        lotRun: '',
        coreType: '',
        coreWeightLbs: null,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Receive Box' }));

    const dialog = await screen.findByRole('dialog', { name: 'Receive IL1-1234' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /Current LF/i }), {
      target: { value: '80' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive Box' }));

    await waitFor(() =>
      expect(receiveOrderedState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        currentFeetOnRoll: 80
      })
    );
  });

  it('preselects and submits ordered receive core type through the dedicated mutation payload', async () => {
    const receiveOrderedState = buildMutationState();
    receiveOrderedState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        receivedDate: '2026-04-17',
        feetAvailable: 500,
        lotRun: '',
        coreType: 'Red plastic',
        coreWeightLbs: 0.7708,
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      })
    );
    useReceiveOrderedBoxMock.mockReturnValue(receiveOrderedState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        lotRun: '',
        coreType: 'Cardboard 3/8"',
        coreWeightLbs: 2.5625,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Receive Box' }));

    const dialog = await screen.findByRole('dialog', { name: 'Receive IL1-1234' });
    const coreTypeSelect = within(dialog).getByRole('combobox', { name: /Core Type/i }) as HTMLSelectElement;
    expect(coreTypeSelect.value).toBe('Cardboard 3/8"');

    fireEvent.change(coreTypeSelect, {
      target: { value: 'Red plastic' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive Box' }));

    await waitFor(() =>
      expect(receiveOrderedState.mutateAsync).toHaveBeenCalledWith({
        boxId: 'IL1-1234',
        currentFeetOnRoll: 500,
        coreType: 'Red plastic'
      })
    );
  });

  it('summarizes planner warnings after receiving an ordered box without dumping raw diagnostics', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const receiveOrderedState = buildMutationState();
    receiveOrderedState.mutateAsync.mockResolvedValue({
      ...buildUpdateBoxResult({
        status: 'IN_STOCK',
        receivedDate: '2026-04-17',
        feetAvailable: 500,
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      warnings: [
        'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
        'Skipped AUTO caulk planning for product DOW-795-BLK in IL1 because existing active allocations exceed physical stock.',
        'Skipped AUTO caulk planning for product DOW-795-WHT in IL1 because existing active allocations exceed physical stock.',
        'Skipped AUTO caulk planning for product DOW-995-GRY in IL1 because existing active allocations exceed physical stock.'
      ]
    });
    useReceiveOrderedBoxMock.mockReturnValue(receiveOrderedState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        lotRun: '',
        coreType: '',
        coreWeightLbs: null,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        hasEverBeenCheckedOut: false,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Receive Box' }));

    const dialog = await screen.findByRole('dialog', { name: 'Receive IL1-1234' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive Box' }));

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Box received',
          description:
            'Box received with planner warnings. Some legacy reservations may need review. 3 planner warnings hidden.',
          actionLabel: 'Undo'
        })
      )
    );

    const toastDescription = toastPushMock.mock.calls[0]?.[0]?.description as string;
    expect(toastDescription).not.toContain('DOW-795-BLK');
    expect(toastDescription).not.toContain('Skipped AUTO caulk planning');

    warnSpy.mockRestore();
  });

  it('auto-opens the QR section when showQr=1 is present in the search params', () => {
    currentSearchParams = 'showQr=1';

    const html = renderPage();

    expect(html).toContain('qr-code-card qr-code-card-open');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-hidden="false"');
  });

  it('does not auto-check in a checked-out box from the old QR scanAction route', async () => {
    currentSearchParams = 'scanAction=checkin';
    const statusMutation = buildMutationState();
    useSetBoxStatusMock.mockReturnValue(statusMutation);
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123',
        lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
        feetAvailable: 0,
        allocationPlanningFeet: 0,
        physicalFeetAvailable: 20
      }),
      error: null
    });

    renderInteractivePage();

    await waitFor(() => expect(screen.getByText('Current Activity')).toBeTruthy());
    expect(statusMutation.mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Check In' })).toBeNull();
  });

  it('shows a scan fallback notice when a checked-out job number cannot be resolved', async () => {
    currentSearchParams = 'scanNotice=checkout-job-unresolved';
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123',
        lastCheckoutJobId: '',
        feetAvailable: 0,
        allocationPlanningFeet: 0,
        physicalFeetAvailable: 20
      }),
      error: null
    });

    renderInteractivePage();

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open the job to check in this box',
          description:
            'Box IL1-1234 is checked out to job 000123, but the app could not resolve one current job record for that job number. Open the related job or search Jobs to check it in.',
          variant: 'warning'
        })
      )
    );
    expect(toastPushMock.mock.calls[0]?.[0]?.description).not.toContain('canonical job link');
  });

  it('shows an ambiguity scan fallback notice without guessing a checked-out job', async () => {
    currentSearchParams = 'scanNotice=checkout-job-ambiguous';
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123',
        lastCheckoutJobId: '',
        feetAvailable: 0,
        allocationPlanningFeet: 0,
        physicalFeetAvailable: 20
      }),
      error: null
    });

    renderInteractivePage();

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open the job to check in this box',
          description:
            'Box IL1-1234 is checked out to job 000123, but that job number matches multiple jobs. Open the correct job from Jobs to check it in.',
          variant: 'warning'
        })
      )
    );
  });

  it('does not expose legacy last checkout job navigation in the cleaned top summary', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123',
        feetAvailable: 0,
        allocationPlanningFeet: 0,
        allocatableNowFeet: 0,
        physicalFeetAvailable: 20,
        allocatedWithInstallDateFeet: 20
      }),
      error: null
    });

    renderInteractivePage();

    expect(screen.queryByRole('button', { name: 'IL1-000123' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'IL1-000123' })).toBeNull();
    expect(screen.getByText('Current Activity')).toBeTruthy();
    expect(screen.getByText('This box is checked out. All remaining film is currently scheduled, so 0 LF is available to allocate.')).toBeTruthy();
  });

  it('shows remaining unclaimed LF for checked-out boxes with partial scheduled and placeholder claims', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123',
        feetAvailable: 42,
        allocationPlanningFeet: 42,
        allocatableNowFeet: 42,
        physicalFeetAvailable: 71,
        allocatedWithInstallDateFeet: 15,
        allocatedWithoutInstallDateFeet: 14
      }),
      error: null
    });

    renderInteractivePage();

    expect(screen.getByText('Physical LF Remaining')).toBeTruthy();
    expect(screen.getByText('Available to Allocate')).toBeTruthy();
    expect(screen.getByText('Scheduled LF')).toBeTruthy();
    expect(screen.getByText('Placeholder LF')).toBeTruthy();
    expect(screen.getByText('This box is checked out. 42 LF remains unclaimed and can be planned, but the box must return before it can be physically checked out again.')).toBeTruthy();
    expect(
      screen.queryByText('This box is checked out. All remaining film is currently scheduled or planned, so 0 LF is available to allocate.')
    ).toBeNull();
  });

  it('renders structured film order origins as read-only metadata', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        orderedForJobs: [
          {
            jobId: '11111111-1111-4111-8111-111111111111',
            jobNumber: '4953',
            workScope: 'Sections 4, 5',
            sections: 'Sections 4, 5',
            phaseNumber: 1,
            filmOrderId: 'FO-1',
            orderedFeet: 120,
            orderedDate: '2026-05-18',
            receivedDate: '2026-05-20'
          },
          { jobNumber: '16242', filmOrderId: 'FO-2', orderedFeet: 48 }
        ]
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Origin');
    expect(html).toContain('Job Ordered For');
    expect(html).toContain('/allocations/jobs/11111111-1111-4111-8111-111111111111');
    expect(html).toContain('/film-orders/FO-1');
    expect(html).toContain('Phase 1 - Sections 4, 5');
    expect(html).toContain('May 18, 2026');
  });

  it('links ordered-for job and film order details when real ids exist', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        orderedForJobs: [
          {
            jobId: '11111111-1111-4111-8111-111111111111',
            jobNumber: '4953',
            workScope: 'Sections 4, 5',
            sections: 'Sections 4, 5',
            filmOrderId: 'FO-1',
            orderedFeet: 120
          }
        ]
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Origin' }));

    expect(screen.getByRole('link', { name: 'IL1-4953 / Sections 4, 5' }).getAttribute('href')).toBe(
      '/allocations/jobs/11111111-1111-4111-8111-111111111111'
    );
    expect(screen.getByRole('link', { name: 'FO-1' }).getAttribute('href')).toBe('/film-orders/FO-1');
  });

  it('does not fake an ordered-for job link when job id is absent', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        orderedForJobs: [{ jobNumber: '4953', filmOrderId: 'FO-1', orderedFeet: 120 }]
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Origin' }));

    expect(screen.queryByRole('link', { name: 'IL1-4953' })).toBeNull();
    expect(screen.getByText('IL1-4953')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'FO-1' }).getAttribute('href')).toBe('/film-orders/FO-1');
  });

  it('renders a film order origin even when the job summary is missing', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        orderedForJobs: [{ jobNumber: '', filmOrderId: 'FO-legacy', orderedFeet: 48 }]
      }),
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Origin' }));

    expect(screen.getByText('Origin')).toBeTruthy();
    expect(screen.queryByText('No origin recorded.')).toBeNull();
    expect(screen.getByRole('link', { name: 'FO-legacy' }).getAttribute('href')).toBe(
      '/film-orders/FO-legacy'
    );
  });

  it('does not parse ordered-for job details from legacy notes', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        notes: 'Ordered for job 4953 via FO-1',
        orderedForJobs: []
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('No origin recorded.');
    expect(html).toContain('Ordered for job 4953 via FO-1');
  });

  it('allows zeroed boxes to enter edit mode from the details page', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({ status: 'ZEROED', zeroedDate: '2026-03-23', zeroedReason: 'Check-in complete' }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('>Edit</button>');
    expect(html).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Edit<\/button>/);
  });

  it('saves ordered-box edits immediately without asking for a risky-field reason', async () => {
    const updateMutationState = buildMutationState();
    updateMutationState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({ status: 'ORDERED', receivedDate: '', widthIn: 48 })
    );
    useUpdateBoxMock.mockReturnValue(updateMutationState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ORDERED',
        receivedDate: '',
        feetAvailable: 0,
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null
      }),
      error: null
    });
    parseUpdateBoxDraftMock.mockReturnValue(
      buildUpdatePayload(
        {
          receivedDate: '',
          widthIn: 48,
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null
        },
        {
          status: 'ORDERED',
          receivedDate: '',
          feetAvailable: 0,
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null
        }
      )
    );

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Mock Edit' }));

    await waitFor(() => {
      expect(updateMutationState.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          widthIn: 48,
          auditNote: 'Inventory metadata update'
        })
      );
    });
    expect(screen.queryByText('Confirm Risky Edit')).toBeNull();
  });

  it('saves received-box edits directly while keeping zeroed reactivation confirmation intact', async () => {
    const updateMutationState = buildMutationState();
    updateMutationState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        widthIn: 48,
        status: 'IN_STOCK',
        receivedDate: '2026-03-21',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null
      })
    );
    useUpdateBoxMock.mockReturnValue(updateMutationState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'IN_STOCK',
        receivedDate: '2026-03-21',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null
      }),
      error: null
    });
    parseUpdateBoxDraftMock.mockReturnValue(
      buildUpdatePayload(
        {
          widthIn: 48,
          receivedDate: '2026-03-21',
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null
        },
        {
          status: 'IN_STOCK',
          receivedDate: '2026-03-21',
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null
        }
      )
    );

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Mock Edit' }));

    await waitFor(() => {
      expect(updateMutationState.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          widthIn: 48,
          auditNote: 'Inventory metadata update'
        })
      );
    });

    cleanup();

    const zeroedUpdateMutationState = buildMutationState();
    zeroedUpdateMutationState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        feetAvailable: 20,
        lastRollWeightLbs: 5,
        zeroedDate: '',
        zeroedReason: '',
        zeroedBy: ''
      })
    );
    useUpdateBoxMock.mockReturnValue(zeroedUpdateMutationState);
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'ZEROED',
        feetAvailable: 0,
        lastRollWeightLbs: 0,
        zeroedDate: '2026-03-23',
        zeroedReason: 'Check-in complete'
      }),
      error: null
    });
    parseUpdateBoxDraftMock.mockReturnValue(
      buildUpdatePayload(
        {
          feetAvailable: 20,
          currentFeetOnRoll: 20,
          lastRollWeightLbs: 5
        },
        {
          status: 'ZEROED',
          feetAvailable: 0,
          lastRollWeightLbs: 0,
          zeroedDate: '2026-03-23',
          zeroedReason: 'Check-in complete'
        }
      )
    );

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Mock Edit' }));

    expect(zeroedUpdateMutationState.mutateAsync).not.toHaveBeenCalled();
    const reactivateDialog = await screen.findByRole('dialog', { name: 'Reactivate Zeroed Box?' });
    expect(
      within(reactivateDialog).getByText(
        'Do you want to move this box back to the active IN_STOCK inventory?'
      )
    ).toBeTruthy();

    fireEvent.click(within(reactivateDialog).getByRole('button', { name: 'YES' }));

    await waitFor(() => {
      expect(zeroedUpdateMutationState.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          reactivateFromZeroed: true,
          auditNote: 'Confirmed zeroed box reactivation edit save'
        })
      );
    });
  });

  it('does not render removed view-only check-in, allocate, or checkout actions', () => {
    useBoxMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: buildBox({
        boxId: 'MS1-919',
        warehouse: 'MS1',
        widthIn: 50,
        initialFeet: 45,
        feetAvailable: 5,
        allocationPlanningFeet: 0,
        status: 'CHECKED_OUT',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        coreType: 'Red plastic',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null,
        lastCheckoutJob: '4580',
        lastCheckoutDate: '2026-04-15'
      }),
      error: null
    });

    renderInteractivePage();

    expect(screen.queryByRole('button', { name: 'Check In' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allocate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
  });
});
