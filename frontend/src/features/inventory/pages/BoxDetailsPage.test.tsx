import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Box } from '../../../domain';
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
const useSetBoxStatusMock = vi.fn();
const useUndoAuditMock = vi.fn();
const useUpdateBoxMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ boxId: 'IL1-1234' }),
  useSearchParams: () => [new URLSearchParams('showQr=1'), setSearchParamsMock]
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
  useBoxAllocations: () => useBoxAllocationsMock(),
  useFilmCatalog: () => useFilmCatalogMock(),
  useIsAddBoxPending: () => useIsAddBoxPendingMock(),
  useDeleteBox: () => useDeleteBoxMock(),
  useSetBoxStatus: () => useSetBoxStatusMock(),
  useUndoAudit: () => useUndoAuditMock(),
  useUpdateBox: () => useUpdateBoxMock()
}));

vi.mock('../components/AllocateDialog', () => ({
  AllocateDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="allocate-dialog">Allocate dialog</div> : null
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
  return renderToStaticMarkup(<BoxDetailsPage />);
}

describe('BoxDetailsPage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    setSearchParamsMock.mockReset();
    toastPushMock.mockReset();
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
    useIsAddBoxPendingMock.mockReturnValue(false);
    useDeleteBoxMock.mockReturnValue(buildMutationState());
    useSetBoxStatusMock.mockReturnValue(buildMutationState());
    useUndoAuditMock.mockReturnValue(buildMutationState());
    useUpdateBoxMock.mockReturnValue(buildMutationState());
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
  });

  it('auto-opens the QR section when showQr=1 is present in the search params', () => {
    const html = renderPage();

    expect(html).toContain('qr-code-card qr-code-card-open');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-hidden="false"');
  });
});
