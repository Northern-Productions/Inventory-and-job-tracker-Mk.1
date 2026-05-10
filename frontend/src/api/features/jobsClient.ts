// Purpose: Job lifecycle and requirement API surface.
import type {
  CreateJobPayload,
  DeleteJobPayload,
  DeleteJobResult,
  JobCaulkRequirementLine,
  JobDetail,
  JobDetailResponse,
  JobListEntry,
  JobListResponse,
  SetJobStagedForPickupPayload,
  UpdateJobPayload
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

export type JobLifecycleFilter = 'ACTIVE' | 'COMPLETED';
export type JobsCalendarView = 'week' | 'month';

export interface JobsCalendarEntriesOptions {
  view: JobsCalendarView;
  anchorDate: string;
  lifecycleStatus?: JobLifecycleFilter;
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeJobListEntry(entry: JobListEntry): JobListEntry {
  const workScope = normalizeOptionalText(entry.workScope ?? entry.sections);
  return {
    ...entry,
    jobId: String(entry.jobId || '').trim() || undefined,
    workScope,
    sections: normalizeOptionalText(entry.sections ?? workScope),
    isLaborOnly: Boolean(entry.isLaborOnly),
    isStagedForPickup: Boolean(entry.isStagedForPickup),
    hasOrderedAllocations: Boolean(entry.hasOrderedAllocations),
    requiredFeet: Math.max(0, Number(entry.requiredFeet || 0)),
    allocatedFeet: Math.max(0, Number(entry.allocatedFeet || 0)),
    allocatedWithInstallDateFeet: Math.max(0, Number(entry.allocatedWithInstallDateFeet || 0)),
    allocatedWithoutInstallDateFeet: Math.max(0, Number(entry.allocatedWithoutInstallDateFeet || 0)),
    remainingFeet: Math.max(0, Number(entry.remainingFeet || 0)),
    requiredTubes: Math.max(0, Number(entry.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(entry.remainingTubes || 0))
  };
}

function normalizeCaulkRequirementLine(entry: JobCaulkRequirementLine): JobCaulkRequirementLine {
  return {
    ...entry,
    requiredTubes: Math.max(0, Number(entry.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(entry.remainingTubes || 0)),
    autoPlanningSuppressed: Boolean(entry.autoPlanningSuppressed)
  };
}

function normalizeJobDetail(detail: JobDetail): JobDetail {
  return {
    ...detail,
    summary: normalizeJobListEntry(detail.summary),
    requirements: (detail.requirements || []).map((entry) => ({
      ...entry,
      requiredFeet: Math.max(0, Number(entry.requiredFeet || 0)),
      allocatedFeet: Math.max(0, Number(entry.allocatedFeet || 0)),
      allocatedWithInstallDateFeet: Math.max(0, Number(entry.allocatedWithInstallDateFeet || 0)),
      allocatedWithoutInstallDateFeet: Math.max(0, Number(entry.allocatedWithoutInstallDateFeet || 0)),
      remainingFeet: Math.max(0, Number(entry.remainingFeet || 0)),
      autoPlanningSuppressed: Boolean(entry.autoPlanningSuppressed)
    })),
    usage: detail.usage || [],
    usageTimeline: detail.usageTimeline || [],
    caulkRequirements: (detail.caulkRequirements || []).map(normalizeCaulkRequirementLine),
    caulkAllocations: detail.caulkAllocations || [],
    caulkCheckouts: detail.caulkCheckouts || [],
    filmTransferAlerts: detail.filmTransferAlerts || [],
    caulkTransferAlerts: detail.caulkTransferAlerts || []
  };
}

function buildJobsQuery(limit: number, lifecycleStatus?: JobLifecycleFilter) {
  const params: Record<string, number | JobLifecycleFilter | string[]> = { limit };
  if (lifecycleStatus) {
    params.lifecycleStatus = lifecycleStatus;
  }
  return params;
}

export async function getJobs(
  limit = 25,
  options: { lifecycleStatus?: JobLifecycleFilter; jobNumbers?: string[] } = {}
): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const params = buildJobsQuery(limit, options.lifecycleStatus);
  const normalizedJobNumbers = Array.from(
    new Set(
      (options.jobNumbers || [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    )
  );
  if (normalizedJobNumbers.length) {
    params.jobNumbers = normalizedJobNumbers;
  }
  const data = await requestReadWithFallback<JobListResponse>('/jobs/list', params, params);
  return (data.entries || []).map(normalizeJobListEntry);
}

export async function getJobsCalendarEntries(
  options: JobsCalendarEntriesOptions
): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const params: {
    view: JobsCalendarView;
    anchorDate: string;
    lifecycleStatus?: JobLifecycleFilter;
  } = {
    view: options.view,
    anchorDate: options.anchorDate
  };
  if (options.lifecycleStatus) {
    params.lifecycleStatus = options.lifecycleStatus;
  }
  const data = await requestReadWithFallback<JobListResponse>('/jobs/calendar', params, params);
  return (data.entries || []).map(normalizeJobListEntry);
}

export async function getJobsCalendarMonth(
  month: string,
  options: { lifecycleStatus?: JobLifecycleFilter } = {}
): Promise<JobListEntry[]> {
  return getJobsCalendarEntries({
    view: 'month',
    anchorDate: `${String(month || '').trim()}-01`,
    lifecycleStatus: options.lifecycleStatus
  });
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

export async function getJobById(jobId: string): Promise<JobDetail> {
  assertFeatureAccess('jobs', 'read');
  const result = await requestReadWithFallback<JobDetailResponse>(
    '/jobs/get-by-id',
    { jobId },
    { jobId }
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

export async function setJobStagedForPickup(
  payload: SetJobStagedForPickupPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/set-staged-pickup', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function checkoutAllJobMaterials(
  payload: { jobNumber: string }
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/checkout-all', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}
