// Purpose: Core inventory boxes API surface.
import type {
  AddBoxPayload,
  ApplyAllocationPlanPayload,
  ApplyAllocationPlanResult,
  Box,
  BoxDealerEntry,
  BoxTransferPlanParams,
  BoxTransferPlanResponse,
  BoxTransferEntry,
  BoxTransferMutationResult,
  CancelBoxTransferPayload,
  BoxMutationResult,
  DeleteBoxPayload,
  DeleteBoxResult,
  ReceiveOrderedBoxPayload,
  SearchBoxesParams,
  ReceiveBoxTransferPayload,
  SetBoxStatusPayload,
  StartBoxTransferPayload,
  UpsertBoxDealerPayload,
  UpdateBoxPayload,
  Warehouse
} from '../../domain';
import { WAREHOUSE_CODES } from '../../domain';
import { dedupeBoxesByDisplayBoxId } from '../../lib/boxIds';
import {
  getOfflineBox,
  replaceOfflineInventoryBoxes,
  searchOfflineBoxes,
  upsertOfflineInventoryBox,
  type OfflineInventorySyncMeta
} from '../../lib/offlineInventory';
import { APIError, request } from '../http';
import {
  assertFeatureAccess,
  mapBoxDealerEntry,
  requestReadWithFallback
} from './sharedClient';
import { applyAllocationPlan } from './allocationsClient';
import { listWarehouses } from './warehouseClient';

function normalizePendingTransfer(
  pendingTransfer: Box['pendingTransfer'] | undefined
): Box['pendingTransfer'] {
  if (!pendingTransfer) {
    return null;
  }

  return {
    transferId: String(pendingTransfer.transferId || '').trim(),
    status: 'PENDING',
    sourceWarehouse: String(pendingTransfer.sourceWarehouse || '').trim().toUpperCase() as Warehouse,
    destinationWarehouse: String(pendingTransfer.destinationWarehouse || '').trim().toUpperCase() as Warehouse
  };
}

export function normalizeOrderedForJobs(value: unknown): Box['orderedForJobs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const orderedForJobs: NonNullable<Box['orderedForJobs']> = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const jobNumber = String(record.jobNumber || '').trim();
    if (!jobNumber) {
      continue;
    }

    const filmOrderId = String(record.filmOrderId || '').trim();
    const orderedFeet =
      record.orderedFeet === null || record.orderedFeet === undefined || record.orderedFeet === ''
        ? NaN
        : Number(record.orderedFeet);
    orderedForJobs.push({
      jobNumber,
      filmOrderId: filmOrderId || undefined,
      orderedFeet: Number.isFinite(orderedFeet) ? Math.max(0, Math.trunc(orderedFeet)) : null
    });
  }

  return orderedForJobs;
}

function normalizeBox(box: Box): Box {
  const availableFeet = Math.max(0, Number(box.feetAvailable || 0));
  const initialFeet = Math.max(0, Number(box.initialFeet || 0));
  const activeAllocatedFeet = Math.max(
    0,
    Number((box as Box & { activeAllocatedFeet?: number }).activeAllocatedFeet || 0)
  );
  const allocatedWithInstallDateFeet = Math.max(0, Number(box.allocatedWithInstallDateFeet || 0));
  const allocatedWithoutInstallDateFeet = Math.max(0, Number(box.allocatedWithoutInstallDateFeet || 0));
  const allocatableNowFeet =
    box.allocatableNowFeet === undefined || box.allocatableNowFeet === null
      ? availableFeet
      : Math.max(0, Number(box.allocatableNowFeet || 0));
  const physicalFeetAvailable =
    box.physicalFeetAvailable === undefined || box.physicalFeetAvailable === null
      ? Math.max(0, availableFeet + allocatedWithInstallDateFeet)
      : Math.max(0, Number(box.physicalFeetAvailable || 0));
  const activePlanningFeet =
    box.allocatableNowFeet !== undefined && box.allocatableNowFeet !== null
      ? allocatableNowFeet
      : box.status === 'IN_STOCK' || box.status === 'TRANSFER'
        ? availableFeet
        : box.status === 'ORDERED'
          ? Math.max(0, initialFeet - activeAllocatedFeet)
          : 0;

  return {
    ...box,
    dealer: String(box.dealer || '').trim(),
    directToJobSite: box.directToJobSite === true,
    initialFeet,
    feetAvailable: availableFeet,
    physicalFeetAvailable,
    allocatableNowFeet,
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    allocationPlanningFeet: activePlanningFeet,
    orderedForJobs: normalizeOrderedForJobs((box as Box & { orderedForJobs?: unknown }).orderedForJobs),
    pendingTransfer: normalizePendingTransfer(box.pendingTransfer)
  };
}

