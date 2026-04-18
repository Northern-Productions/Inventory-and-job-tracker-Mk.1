import { describe, expect, it } from 'vitest';
import { mapCaulkTransferEntry } from './sharedClient';

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
});
