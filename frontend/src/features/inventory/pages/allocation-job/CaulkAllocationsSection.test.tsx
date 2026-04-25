// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaulkJobAllocationEntry, CaulkJobCheckoutEntry } from '../../../../domain';
import { CaulkAllocationsSection } from './CaulkAllocationsSection';

function buildAllocation(
  overrides: Partial<CaulkJobAllocationEntry> = {}
): CaulkJobAllocationEntry {
  return {
    caulkAllocationId: 'caulk-1',
    requirementId: 'req-1',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: 'Geocel',
    productName: '2300',
    productCode: 'G2300',
    tubesPerCase: 12,
    warehouse: 'IL1',
    allocatedTubes: 12,
    reservedTubesRemaining: 12,
    checkedOutTubesTotal: 0,
    returnedUnusedTubesTotal: 0,
    usedTubesTotal: 0,
    overageTubesTotal: 0,
    outstandingCheckoutTubes: 0,
    openCheckoutCount: 0,
    status: 'ACTIVE',
    allocationSource: 'MANUAL',
    createdAt: '2026-04-15T08:00:00Z',
    createdBy: 'tester',
    updatedAt: '2026-04-15T08:00:00Z',
    updatedBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    ...overrides
  };
}

function buildCheckout(
  overrides: Partial<CaulkJobCheckoutEntry> = {}
): CaulkJobCheckoutEntry {
  return {
    caulkCheckoutId: 'checkout-1',
    caulkAllocationId: 'caulk-1',
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: 'Geocel',
    productName: '2300',
    productCode: 'G2300',
    tubesPerCase: 12,
    warehouse: 'IL1',
    checkoutTubes: 12,
    overageTubes: 0,
    status: 'OPEN',
    checkedOutAt: '2026-04-15T09:00:00Z',
    checkedOutBy: 'tester',
    checkedInAt: '',
    checkedInBy: '',
    unusedTubes: 0,
    usedTubes: 0,
    notes: '',
    ...overrides
  };
}

describe('CaulkAllocationsSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('only disables the row that has a pending caulk mutation', () => {
    render(
      <CaulkAllocationsSection
        entries={[
          buildAllocation(),
          buildAllocation({
            caulkAllocationId: 'caulk-2',
            requirementId: 'req-2',
            productId: 'product-2',
            productCode: 'SCS1200',
            productName: '1200',
            manufacturer: 'SilPruf'
          })
        ]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        canManageTransfers={true}
        canOpenAllocateDialog={true}
        isAuthenticated={true}
        clientIdConfigured={true}
        openCaulkCheckoutByAllocationId={{}}
        productsErrorMessage=""
        isCaulkAllocationPending={(caulkAllocationId) => caulkAllocationId === 'caulk-1'}
        isCaulkCheckoutPending={() => false}
        isCaulkTransferPending={() => false}
        onOpenAllocateDialog={vi.fn()}
        onOpenEdit={vi.fn()}
        onOpenCheckout={vi.fn()}
        onOpenCheckin={vi.fn()}
        onReceiveTransfer={vi.fn()}
        onCancelTransfer={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    const rows = screen.getAllByRole('row');
    const firstDataRow = rows[1];
    const secondDataRow = rows[2];

    expect(screen.getByRole('button', { name: 'Allocate Caulk' }).hasAttribute('disabled')).toBe(
      false
    );
    expect(within(firstDataRow).getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(
      true
    );
    expect(
      within(firstDataRow).getByRole('button', { name: 'Check Out' }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      within(firstDataRow).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')
    ).toBe(true);

    expect(within(secondDataRow).getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(
      false
    );
    expect(
      within(secondDataRow).getByRole('button', { name: 'Check Out' }).hasAttribute('disabled')
    ).toBe(false);
    expect(
      within(secondDataRow).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')
    ).toBe(false);
  });

  it('only disables the open checkout row that is being checked in', () => {
    render(
      <CaulkAllocationsSection
        entries={[
          buildAllocation({
            caulkAllocationId: 'caulk-1',
            checkedOutTubesTotal: 12,
            reservedTubesRemaining: 0,
            openCheckoutCount: 1
          }),
          buildAllocation({
            caulkAllocationId: 'caulk-2',
            requirementId: 'req-2',
            productId: 'product-2',
            productCode: 'SCS1200',
            productName: '1200',
            manufacturer: 'SilPruf',
            checkedOutTubesTotal: 12,
            reservedTubesRemaining: 0,
            openCheckoutCount: 1
          })
        ]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        canManageTransfers={true}
        canOpenAllocateDialog={true}
        isAuthenticated={true}
        clientIdConfigured={true}
        openCaulkCheckoutByAllocationId={{
          'caulk-1': buildCheckout(),
          'caulk-2': buildCheckout({
            caulkCheckoutId: 'checkout-2',
            caulkAllocationId: 'caulk-2',
            productId: 'product-2',
            productCode: 'SCS1200',
            productName: '1200',
            manufacturer: 'SilPruf'
          })
        }}
        productsErrorMessage=""
        isCaulkAllocationPending={() => false}
        isCaulkCheckoutPending={(caulkCheckoutId) => caulkCheckoutId === 'checkout-1'}
        isCaulkTransferPending={() => false}
        onOpenAllocateDialog={vi.fn()}
        onOpenEdit={vi.fn()}
        onOpenCheckout={vi.fn()}
        onOpenCheckin={vi.fn()}
        onReceiveTransfer={vi.fn()}
        onCancelTransfer={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    const rows = screen.getAllByRole('row');
    const firstDataRow = rows[1];
    const secondDataRow = rows[2];

    expect(
      within(firstDataRow).getByRole('button', { name: 'Check In' }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      within(secondDataRow).getByRole('button', { name: 'Check In' }).hasAttribute('disabled')
    ).toBe(false);
  });
});
