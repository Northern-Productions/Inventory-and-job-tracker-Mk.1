// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaulkJobCheckoutEntry } from '../../../../domain';
import { CaulkCheckoutCyclesSection } from './CaulkCheckoutCyclesSection';

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

describe('CaulkCheckoutCyclesSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('only disables the checkout cycle currently being checked in', () => {
    render(
      <CaulkCheckoutCyclesSection
        entries={[
          buildCheckout(),
          buildCheckout({
            caulkCheckoutId: 'checkout-2',
            caulkAllocationId: 'caulk-2',
            productId: 'product-2',
            productCode: 'SCS1200',
            productName: '1200',
            manufacturer: 'SilPruf'
          })
        ]}
        isPhoneLayout={false}
        isReadOnlyJob={false}
        isCaulkCheckoutPending={(caulkCheckoutId) => caulkCheckoutId === 'checkout-1'}
        onOpenCheckin={vi.fn()}
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
