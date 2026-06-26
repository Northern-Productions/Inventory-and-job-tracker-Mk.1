import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => {
  class APIError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIError';
    }
  }

  return {
    APIError,
    request: vi.fn()
  };
});

vi.mock('./features/sharedClient', async () => {
  const actual = await vi.importActual<typeof import('./features/sharedClient')>('./features/sharedClient');
  return {
    ...actual,
    assertFeatureAccess: vi.fn(),
    assertOwnerAccess: vi.fn(),
    requestReadWithFallback: vi.fn()
  };
});

import {
  bulkTransferOwnership,
  changeCaulkStockOwner,
  changeFilmBoxOwner,
  listOwnerCompanies,
  upsertOwnerCompany
} from './client';
import { request } from './http';
import { assertOwnerAccess, requestReadWithFallback } from './features/sharedClient';

const requestMock = vi.mocked(request);
const requestReadWithFallbackMock = vi.mocked(requestReadWithFallback);
const assertOwnerAccessMock = vi.mocked(assertOwnerAccess);

describe('ownership API client', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestReadWithFallbackMock.mockReset();
    assertOwnerAccessMock.mockClear();
  });

  it('lists owner companies through the shared read route', async () => {
    requestReadWithFallbackMock.mockResolvedValueOnce({
      entries: [
        {
          ownerCompanyId: 'owner-mgt',
          code: 'mgt',
          displayName: 'MGT',
          lookupKey: 'mgt',
          isActive: true
        }
      ]
    });

    const entries = await listOwnerCompanies({ includeInactive: true });

    expect(requestReadWithFallbackMock).toHaveBeenCalledWith(
      '/owner-companies/list',
      { includeInactive: true },
      { includeInactive: true }
    );
    expect(entries).toEqual([
      expect.objectContaining({
        ownerCompanyId: 'owner-mgt',
        code: 'MGT',
        isActive: true
      })
    ]);
  });

  it('uses owner-only mutation routes for ownership management', async () => {
    requestMock
      .mockResolvedValueOnce({
        data: {
          ownerCompanyId: 'owner-edh',
          code: 'EDH',
          displayName: 'EDH',
          isActive: true
        },
        warnings: []
      })
      .mockResolvedValueOnce({ data: { changedCount: 1, batchId: 'batch-box', events: [] }, warnings: [] })
      .mockResolvedValueOnce({ data: { changedCount: 1, batchId: 'batch-caulk', events: [] }, warnings: [] })
      .mockResolvedValueOnce({ data: { changedCount: 2, batchId: 'batch-bulk', events: [] }, warnings: [] });

    await upsertOwnerCompany({ code: 'EDH' });
    await changeFilmBoxOwner({ boxId: 'IL1-7001', ownerCompanyId: 'owner-edh', note: 'Accounting correction' });
    await changeCaulkStockOwner({ stockId: 'stock-1', ownerCompanyId: 'owner-edh' });
    await bulkTransferOwnership({
      filmBoxIds: ['IL1-7001'],
      caulkStockIds: ['stock-1'],
      ownerCompanyId: 'owner-edh'
    });

    expect(assertOwnerAccessMock).toHaveBeenCalledTimes(4);
    expect(requestMock).toHaveBeenNthCalledWith(1, 'POST', '/owner/owner-companies/upsert', {
      body: { code: 'EDH' }
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'POST', '/owner/inventory-ownership/box', {
      body: { boxId: 'IL1-7001', ownerCompanyId: 'owner-edh', note: 'Accounting correction' }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'POST', '/owner/inventory-ownership/caulk-stock', {
      body: { stockId: 'stock-1', ownerCompanyId: 'owner-edh' }
    });
    expect(requestMock).toHaveBeenNthCalledWith(4, 'POST', '/owner/inventory-ownership/bulk-transfer', {
      body: {
        filmBoxIds: ['IL1-7001'],
        caulkStockIds: ['stock-1'],
        ownerCompanyId: 'owner-edh'
      }
    });
  });
});
