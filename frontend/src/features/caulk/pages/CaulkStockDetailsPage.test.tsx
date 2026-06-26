// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import CaulkStockDetailsPage from './CaulkStockDetailsPage';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';

const toastPushMock = vi.fn();
const listCaulkStockMock = vi.fn();
const listCaulkTransactionsMock = vi.fn();
const listPendingCaulkTransfersMock = vi.fn();
const mutateCaulkStockMock = vi.fn();
const receiveCaulkTransferMock = vi.fn();
const cancelCaulkTransferMock = vi.fn();
const changeOwnerMutationMock = {
  mutateAsync: vi.fn(),
  isPending: false
};
const ownerCompaniesQueryMock = {
  data: [] as Array<{
    ownerCompanyId: string;
    code: string;
    displayName: string;
    isActive: boolean;
  }>,
  isLoading: false,
  error: null as Error | null
};
const authState = {
  isAuthenticated: false,
  isOwner: false,
  hasFeatureAccess: vi.fn(() => true)
};

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../../api/features/caulkClient', () => ({
  cancelCaulkTransfer: (payload: unknown) => cancelCaulkTransferMock(payload),
  listCaulkStock: (params: unknown) => listCaulkStockMock(params),
  listPendingCaulkTransfers: (params: unknown) => listPendingCaulkTransfersMock(params),
  listCaulkTransactions: (params: unknown) => listCaulkTransactionsMock(params),
  mutateCaulkStock: (payload: unknown) => mutateCaulkStockMock(payload),
  receiveCaulkTransfer: (payload: unknown) => receiveCaulkTransferMock(payload)
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => authState
}));

vi.mock('../../inventory/hooks/useInventoryQueries', () => ({
  useChangeCaulkStockOwner: () => changeOwnerMutationMock,
  useOwnerCompanies: () => ownerCompaniesQueryMock,
  usePendingCancelCaulkTransferIds: () => new Set<string>(),
  usePendingReceiveCaulkTransferIds: () => new Set<string>()
}));

vi.mock('../../inventory/hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1', name: 'Wauconda IL1' }]
  })
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="route-location">{location.pathname}</span>;
}

function fieldControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  label: string,
  selector: string
) {
  const control = screen.getByText(label).closest('label')?.querySelector(selector);
  expect(control).toBeTruthy();
  return control as T;
}

function renderPage(initialEntry = '/caulk/IL1/p1') {
  const queryClient = createQueryClient();
  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <LocationProbe />
        <Routes>
          <Route path="/caulk/:warehouse/:productId" element={<CaulkStockDetailsPage />} />
          <Route path="/caulk/stock/:stockId" element={<CaulkStockDetailsPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );

  return {
    ...view,
    queryClient
  };
}