function buildSearchBoxFilters(params: SearchBoxesParams) {
  return {
    warehouse: params.warehouse,
    warehouses: params.warehouses,
    manufacturer: params.manufacturer,
    q: params.q,
    status: params.status,
    film: params.film,
    width: params.width,
    showRetired: params.showRetired ?? false
  };
}

function shouldUseOfflineInventoryFallback(error: unknown): error is APIError {
  return error instanceof APIError && error.message.indexOf('The API is unreachable.') === 0;
}

async function fetchRemoteBoxes(params: SearchBoxesParams): Promise<Box[]> {
  const filters = buildSearchBoxFilters(params);
  return dedupeBoxesByDisplayBoxId(
    (await requestReadWithFallback<Box[]>('/boxes/search', filters, filters)).map(normalizeBox)
  );
}

export async function searchBoxes(params: SearchBoxesParams): Promise<Box[]> {
  assertFeatureAccess('inventory', 'read');
  try {
    return await fetchRemoteBoxes(params);
  } catch (error) {
    if (shouldUseOfflineInventoryFallback(error)) {
      return dedupeBoxesByDisplayBoxId(await searchOfflineBoxes(params));
    }

    throw error;
  }
}

export async function getBox(boxId: string): Promise<Box> {
  assertFeatureAccess('inventory', 'read');
  try {
    const box = normalizeBox(await requestReadWithFallback<Box>('/boxes/get', { boxId }, { boxId }));

    try {
      await upsertOfflineInventoryBox(box);
    } catch {
      // Keep the live box read successful even if the offline cache write fails.
    }

    return box;
  } catch (error) {
    if (shouldUseOfflineInventoryFallback(error)) {
      const offlineBox = await getOfflineBox(boxId);
      if (offlineBox) {
        return offlineBox;
      }
    }

    throw error;
  }
}

export async function getBoxTransfer(boxId: string): Promise<BoxTransferEntry | null> {
  assertFeatureAccess('inventory', 'read');
  return requestReadWithFallback<BoxTransferEntry | null>(
    '/boxes/transfer/by-box',
    { boxId },
    { boxId }
  );
}

export async function getBoxTransferPlan(
  params: BoxTransferPlanParams
): Promise<BoxTransferPlanResponse> {
  assertFeatureAccess('inventory', 'read');
  return requestReadWithFallback<BoxTransferPlanResponse>(
    '/boxes/transfer/plan',
    {
      boxId: params.boxId,
      toWarehouse: params.toWarehouse,
      destinationBoxIdOverride: params.destinationBoxIdOverride
    },
    {
      boxId: params.boxId,
      toWarehouse: params.toWarehouse,
      destinationBoxIdOverride: params.destinationBoxIdOverride
    }
  );
}

export async function addBox(
  payload: AddBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/add', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function listBoxDealers(): Promise<BoxDealerEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<{ entries: unknown[] }>('/box-dealers/list', {}, {});
  return (data.entries || [])
    .map((entry) => mapBoxDealerEntry(entry))
    .filter((entry): entry is BoxDealerEntry => Boolean(entry));
}

