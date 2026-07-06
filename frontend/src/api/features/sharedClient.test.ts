import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFeatureAccessMap } from '../../domain';

const getStoredAuthSessionMock = vi.fn();

vi.mock('../../lib/storage', () => ({
  getStoredAuthSession: () => getStoredAuthSessionMock()
}));

import {
  __resetJobsApiAvailabilityForTests,
  getClientOfflineInventoryScope,
  mapCaulkStockEntry,
  mapCaulkTransactionEntry,
  mapCaulkTransferEntry,
  setClientAccessContext
} from './sharedClient';

describe('getClientOfflineInventoryScope', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    getStoredAuthSessionMock.mockReset();
  });

  it('uses the active stored session user and approved access org', () => {
    getStoredAuthSessionMock.mockReturnValue({
      token: 'token',
      user: {
        email: 'user@example.com',
        hasProfileName: true,
        name: 'User Example',
        sub: 'user-a'
      },
      issuedAt: 0,
      expiresAt: Date.now() + 60_000
    });
    setClientAccessContext({
      orgId: 'org-a',
      accessStatus: 'approved',
      role: 'owner',
      permissions: createDefaultFeatureAccessMap(),
      isAdminConsoleAllowed: true,
      pendingCount: 0,
      receivesInAppNotifications: true,
      defaultWarehouse: ''
    });

    expect(getClientOfflineInventoryScope()).toEqual({
      userId: 'user-a',
      orgId: 'org-a'
    });
  });

  it('fails closed when user, org, or approval state is missing', () => {
    getStoredAuthSessionMock.mockReturnValue(null);
    setClientAccessContext({
      orgId: 'org-a',
      accessStatus: 'approved',
      role: 'owner',
      permissions: createDefaultFeatureAccessMap(),
      isAdminConsoleAllowed: true,
      pendingCount: 0,
      receivesInAppNotifications: true,
      defaultWarehouse: ''
    });

    expect(getClientOfflineInventoryScope()).toBeNull();

    getStoredAuthSessionMock.mockReturnValue({
      token: 'token',
      user: {
        email: 'user@example.com',
        hasProfileName: true,
        name: 'User Example',
        sub: 'user-a'
      },
      issuedAt: 0,
      expiresAt: Date.now() + 60_000
    });
    setClientAccessContext({
      orgId: 'org-a',
      accessStatus: 'pending',
      role: 'member',
      permissions: createDefaultFeatureAccessMap(),
      isAdminConsoleAllowed: false,
      pendingCount: 0,
      receivesInAppNotifications: false,
      defaultWarehouse: ''
    });

    expect(getClientOfflineInventoryScope()).toBeNull();
  });
});

describe('mapCaulkStockEntry', () => {
  it('preserves owner identity for owner-separated stock rows', () => {
    const entry = mapCaulkStockEntry({
      stockId: 'stock-1',
      productId: 'product-1',
      warehouse: 'il1',
      manufacturerId: 'manufacturer-1',
      manufacturer: '3M',
      productName: 'IPA White',
      productCode: 'IPA-W',
      ownerCompanyId: 'owner-mgt',
      ownerCompanyCode: 'mgt',
      ownerCompanyDisplayName: 'MGT',
      ownerCompanyIsActive: true,
      tubesPerCase: 16,
      tubesOnHand: 18,
      updatedAt: '2026-06-26T00:00:00Z',
      updatedBy: 'tester'
    });

    expect(entry).toMatchObject({
      stockId: 'stock-1',
      warehouse: 'IL1',
      ownerCompanyId: 'owner-mgt',
      ownerCompanyCode: 'MGT',
      ownerCompanyDisplayName: 'MGT',
      ownerCompanyIsActive: true,
      tubesOnHand: 18,
      casesOnHand: 1,
      looseTubes: 2
    });
  });
});

