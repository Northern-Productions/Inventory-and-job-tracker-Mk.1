import { describe, expect, it } from 'vitest';
import { mapCaulkTransactionEntry, mapCaulkTransferEntry } from './sharedClient';

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
