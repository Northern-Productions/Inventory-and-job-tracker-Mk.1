// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import { JobAllocateDialog } from './JobAllocateDialog';

const toastPushMock = vi.fn();
const useAllocateBoxMock = vi.fn();
const useAllocationPreviewMock = vi.fn();
const useCreateFilmOrderMock = vi.fn();
const searchBoxesMock = vi.fn();

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ push: toastPushMock })
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    clientIdConfigured: true,
    isOwner: true,
    isAdmin: true,
    hasFeatureAccess: () => true
  })
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1' }, { code: 'MS1' }]
  })
}));

vi.mock('../hooks/useInventoryQueries', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useInventoryQueries')>(
    '../hooks/useInventoryQueries'
  );

  return {
    ...actual,
    useAllocateBox: () => useAllocateBoxMock(),
    useAllocationPreview: (payload: unknown) => useAllocationPreviewMock(payload),
    useCreateFilmOrder: () => useCreateFilmOrderMock()
  };
});

vi.mock('../../../api/features/inventoryClient', () => ({
  searchBoxes: (...args: unknown[]) => searchBoxesMock(...args)
}));

function buildMutationState() {
  return {
    isPending: false,
    mutateAsync: vi.fn()
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
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
        retry: false,
        staleTime: Infinity
      }
    }
  });
}

function buildPreviewState(
  overrides: Partial<{
    data: Record<string, unknown> | null;
    isLoading: boolean;
    isFetching: boolean;
    isError: boolean;
    error: Error | null;
  }> = {}
) {
  return {
    data: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    ...overrides
  };
}

function renderDialog(
  overrides: Partial<{
    jobNumber: string;
    warehouse: Warehouse;
    installDate: string;
    crewLeader: string;
    requirements: JobRequirementLine[];
    filmOrders: FilmOrderEntry[];
    isExtraFilmMode: boolean;
    onCancel: () => void;
  }> = {}
) {
  const queryClient = createQueryClient();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <JobAllocateDialog
        open
        jobNumber={overrides.jobNumber || '55555'}
        warehouse={overrides.warehouse || 'IL1'}
        installDate={overrides.installDate || ''}
        crewLeader={overrides.crewLeader || ''}
        requirements={
          overrides.requirements || [
            {
              requirementId: 'req-1',
              manufacturer: 'Llumar',
              filmName: 'RN 07',
              widthIn: 48,
              requiredFeet: 15,
              allocatedFeet: 0,
              remainingFeet: 15
            }
          ]
        }
        filmOrders={overrides.filmOrders || []}
        isExtraFilmMode={overrides.isExtraFilmMode || false}
        onCancel={overrides.onCancel || (() => undefined)}
      />
    </QueryClientProvider>
  );

  return {
    ...view,
    queryClient
  };
}

