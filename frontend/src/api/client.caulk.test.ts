import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => {
  class APIError extends Error {
    warnings: string[];

    constructor(message: string, warnings: string[] = []) {
      super(message);
      this.name = 'APIError';
      this.warnings = warnings;
    }
  }

  return {
    APIError,
    request: vi.fn()
  };
});

vi.mock('./features/sharedClient', () => ({
  assertFeatureAccess: vi.fn(),
  assertOwnerAccess: vi.fn(),
  getClientOfflineInventoryScope: vi.fn(() => null),
  mapCaulkManufacturerEntry: vi.fn(),
  mapCaulkProductEntry: (value: unknown) => value,
  mapCaulkStockEntry: vi.fn(),
  mapCaulkTransactionEntry: vi.fn(),
  requestReadWithFallback: vi.fn()
}));

import { upsertCaulkProduct } from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

describe('caulk API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('passes warehouse through POST /caulk/products/upsert when creating a new product row', async () => {
    const payload = {
      manufacturerId: 'manufacturer-1',
      productName: '3M IPA White',
      warehouse: 'MS1' as const,
      tubesPerCase: 16
    };

    requestMock.mockResolvedValueOnce({
      data: {
        productId: 'product-1',
        manufacturerId: 'manufacturer-1',
        manufacturer: '3M',
        productName: '3M IPA White',
        productCode: '',
        lookupKey: '3m ipa white',
        tubesPerCase: 16,
        isActive: true,
        notes: '',
        updatedAt: '2026-04-16T00:00:00Z'
      },
      warnings: []
    });

    await upsertCaulkProduct(payload);

    expect(requestMock).toHaveBeenCalledWith('POST', '/caulk/products/upsert', {
      body: payload
    });
  });
});
