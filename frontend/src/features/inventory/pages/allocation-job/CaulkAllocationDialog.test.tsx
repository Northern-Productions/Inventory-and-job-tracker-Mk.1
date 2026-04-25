// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { Warehouse } from '../../../../domain';
import { CaulkAllocationDialog } from './CaulkAllocationDialog';

const listCaulkStockMock = vi.fn();

vi.mock('../../../../api/features/caulkClient', () => ({
  listCaulkStock: (params: unknown) => listCaulkStockMock(params)
}));

function buildQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });
}

function renderDialog(stockRows: unknown[], editorOverrides: Record<string, unknown> = {}, allocationOverrides: Record<string, unknown> = {}) {
  const queryClient = buildQueryClient();
  const warehouseOptions: Warehouse[] = ['IL1', 'MS1', 'AZ1'];
  queryClient.setQueryData(['caulk', 'stock', 'allocation-dialog', 'product-1'], stockRows);

  render(
    <QueryClientProvider client={queryClient}>
      <CaulkAllocationDialog
        editor={{
          mode: 'add',
          caulkAllocationId: '',
          requirementId: '',
          productId: 'product-1',
          warehouse: 'MS1',
          transferFromWarehouse: '',
          allocatedTubes: '3',
          notes: '',
          lockProductWarehouse: false,
          minAllocatedTubes: 1,
          ...editorOverrides
        }}
        setEditor={vi.fn()}
        error=""
        setError={vi.fn()}
        pending={false}
        caulkRequirements={[]}
        caulkAllocations={[
          {
            caulkAllocationId: 'alloc-1',
            requirementId: '',
            productId: 'product-1',
            manufacturerId: 'manufacturer-1',
            manufacturer: '3M',
            productName: 'IPA White',
            productCode: 'IPA-W',
            tubesPerCase: 16,
            warehouse: 'MS1',
            allocatedTubes: 10,
            reservedTubesRemaining: 10,
            checkedOutTubesTotal: 0,
            returnedUnusedTubesTotal: 0,
            usedTubesTotal: 0,
            overageTubesTotal: 0,
            outstandingCheckoutTubes: 0,
            openCheckoutCount: 0,
            status: 'ACTIVE',
            allocationSource: 'MANUAL',
            createdAt: '2026-04-16T00:00:00Z',
            createdBy: 'tester',
            updatedAt: '2026-04-16T00:00:00Z',
            updatedBy: 'tester',
            resolvedAt: '',
            resolvedBy: '',
            notes: '',
            ...allocationOverrides
          }
        ]}
        caulkProducts={[
          {
            productId: 'product-1',
            manufacturerId: 'manufacturer-1',
            manufacturer: '3M',
            productName: 'IPA White',
            productCode: 'IPA-W',
            lookupKey: '3m ipa white ipa-w',
            tubesPerCase: 16,
            isActive: true,
            notes: '',
            updatedAt: '2026-04-16T00:00:00Z'
          }
        ]}
        warehouseOptions={warehouseOptions}
        onSubmit={vi.fn()}
      />
    </QueryClientProvider>
  );

  return queryClient;
}

afterEach(() => {
  cleanup();
  listCaulkStockMock.mockReset();
});

describe('CaulkAllocationDialog', () => {
  it('shows a transfer-assist picker when the selected warehouse is short on stock', () => {
    listCaulkStockMock.mockResolvedValue([]);

    renderDialog([
      {
        warehouse: 'MS1',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        tubesOnHand: 0,
        casesOnHand: 0,
        looseTubes: 0,
        updatedAt: '2026-04-16T00:00:00Z',
        updatedBy: 'tester'
      },
      {
        warehouse: 'IL1',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        tubesOnHand: 6,
        casesOnHand: 0,
        looseTubes: 6,
        updatedAt: '2026-04-16T00:00:00Z',
        updatedBy: 'tester'
      },
      {
        warehouse: 'AZ1',
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: 'IPA White',
        productCode: 'IPA-W',
        tubesPerCase: 16,
        tubesOnHand: 2,
        casesOnHand: 0,
        looseTubes: 2,
        updatedAt: '2026-04-16T00:00:00Z',
        updatedBy: 'tester'
      }
    ]);

    expect(screen.getByText('MS1 is short 3 tubes for this allocation.')).toBeTruthy();
    expect(screen.getByText('Transfer From')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transfer + Add Allocation' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'IL1 (6 tubes available)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'AZ1 (2 tubes available)' })).toBeNull();
  });

  it('uses the transfer-assisted save label only for the additional reserve delta during edits', () => {
    listCaulkStockMock.mockResolvedValue([]);

    renderDialog(
      [
        {
          warehouse: 'MS1',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: '3M',
          productName: 'IPA White',
          productCode: 'IPA-W',
          tubesPerCase: 16,
          tubesOnHand: 1,
          casesOnHand: 0,
          looseTubes: 1,
          updatedAt: '2026-04-16T00:00:00Z',
          updatedBy: 'tester'
        },
        {
          warehouse: 'IL1',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: '3M',
          productName: 'IPA White',
          productCode: 'IPA-W',
          tubesPerCase: 16,
          tubesOnHand: 4,
          casesOnHand: 0,
          looseTubes: 4,
          updatedAt: '2026-04-16T00:00:00Z',
          updatedBy: 'tester'
        }
      ],
      {
        mode: 'edit',
        caulkAllocationId: 'alloc-1',
        allocatedTubes: '12'
      }
    );

    expect(screen.getByText('MS1 is short 1 tube for this allocation.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transfer + Save Allocation' })).toBeTruthy();
  });
});
