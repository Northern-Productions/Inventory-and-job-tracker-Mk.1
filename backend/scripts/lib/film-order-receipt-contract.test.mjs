import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILM_ORDER_LEDGER_VERSION,
  FILM_ORDER_RECEIPT_LEDGER_VERSION,
  getFilmOrderLinkCoveredFeet,
  getFilmOrderLinkReceivedFeet,
  getFilmOrderLinkSourceFeet,
  getFilmOrderReceiptHistoryStatus,
  hasCompleteFilmOrderReceiptHistory,
} from '../../../shared/domain/filmOrderReceiptContract.mjs';

const order = { widthIn: 60 };
const finalized = {
  orderedFeet: 60,
  receiptContributionFeet: 60,
  receiptSourceWidthIn: 60,
  receiptFinalizedAt: '2026-08-13T12:00:00.000Z',
};

test('Film Order receipt versions identify the historical ledger contract', () => {
  assert.equal(FILM_ORDER_LEDGER_VERSION, 'film-order-ledger-v2');
  assert.equal(FILM_ORDER_RECEIPT_LEDGER_VERSION, 'film-order-receipt-v2');
});

test('finalized receipt credit is independent from mutable inventory LF and Initial LF', () => {
  for (const box of [
    { status: 'IN_STOCK', initialFeet: 60, physicalFeetAvailable: 60, widthIn: 60 },
    { status: 'IN_STOCK', initialFeet: 60, physicalFeetAvailable: 35, widthIn: 60 },
    { status: 'CHECKED_OUT', initialFeet: 32, physicalFeetAvailable: 10, widthIn: 60 },
    { status: 'TRANSFER', initialFeet: 100, physicalFeetAvailable: 0, widthIn: 60 },
    { status: 'ZEROED', initialFeet: 0, physicalFeetAvailable: 0, widthIn: 60 },
  ]) {
    assert.equal(getFilmOrderReceiptHistoryStatus(finalized, box), 'FINALIZED');
    assert.equal(getFilmOrderLinkSourceFeet(finalized, box), 60);
    assert.equal(getFilmOrderLinkCoveredFeet(order, finalized, box), 60);
    assert.equal(getFilmOrderLinkReceivedFeet(order, finalized, box), 60);
    assert.equal(hasCompleteFilmOrderReceiptHistory(finalized, box), true);
  }
});

test('pending receipt follows pre-finalization Initial LF and split receipts add deterministically', () => {
  const pending = { orderedFeet: 60 };
  const first = { ...finalized, receiptContributionFeet: 35 };
  const second = { ...finalized, receiptContributionFeet: 25 };

  assert.equal(getFilmOrderReceiptHistoryStatus(pending, { status: 'ORDERED', initialFeet: 35 }), 'PENDING');
  assert.equal(getFilmOrderLinkSourceFeet(pending, { status: 'ORDERED', initialFeet: 35 }), 35);
  assert.equal(getFilmOrderLinkReceivedFeet(order, pending, { status: 'ORDERED', initialFeet: 35 }), 0);
  assert.equal(
    getFilmOrderLinkReceivedFeet(order, first, { status: 'IN_STOCK', widthIn: 60 }) +
      getFilmOrderLinkReceivedFeet(order, second, { status: 'IN_STOCK', widthIn: 60 }),
    60
  );
});

test('receipt correction changes only the authoritative historical contribution', () => {
  const corrected = { ...finalized, receiptContributionFeet: 52 };
  const liveBox = { status: 'IN_STOCK', initialFeet: 60, physicalFeetAvailable: 20, widthIn: 60 };

  assert.equal(getFilmOrderLinkReceivedFeet(order, finalized, liveBox), 60);
  assert.equal(getFilmOrderLinkReceivedFeet(order, corrected, liveBox), 52);
  assert.deepEqual(liveBox, {
    status: 'IN_STOCK',
    initialFeet: 60,
    physicalFeetAvailable: 20,
    widthIn: 60,
  });
});

test('source-width snapshots preserve split-width receipt conversion', () => {
  const wideReceipt = {
    ...finalized,
    receiptContributionFeet: 30,
    receiptSourceWidthIn: 60,
  };
  const narrowOrder = { widthIn: 30 };

  assert.equal(getFilmOrderLinkReceivedFeet(narrowOrder, wideReceipt, { status: 'IN_STOCK', widthIn: 36 }), 60);
});

test('received links without deterministic history remain unknown instead of reading live box quantities or becoming zero', () => {
  const missing = { orderedFeet: 60 };
  const box = { status: 'IN_STOCK', initialFeet: 60, physicalFeetAvailable: 40, widthIn: 60 };

  assert.equal(getFilmOrderReceiptHistoryStatus(missing, box), 'MISSING');
  assert.equal(getFilmOrderLinkSourceFeet(missing, box), null);
  assert.equal(getFilmOrderLinkCoveredFeet(order, missing, box), null);
  assert.equal(getFilmOrderLinkReceivedFeet(order, missing, box), null);
  assert.equal(hasCompleteFilmOrderReceiptHistory(missing, box), false);
});

test('shared receipt contract accepts database snake-case rows without changing semantics', () => {
  const link = {
    ordered_feet: 60,
    receipt_contribution_feet: 35,
    receipt_source_width_in: '60.0000',
    receipt_finalized_at: '2026-08-13T12:00:00.000Z',
  };
  const box = { status: 'IN_STOCK', initial_feet: 90, width_in: 60 };

  assert.equal(getFilmOrderReceiptHistoryStatus(link, box), 'FINALIZED');
  assert.equal(getFilmOrderLinkReceivedFeet({ width_in: 60 }, link, box), 35);
});
