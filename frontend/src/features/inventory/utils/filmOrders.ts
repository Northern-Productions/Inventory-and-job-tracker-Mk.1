import type { FilmOrderEntry, FilmOrderLinkedBox, FilmOrderStatus } from '../../../domain';

type FilmOrderAttentionEntry = Pick<FilmOrderEntry, 'status'> &
  Partial<Pick<FilmOrderEntry, 'remainingToOrderFeet' | 'installDate'>>;
type FilmOrderOriginEntry = Partial<Pick<FilmOrderEntry, 'origin' | 'sourceBoxId'>>;
type FilmOrderLinkedBoxesEntry = Partial<Pick<FilmOrderEntry, 'linkedBoxes'>>;

export const FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL = '--';

export interface FilmOrderLinkedBoxDisplayEntry {
  boxId: string;
  isReceived: boolean;
}

interface FilmOrderLinkedBoxMutationEntry {
  boxId: string;
  dealer?: string;
  orderedFeet: number;
  autoAllocatedFeet?: number;
  isReceived?: boolean;
}

type FilmOrderDerivedStateEntry = Pick<
  FilmOrderEntry,
  'status' | 'requestedFeet' | 'coveredFeet' | 'orderedFeet' | 'linkedBoxes' | 'resolvedAt' | 'resolvedBy'
>;

interface FilmOrderLinkedBoxSelectionOptions {
  excludeBoxIds?: string[];
}

interface FilmOrderDerivedStateOptions {
  actor?: string;
  now?: string;
}

export function getFilmOrderOrigin(
  order: FilmOrderOriginEntry | null | undefined
): NonNullable<FilmOrderEntry['origin']> {
  const explicitOrigin = String(order?.origin || '').trim().toUpperCase();
  if (explicitOrigin === 'AUTO_SHORTAGE' || explicitOrigin === 'MANUAL') {
    return explicitOrigin;
  }

  return String(order?.sourceBoxId || '').trim() ? 'AUTO_SHORTAGE' : 'MANUAL';
}

export function formatFilmOrderOriginLabel(
  order: FilmOrderOriginEntry | null | undefined
): string {
  return getFilmOrderOrigin(order) === 'AUTO_SHORTAGE' ? 'Auto shortage' : 'Manual';
}

export function getFilmOrderOriginSourceBoxId(
  order: FilmOrderOriginEntry | null | undefined
): string {
  if (getFilmOrderOrigin(order) !== 'AUTO_SHORTAGE') {
    return '';
  }

  return String(order?.sourceBoxId || '').trim();
}

function normalizeLinkedBoxId(value: string) {
  return String(value || '').trim().toUpperCase();
}

function normalizeDealerName(value: string) {
  return String(value || '').trim();
}

export function getFilmOrderLinkedBoxIds(
  order: FilmOrderLinkedBoxesEntry | null | undefined
): string[] {
  return getFilmOrderLinkedBoxes(order).map((entry) => entry.boxId);
}

export function getFilmOrderLinkedBoxes(
  order: FilmOrderLinkedBoxesEntry | null | undefined
): FilmOrderLinkedBoxDisplayEntry[] {
  if (!Array.isArray(order?.linkedBoxes) || !order.linkedBoxes.length) {
    return [];
  }

  const dedupedEntries = new Map<string, FilmOrderLinkedBoxDisplayEntry>();
  for (let index = 0; index < order.linkedBoxes.length; index += 1) {
    const entry = order.linkedBoxes[index] as Partial<FilmOrderLinkedBox> | null | undefined;
    const boxId = normalizeLinkedBoxId(entry?.boxId || '');
    if (!boxId) {
      continue;
    }

    const previousEntry = dedupedEntries.get(boxId);
    dedupedEntries.set(boxId, {
      boxId,
      isReceived: Boolean(previousEntry?.isReceived || entry?.isReceived)
    });
  }

  return Array.from(dedupedEntries.values()).sort((left, right) => left.boxId.localeCompare(right.boxId));
}

export function getFilmOrderDealerNames(
  order: FilmOrderLinkedBoxesEntry | null | undefined
): string[] {
  if (!Array.isArray(order?.linkedBoxes) || !order.linkedBoxes.length) {
    return [];
  }

  const dealerNames: string[] = [];
  const seenLookupKeys = new Set<string>();
  for (let index = 0; index < order.linkedBoxes.length; index += 1) {
    const entry = order.linkedBoxes[index] as Partial<FilmOrderLinkedBox> | null | undefined;
    const dealer = normalizeDealerName(entry?.dealer || '');
    if (!dealer) {
      continue;
    }

    const lookupKey = dealer.toLocaleLowerCase();
    if (seenLookupKeys.has(lookupKey)) {
      continue;
    }

    seenLookupKeys.add(lookupKey);
    dealerNames.push(dealer);
  }

  return dealerNames;
}