describe('CaulkStockDetailsPage', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    listCaulkStockMock.mockReset();
    listCaulkTransactionsMock.mockReset();
    listPendingCaulkTransfersMock.mockReset();
    mutateCaulkStockMock.mockReset();
    receiveCaulkTransferMock.mockReset();
    cancelCaulkTransferMock.mockReset();
    changeOwnerMutationMock.mutateAsync.mockReset();
    changeOwnerMutationMock.mutateAsync.mockResolvedValue({
      changedCount: 1,
      batchId: 'ownership-batch-1',
      events: []
    });
    changeOwnerMutationMock.isPending = false;
    ownerCompaniesQueryMock.data = [
      { ownerCompanyId: 'owner-mgt', code: 'MGT', displayName: 'MGT', isActive: true },
      { ownerCompanyId: 'owner-kam', code: 'KAM', displayName: 'KAM', isActive: true }
    ];
    ownerCompaniesQueryMock.isLoading = false;
    ownerCompaniesQueryMock.error = null;
    authState.isAuthenticated = false;
    authState.isOwner = false;
    authState.hasFeatureAccess.mockReturnValue(true);

    listCaulkStockMock.mockResolvedValue([
      {
        stockId: 'stock-p1-mgt',
        warehouse: 'IL1',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        ownerCompanyId: 'owner-mgt',
        ownerCompanyCode: 'MGT',
        ownerCompanyDisplayName: 'MGT',
        ownerCompanyIsActive: true,
        tubesPerCase: 16,
        tubesOnHand: 33,
        casesOnHand: 2,
        looseTubes: 1,
        updatedAt: '2026-04-08T12:00:00Z',
        updatedBy: 'tester'
      }
    ]);
    listCaulkTransactionsMock.mockResolvedValue([
      {
        transactionId: 'tx-1',
        productId: 'p1',
        warehouse: 'IL1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        action: 'JOB_CHECKIN_UNUSED',
        deltaTubes: 2,
        resultingTubesOnHand: 33,
        tubesPerCase: 16,
        reason: 'Checked in unused caulk from job 18782.',
        notes: '',
        transferId: '',
        sourceBoxId: '20260323212436379-623',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester'
      },
      {
        transactionId: 'tx-3',
        productId: 'p1',
        warehouse: 'IL1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        action: 'ADJUST',
        deltaTubes: -23,
        resultingTubesOnHand: 10,
        tubesPerCase: 16,
        reason: 'physical count after shelf audit',
        notes: 'physical count after shelf audit',
        transferId: '',
        sourceBoxId: '',
        createdAt: '2026-04-10T12:55:00Z',
        createdBy: 'tester'
      }
    ]);
    listPendingCaulkTransfersMock.mockResolvedValue([
      {
        transferId: 'transfer-1',
        caulkAllocationId: 'alloc-1',
        jobNumber: '18782',
        jobWarehouse: 'IL1',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        sourceWarehouse: 'MS1',
        destinationWarehouse: 'IL1',
        pendingTubes: 4,
        status: 'PENDING',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester',
        receivedAt: '',
        receivedBy: '',
        cancelledAt: '',
        cancelledBy: '',
        updatedAt: '2026-04-08T12:00:00Z',
        updatedBy: 'tester',
        notes: ''
      }
    ]);
    mutateCaulkStockMock.mockResolvedValue({
      transactionId: 'tx-2',
      productId: 'p1',
      manufacturer: '3M',
      productName: '3M IPA White',
      productCode: 'IPA-W',
      warehouse: 'IL1',
      action: 'ADJUST',
      deltaTubes: 16,
      tubesPerCase: 16,
      tubesBefore: 33,
      tubesOnHand: 49,
      casesOnHand: 3,
      looseTubes: 1
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('loads the stock row and transaction history', async () => {
    const { queryClient } = renderPage();

    expect(await screen.findByText('Caulk Details')).toBeTruthy();
    expect(await screen.findByText('3M IPA White')).toBeTruthy();
    expect(await screen.findByText('Recent Transactions')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('Delta Tubes')).toBeTruthy();
    expect(screen.getByText('Resulting Tubes')).toBeTruthy();
    expect(screen.getByText('Reason')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(await screen.findByText('Checked in unused caulk from job 18782.')).toBeTruthy();
    expect(await screen.findByText('physical count after shelf audit')).toBeTruthy();
    expect(screen.queryByText(/20260323212436379-623/)).toBeNull();

    queryClient.clear();
  });

  it('renders inbound transfers with prefixed job labels', async () => {
    const { queryClient } = renderPage();

    expect(await screen.findByText('Job IL1-18782')).toBeTruthy();

    queryClient.clear();
  });

  it('renders inbound transfers with scoped job labels when scope is available', async () => {
    listPendingCaulkTransfersMock.mockResolvedValueOnce([
      {
        transferId: 'transfer-scoped',
        caulkAllocationId: 'alloc-1',
        jobNumber: '18782',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobWarehouse: 'IL1',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        sourceWarehouse: 'MS1',
        destinationWarehouse: 'IL1',
        pendingTubes: 4,
        status: 'PENDING',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester',
        receivedAt: '',
        receivedBy: '',
        cancelledAt: '',
        cancelledBy: '',
        updatedAt: '2026-04-08T12:00:00Z',
        updatedBy: 'tester',
        notes: ''
      }
    ]);
    const { queryClient } = renderPage();

    expect(
      await screen.findByText(
        `Job ${formatJobDisplayLabel({
          jobNumber: '18782',
          warehouse: 'IL1',
          workScope: 'Sections 4, 5'
        })}`
      )
    ).toBeTruthy();

    queryClient.clear();
  });

  it('keeps inbound transfers without job numbers on the existing fallback label', async () => {
    listPendingCaulkTransfersMock.mockResolvedValueOnce([
      {
        transferId: 'transfer-legacy',
        caulkAllocationId: 'alloc-legacy',
        jobNumber: '',
        jobWarehouse: '',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        sourceWarehouse: 'MS1',
        destinationWarehouse: 'IL1',
        pendingTubes: 4,
        status: 'PENDING',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester',
        receivedAt: '',
        receivedBy: '',
        cancelledAt: '',
        cancelledBy: '',
        updatedAt: '2026-04-08T12:00:00Z',
        updatedBy: 'tester',
        notes: ''
      }
    ]);
    const { queryClient } = renderPage();

    expect(await screen.findByText('Job --')).toBeTruthy();
    expect(screen.queryByText(/Sections 4, 5/)).toBeNull();

    queryClient.clear();
  });

  it('renders structured transaction job labels without changing reason text', async () => {
    listPendingCaulkTransfersMock.mockResolvedValueOnce([]);
    listCaulkTransactionsMock.mockResolvedValueOnce([
      {
        transactionId: 'tx-scoped',
        productId: 'p1',
        warehouse: 'IL1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        action: 'TRANSFER_IN',
        deltaTubes: 4,
        resultingTubesOnHand: 37,
        tubesPerCase: 16,
        reason: 'Received caulk transfer into IL1 for job 18782.',
        notes: '',
        transferId: 'transfer-scoped',
        sourceBoxId: '',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '18782',
        jobWarehouse: 'IL1',
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester'
      }
    ]);
    const { queryClient } = renderPage();

    expect(await screen.findByText('Received caulk transfer into IL1 for job 18782.')).toBeTruthy();
    expect(
      await screen.findByText(
        `Job ${formatJobDisplayLabel({
          jobNumber: '18782',
          warehouse: 'IL1',
          workScope: 'Sections 4, 5'
        })}`
      )
    ).toBeTruthy();

    queryClient.clear();
  });

  it('leaves generic transactions without structured job identity unchanged', async () => {
    listPendingCaulkTransfersMock.mockResolvedValueOnce([]);
    listCaulkTransactionsMock.mockResolvedValueOnce([
      {
        transactionId: 'tx-generic',
        productId: 'p1',
        warehouse: 'IL1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: 'IPA-W',
        action: 'ADJUST',
        deltaTubes: -1,
        resultingTubesOnHand: 32,
        tubesPerCase: 16,
        reason: 'physical count after shelf audit',
        notes: 'physical count after shelf audit',
        transferId: '',
        sourceBoxId: '',
        createdAt: '2026-04-08T12:00:00Z',
        createdBy: 'tester'
      }
    ]);
    const { queryClient } = renderPage();

    expect(await screen.findByText('physical count after shelf audit')).toBeTruthy();
    expect(screen.queryByText(/^Job /)).toBeNull();

    queryClient.clear();
  });

  it('saves an adjusted tube delta from cases and loose tube edits', async () => {
    const { queryClient } = renderPage();

    const casesInput = await screen.findByLabelText('Cases Available');
    const looseInput = screen.getByLabelText(/Loose Tubes Available/i);
    const notesInput = screen.getByText('Adjustment Notes').closest('label')?.querySelector('textarea');
    expect(notesInput).toBeTruthy();
    fireEvent.change(casesInput, { target: { value: '3' } });
    fireEvent.change(looseInput, { target: { value: '1' } });
    fireEvent.change(notesInput as HTMLTextAreaElement, { target: { value: 'cycle count correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mutateCaulkStockMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADJUST',
          warehouse: 'IL1',
          productId: 'p1',
          deltaTubes: 16,
          reason: 'cycle count correction',
          notes: 'cycle count correction'
        })
      )
    );

    queryClient.clear();
  });

  it('uses Inventory edit as the adjustment reason when notes are blank', async () => {
    const { queryClient } = renderPage();

    const casesInput = await screen.findByLabelText('Cases Available');
    const looseInput = screen.getByLabelText(/Loose Tubes Available/i);
    fireEvent.change(casesInput, { target: { value: '3' } });
    fireEvent.change(looseInput, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mutateCaulkStockMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADJUST',
          reason: 'Inventory edit',
          notes: ''
        })
      )
    );

    queryClient.clear();
  });

  it('does not call the mutation when the inventory counts are unchanged', async () => {
    const { queryClient } = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'No changes to save',
          variant: 'warning'
        })
      )
    );
    expect(mutateCaulkStockMock).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it('routes to the surviving caulk stock row when an owner change merges with an existing owner row', async () => {
    authState.isAuthenticated = true;
    authState.isOwner = true;
    const sourceRow = {
      stockId: 'stock-source',
      warehouse: 'IL1',
      productId: 'p1',
      manufacturerId: 'm1',
      manufacturer: '3M',
      productName: '3M IPA White',
      productCode: 'IPA-W',
      ownerCompanyId: 'owner-mgt',
      ownerCompanyCode: 'MGT',
      ownerCompanyDisplayName: 'MGT',
      ownerCompanyIsActive: true,
      tubesPerCase: 16,
      tubesOnHand: 8,
      casesOnHand: 0,
      looseTubes: 8,
      updatedAt: '2026-04-08T12:00:00Z',
      updatedBy: 'tester'
    };
    const targetRow = {
      ...sourceRow,
      stockId: 'stock-target',
      ownerCompanyId: 'owner-kam',
      ownerCompanyCode: 'KAM',
      ownerCompanyDisplayName: 'KAM',
      tubesOnHand: 41,
      looseTubes: 9
    };
    listCaulkStockMock.mockImplementation((params: { stockId?: string; warehouse?: string; productId?: string }) => {
      if (params.stockId === 'stock-source') {
        return Promise.resolve([sourceRow]);
      }
      if (params.stockId === 'stock-target') {
        return Promise.resolve([targetRow]);
      }
      if (params.warehouse === 'IL1' && params.productId === 'p1') {
        return Promise.resolve([targetRow]);
      }
      return Promise.resolve([]);
    });
    listPendingCaulkTransfersMock.mockResolvedValueOnce([]);
    listCaulkTransactionsMock.mockResolvedValue([]);
    const { queryClient } = renderPage('/caulk/stock/stock-source');

    expect(await screen.findByText('MGT')).toBeTruthy();
    fireEvent.change(fieldControl<HTMLSelectElement>('Owner Company', 'select'), { target: { value: 'owner-kam' } });
    await screen.findByText('Ownership Note');
    fireEvent.change(fieldControl<HTMLInputElement>('Ownership Note', 'input'), {
      target: { value: 'merge into existing KAM row' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Ownership' }));

    await waitFor(() =>
      expect(changeOwnerMutationMock.mutateAsync).toHaveBeenCalledWith({
        stockId: 'stock-source',
        ownerCompanyId: 'owner-kam',
        note: 'merge into existing KAM row'
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('route-location').textContent).toBe('/caulk/stock/stock-target')
    );
    expect(await screen.findByText('KAM')).toBeTruthy();
    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Caulk owner updated',
        variant: 'success'
      })
    );

    queryClient.clear();
  });
});