export async function upsertBoxDealer(
  payload: UpsertBoxDealerPayload
): Promise<BoxDealerEntry> {
  assertFeatureAccess('inventory', 'write');
  const { data } = await request<unknown>('POST', '/box-dealers/upsert', { body: payload });
  const mapped = mapBoxDealerEntry(data);
  if (!mapped) {
    throw new APIError('Dealer update completed but the response was invalid.');
  }
  return mapped;
}

export async function updateBox(
  payload: UpdateBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/update', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function deleteBox(
  payload: DeleteBoxPayload
): Promise<{ result: DeleteBoxResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<DeleteBoxResult>('POST', '/boxes/delete', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function setBoxStatus(
  payload: SetBoxStatusPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/set-status', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function receiveOrderedBox(
  payload: ReceiveOrderedBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/receive', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function startBoxTransfer(
  payload: StartBoxTransferPayload
): Promise<{ result: BoxTransferMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxTransferMutationResult>('POST', '/boxes/transfer/start', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function receiveBoxTransfer(
  payload: ReceiveBoxTransferPayload
): Promise<{ result: BoxTransferMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxTransferMutationResult>('POST', '/boxes/transfer/receive', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function cancelBoxTransfer(
  payload: CancelBoxTransferPayload
): Promise<{ result: BoxTransferMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxTransferMutationResult>('POST', '/boxes/transfer/cancel', { body: payload });
  return {
    result: {
      ...response.data,
      box: normalizeBox(response.data.box)
    },
    warnings: response.warnings
  };
}

export async function syncOfflineInventorySnapshot(
  warehouse: Warehouse
): Promise<OfflineInventorySyncMeta | null> {
  const boxes = await fetchRemoteBoxes({ warehouse, showRetired: true });
  return replaceOfflineInventoryBoxes(warehouse, boxes);
}

function prioritizeWarehouseCodes(
  warehouseCodes: Warehouse[],
  preferredWarehouse?: Warehouse | ''
): Warehouse[] {
  const normalizedPreferred = String(preferredWarehouse || '').trim().toUpperCase();
  const uniqueCodes = Array.from(
    new Set(warehouseCodes.map((entry) => String(entry || '').trim().toUpperCase()).filter(Boolean))
  ) as Warehouse[];

  if (!normalizedPreferred) {
    return uniqueCodes;
  }

  return [
    ...uniqueCodes.filter((warehouse) => warehouse === normalizedPreferred),
    ...uniqueCodes.filter((warehouse) => warehouse !== normalizedPreferred)
  ];
}

/**
 * PURPOSE:
 * Refreshes per-warehouse IndexedDB snapshots without fanning out heavy inventory reads.
 *
 * AFFECTS:
 * Inventory page offline copy status, offline search fallback, and mutation cache refreshes.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * /boxes/search Edge/backend filtering, IndexedDB replaceOfflineInventoryBoxes, and warehouse registry loading.
 *
 * COMMON FAILURE MODES:
 * Parallel all-warehouse refreshes can hit database statement timeouts; failed snapshots must not erase the last good copy.
 */
export async function syncAllOfflineInventorySnapshots(
  preferredWarehouse?: Warehouse | ''
): Promise<OfflineInventorySyncMeta[]> {
  let warehouseCodes: Warehouse[] = [];
  try {
    warehouseCodes = (await listWarehouses()).map((entry) => entry.code);
  } catch {
    warehouseCodes = [...WAREHOUSE_CODES];
  }

  if (warehouseCodes.length === 0) {
    return [];
  }

  const snapshots: Array<OfflineInventorySyncMeta | null> = [];
  const orderedWarehouseCodes = prioritizeWarehouseCodes(warehouseCodes, preferredWarehouse);

  for (const warehouse of orderedWarehouseCodes) {
    snapshots.push(await syncOfflineInventorySnapshot(warehouse));
  }

  return snapshots.filter((snapshot): snapshot is OfflineInventorySyncMeta => Boolean(snapshot));
}

export async function allocateBox(
  payload: ApplyAllocationPlanPayload
): Promise<{ result: ApplyAllocationPlanResult; warnings: string[] }> {
  return applyAllocationPlan(payload);
}