describe('mapCaulkTransferEntry', () => {
  it('maps job warehouse for pending caulk transfer entries', () => {
    const entry = mapCaulkTransferEntry({
      transferId: 'transfer-1',
      caulkAllocationId: 'alloc-1',
      jobNumber: '2941',
      jobWarehouse: 'il1',
      productId: 'product-1',
      manufacturerId: 'manufacturer-1',
      manufacturer: '3M',
      productName: 'IPA White',
      productCode: 'IPA-W',
      tubesPerCase: 16,
      sourceWarehouse: 'MS1',
      destinationWarehouse: 'IL1',
      ownerCompanyId: 'owner-edh',
      ownerCompanyCode: 'edh',
      ownerCompanyDisplayName: 'EDH',
      pendingTubes: 6,
      status: 'PENDING',
      createdAt: '2026-04-17T00:00:00Z',
      createdBy: 'tester',
      receivedAt: '',
      receivedBy: '',
      cancelledAt: '',
      cancelledBy: '',
      updatedAt: '2026-04-17T00:00:00Z',
      updatedBy: 'tester',
      notes: ''
    });

    expect(entry?.jobWarehouse).toBe('IL1');
    expect(entry).toMatchObject({
      ownerCompanyId: 'owner-edh',
      ownerCompanyCode: 'EDH',
      ownerCompanyDisplayName: 'EDH'
    });
  });

  it('preserves optional job identity and scope fields additively', () => {
    const entry = mapCaulkTransferEntry({
      transferId: 'transfer-1',
      caulkAllocationId: 'alloc-1',
      jobNumber: '2941',
      jobId: '11111111-1111-4111-8111-111111111111',
      jobWarehouse: 'il1',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5',
      productId: 'product-1',
      manufacturerId: 'manufacturer-1',
      manufacturer: '3M',
      productName: 'IPA White',
      productCode: 'IPA-W',
      tubesPerCase: 16,
      sourceWarehouse: 'MS1',
      destinationWarehouse: 'IL1',
      pendingTubes: 6,
      status: 'PENDING',
      createdAt: '2026-04-17T00:00:00Z',
      createdBy: 'tester',
      receivedAt: '',
      receivedBy: '',
      cancelledAt: '',
      cancelledBy: '',
      updatedAt: '2026-04-17T00:00:00Z',
      updatedBy: 'tester',
      notes: ''
    });

    expect(entry).toMatchObject({
      jobId: '11111111-1111-4111-8111-111111111111',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5'
    });
  });
});

describe('mapCaulkTransactionEntry', () => {
  it('preserves optional structured job identity and scope fields when present', () => {
    const entry = mapCaulkTransactionEntry({
      transactionId: 'tx-1',
      productId: 'product-1',
      warehouse: 'ms1',
      manufacturer: '3M',
      productName: 'IPA White',
      productCode: 'IPA-W',
      action: 'TRANSFER_IN',
      deltaTubes: 6,
      resultingTubesOnHand: 10,
      tubesPerCase: 16,
      ownerCompanyId: 'owner-kam',
      ownerCompanyCode: 'kam',
      ownerCompanyDisplayName: 'KAM',
      reason: 'Transfer',
      notes: '',
      transferId: 'transfer-1',
      sourceBoxId: '',
      jobId: '22222222-2222-4222-8222-222222222222',
      jobNumber: '4953',
      jobWarehouse: 'il1',
      workScope: 'Lobby',
      sections: 'Lobby',
      createdAt: '2026-04-17T00:00:00Z',
      createdBy: 'tester'
    });

    expect(entry).toMatchObject({
      jobId: '22222222-2222-4222-8222-222222222222',
      jobNumber: '4953',
      jobWarehouse: 'IL1',
      workScope: 'Lobby',
      sections: 'Lobby'
    });
    expect(entry).toMatchObject({
      ownerCompanyId: 'owner-kam',
      ownerCompanyCode: 'KAM',
      ownerCompanyDisplayName: 'KAM'
    });
  });

  it('keeps generic caulk transactions compatible without job identity', () => {
    const entry = mapCaulkTransactionEntry({
      transactionId: 'tx-generic',
      productId: 'product-1',
      warehouse: 'ms1',
      manufacturer: '3M',
      productName: 'IPA White',
      productCode: 'IPA-W',
      action: 'ADJUST',
      deltaTubes: 1,
      resultingTubesOnHand: 11,
      tubesPerCase: 16,
      reason: 'Inventory edit',
      notes: '',
      transferId: '',
      sourceBoxId: '',
      createdAt: '2026-04-17T00:00:00Z',
      createdBy: 'tester'
    });

    expect(entry?.jobId).toBeUndefined();
    expect(entry?.jobNumber).toBeUndefined();
    expect(entry?.workScope).toBeUndefined();
    expect(entry?.sections).toBeUndefined();
  });
});
