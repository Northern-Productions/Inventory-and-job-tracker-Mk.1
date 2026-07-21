import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFilmBoxAllocationEligibility,
} from '../../../shared/domain/filmBoxAllocationEligibility.mjs';

function box(overrides = {}) {
  return {
    boxId: 'IL1-100',
    warehouse: 'IL1',
    status: 'IN_STOCK',
    ...overrides,
  };
}

test('same-warehouse allocation retains the reviewed allocatable statuses', () => {
  for (const status of ['IN_STOCK', 'ORDERED', 'CHECKED_OUT']) {
    assert.deepEqual(
      getFilmBoxAllocationEligibility(box({ status }), null, 'IL1'),
      { eligible: true, requiresTransfer: false, reason: '' },
    );
  }
});

test('cross-warehouse transfer assist requires unreserved in-stock custody', () => {
  assert.deepEqual(
    getFilmBoxAllocationEligibility(box(), null, 'MS1', {
      allowTransferAssist: true,
      hasReservations: false,
    }),
    { eligible: true, requiresTransfer: true, reason: '' },
  );

  assert.match(
    getFilmBoxAllocationEligibility(box({ status: 'ORDERED' }), null, 'MS1').reason,
    /must be in stock/i,
  );
  assert.match(
    getFilmBoxAllocationEligibility(box(), null, 'MS1', { hasReservations: true }).reason,
    /already has reserved film/i,
  );
});

test('pending transfer custody is never allocation eligible before receipt', () => {
  for (const status of ['IN_STOCK', 'TRANSFER']) {
    const result = getFilmBoxAllocationEligibility(
      box({ status }),
      { status: 'PENDING', destinationWarehouse: 'MS1' },
      'MS1',
    );
    assert.equal(result.eligible, false);
    assert.equal(result.requiresTransfer, false);
    assert.match(result.reason, /not physically available until receipt/i);
  }
});

test('extra-film and other non-assisted modes reject cross-warehouse boxes', () => {
  const result = getFilmBoxAllocationEligibility(box(), null, 'MS1', {
    allowTransferAssist: false,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.requiresTransfer, false);
  assert.match(result.reason, /must be received at MS1/i);
});