export function formatFilmOrderDealerLabel(
  order: FilmOrderLinkedBoxesEntry | null | undefined,
  emptyLabel = FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL
): string {
  const dealerNames = getFilmOrderDealerNames(order);
  return dealerNames.length ? dealerNames.join(', ') : emptyLabel;
}

export function getNextFilmOrderLinkedBoxToReceive(
  order: FilmOrderLinkedBoxesEntry | null | undefined,
  options: FilmOrderLinkedBoxSelectionOptions = {}
): FilmOrderLinkedBoxDisplayEntry | null {
  const excludedBoxIds = new Set(
    (options.excludeBoxIds || []).map((entry) => normalizeLinkedBoxId(entry)).filter(Boolean)
  );

  const linkedBoxes = getFilmOrderLinkedBoxes(order);
  for (let index = 0; index < linkedBoxes.length; index += 1) {
    const entry = linkedBoxes[index];
    if (entry.isReceived || excludedBoxIds.has(entry.boxId)) {
      continue;
    }

    return entry;
  }

  return null;
}

export function formatFilmOrderLinkedBoxIds(
  order: FilmOrderLinkedBoxesEntry | null | undefined,
  emptyLabel = FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL
): string {
  const boxIds = getFilmOrderLinkedBoxIds(order);
  return boxIds.length ? boxIds.join(', ') : emptyLabel;
}

export function deriveFilmOrderStatusFromLinkedBoxes(
  order: FilmOrderDerivedStateEntry,
  options: FilmOrderDerivedStateOptions = {}
): Pick<FilmOrderEntry, 'status' | 'resolvedAt' | 'resolvedBy'> {
  const normalizedStatus = String(order.status || '').trim().toUpperCase();
  if (normalizedStatus === 'CANCELLED') {
    return {
      status: 'CANCELLED',
      resolvedAt: String(order.resolvedAt || '').trim(),
      resolvedBy: String(order.resolvedBy || '').trim()
    };
  }

  const requestedFeet = Math.max(0, Number(order.requestedFeet || 0));
  const coveredFeet = Math.max(0, Number(order.coveredFeet || 0));
  const orderedFeet = Math.max(0, Number(order.orderedFeet || 0));
  const linkedBoxes = Array.isArray(order.linkedBoxes) ? order.linkedBoxes : [];
  const normalizedLinkedBoxes = linkedBoxes
    .map((entry) => ({
      boxId: normalizeLinkedBoxId(entry?.boxId || ''),
      isReceived: Boolean(entry?.isReceived)
    }))
    .filter((entry) => entry.boxId);
  const hasLinkedBoxes = normalizedLinkedBoxes.length > 0;
  const allLinkedBoxesReceived =
    hasLinkedBoxes && normalizedLinkedBoxes.every((entry) => entry.isReceived);

  let nextStatus: FilmOrderStatus;
  if (hasLinkedBoxes) {
    nextStatus =
      orderedFeet < requestedFeet
        ? 'FILM_ORDER'
        : allLinkedBoxesReceived
          ? 'FULFILLED'
          : 'FILM_ON_THE_WAY';
  } else if (coveredFeet >= requestedFeet) {
    nextStatus = 'FULFILLED';
  } else if (orderedFeet >= requestedFeet) {
    nextStatus = 'FILM_ON_THE_WAY';
  } else {
    nextStatus = 'FILM_ORDER';
  }

  if (nextStatus === 'FULFILLED') {
    const resolvedAt = String(order.resolvedAt || '').trim() || options.now || new Date().toISOString();
    const resolvedBy = String(order.resolvedBy || '').trim() || String(options.actor || '').trim() || 'Pending...';
    return {
      status: nextStatus,
      resolvedAt,
      resolvedBy
    };
  }

  return {
    status: nextStatus,
    resolvedAt: '',
    resolvedBy: ''
  };
}

