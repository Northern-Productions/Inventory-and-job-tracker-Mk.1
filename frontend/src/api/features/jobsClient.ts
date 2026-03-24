// Purpose: Job lifecycle and requirement API surface.
import type {
  CreateJobPayload,
  DeleteJobPayload,
  DeleteJobResult,
  JobDetail,
  JobDetailResponse,
  JobListEntry,
  JobListResponse,
  UpdateJobPayload
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

export type JobLifecycleFilter = 'ACTIVE' | 'COMPLETED';

function normalizeJobListEntry(entry: JobListEntry): JobListEntry {
  return {
    ...entry,
    requiredTubes: Math.max(0, Number(entry.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(entry.remainingTubes || 0))
  };
}

function normalizeJobDetail(detail: JobDetail): JobDetail {
  return {
    ...detail,
    summary: normalizeJobListEntry(detail.summary),
    usage: detail.usage || [],
    usageTimeline: detail.usageTimeline || [],
    caulkRequirements: detail.caulkRequirements || [],
    caulkAllocations: detail.caulkAllocations || [],
    caulkCheckouts: detail.caulkCheckouts || []
  };
}

function buildJobsQuery(limit: number, lifecycleStatus?: JobLifecycleFilter) {
  const params: Record<string, number | JobLifecycleFilter> = { limit };
  if (lifecycleStatus) {
    params.lifecycleStatus = lifecycleStatus;
  }
  return params;
}

export async function getJobs(
  limit = 25,
  options: { lifecycleStatus?: JobLifecycleFilter } = {}
): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const params = buildJobsQuery(limit, options.lifecycleStatus);
  const data = await requestReadWithFallback<JobListResponse>('/jobs/list', params, params);
  return (data.entries || []).map(normalizeJobListEntry);
}

export async function searchJobsByNumber(
  query: string,
  limit = 25,
  options: { lifecycleStatus?: JobLifecycleFilter } = {}
): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const normalizedQuery = String(query || '').replace(/[^0-9]/g, '');
  if (!normalizedQuery) {
    return [];
  }

  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const params = {
    query: normalizedQuery,
    ...buildJobsQuery(normalizedLimit, options.lifecycleStatus)
  };
  const data = await requestReadWithFallback<JobListResponse>('/jobs/search', params, params);
  return (data.entries || []).map(normalizeJobListEntry);
}

export async function getJob(jobNumber: string): Promise<JobDetail> {
  assertFeatureAccess('jobs', 'read');
  const result = await requestReadWithFallback<JobDetailResponse>(
    '/jobs/get',
    { jobNumber },
    { jobNumber }
  );
  return normalizeJobDetail(result);
}

export async function createJob(
  payload: CreateJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/create', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function updateJob(
  payload: UpdateJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/update', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function completeJob(
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/complete', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function reopenJob(
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/reopen', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function deleteJob(
  payload: DeleteJobPayload
): Promise<{ result: DeleteJobResult; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<DeleteJobResult>('POST', '/jobs/delete', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}
