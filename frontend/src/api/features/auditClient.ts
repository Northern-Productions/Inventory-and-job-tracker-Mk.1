// Purpose: Audit and history API surface.
import type {
  AuditEntry,
  AuditListParams,
  AuditListResponse,
  BoxHistoryResponse,
  RollHistoryEntry,
  RollHistoryResponse,
  UndoAuditPayload,
  UndoMutationResult
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

function normalizeOptionalText(value: unknown): string | null {
  return String(value ?? '').trim() || null;
}

function normalizeRollHistoryEntry(entry: RollHistoryEntry): RollHistoryEntry {
  const jobId = String(entry.jobId || '').trim();
  const rawWorkScope = normalizeOptionalText(entry.workScope);
  const rawSections = normalizeOptionalText(entry.sections);
  const workScope = rawWorkScope ?? rawSections;
  return {
    ...entry,
    jobId: jobId || undefined,
    workScope,
    sections: rawSections ?? workScope
  };
}

export async function getAuditByBox(boxId: string): Promise<AuditEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const data = await requestReadWithFallback<BoxHistoryResponse>('/audit/by-box', { boxId }, { boxId });
  return data.entries;
}

export async function listAudit(params: AuditListParams): Promise<AuditEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const filters = {
    from: params.from,
    to: params.to,
    user: params.user,
    action: params.action
  };
  const data = await requestReadWithFallback<AuditListResponse>('/audit/list', filters, filters);
  return data.entries;
}

export async function getRollHistoryByBox(boxId: string): Promise<RollHistoryEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const data = await requestReadWithFallback<RollHistoryResponse>(
    '/roll-history/by-box',
    { boxId },
    { boxId }
  );
  return (data.entries || []).map(normalizeRollHistoryEntry);
}

export async function undoAudit(
  payload: UndoAuditPayload
): Promise<{ result: UndoMutationResult; warnings: string[] }> {
  assertFeatureAccess('activity_history', 'write');
  const response = await request<UndoMutationResult>('POST', '/audit/undo', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}
