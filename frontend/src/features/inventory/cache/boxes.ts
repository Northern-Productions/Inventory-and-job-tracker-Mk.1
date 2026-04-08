import type { QueryClient } from '@tanstack/react-query';
import type { AddBoxPayload, Box, SearchBoxesParams } from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { matchesBoxSearchQuery, rankBoxSearchCandidates } from '../../../domain/boxSearchMatcher.mjs';
import { normalizeManufacturerLookupKey } from '../../../lib/manufacturerCanonicalization';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';

function updateMatchingBoxEntries(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: (box: Box) => Box
) {
  const queries = queryClient.getQueriesData<Box[]>({ queryKey });
  for (let index = 0; index < queries.length; index += 1) {
    const [currentQueryKey, current] = queries[index];
    if (!current) {
      continue;
    }

    let didUpdate = false;
    const nextEntries = current.map((box) => {
      const nextBox = updater(box);
      if (nextBox !== box) {
        didUpdate = true;
      }
      return nextBox;
    });

    if (!didUpdate) {
      continue;
    }

    queryClient.setQueryData<Box[]>(currentQueryKey, nextEntries);
  }
}

function removeMatchingBoxEntries(queryClient: QueryClient, queryKey: readonly unknown[], boxId: string) {
  const queries = queryClient.getQueriesData<Box[]>({ queryKey });
  for (let index = 0; index < queries.length; index += 1) {
    const [currentQueryKey, current] = queries[index];
    if (!current) {
      continue;
    }

    const nextEntries = current.filter((box) => box.boxId !== boxId);
    if (nextEntries.length === current.length) {
      continue;
    }

    queryClient.setQueryData<Box[]>(currentQueryKey, nextEntries);
  }
}

export function updateBoxCaches(
  queryClient: QueryClient,
  boxId: string,
  updater: (box: Box) => Box
) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), (current) =>
    current ? updater(current) : current
  );

  updateMatchingBoxEntries(queryClient, inventoryKeys.listRoot, (box) =>
    box.boxId === boxId ? updater(box) : box
  );
  updateMatchingBoxEntries(queryClient, inventoryKeys.searchRoot, (box) =>
    box.boxId === boxId ? updater(box) : box
  );
}

export function removeBoxCaches(queryClient: QueryClient, boxId: string) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), undefined);
  removeMatchingBoxEntries(queryClient, inventoryKeys.listRoot, boxId);
  removeMatchingBoxEntries(queryClient, inventoryKeys.searchRoot, boxId);
}

