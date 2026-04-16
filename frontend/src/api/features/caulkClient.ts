// Purpose: Caulk inventory API surface.
import type {
  CancelCaulkTransferPayload,
  CaulkManufacturerEntry,
  CaulkMutationResult,
  CaulkProductEntry,
  CaulkStockEntry,
  CaulkTransferEntry,
  CaulkTransferMutationResult,
  CaulkTransactionEntry,
  CaulkTransferResult,
  ListCaulkStockParams,
  ListPendingCaulkTransfersParams,
  ListCaulkTransactionsParams,
  MutateCaulkStockPayload,
  ReceiveCaulkTransferPayload,
  TransferCaulkStockPayload,
  UpsertCaulkManufacturerPayload,
  UpsertCaulkProductPayload
} from '../../domain';
import { APIError, request } from '../http';
import {
  assertFeatureAccess,
  assertOwnerAccess,
  mapCaulkManufacturerEntry,
  mapCaulkProductEntry,
  mapCaulkStockEntry,
  mapCaulkTransferEntry,
  mapCaulkTransactionEntry,
  requestReadWithFallback
} from './sharedClient';

export async function listCaulkManufacturers(): Promise<CaulkManufacturerEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/caulk/manufacturers/list',
    {},
    {}
  );
  return (data.entries || [])
    .map((entry) => mapCaulkManufacturerEntry(entry))
    .filter((entry): entry is CaulkManufacturerEntry => Boolean(entry));
}

export async function listCaulkProducts(): Promise<CaulkProductEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<{ entries: unknown[] }>('/caulk/products/list', {}, {});
  return (data.entries || [])
    .map((entry) => mapCaulkProductEntry(entry))
    .filter((entry): entry is CaulkProductEntry => Boolean(entry));
}

export async function listCaulkStock(params: ListCaulkStockParams): Promise<CaulkStockEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const body = {
    warehouse: params.warehouse || 'ALL',
    manufacturer: params.manufacturer || '',
    productId: params.productId || '',
    q: params.q || ''
  };
  const query = { ...body };
  const data = await requestReadWithFallback<{ entries: unknown[] }>('/caulk/stock/list', body, query);
  return (data.entries || [])
    .map((entry) => mapCaulkStockEntry(entry))
    .filter((entry): entry is CaulkStockEntry => Boolean(entry));
}

export async function listCaulkTransactions(
  params: ListCaulkTransactionsParams
): Promise<CaulkTransactionEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const body = {
    warehouse: params.warehouse || 'ALL',
    productId: params.productId || '',
    limit: params.limit || 200
  };
  const query = {
    warehouse: body.warehouse,
    productId: body.productId,
    limit: body.limit
  };
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/caulk/transactions/list',
    body,
    query
  );
  return (data.entries || [])
    .map((entry) => mapCaulkTransactionEntry(entry))
    .filter((entry): entry is CaulkTransactionEntry => Boolean(entry));
}

export async function listPendingCaulkTransfers(
  params: ListPendingCaulkTransfersParams
): Promise<CaulkTransferEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const body = {
    warehouse: params.warehouse,
    productId: params.productId || ''
  };
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/caulk/transfers/list',
    body,
    body
  );
  return (data.entries || [])
    .map((entry) => mapCaulkTransferEntry(entry))
    .filter((entry): entry is CaulkTransferEntry => Boolean(entry));
}

export async function ownerUpsertCaulkManufacturer(
  payload: UpsertCaulkManufacturerPayload
): Promise<CaulkManufacturerEntry> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/caulk/manufacturers/upsert', { body: payload });
  const mapped = mapCaulkManufacturerEntry(data);
  if (!mapped) {
    throw new APIError('Manufacturer update completed but the response was invalid.');
  }
  return mapped;
}

export async function upsertCaulkProduct(payload: UpsertCaulkProductPayload): Promise<CaulkProductEntry> {
  assertFeatureAccess('inventory', 'write');
  const { data } = await request<unknown>('POST', '/caulk/products/upsert', { body: payload });
  const mapped = mapCaulkProductEntry(data);
  if (!mapped) {
    throw new APIError('Product update completed but the response was invalid.');
  }
  return mapped;
}

export async function mutateCaulkStock(payload: MutateCaulkStockPayload): Promise<CaulkMutationResult> {
  assertFeatureAccess('inventory', 'write');
  const { data } = await request<CaulkMutationResult>('POST', '/caulk/mutate', { body: payload });
  return data;
}

export async function transferCaulkStock(
  payload: TransferCaulkStockPayload
): Promise<CaulkTransferResult> {
  assertFeatureAccess('inventory', 'write');
  const { data } = await request<CaulkTransferResult>('POST', '/caulk/transfer', { body: payload });
  return data;
}

export async function receiveCaulkTransfer(
  payload: ReceiveCaulkTransferPayload
): Promise<{ result: CaulkTransferMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<CaulkTransferMutationResult>('POST', '/caulk/transfers/receive', {
    body: payload
  });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function cancelCaulkTransfer(
  payload: CancelCaulkTransferPayload
): Promise<{ result: CaulkTransferMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<CaulkTransferMutationResult>('POST', '/caulk/transfers/cancel', {
    body: payload
  });
  return {
    result: response.data,
    warnings: response.warnings
  };
}
