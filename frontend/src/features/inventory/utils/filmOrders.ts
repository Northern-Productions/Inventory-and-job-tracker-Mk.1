import type { FilmOrderEntry, FilmOrderStatus } from '../../../domain';

export function isUnresolvedFilmOrderStatus(status: FilmOrderStatus | string): boolean {
  const normalizedStatus = String(status || '').trim().toUpperCase();
  return normalizedStatus === 'FILM_ORDER' || normalizedStatus === 'FILM_ON_THE_WAY';
}

export function hasFilmOrderInstallDate(
  order: Pick<FilmOrderEntry, 'jobDate'> | null | undefined
): boolean {
  return Boolean(String(order?.jobDate || '').trim());
}

export function isUnresolvedFilmOrder(
  order: Pick<FilmOrderEntry, 'status'> | null | undefined
): boolean {
  return Boolean(order && isUnresolvedFilmOrderStatus(order.status));
}

export function isFilmOrderNeedingAttention(
  order: Pick<FilmOrderEntry, 'status' | 'jobDate'> | null | undefined
): boolean {
  return Boolean(order && isUnresolvedFilmOrderStatus(order.status) && hasFilmOrderInstallDate(order));
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
  entries: ReadonlyArray<Pick<FilmOrderEntry, 'status' | 'jobDate'>> | null | undefined
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
  entries: ReadonlyArray<Pick<FilmOrderEntry, 'status' | 'jobDate'>> | null | undefined
): boolean {
  return countFilmOrdersNeedingAttention(entries) > 0;
}
