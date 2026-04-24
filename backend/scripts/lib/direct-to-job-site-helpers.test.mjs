import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECT_TO_SITE_CHECKED_OUT_PREFIX,
  DIRECT_TO_SITE_CREATED_PREFIX,
  DIRECT_TO_SITE_FIRST_RETURN_PREFIX,
  assertDirectToJobSiteFlagIsServerOwned,
  assertNoShipDirectToJobSiteFlag,
  assertNoWarehouseReceiptInputsForDirectToJobSite,
  buildDirectToJobSiteCheckedOutAuditNote,
  buildDirectToJobSiteCreatedAuditNote,
  buildDirectToJobSiteFirstReturnNote,
  getDirectToJobSiteAvailableFeet,
  getDirectToJobSiteCommittedFeet,
  parseShipDirectToJobSiteFlag,
} from '../../src/app/services/runtime/boxes/directToJobSite.mjs';

test('parseShipDirectToJobSiteFlag only accepts the approved request flag', () => {
  assert.equal(parseShipDirectToJobSiteFlag({}), false);
  assert.equal(parseShipDirectToJobSiteFlag({ shipDirectToJobSite: true }), true);
  assert.equal(parseShipDirectToJobSiteFlag({ shipDirectToJobSite: 'true' }), true);
  assert.throws(
    () => parseShipDirectToJobSiteFlag({ shipDirectToJobSite: 'maybe' }),
    /ShipDirectToJobSite must be true or false/
  );
});

test('generic update and status flows reject direct-to-job-site flags', () => {
  assert.throws(
    () => assertDirectToJobSiteFlagIsServerOwned({ directToJobSite: true }, 'Update Box'),
    /cannot set DirectToJobSite directly/
  );
  assert.throws(
    () => assertNoShipDirectToJobSiteFlag({ shipDirectToJobSite: true }, 'Set Box Status'),
    /only allowed when adding a box through Film Order fulfillment/
  );
});

test('direct-to-job-site fulfillment rejects warehouse receipt fields', () => {
  assert.doesNotThrow(() =>
    assertNoWarehouseReceiptInputsForDirectToJobSite({
      receivedDate: '',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      coreType: '',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null,
    })
  );

  assert.throws(
    () => assertNoWarehouseReceiptInputsForDirectToJobSite({ receivedDate: '2026-04-20' }),
    /cannot include warehouse receipt dates or initial warehouse weight fields/
  );
  assert.throws(
    () => assertNoWarehouseReceiptInputsForDirectToJobSite({ lastRollWeightLbs: 12.5 }),
    /cannot include warehouse receipt dates or initial warehouse weight fields/
  );
});

test('direct-to-job-site committed feet and remaining feet preserve first-return math', () => {
  assert.equal(
    getDirectToJobSiteCommittedFeet({ requestedFeet: 120, coveredFeet: 20 }, 90),
    90
  );
  assert.equal(
    getDirectToJobSiteCommittedFeet({ requestedFeet: 120, coveredFeet: 120 }, 90),
    0
  );
  assert.equal(getDirectToJobSiteAvailableFeet(100, 65), 35);
});

test('direct-to-job-site audit notes use standardized machine-readable prefixes', () => {
  const createdNote = buildDirectToJobSiteCreatedAuditNote({
    filmOrderId: 'FO-1',
    jobNumber: '2941',
    userNote: 'Ordered from vendor stock'
  });
  const checkedOutNote = buildDirectToJobSiteCheckedOutAuditNote({
    filmOrderId: 'FO-1',
    jobNumber: '2941'
  });

  assert.match(createdNote, new RegExp(`^${DIRECT_TO_SITE_CREATED_PREFIX}: `));
  assert.match(checkedOutNote, new RegExp(`^${DIRECT_TO_SITE_CHECKED_OUT_PREFIX}: `));
  assert.match(createdNote, /Additional note: Ordered from vendor stock/);
  assert.match(checkedOutNote, /job 2941/);
});

test('direct-to-job-site first return notes stay standardized and carry the calibration metrics', () => {
  const note = buildDirectToJobSiteFirstReturnNote({
    jobNumber: '2941',
    lastRollWeightLbs: 3.34,
    currentFeetOnRoll: 19,
    userNote: 'Returned after install'
  });

  assert.match(note, new RegExp(`^${DIRECT_TO_SITE_FIRST_RETURN_PREFIX}: `));
  assert.match(note, /3.34 lbs with 19 LF remaining/);
  assert.match(note, /Additional note: Returned after install/);
});
