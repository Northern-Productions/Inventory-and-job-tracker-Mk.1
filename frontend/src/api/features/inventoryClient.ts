// Purpose: Core inventory boxes API surface.
import type {
  AddBoxPayload,
  ApplyAllocationPlanPayload,
  ApplyAllocationPlanResult,
  Box,
  BoxTransferPlanParams,
  BoxTransferPlanResponse,
  BoxTransferEntry,
  BoxTransferMutationResult,
  CancelBoxTransferPayload,
  BoxMutationResult,
  DeleteBoxPayload,
  DeleteBoxResult,
  SearchBoxesParams,
  ReceiveBoxTransferPayload,
  SetBoxStatusPayload,
  StartBoxTransferPayload,
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
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';
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

function normalizeBox(box: Box): Box {
  const onHandFeet = Math.max(0, Number(box.feetAvailable || 0));
  const initialFeet = Math.max(0, Number(box.initialFeet || 0));
  const activeAllocatedFeet = Math.max(
    0,
    Number((box as Box & { activeAllocatedFeet?: number }).activeAllocatedFeet || 0)
  );
  const activePlanningFeet =
    box.allocationPlanningFeet === undefined || box.allocationPlanningFeet === null
      ? box.status === 'IN_STOCK' || box.status === 'TRANSFER'
        ? onHandFeet
        : box.status === 'ORDERED'
          ? Math.max(0, initialFeet - activeAllocatedFeet)
          : 0
      : Math.max(0, Number(box.allocationPlanningFeet || 0));

  return {
    ...box,
    initialFeet,
    feetAvailable: onHandFeet,
    allocationPlanningFeet: activePlanningFeet,
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

export async function syncAllOfflineInventorySnapshots(): Promise<OfflineInventorySyncMeta[]> {
  let warehouseCodes: Warehouse[] = [];
  try {
    warehouseCodes = (await listWarehouses()).map((entry) => entry.code);
  } catch {
    warehouseCodes = [...WAREHOUSE_CODES];
  }

  if (warehouseCodes.length === 0) {
    return [];
  }

  const snapshots = await Promise.all(
    warehouseCodes.map((warehouse) => syncOfflineInventorySnapshot(warehouse))
  );

  return snapshots.filter((snapshot): snapshot is OfflineInventorySyncMeta => Boolean(snapshot));
}

export async function allocateBox(
  payload: ApplyAllocationPlanPayload
): Promise<{ result: ApplyAllocationPlanResult; warnings: string[] }> {
  return applyAllocationPlan(payload);
}
