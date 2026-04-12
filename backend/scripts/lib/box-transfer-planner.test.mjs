import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTransferredBoxId,
  planTransferredBoxId,
} from '../../../frontend/src/domain/boxTransferPlanner.mjs';

const WAREHOUSE_PREFIXES = ['IL1', 'MS1', 'TX1'];

test('plans the first transfer destination with the original warehouse tag', () => {
  assert.equal(
    buildTransferredBoxId('IL1-1111', 'IL1', 'MS1', WAREHOUSE_PREFIXES),
    'MS1-1111-IL1',
  );
});

test('keeps the original warehouse tag on later transfers', () => {
  assert.equal(
    buildTransferredBoxId('MS1-1111-IL1', 'MS1', 'TX1', WAREHOUSE_PREFIXES),
    'TX1-1111-IL1',
  );
});

test('returns home to the plain home id when no extra suffix is present', () => {
  assert.equal(
    buildTransferredBoxId('TX1-1111-IL1', 'TX1', 'IL1', WAREHOUSE_PREFIXES),
    'IL1-1111',
  );
});

test('keeps custom suffixes while still stripping the repeated origin tag on return home', () => {
  assert.equal(
    buildTransferredBoxId('MS1-1111-IL1-2', 'MS1', 'TX1', WAREHOUSE_PREFIXES),
    'TX1-1111-IL1-2',
  );
  assert.equal(
    buildTransferredBoxId('TX1-1111-IL1-2', 'TX1', 'IL1', WAREHOUSE_PREFIXES),
    'IL1-1111-2',
  );
});

test('accepts a destination-prefixed override and rejects the wrong prefix', () => {
  assert.equal(
    planTransferredBoxId('IL1-1111', 'IL1', 'MS1', WAREHOUSE_PREFIXES, 'ms1-1111-il1-2'),
    'MS1-1111-IL1-2',
  );

  assert.throws(
    () => planTransferredBoxId('IL1-1111', 'IL1', 'MS1', WAREHOUSE_PREFIXES, 'TX1-1111'),
    /must start with MS1-/i,
  );
});
