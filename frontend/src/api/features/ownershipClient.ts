import type {
  BulkOwnershipTransferPayload,
  ChangeCaulkStockOwnerPayload,
  ChangeFilmBoxOwnerPayload,
  DeactivateOwnerCompanyPayload,
  OwnerCompanyEntry,
  OwnershipEventEntry,
  OwnershipMutationResult,
  UpsertOwnerCompanyPayload
} from '../../domain';
import { APIError, request } from '../http';
import {
  assertFeatureAccess,
  assertOwnerAccess,
  mapOwnerCompanyEntry,
  mapOwnershipEventEntry,
  requestReadWithFallback
} from './sharedClient';

function normalizeOwnershipMutationResult(value: unknown): OwnershipMutationResult {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const events = Array.isArray(source.events)
    ? source.events
        .map((entry) => mapOwnershipEventEntry(entry))
        .filter((entry): entry is OwnershipEventEntry => Boolean(entry))
    : [];

  return {
    changedCount: Math.max(0, Number(source.changedCount || source.changed_count || events.length) || 0),
    batchId: String(source.batchId || source.batch_id || '').trim(),
    events
  };
}

export async function listOwnerCompanies(params: { includeInactive?: boolean } = {}): Promise<OwnerCompanyEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const includeInactive = params.includeInactive === true;
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/owner-companies/list',
    { includeInactive },
    { includeInactive }
  );

  return (data.entries || [])
    .map((entry) => mapOwnerCompanyEntry(entry))
    .filter((entry): entry is OwnerCompanyEntry => Boolean(entry));
}

export async function upsertOwnerCompany(payload: UpsertOwnerCompanyPayload): Promise<OwnerCompanyEntry> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/owner-companies/upsert', { body: payload });
  const mapped = mapOwnerCompanyEntry(data);
  if (!mapped) {
    throw new APIError('Owner company update completed but the response was invalid.');
  }
  return mapped;
}

export async function deactivateOwnerCompany(payload: DeactivateOwnerCompanyPayload): Promise<OwnerCompanyEntry> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/owner-companies/deactivate', { body: payload });
  const mapped = mapOwnerCompanyEntry(data);
  if (!mapped) {
    throw new APIError('Owner company deactivate completed but the response was invalid.');
  }
  return mapped;
}

export async function changeFilmBoxOwner(payload: ChangeFilmBoxOwnerPayload): Promise<OwnershipMutationResult> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/inventory-ownership/box', { body: payload });
  return normalizeOwnershipMutationResult(data);
}

export async function changeCaulkStockOwner(payload: ChangeCaulkStockOwnerPayload): Promise<OwnershipMutationResult> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/inventory-ownership/caulk-stock', { body: payload });
  return normalizeOwnershipMutationResult(data);
}

export async function bulkTransferOwnership(payload: BulkOwnershipTransferPayload): Promise<OwnershipMutationResult> {
  assertOwnerAccess();
  const { data } = await request<unknown>('POST', '/owner/inventory-ownership/bulk-transfer', { body: payload });
  return normalizeOwnershipMutationResult(data);
}