export function createOptimisticBoxFromAddPayload(payload: AddBoxPayload): Box {
  const isReceived = Boolean(payload.receivedDate);

  return {
    boxId: payload.boxId,
    warehouse: payload.warehouse || WAREHOUSE_CODES[0],
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    initialFeet: payload.initialFeet,
    feetAvailable: payload.feetAvailable,
    lotRun: payload.lotRun || '',
    status: isReceived ? 'IN_STOCK' : 'ORDERED',
    orderDate: payload.orderDate,
    receivedDate: payload.receivedDate,
    initialWeightLbs: payload.initialWeightLbs ?? null,
    lastRollWeightLbs: payload.lastRollWeightLbs ?? null,
    lastWeighedDate: payload.lastWeighedDate || '',
    filmKey: payload.filmKey || '',
    coreType: payload.coreType || '',
    coreWeightLbs: payload.coreWeightLbs ?? null,
    lfWeightLbsPerFt: payload.lfWeightLbsPerFt ?? null,
    pricePerLf: payload.pricePerLf ?? null,
    purchaseCost: payload.purchaseCost ?? null,
    notes: payload.notes || '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

function normalizeSearchBoxesQueryKeyParams(queryKey: readonly unknown[]) {
  if (!Array.isArray(queryKey) || queryKey.length < 3) {
    return null;
  }

  return (queryKey[2] as Partial<SearchBoxesParams> | undefined) || null;
}

function isLowStockBoxForSearch(box: Box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < 10;
}

function matchesSearchBoxesParams(box: Box, params: Partial<SearchBoxesParams> | null) {
  if (!params) {
    return true;
  }

  const normalizedWarehouse = String(params.warehouse || '')
    .trim()
    .toUpperCase();
  if (normalizedWarehouse && box.warehouse !== normalizedWarehouse) {
    return false;
  }

  const status = String(params.status || '')
    .trim()
    .toUpperCase();
  if (status && box.status !== status) {
    return false;
  }

  const manufacturer = String(params.manufacturer || '').trim();
  if (
    manufacturer &&
    normalizeManufacturerLookupKey(box.manufacturer).indexOf(
      normalizeManufacturerLookupKey(manufacturer)
    ) === -1
  ) {
    return false;
  }

  const width = String(params.width || '').trim();
  if (width && String(box.widthIn) !== width) {
    return false;
  }

  const film = String(params.film || '')
    .trim()
    .toLowerCase();
  if (
    film &&
    !box.filmName.toLowerCase().includes(film) &&
    !box.manufacturer.toLowerCase().includes(film) &&
    !box.filmKey.toLowerCase().includes(film)
  ) {
    return false;
  }

  const query = String(params.q || '')
    .trim()
    .toLowerCase();
  if (query && !matchesBoxSearchQuery(box, query)) {
    return false;
  }

  if (!params.showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
    return false;
  }

  return true;
}

function sortBoxesForSearchCache(boxes: Box[], params: Partial<SearchBoxesParams> | null) {
  let ordered = boxes;

  if (params?.film) {
    const lowStock = ordered.filter((box) => isLowStockBoxForSearch(box));
    const remaining = ordered.filter((box) => !lowStock.includes(box));
    lowStock.sort((left, right) =>
      left.feetAvailable !== right.feetAvailable
        ? left.feetAvailable - right.feetAvailable
        : left.boxId < right.boxId
          ? -1
          : left.boxId > right.boxId
            ? 1
            : 0
    );

    ordered = [...lowStock, ...remaining];
  }

  const query = String(params?.q || '').trim();
  if (query) {
    ordered = rankBoxSearchCandidates(ordered, query);
  }

  return ordered;
}

export function upsertBoxInSearchCaches(queryClient: QueryClient, box: Box) {
  const normalizedBoxId = box.boxId.trim().toUpperCase();
  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });

  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    const params = normalizeSearchBoxesQueryKeyParams(queryKey);
    const nextMatches = matchesSearchBoxesParams(box, params);
    const existingIndex = current.findIndex(
      (entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId
    );

    if (!nextMatches) {
      if (existingIndex === -1) {
        continue;
      }

      queryClient.setQueryData<Box[]>(
        queryKey,
        current.filter((entry) => entry.boxId.trim().toUpperCase() !== normalizedBoxId)
      );
      continue;
    }

    const nextEntries =
      existingIndex === -1
        ? [box, ...current]
        : current.map((entry) =>
            entry.boxId.trim().toUpperCase() === normalizedBoxId ? box : entry
          );

    queryClient.setQueryData<Box[]>(queryKey, sortBoxesForSearchCache(nextEntries, params));
  }
}

export function findCachedBoxById(queryClient: QueryClient, boxId: string) {
  const normalizedBoxId = String(boxId || '').trim().toUpperCase();
  if (!normalizedBoxId) {
    return null;
  }

  const directMatch = queryClient.getQueryData<Box>(inventoryKeys.box(normalizedBoxId));
  if (directMatch) {
    return directMatch;
  }

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [, current] = listQueries[index];
    const matched =
      current?.find((entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId) || null;
    if (matched) {
      return matched;
    }
  }

  const searchQueries = queryClient.getQueriesData<Box[]>({
    queryKey: inventoryKeys.searchRoot
  });
  for (let index = 0; index < searchQueries.length; index += 1) {
    const [, current] = searchQueries[index];
    const matched =
      current?.find((entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId) || null;
    if (matched) {
      return matched;
    }
  }

  return null;
}