export function addOptimisticLinkedBoxToFilmOrder(
  order: FilmOrderEntry,
  linkedBox: FilmOrderLinkedBoxMutationEntry,
  options: FilmOrderDerivedStateOptions = {}
): FilmOrderEntry {
  const normalizedBoxId = normalizeLinkedBoxId(linkedBox.boxId);
  if (!normalizedBoxId) {
    return order;
  }

  const nextOrderedFeet =
    Math.max(0, Number(order.orderedFeet || 0)) + Math.max(0, Number(linkedBox.orderedFeet || 0));
  const nextRemainingToOrderFeet = Math.max(
    Math.max(0, Number(order.requestedFeet || 0)) - nextOrderedFeet,
    0
  );
  const nextLinkedBoxes = [
    ...order.linkedBoxes,
    {
      boxId: normalizedBoxId,
      dealer: normalizeDealerName(linkedBox.dealer || ''),
      orderedFeet: Math.max(0, Number(linkedBox.orderedFeet || 0)),
      autoAllocatedFeet: Math.max(0, Number(linkedBox.autoAllocatedFeet || 0)),
      isReceived: Boolean(linkedBox.isReceived)
    }
  ];
  const derivedState = deriveFilmOrderStatusFromLinkedBoxes(
    {
      ...order,
      orderedFeet: nextOrderedFeet,
      linkedBoxes: nextLinkedBoxes
    },
    options
  );

  return {
    ...order,
    orderedFeet: nextOrderedFeet,
    remainingToOrderFeet: nextRemainingToOrderFeet,
    status: derivedState.status,
    resolvedAt: derivedState.resolvedAt,
    resolvedBy: derivedState.resolvedBy,
    linkedBoxes: nextLinkedBoxes
  };
}

export function markFilmOrderLinkedBoxReceived(
  order: FilmOrderEntry,
  boxId: string,
  options: FilmOrderDerivedStateOptions = {}
): FilmOrderEntry {
  const normalizedBoxId = normalizeLinkedBoxId(boxId);
  if (!normalizedBoxId) {
    return order;
  }

  let didUpdate = false;
  const nextLinkedBoxes = order.linkedBoxes.map((entry) => {
    if (normalizeLinkedBoxId(entry.boxId) !== normalizedBoxId || entry.isReceived) {
      return entry;
    }

    didUpdate = true;
    return {
      ...entry,
      isReceived: true
    };
  });

  if (!didUpdate) {
    return order;
  }

  const derivedState = deriveFilmOrderStatusFromLinkedBoxes(
    {
      ...order,
      linkedBoxes: nextLinkedBoxes
    },
    options
  );

  return {
    ...order,
    status: derivedState.status,
    resolvedAt: derivedState.resolvedAt,
    resolvedBy: derivedState.resolvedBy,
    linkedBoxes: nextLinkedBoxes
  };
}

export function isUnresolvedFilmOrderStatus(status: FilmOrderStatus | string): boolean {
  const normalizedStatus = String(status || '').trim().toUpperCase();
  return normalizedStatus === 'FILM_ORDER' || normalizedStatus === 'FILM_ON_THE_WAY';
}

export function hasFilmOrderInstallDate(
  order: Partial<Pick<FilmOrderEntry, 'installDate'>> | null | undefined
): boolean {
  return Boolean(String(order?.installDate || '').trim());
}

function hasRemainingFilmToOrder(
  order: Partial<Pick<FilmOrderEntry, 'remainingToOrderFeet'>> | null | undefined
): boolean {
  const remainingToOrderFeet = Number(order?.remainingToOrderFeet);
  return Number.isFinite(remainingToOrderFeet) ? remainingToOrderFeet > 0 : true;
}

export function isUnresolvedFilmOrder(
  order: Pick<FilmOrderEntry, 'status'> | null | undefined
): boolean {
  return Boolean(order && isUnresolvedFilmOrderStatus(order.status));
}

export function isFilmOrderNeedingAttention(
  order: FilmOrderAttentionEntry | null | undefined
): boolean {
  if (!order) {
    return false;
  }

  const normalizedStatus = String(order.status || '').trim().toUpperCase();
  return (
    normalizedStatus === 'FILM_ORDER' &&
    hasFilmOrderInstallDate(order) &&
    hasRemainingFilmToOrder(order)
  );
}

export function countUnresolvedFilmOrders(
  entries: ReadonlyArray<Pick<FilmOrderEntry, 'status'>> | null | undefined
): number {
  if (!entries?.length) {
    return 0;
  }

  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (isUnresolvedFilmOrder(entries[index])) {
      count += 1;
    }
  }

  return count;
}

export function hasUnresolvedFilmOrders(
  entries: ReadonlyArray<Pick<FilmOrderEntry, 'status'>> | null | undefined
): boolean {
  return countUnresolvedFilmOrders(entries) > 0;
}

export function countFilmOrdersNeedingAttention(
  entries: ReadonlyArray<FilmOrderAttentionEntry> | null | undefined
): number {
  if (!entries?.length) {
    return 0;
  }

  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (isFilmOrderNeedingAttention(entries[index])) {
      count += 1;
    }
  }

  return count;
}

export function hasFilmOrdersNeedingAttention(
  entries: ReadonlyArray<FilmOrderAttentionEntry> | null | undefined
): boolean {
  return countFilmOrdersNeedingAttention(entries) > 0;
}
