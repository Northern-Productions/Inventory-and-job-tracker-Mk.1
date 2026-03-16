// Purpose: Warehouse registry API surface.
import type { AddWarehousePayload, WarehouseEntry } from '../../domain';
import { APIError, request } from '../http';
import { assertFeatureAccess, mapWarehouseEntry, requestReadWithFallback } from './sharedClient';

export async function listWarehouses(): Promise<WarehouseEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<{ entries: unknown[] }>('/warehouses/list', {}, {});
  return (data.entries || [])
    .map((entry) => mapWarehouseEntry(entry))
    .filter((entry): entry is WarehouseEntry => Boolean(entry));
}

export async function addWarehouse(payload: AddWarehousePayload): Promise<WarehouseEntry> {
  const { data } = await request<unknown>('POST', '/owner/warehouses/add', { body: payload });
  const mapped = mapWarehouseEntry(data);
  if (!mapped) {
    throw new APIError('The warehouse was created but the response was invalid.');
  }
  return mapped;
}