function buildSearchBox(overrides: Record<string, unknown> = {}) {
  return {
    boxId: 'IL1-BOX',
    warehouse: 'IL1',
    manufacturer: 'Llumar',
    filmName: 'RN 07',
    widthIn: 48,
    initialFeet: 50,
    feetAvailable: 50,
    allocationPlanningFeet: 50,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-01-01',
    receivedDate: '2026-01-01',
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

describe('JobAllocateDialog', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    toastPushMock.mockReset();
    useAllocateBoxMock.mockReset();
    useAllocationPreviewMock.mockReset();
    useCreateFilmOrderMock.mockReset();
    searchBoxesMock.mockReset();
    useAllocateBoxMock.mockReturnValue(buildMutationState());
    useCreateFilmOrderMock.mockReturnValue(buildMutationState());
    useAllocationPreviewMock.mockReturnValue(buildPreviewState());
    searchBoxesMock.mockResolvedValue([]);
  });

  it('uses the shared sticky footer action class for the final allocate row', () => {
    const { queryClient } = renderDialog({
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M Solar',
          filmName: 'Prestige 50',
          widthIn: 48,
          requiredFeet: 10,
          allocatedFeet: 0,
          remainingFeet: 10
        }
      ]
    });

    expect(document.querySelector('.dialog-actions.dialog-actions-sticky-footer')).not.toBeNull();
    queryClient.clear();
  });

  it('only renders unmet requirement lines in the selector', () => {
    const { queryClient } = renderDialog({
      jobNumber: '29010',
      requirements: [
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 2,
          remainingFeet: 0
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 10,
          remainingFeet: 2
        }
      ]
    });

    const optionLabels = Array.from(screen.getAllByRole('option')).map((entry) => entry.textContent || '');
    expect(optionLabels.some((label) => label.includes('Affinity 15 50" (0 LF remaining)'))).toBe(false);
    expect(optionLabels.some((label) => label.includes('Affinity 15 72" (2 LF remaining)'))).toBe(true);
    queryClient.clear();
  });

  it('keeps the dialog open in extra mode and lists fulfilled requirement lines', async () => {
    searchBoxesMock.mockResolvedValue([]);
    const onCancel = vi.fn();
    const { queryClient } = renderDialog({
      isExtraFilmMode: true,
      onCancel,
      requirements: [
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Prestige 50',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 12,
          remainingFeet: 0
        }
      ]
    });

    expect(screen.getByRole('heading', { name: 'Allocate Extra Job Film' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allocate Extra' })).toBeTruthy();
    expect(screen.queryByLabelText('Requested LF')).toBeNull();

    const optionLabels = Array.from(screen.getAllByRole('option')).map((entry) => entry.textContent || '');
    expect(optionLabels.some((label) => label.includes('Affinity 15 50" (20 LF required)'))).toBe(true);
    expect(optionLabels.some((label) => label.includes('Prestige 50 72" (12 LF required)'))).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it('allocates selected fulfilled-requirement boxes as full-box extra film', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      result: {
        allocations: [
          {
            allocationId: 'alloc-extra',
            boxId: 'IL1-EXTRA',
            warehouse: 'IL1',
            jobNumber: '29010',
            installDate: '',
            crewLeader: '',
            allocatedFeet: 44,
            coveredFeet: 44,
            requirementId: '',
            allocationKind: 'EXTRA',
            allocationSource: 'MANUAL' as const,
            status: 'ACTIVE',
            createdAt: '2026-04-10T12:00:00Z',
            createdBy: 'tester',
            resolvedAt: '',
            resolvedBy: '',
            filmOrderId: '',
            notes: ''
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    searchBoxesMock.mockResolvedValue([
      buildSearchBox({
        boxId: 'IL1-EXTRA',
        manufacturer: '3M Solar',
        filmName: 'Prestige 50',
        widthIn: 72,
        feetAvailable: 44,
        allocationPlanningFeet: 44
      })
    ]);
    const onCancel = vi.fn();

    const { queryClient } = renderDialog({
      jobNumber: '29010',
      isExtraFilmMode: true,
      onCancel,
      requirements: [
        {
          requirementId: 'req-fulfilled',
          manufacturer: '3M Solar',
          filmName: 'Prestige 50',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 12,
          remainingFeet: 0
        }
      ]
    });

    const table = await screen.findByRole('table');
    const checkbox = within(table).getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(checkbox.checked).toBe(true);
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Extra LF\s*44/i);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Allocate Extra' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId: 'IL1-EXTRA',
          requestedFeet: 0,
          requestedWidthIn: 72,
          requirementId: 'req-fulfilled',
          selectedSuggestionBoxIds: [],
          extraAllocations: [{ boxId: 'IL1-EXTRA', allocatedFeet: 44 }],
          crossWarehouse: true,
          jobWarehouse: 'IL1'
        })
      )
    );
    expect(onCancel).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });

  it('shows status and planning LF for ordered candidates while keeping in-stock boxes first', async () => {
    searchBoxesMock.mockResolvedValue([
      buildSearchBox({
        boxId: 'IL1-IN-STOCK',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        initialFeet: 20,
        feetAvailable: 20,
        allocationPlanningFeet: 20,
        status: 'IN_STOCK'
      }),
      buildSearchBox({
        boxId: 'IL1-ORDERED',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        initialFeet: 80,
        feetAvailable: 0,
        allocatableNowFeet: 40,
        allocationPlanningFeet: 40,
        status: 'ORDERED',
        receivedDate: ''
      })
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '29088',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          requiredFeet: 40,
          allocatedFeet: 0,
          remainingFeet: 40
        }
      ]
    });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent || '').toContain('IL1-IN-STOCK');
    expect(rows[1].textContent || '').toContain('IL1-ORDERED');
    expect(within(rows[1]).getByText('ORDERED')).toBeTruthy();
    expect(within(rows[1]).getByText('40')).toBeTruthy();

    queryClient.clear();
  });

  it('shows matching transfer boxes for the job warehouse and uses them in the live preview', async () => {
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string; jobWarehouse?: string } | null) =>
      payload?.boxId === 'IL1-TRANSFER'
        ? buildPreviewState({
            data: {
              jobNumber: '4803',
              installDate: '',
              crewLeader: '',
              requestedFeet: 13,
              requestedWidthIn: 72,
              sourceBoxId: 'IL1-TRANSFER',
              sourceWarehouse: 'IL1',
              sourceWidthIn: 72,
              sourceBoxFeetAvailable: 96,
              sourceSuggestedFeet: 13,
              sourceSuggestedCoveredFeet: 13,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 13,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );
    searchBoxesMock.mockResolvedValue([
      buildSearchBox({
        boxId: 'MS1-IN-STOCK',
        warehouse: 'MS1',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        widthIn: 72,
        status: 'IN_STOCK',
        feetAvailable: 20,
        allocationPlanningFeet: 20
      }),
      buildSearchBox({
        boxId: 'IL1-TRANSFER',
        warehouse: 'IL1',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        widthIn: 72,
        status: 'TRANSFER',
        feetAvailable: 96,
        allocationPlanningFeet: 96,
        pendingTransfer: {
          transferId: 'TRF-1',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1'
        }
      })
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '4803',
      warehouse: 'MS1',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          requiredFeet: 13,
          allocatedFeet: 0,
          remainingFeet: 13
        }
      ]
    });

    const table = await screen.findByRole('table');
    expect(screen.getByText(/Transfer boxes already headed to this warehouse/i)).toBeTruthy();

    const transferRow = within(table).getByText(/IL1-TRANSFER/).closest('tr');
    expect(transferRow).not.toBeNull();
    const transferCheckbox = within(transferRow as HTMLElement).getByRole('checkbox') as HTMLInputElement;

    fireEvent.click(transferCheckbox);

    await waitFor(() =>
      expect(useAllocationPreviewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          boxId: 'IL1-TRANSFER',
          jobWarehouse: 'MS1'
        })
      )
    );
    await waitFor(() => expect(transferCheckbox.checked).toBe(true));
    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*13/i)
    );

    queryClient.clear();
  });

  it('keeps transfer boxes visible even when transfer metadata points elsewhere', async () => {
    searchBoxesMock.mockResolvedValue([
      buildSearchBox({
        boxId: 'IL1-TRANSFER-WRONG',
        warehouse: 'IL1',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        widthIn: 72,
        status: 'TRANSFER',
        feetAvailable: 96,
        allocationPlanningFeet: 96,
        pendingTransfer: {
          transferId: 'TRF-2',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'TX1'
        }
      }),
      buildSearchBox({
        boxId: 'MS1-IN-STOCK',
        warehouse: 'MS1',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        widthIn: 72,
        status: 'IN_STOCK',
        feetAvailable: 20,
        allocationPlanningFeet: 20
      })
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '4803',
      warehouse: 'MS1',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 72,
          requiredFeet: 13,
          allocatedFeet: 0,
          remainingFeet: 13
        }
      ]
    });

    const table = await screen.findByRole('table');
    expect(table.textContent || '').toContain('MS1-IN-STOCK');
    expect(table.textContent || '').toContain('IL1-TRANSFER-WRONG');

    queryClient.clear();
  });

  it('searches with manufacturer plus q and lets the user manually choose RN07-family boxes', async () => {
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) =>
      payload?.boxId === 'IL1-RN07'
        ? buildPreviewState({
            data: {
              jobNumber: '55555',
              installDate: '',
              crewLeader: '',
              requestedFeet: 15,
              requestedWidthIn: 48,
              sourceBoxId: 'IL1-RN07',
              sourceWarehouse: 'IL1',
              sourceWidthIn: 48,
              sourceBoxFeetAvailable: 10,
              sourceSuggestedFeet: 10,
              sourceSuggestedCoveredFeet: 10,
              sourceConflicts: [],
              suggestions: [
                {
                  boxId: 'IL1-LEGACY',
                  warehouse: 'IL1',
                  widthIn: 48,
                  availableFeet: 10,
                  suggestedFeet: 5,
                  suggestedCoveredFeet: 5,
                  receivedDate: '2026-01-06',
                  orderDate: '2026-01-06'
                },
                {
                  boxId: 'IL1-REFL',
                  warehouse: 'IL1',
                  widthIn: 48,
                  availableFeet: 10,
                  suggestedFeet: 0,
                  suggestedCoveredFeet: 0,
                  receivedDate: '2026-01-01',
                  orderDate: '2026-01-01'
                }
              ],
              defaultCoveredFeet: 15,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );

    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'IL1-RN07',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN07',
        widthIn: 48,
        initialFeet: 10,
        feetAvailable: 10,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-05',
        receivedDate: '2026-01-05',
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
        zeroedBy: ''
      },
      {
        boxId: 'IL1-LEGACY',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'Llumar RN07',
        widthIn: 48,
        initialFeet: 10,
        feetAvailable: 10,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-06',
        receivedDate: '2026-01-06',
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
        zeroedBy: ''
      },
      {
        boxId: 'IL1-REFL',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        initialFeet: 10,
        feetAvailable: 10,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-01',
        receivedDate: '2026-01-01',
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
        zeroedBy: ''
      }
    ]);

    const { queryClient } = renderDialog();

    await waitFor(() => expect(searchBoxesMock).toHaveBeenCalledTimes(1));
    expect(searchBoxesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouses: ['IL1', 'MS1'],
        manufacturer: 'Llumar',
        q: 'RN 07',
        showRetired: false
      })
    );

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent || '').toContain('RN07');
    expect(rows[1].textContent || '').toContain('Llumar RN07');
    expect(rows[2].textContent || '').toContain('RN 07 Refl. One Way Mirror');

    const checkboxes = within(table).getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[2] as HTMLInputElement).checked).toBe(false);
    const statGrid = document.querySelector('.allocation-stat-grid');
    expect(statGrid).not.toBeNull();
    expect(statGrid?.textContent || '').toMatch(/Covered\s*0/i);
    expect(statGrid?.textContent || '').toMatch(/Still Short\s*15/i);

    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*10/i);
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*5/i);
    });

    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*15/i);
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*0/i);
    });

    const firstRowCells = within(rows[0]).getAllByRole('cell');
    const secondRowCells = within(rows[1]).getAllByRole('cell');
    const thirdRowCells = within(rows[2]).getAllByRole('cell');
    expect(firstRowCells[firstRowCells.length - 1].textContent || '').toBe('10');
    expect(secondRowCells[secondRowCells.length - 1].textContent || '').toBe('5');
    expect(thirdRowCells[thirdRowCells.length - 1].textContent || '').toBe('0');

    queryClient.clear();
  });

  it('keeps the same requirement open when an allocation leaves remaining LF uncovered', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      result: {
        allocations: [
          {
            allocationId: 'alloc-1',
            boxId: 'IL1-6915',
            warehouse: 'IL1',
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            allocatedFeet: 10,
            coveredFeet: 10,
            requirementId: 'req-1',
            allocationKind: 'REQUIREMENT',
            allocationSource: 'MANUAL' as const,
            status: 'ACTIVE',
            createdAt: '2026-04-07T21:25:03Z',
            createdBy: 'tester',
            resolvedAt: '',
            resolvedBy: '',
            filmOrderId: '',
            notes: ''
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 5
      },
      warnings: []
    });
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) => {
      if (payload?.boxId === 'IL1-6769') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 15,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-6769',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 10,
            sourceSuggestedFeet: 10,
            sourceSuggestedCoveredFeet: 10,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 10,
            defaultRemainingFeet: 5
          }
        });
      }

      if (payload?.boxId === 'IL1-6915') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 15,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-6915',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 25,
              sourceSuggestedFeet: 10,
              sourceSuggestedCoveredFeet: 10,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 10,
              defaultRemainingFeet: 5
            }
          });
      }

      return buildPreviewState();
    });
    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'IL1-6769',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        initialFeet: 10,
        feetAvailable: 10,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-05',
        receivedDate: '2026-01-05',
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
        zeroedBy: ''
      },
      {
        boxId: 'IL1-6915',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        initialFeet: 25,
        feetAvailable: 25,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-01',
        receivedDate: '2026-01-01',
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
        zeroedBy: ''
      }
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '17170'
    });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    const checkboxes = within(table).getAllByRole('checkbox');
    expect(rows).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*0/i);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*15/i);

    fireEvent.click(checkboxes[1]);

    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*10/i)
    );
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*5/i);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId: 'IL1-6915',
          selectedSuggestionBoxIds: [],
          requestedFeet: 15,
          requirementId: 'req-1'
        })
      )
    );
    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation saved',
          description: expect.stringContaining('5 LF remains unallocated.'),
          variant: 'success'
        })
      )
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('req-1');
    expect(screen.getByDisplayValue('5')).toBeTruthy();

    queryClient.clear();
  });

  it('keeps the same requirement open when the user allocates only part of the remaining LF', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      result: {
        allocations: [
          {
            allocationId: 'alloc-1',
            boxId: 'IL1-RN07',
            warehouse: 'IL1',
            jobNumber: '55555',
            installDate: '',
            crewLeader: '',
            allocatedFeet: 5,
            coveredFeet: 5,
            requirementId: 'req-1',
            allocationKind: 'REQUIREMENT',
            allocationSource: 'MANUAL' as const,
            status: 'ACTIVE',
            createdAt: '2026-04-21T12:00:00Z',
            createdBy: 'tester',
            resolvedAt: '',
            resolvedBy: '',
            filmOrderId: '',
            notes: ''
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) =>
      payload?.boxId === 'IL1-RN07'
        ? buildPreviewState({
            data: {
              jobNumber: '55555',
              installDate: '',
              crewLeader: '',
              requestedFeet: 5,
              requestedWidthIn: 48,
              sourceBoxId: 'IL1-RN07',
              sourceWarehouse: 'IL1',
              sourceWidthIn: 48,
              sourceBoxFeetAvailable: 50,
              sourceSuggestedFeet: 5,
              sourceSuggestedCoveredFeet: 5,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 5,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );
    searchBoxesMock.mockResolvedValue([buildSearchBox({ boxId: 'IL1-RN07' })]);

    const { queryClient } = renderDialog();

    fireEvent.change(screen.getByLabelText('Requested LF'), {
      target: { value: '5' }
    });

    const table = await screen.findByRole('table');
    fireEvent.click(within(table).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation saved',
          variant: 'success'
        })
      )
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('req-1');
    expect(screen.getByDisplayValue('10')).toBeTruthy();

    queryClient.clear();
  });

  it('waits for allocation success before advancing to the next requirement', async () => {
    const firstSave = createDeferred<{
      result: {
        allocations: Array<Record<string, unknown>>;
        filmOrder: null;
        remainingUncoveredFeet: number;
      };
      warnings: string[];
    }>();
    const mutateAsync = vi.fn().mockImplementation(() => firstSave.promise);
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) => {
      if (payload?.boxId === 'IL1-RN07') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 15,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-RN07',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 25,
            sourceSuggestedFeet: 15,
            sourceSuggestedCoveredFeet: 15,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 15,
            defaultRemainingFeet: 0
          }
        });
      }

      if (payload?.boxId === 'IL1-P60') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 12,
            requestedWidthIn: 60,
            sourceBoxId: 'IL1-P60',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 60,
            sourceBoxFeetAvailable: 30,
            sourceSuggestedFeet: 12,
            sourceSuggestedCoveredFeet: 12,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 12,
            defaultRemainingFeet: 0
          }
        });
      }

      return buildPreviewState();
    });
    searchBoxesMock.mockImplementation(async (params: { q?: string; manufacturer?: string }) => {
      if (params.q === 'RN 07') {
        return [
          buildSearchBox({
            boxId: 'IL1-RN07',
            manufacturer: 'Llumar',
            filmName: 'RN 07',
            widthIn: 48
          })
        ];
      }

      if (params.q === 'Prestige 60') {
        return [
          buildSearchBox({
            boxId: 'IL1-P60',
            manufacturer: '3M Solar',
            filmName: 'Prestige 60',
            widthIn: 60
          })
        ];
      }

      return [];
    });

    const { queryClient } = renderDialog({
      jobNumber: '17170',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 15,
          allocatedFeet: 0,
          remainingFeet: 15
        },
        {
          requirementId: 'req-2',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          requiredFeet: 12,
          allocatedFeet: 0,
          remainingFeet: 12
        }
      ]
    });

    const table = await screen.findByRole('table');
    const checkbox = within(table).getByRole('checkbox');
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*15/i)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(true)
    );

    const requirementSelect = screen.getByRole('combobox') as HTMLSelectElement;
    expect(requirementSelect.value).toBe('req-1');
    expect(screen.getByDisplayValue('15')).toBeTruthy();

    firstSave.resolve({
      result: {
        allocations: [
          {
            allocationId: 'alloc-1',
            boxId: 'IL1-RN07',
            allocatedFeet: 15,
            coveredFeet: 15
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation saved',
          variant: 'success'
        })
      )
    );
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('req-2'));
    expect(screen.getByDisplayValue('12')).toBeTruthy();

    queryClient.clear();
  });

  it('waits for the final allocation save before closing the dialog', async () => {
    const save = createDeferred<{
      result: {
        allocations: Array<Record<string, unknown>>;
        filmOrder: null;
        remainingUncoveredFeet: number;
      };
      warnings: string[];
    }>();
    const mutateAsync = vi.fn().mockImplementation(() => save.promise);
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) =>
      payload?.boxId === 'IL1-BOX'
        ? buildPreviewState({
            data: {
              jobNumber: '55555',
              installDate: '',
              crewLeader: '',
              requestedFeet: 15,
              requestedWidthIn: 48,
              sourceBoxId: 'IL1-BOX',
              sourceWarehouse: 'IL1',
              sourceWidthIn: 48,
              sourceBoxFeetAvailable: 50,
              sourceSuggestedFeet: 15,
              sourceSuggestedCoveredFeet: 15,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 15,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );
    searchBoxesMock.mockResolvedValue([buildSearchBox()]);
    const onCancel = vi.fn();

    const { queryClient } = renderDialog({
      onCancel,
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 15,
          allocatedFeet: 0,
          remainingFeet: 15
        }
      ]
    });

    const checkbox = within(await screen.findByRole('table')).getByRole('checkbox');
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*15/i)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    expect(onCancel).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(true)
    );

    save.resolve({
      result: {
        allocations: [
          {
            allocationId: 'alloc-final',
            boxId: 'IL1-BOX',
            allocatedFeet: 15,
            coveredFeet: 15
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation saved',
          variant: 'success'
        })
      )
    );
    await waitFor(() => expect(onCancel).toHaveBeenCalled());

    queryClient.clear();
  });

  it('prevents a second allocation submit while the first allocation save is still pending', async () => {
    const firstSave = createDeferred<{
      result: {
        allocations: Array<Record<string, unknown>>;
        filmOrder: null;
        remainingUncoveredFeet: number;
      };
      warnings: string[];
    }>();
    const mutateAsync = vi.fn().mockImplementation(() => firstSave.promise);
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) => {
      if (payload?.boxId === 'IL1-RN07') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 15,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-RN07',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 25,
            sourceSuggestedFeet: 15,
            sourceSuggestedCoveredFeet: 15,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 15,
            defaultRemainingFeet: 0
          }
        });
      }

      if (payload?.boxId === 'IL1-P60') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 12,
            requestedWidthIn: 60,
            sourceBoxId: 'IL1-P60',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 60,
            sourceBoxFeetAvailable: 30,
            sourceSuggestedFeet: 12,
            sourceSuggestedCoveredFeet: 12,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 12,
            defaultRemainingFeet: 0
          }
        });
      }

      return buildPreviewState();
    });
    searchBoxesMock.mockImplementation(async (params: { q?: string }) => {
      if (params.q === 'RN 07') {
        return [buildSearchBox({ boxId: 'IL1-RN07', manufacturer: 'Llumar', filmName: 'RN 07', widthIn: 48 })];
      }

      if (params.q === 'Prestige 60') {
        return [buildSearchBox({ boxId: 'IL1-P60', manufacturer: '3M Solar', filmName: 'Prestige 60', widthIn: 60 })];
      }

      return [];
    });

    const { queryClient } = renderDialog({
      jobNumber: '17170',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 15,
          allocatedFeet: 0,
          remainingFeet: 15
        },
        {
          requirementId: 'req-2',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          requiredFeet: 12,
          allocatedFeet: 0,
          remainingFeet: 12
        }
      ]
    });

    let table = await screen.findByRole('table');
    fireEvent.click(within(table).getByRole('checkbox'));

    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*15/i)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement).disabled).toBe(true)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    firstSave.resolve({
      result: {
        allocations: [
          {
            allocationId: 'alloc-1',
            boxId: 'IL1-RN07',
            allocatedFeet: 15,
            coveredFeet: 15
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation saved',
          variant: 'success'
        })
      )
    );
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('req-2'));

    queryClient.clear();
  });

  it('keeps the same requirement selected when allocation save fails', async () => {
    const firstSave = createDeferred<{
      result: {
        allocations: Array<Record<string, unknown>>;
        filmOrder: null;
        remainingUncoveredFeet: number;
      };
      warnings: string[];
    }>();
    const mutateAsync = vi.fn().mockImplementationOnce(() => firstSave.promise);
    useAllocateBoxMock.mockReturnValue({
      isPending: false,
      mutateAsync
    });
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) => {
      if (payload?.boxId === 'IL1-RN07') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 15,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-RN07',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 25,
            sourceSuggestedFeet: 15,
            sourceSuggestedCoveredFeet: 15,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 15,
            defaultRemainingFeet: 0
          }
        });
      }

      if (payload?.boxId === 'IL1-P60') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 12,
            requestedWidthIn: 60,
            sourceBoxId: 'IL1-P60',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 60,
            sourceBoxFeetAvailable: 30,
            sourceSuggestedFeet: 12,
            sourceSuggestedCoveredFeet: 12,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 12,
            defaultRemainingFeet: 0
          }
        });
      }

      return buildPreviewState();
    });
    searchBoxesMock.mockImplementation(async (params: { q?: string }) => {
      if (params.q === 'RN 07') {
        return [buildSearchBox({ boxId: 'IL1-RN07', manufacturer: 'Llumar', filmName: 'RN 07', widthIn: 48 })];
      }

      if (params.q === 'Prestige 60') {
        return [buildSearchBox({ boxId: 'IL1-P60', manufacturer: '3M Solar', filmName: 'Prestige 60', widthIn: 60 })];
      }

      return [];
    });

    const { queryClient } = renderDialog({
      jobNumber: '17170',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 15,
          allocatedFeet: 0,
          remainingFeet: 15
        },
        {
          requirementId: 'req-2',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 60,
          requiredFeet: 12,
          allocatedFeet: 0,
          remainingFeet: 12
        }
      ]
    });

    let table = await screen.findByRole('table');
    fireEvent.click(within(table).getByRole('checkbox'));

    await waitFor(() =>
      expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*15/i)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    firstSave.reject(new Error('The allocation could not be completed.'));

    await waitFor(() =>
      expect(toastPushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Allocation failed',
          description: 'The allocation could not be completed.',
          variant: 'error'
        })
      )
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('req-1');
    expect(screen.getByDisplayValue('15')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Saving...' })).toBeNull();

    queryClient.clear();
  });

  it('starts with no boxes selected and lets the user uncheck the only selected box', async () => {
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string } | null) =>
      payload?.boxId === 'MS1-487'
        ? buildPreviewState({
            data: {
              jobNumber: '17872',
              installDate: '',
              crewLeader: '',
              requestedFeet: 85,
              requestedWidthIn: 36,
              sourceBoxId: 'MS1-487',
              sourceWarehouse: 'MS1',
              sourceWidthIn: 60,
              sourceBoxFeetAvailable: 86,
              sourceSuggestedFeet: 85,
              sourceSuggestedCoveredFeet: 85,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 85,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );
    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'MS1-487',
        warehouse: 'MS1',
        manufacturer: 'Security',
        filmName: '3M Ultra S800',
        widthIn: 60,
        initialFeet: 86,
        feetAvailable: 86,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-01',
        receivedDate: '2026-01-01',
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
        zeroedBy: ''
      }
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '17872',
      warehouse: 'MS1',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Security',
          filmName: '3M Ultra S800',
          widthIn: 36,
          requiredFeet: 85,
          allocatedFeet: 0,
          remainingFeet: 85
        }
      ]
    });

    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement;
    const allocateButton = screen.getByRole('button', { name: 'Allocate' });

    expect(checkbox.checked).toBe(false);
    expect((allocateButton as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*0/i);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*85/i);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect((allocateButton as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*85/i);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*0/i);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect((allocateButton as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*0/i);
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Still Short\s*85/i);

    queryClient.clear();
  });

  it('prefers same-warehouse boxes before closer cross-warehouse matches and only previews after manual selection', async () => {
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string; jobWarehouse?: string } | null) =>
      payload?.boxId === 'IL1-6915'
        ? buildPreviewState({
            data: {
              jobNumber: '17170',
              installDate: '',
              crewLeader: '',
              requestedFeet: 5,
              requestedWidthIn: 48,
              sourceBoxId: 'IL1-6915',
              sourceWarehouse: 'IL1',
              sourceWidthIn: 48,
              sourceBoxFeetAvailable: 25,
              sourceSuggestedFeet: 5,
              sourceSuggestedCoveredFeet: 5,
              sourceConflicts: [],
              suggestions: [],
              defaultCoveredFeet: 5,
              defaultRemainingFeet: 0
            }
          })
        : buildPreviewState()
    );
    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'IL1-6915',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        initialFeet: 25,
        feetAvailable: 25,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-01',
        receivedDate: '2026-01-01',
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
        zeroedBy: ''
      },
      {
        boxId: 'MS1-127',
        warehouse: 'MS1',
        manufacturer: 'Llumar',
        filmName: 'RN07',
        widthIn: 60,
        initialFeet: 24,
        feetAvailable: 24,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-02',
        receivedDate: '2026-01-02',
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
        zeroedBy: ''
      }
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '17170',
      warehouse: 'IL1',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 5,
          allocatedFeet: 0,
          remainingFeet: 5
        }
      ]
    });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent || '').toContain('IL1-6915');
    expect(rows[1].textContent || '').toContain('MS1-127');

    const checkboxes = within(table).getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkboxes[0]);

    await waitFor(() =>
      expect(useAllocationPreviewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          boxId: 'IL1-6915',
          jobWarehouse: 'IL1'
        })
      )
    );

    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);

    queryClient.clear();
  });

  it('lets the user reassign the source by unchecking the current box after selecting another one', async () => {
    useAllocationPreviewMock.mockImplementation((payload: { boxId?: string; jobWarehouse?: string } | null) => {
      if (payload?.boxId === 'MS1-127') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 5,
            requestedWidthIn: 48,
            sourceBoxId: 'MS1-127',
            sourceWarehouse: 'MS1',
            sourceWidthIn: 60,
            sourceBoxFeetAvailable: 24,
            sourceSuggestedFeet: 5,
            sourceSuggestedCoveredFeet: 5,
            sourceConflicts: [],
            suggestions: [
              {
                boxId: 'IL1-6915',
                warehouse: 'IL1',
                widthIn: 48,
                availableFeet: 25,
                suggestedFeet: 0,
                suggestedCoveredFeet: 0,
                receivedDate: '2026-01-01',
                orderDate: '2026-01-01'
              }
            ],
            defaultCoveredFeet: 5,
            defaultRemainingFeet: 0
          }
        });
      }

      if (payload?.boxId === 'IL1-6915') {
        return buildPreviewState({
          data: {
            jobNumber: '17170',
            installDate: '',
            crewLeader: '',
            requestedFeet: 5,
            requestedWidthIn: 48,
            sourceBoxId: 'IL1-6915',
            sourceWarehouse: 'IL1',
            sourceWidthIn: 48,
            sourceBoxFeetAvailable: 25,
            sourceSuggestedFeet: 5,
            sourceSuggestedCoveredFeet: 5,
            sourceConflicts: [],
            suggestions: [],
            defaultCoveredFeet: 5,
            defaultRemainingFeet: 0
          }
        });
      }

      return buildPreviewState();
    });
    searchBoxesMock.mockResolvedValue([
      {
        boxId: 'MS1-127',
        warehouse: 'MS1',
        manufacturer: 'Llumar',
        filmName: 'RN07',
        widthIn: 60,
        initialFeet: 24,
        feetAvailable: 24,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-02',
        receivedDate: '2026-01-02',
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
        zeroedBy: ''
      },
      {
        boxId: 'IL1-6915',
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        initialFeet: 25,
        feetAvailable: 25,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-01-01',
        receivedDate: '2026-01-01',
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
        zeroedBy: ''
      }
    ]);

    const { queryClient } = renderDialog({
      jobNumber: '17170',
      warehouse: 'MS1',
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: 'Llumar',
          filmName: 'RN 07',
          widthIn: 48,
          requiredFeet: 5,
          allocatedFeet: 0,
          remainingFeet: 5
        }
      ]
    });

    const table = await screen.findByRole('table');
    let rows = within(table).getAllByRole('row').slice(1);
    let checkboxes = within(table).getAllByRole('checkbox');
    expect(rows[0].textContent || '').toContain('MS1-127');
    expect(rows[1].textContent || '').toContain('IL1-6915');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      const refreshedCheckboxes = within(table).getAllByRole('checkbox');
      expect((refreshedCheckboxes[0] as HTMLInputElement).checked).toBe(true);
      expect((refreshedCheckboxes[1] as HTMLInputElement).checked).toBe(false);
    });

    fireEvent.click(checkboxes[1]);

    await waitFor(() =>
      expect(useAllocationPreviewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          boxId: 'MS1-127',
          jobWarehouse: 'MS1'
        })
      )
    );

    await waitFor(() => {
      const refreshedCheckboxes = within(table).getAllByRole('checkbox');
      expect((refreshedCheckboxes[0] as HTMLInputElement).checked).toBe(true);
      expect((refreshedCheckboxes[1] as HTMLInputElement).checked).toBe(true);
    });

    fireEvent.click(checkboxes[0]);

    rows = within(table).getAllByRole('row').slice(1);
    checkboxes = within(table).getAllByRole('checkbox');
    await waitFor(() => {
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    });
    expect(rows[1].textContent || '').toContain('IL1-6915');
    const secondRowCells = within(rows[1]).getAllByRole('cell');
    expect(secondRowCells[secondRowCells.length - 1].textContent || '').toBe('5');
    expect(document.querySelector('.allocation-stat-grid')?.textContent || '').toMatch(/Covered\s*5/i);

    await waitFor(() =>
      expect(useAllocationPreviewMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          boxId: 'IL1-6915',
          jobWarehouse: 'MS1'
        })
      )
    );

    queryClient.clear();
  });
});
