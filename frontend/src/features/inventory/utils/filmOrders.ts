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
    const boxId = String(entry?.boxId || '').trim().toUpperCase();
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

export function formatFilmOrderLinkedBoxIds(
  order: FilmOrderLinkedBoxesEntry | null | undefined,
  emptyLabel = FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL
): string {
  const boxIds = getFilmOrderLinkedBoxIds(order);
  return boxIds.length ? boxIds.join(', ') : emptyLabel;
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
