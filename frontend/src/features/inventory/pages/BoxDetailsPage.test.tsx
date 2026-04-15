// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const useJobSummariesByNumbersMock = vi.fn();
const useSetBoxStatusMock = vi.fn();
const useUndoAuditMock = vi.fn();
const useUpdateBoxMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const parseUpdateBoxDraftMock = vi.fn();
const qrCodeToDataUrlMock = vi.fn();
let nextBoxFormSubmitDraft: unknown = {};

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ boxId: 'IL1-1234' }),
  useSearchParams: () => [new URLSearchParams('showQr=1'), setSearchParamsMock]
}));

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
  useFilmCatalog: () => useFilmCatalogMock(),
  useIsAddBoxPending: () => useIsAddBoxPendingMock(),
  useDeleteBox: () => useDeleteBoxMock(),
  useStartBoxTransfer: () => useStartBoxTransferMock(),
  useReceiveBoxTransfer: () => useReceiveBoxTransferMock(),
  useCancelBoxTransfer: () => useCancelBoxTransferMock(),
  useJobSummariesByNumbers: () => useJobSummariesByNumbersMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
  useUndoAudit: () => useUndoAuditMock(),
  useUpdateBox: () => useUpdateBoxMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../schemas/boxSchemas', () => ({
  parseUpdateBoxDraft: (...args: unknown[]) => parseUpdateBoxDraftMock(...args)
}));

vi.mock('../components/AllocateDialog', () => ({
  AllocateDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="allocate-dialog">Allocate dialog</div> : null
}));

vi.mock('../components/BoxForm', () => ({
  BoxForm: ({ onSubmit }: { onSubmit: (draft: unknown) => void }) => (
    <div data-testid="box-form">
      <button type="button" onClick={() => onSubmit(nextBoxFormSubmitDraft)}>
        Submit Mock Edit
      </button>
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
  }) => <div data-testid="allocations-panel">{`${boxId}:${String(collapsed)}`}</div>
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

vi.mock('../components/RollHistoryPanel', () => ({
  RollHistoryPanel: ({
    boxId,
    collapsed
  }: {
    boxId: string;
    collapsed: boolean;
  }) => <div data-testid="roll-history-panel">{`${boxId}:${String(collapsed)}`}</div>
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
      <BoxDetailsPage />
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
      <BoxDetailsPage />
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
    qrCodeToDataUrlMock.mockResolvedValue('data:image/png;base64,qr');
    nextBoxFormSubmitDraft = {};
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
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
    useUndoAuditMock.mockReturnValue(buildMutationState());
    useUpdateBoxMock.mockReturnValue(buildMutationState());
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
  });

  it('renders the box summary, QR section, and detail actions without needing browser interactions', () => {
    const html = renderPage();

    expect(html).toContain('IL1-1234');
    expect(html).toContain('3M');
    expect(html).toContain('Ultra 70');
    expect(html).toContain('QR Code');
    expect(html).toContain('Copy QR Code');
    expect(html).toContain('Available Feet');
    expect(html).toContain('420');
    expect(html).toContain('Transfer Box');
  });

  it('keeps Allocate enabled for ordered boxes with planning feet and shows the planning feet stat', async () => {
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

    renderInteractivePage();

    expect(screen.getByText('Planning Feet')).toBeTruthy();
    expect(screen.getByText('35')).toBeTruthy();

    const allocateButton = screen.getByRole('button', { name: 'Allocate' }) as HTMLButtonElement;
    expect(allocateButton.disabled).toBe(false);

    fireEvent.click(allocateButton);

    expect(screen.getByTestId('allocate-dialog')).toBeTruthy();
  });

  it('starts a transfer from the box details dialog', async () => {
    const startTransferState = buildMutationState();
    startTransferState.mutateAsync.mockResolvedValue(buildTransferResult());
    useStartBoxTransferMock.mockReturnValue(startTransferState);

    renderInteractivePage();

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

  it('auto-opens the QR section when showQr=1 is present in the search params', () => {
    const html = renderPage();

    expect(html).toContain('qr-code-card qr-code-card-open');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-hidden="false"');
  });

  it('renders the last checkout job as a clickable button while the box is checked out', () => {
    useBoxMock.mockReturnValueOnce({
      isLoading: false,
      isError: false,
      data: buildBox({
        status: 'CHECKED_OUT',
        lastCheckoutJob: '000123'
      }),
      error: null
    });

    const html = renderPage();

    expect(html).toContain('Last Checkout Job');
    expect(html).toContain('class="row-button"');
    expect(html).toContain('>000123</button>');
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
    expect(screen.getByText('Do you want to move this box back to the active IN_STOCK inventory?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'YES' }));

    await waitFor(() => {
      expect(zeroedUpdateMutationState.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          reactivateFromZeroed: true,
          auditNote: 'Confirmed zeroed box reactivation edit save'
        })
      );
    });
  });

  it('uses the dedicated film check-in dialog for boxes that need current linear feet to calibrate return math', async () => {
    const setStatusState = buildMutationState();
    setStatusState.mutateAsync.mockResolvedValue(
      buildUpdateBoxResult({
        status: 'IN_STOCK',
        initialFeet: 45,
        feetAvailable: 19,
        initialWeightLbs: null,
        lastRollWeightLbs: 3.34,
        lastWeighedDate: '2026-04-15',
        coreType: 'Red plastic',
        coreWeightLbs: 1.2847,
        lfWeightLbsPerFt: 0.108174,
        lastCheckoutJob: '',
        lastCheckoutDate: ''
      })
    );
    useSetBoxStatusMock.mockReturnValue(setStatusState);
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
    useBoxAllocationsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          allocationId: 'alloc-1',
          boxId: 'MS1-919',
          warehouse: 'MS1',
          jobNumber: '4580',
          installDate: '2026-04-15',
          crewLeader: 'Crew',
          allocatedFeet: 20,
          coveredFeet: 20,
          allocationKind: 'REQUIREMENT',
          status: 'ACTIVE',
          createdAt: '2026-04-15T10:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 50,
          boxStatus: 'CHECKED_OUT',
          checkedOutOnThisJob: true
        }
      ],
      error: null
    });

    renderInteractivePage();

    fireEvent.click(screen.getByRole('button', { name: 'Check In' }));

    const dialog = await screen.findByRole('dialog', { name: 'Check In MS1-919' });
    expect(within(dialog).getByLabelText(/Current Linear Feet/i)).toBeTruthy();
    expect(within(dialog).getByText(/planning allocation for job 4580 will be released/i)).toBeTruthy();

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /Last Roll Weight/i }), {
      target: { value: '3.34' }
    });
    fireEvent.change(within(dialog).getByLabelText(/Current Linear Feet/i), {
      target: { value: '19' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check In' }));

    await waitFor(() =>
      expect(setStatusState.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId: 'MS1-919',
          status: 'IN_STOCK',
          lastRollWeightLbs: 3.34,
          currentFeetOnRoll: 19,
          auditNote: 'Checked in at 3.34 lbs with 19 LF remaining'
        })
      )
    );

    const submittedPayload = setStatusState.mutateAsync.mock.calls[0]?.[0];
    expect(submittedPayload).not.toHaveProperty('coreType');
  });
});
