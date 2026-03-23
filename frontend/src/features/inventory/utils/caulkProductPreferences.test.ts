import { describe, expect, it } from 'vitest';
import type { CaulkProductEntry } from '../../../domain';
import { getPreferredCaulkProductId } from './caulkProductPreferences';

function createCaulkProductEntry(overrides: Partial<CaulkProductEntry>): CaulkProductEntry {
  return {
    productId: 'product-1',
    manufacturerId: 'manufacturer-1',
    manufacturer: '3M',
    productName: 'Bronze Caulk',
    productCode: '',
    lookupKey: '3m-bronze-caulk',
    tubesPerCase: 12,
    isActive: true,
    notes: '',
    updatedAt: '2026-03-22T00:00:00Z',
    ...overrides
  };
}

describe('getPreferredCaulkProductId', () => {
  it('prefers DOW 995 Black when it is present', () => {
    const entries = [
      createCaulkProductEntry({ productId: 'product-3m' }),
      createCaulkProductEntry({
        productId: 'product-dow-995-black',
        manufacturer: 'DOW',
        productName: 'DOW 995 Black',
        productCode: 'DOW-995'
      }),
      createCaulkProductEntry({
        productId: 'product-dow-995-gray',
        manufacturer: 'DOW',
        productName: 'DOW 995 Gray',
        productCode: 'DOW-995'
      })
    ];

    expect(getPreferredCaulkProductId(entries)).toBe('product-dow-995-black');
  });

  it('falls back to the first entry when DOW 995 Black is not present', () => {
    const entries = [
      createCaulkProductEntry({ productId: 'product-3m' }),
      createCaulkProductEntry({
        productId: 'product-dow-995-gray',
        manufacturer: 'DOW',
        productName: 'DOW 995 Gray',
        productCode: 'DOW-995'
      })
    ];

    expect(getPreferredCaulkProductId(entries)).toBe('product-3m');
  });
});
