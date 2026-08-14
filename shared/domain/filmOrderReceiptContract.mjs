import { computeCoveredFeetForAllocation } from './allocationCoverageContract.mjs';

export const FILM_ORDER_RECEIPT_LEDGER_VERSION = 'film-order-receipt-v2';
export const FILM_ORDER_LEDGER_VERSION = 'film-order-ledger-v2';

function firstDefined(record, camelName, snakeName) {
  if (record && record[camelName] !== undefined) {
    return record[camelName];
  }
  return record?.[snakeName];
}

function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function nonBlank(value) {
  return String(value ?? '').trim();
}

export function getFilmOrderReceiptHistoryStatus(link, box) {
  const contribution = firstDefined(link, 'receiptContributionFeet', 'receipt_contribution_feet');
  const sourceWidth = firstDefined(link, 'receiptSourceWidthIn', 'receipt_source_width_in');
  const finalizedAt = firstDefined(link, 'receiptFinalizedAt', 'receipt_finalized_at');

  if (
    contribution !== null && contribution !== undefined &&
    positiveNumber(sourceWidth) !== null &&
    nonBlank(finalizedAt)
  ) {
    return 'FINALIZED';
  }

  return nonBlank(box?.status).toUpperCase() === 'ORDERED' ? 'PENDING' : 'MISSING';
}

export function getFilmOrderLinkSourceFeet(link, box) {
  const status = getFilmOrderReceiptHistoryStatus(link, box);
  if (status === 'FINALIZED') {
    return nonNegativeInteger(firstDefined(link, 'receiptContributionFeet', 'receipt_contribution_feet'));
  }
  if (status === 'PENDING') {
    const initialFeet = firstDefined(box, 'initialFeet', 'initial_feet');
    if (initialFeet !== null && initialFeet !== undefined && Number.isFinite(Number(initialFeet))) {
      return nonNegativeInteger(initialFeet);
    }
    return nonNegativeInteger(firstDefined(link, 'orderedFeet', 'ordered_feet'));
  }
  return null;
}

export function getFilmOrderLinkSourceWidth(link, box, filmOrder) {
  if (getFilmOrderReceiptHistoryStatus(link, box) === 'FINALIZED') {
    return positiveNumber(firstDefined(link, 'receiptSourceWidthIn', 'receipt_source_width_in'));
  }
  return positiveNumber(firstDefined(box, 'widthIn', 'width_in')) || positiveNumber(filmOrder?.widthIn ?? filmOrder?.width_in);
}

export function getFilmOrderLinkCoveredFeet(filmOrder, link, box) {
  const sourceFeet = getFilmOrderLinkSourceFeet(link, box);
  if (sourceFeet === null) {
    return null;
  }
  return computeCoveredFeetForAllocation(
    sourceFeet,
    getFilmOrderLinkSourceWidth(link, box, filmOrder),
    filmOrder?.widthIn ?? filmOrder?.width_in
  );
}

export function getFilmOrderLinkReceivedFeet(filmOrder, link, box) {
  const status = getFilmOrderReceiptHistoryStatus(link, box);
  if (status === 'MISSING') {
    return null;
  }
  if (status !== 'FINALIZED') {
    return 0;
  }
  return getFilmOrderLinkCoveredFeet(filmOrder, link, box);
}

export function hasCompleteFilmOrderReceiptHistory(link, box) {
  return getFilmOrderReceiptHistoryStatus(link, box) !== 'MISSING';
}
