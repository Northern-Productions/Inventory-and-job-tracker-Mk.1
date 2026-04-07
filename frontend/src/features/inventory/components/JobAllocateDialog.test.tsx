// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import { JobAllocateDialog } from './JobAllocateDialog';

const toastPushMock = vi.fn();
const useAllocateBoxMock = vi.fn();
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

vi.mock('../hooks/useInventoryQueries', () => ({
  useAllocateBox: () => useAllocateBoxMock(),
  useCreateFilmOrder: () => useCreateFilmOrderMock()
}));

vi.mock('../../../api/features/inventoryClient', () => ({
  searchBoxes: (...args: unknown[]) => searchBoxesMock(...args)
}));

function buildMutationState() {
  return {
    isPending: false,
    mutateAsync: vi.fn()
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

function renderDialog(
  overrides: Partial<{
    jobNumber: string;
    warehouse: Warehouse;
    dueDate: string;
    crewLeader: string;
    requirements: JobRequirementLine[];
    filmOrders: FilmOrderEntry[];
  }> = {}
) {
  const queryClient = createQueryClient();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <JobAllocateDialog
        open
        jobNumber={overrides.jobNumber || '55555'}
        warehouse={overrides.warehouse || 'IL1'}
        dueDate={overrides.dueDate || ''}
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
        onCancel={() => undefined}
      />
    </QueryClientProvider>
  );

  return {
    ...view,
    queryClient
  };
}

describe('JobAllocateDialog', () => {
  beforeEach(() => {
    toastPushMock.mockReset();
    useAllocateBoxMock.mockReset();
    useCreateFilmOrderMock.mockReset();
    searchBoxesMock.mockReset();
    useAllocateBoxMock.mockReturnValue(buildMutationState());
    useCreateFilmOrderMock.mockReturnValue(buildMutationState());
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

  it('searches with manufacturer plus q and ranks exact RN07-family boxes ahead of descriptive variants', async () => {
    searchBoxesMock.mockImplementation(async (params: { warehouse: string }) => {
      if (params.warehouse === 'IL1') {
        return [
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
        ];
      }

      return [];
    });

    const { queryClient } = renderDialog();

    await waitFor(() => expect(searchBoxesMock).toHaveBeenCalledTimes(2));
    expect(searchBoxesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouse: 'IL1',
        manufacturer: 'Llumar',
        q: 'RN 07',
        showRetired: false
      })
    );
    expect(searchBoxesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouse: 'MS1',
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
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[2] as HTMLInputElement).checked).toBe(false);

    queryClient.clear();
  });
});
