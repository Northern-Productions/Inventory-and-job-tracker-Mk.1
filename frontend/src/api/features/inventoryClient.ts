// Purpose: Core inventory boxes API surface.
import type {
  AddBoxPayload,
  ApplyAllocationPlanPayload,
  ApplyAllocationPlanResult,
  Box,
  BoxMutationResult,
  DeleteBoxPayload,
  DeleteBoxResult,
  SearchBoxesParams,
  SetBoxStatusPayload,
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

function buildSearchBoxFilters(params: SearchBoxesParams) {
  return {
    warehouse: params.warehouse,
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
  return dedupeBoxesByDisplayBoxId(await requestReadWithFallback<Box[]>('/boxes/search', filters, filters));
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
    const box = await requestReadWithFallback<Box>('/boxes/get', { boxId }, { boxId });

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

export async function addBox(
  payload: AddBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/add', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function updateBox(
  payload: UpdateBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/update', { body: payload });
  return {
    result: response.data,
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
    result: response.data,
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
