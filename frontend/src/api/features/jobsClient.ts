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
  JobPhase,
  SetJobStagedForPickupPayload,
  SetJobRequirementStatePayload,
  SetJobPhaseStatePayload,
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

export interface JobDuplicateCheckResult {
  exists: boolean;
  allowed?: boolean;
  canCreate?: boolean;
  duplicatesEnabled?: boolean;
  reason?:
    | 'NO_MATCH'
    | 'SAME_JOB_SCOPE_ACTIVE'
    | 'SAME_JOB_SCOPE_COMPLETED'
    | 'SAME_JOB_NUMBER_BLOCKED_UNTIL_SCOPE_DUPLICATES_ENABLED';
  blockingReason?: JobDuplicateCheckResult['reason'] | null;
  duplicateScopeMode?: 'NO_MATCH' | 'EXACT_SCOPE' | 'DIFFERENT_SCOPE' | 'MIXED_SCOPE';
  jobNumber?: string;
  workScope?: string | null;
  workScopeKey?: string;
  requestedWorkScope?: string | null;
  requestedWorkScopeKey?: string;
  exactScopeDuplicateExists?: boolean;
  sameJobNumberDifferentScopeExists?: boolean;
  futureCanCreateAfterEnablement?: boolean;
  job: JobListEntry | null;
  existingJob?: JobListEntry | null;
  sameJobNumberJobs?: JobListEntry[];
  exactScopeJobs?: JobListEntry[];
  differentScopeJobs?: JobListEntry[];
}

export interface CheckJobDuplicateOptions {
  workScope?: string | number | null;
  sections?: string | number | null;
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeJobListEntry<T extends JobListEntry>(entry: T): T {
  const workScope = normalizeOptionalText(entry.workScope ?? entry.sections);
  const phases = (entry.phases || []).map(normalizeJobPhase);
  return {
    ...entry,
    jobId: String(entry.jobId || '').trim() || undefined,
    workScope,
    primaryWorkScope: normalizeOptionalText(entry.primaryWorkScope),
    workScopeKey: normalizeOptionalText(entry.workScopeKey) || undefined,
    routeTarget: normalizeOptionalText(entry.routeTarget) || undefined,
    sections: normalizeOptionalText(entry.sections ?? workScope),
    phaseId: String(entry.phaseId || '').trim() || undefined,
    phaseNumber: Number.isFinite(Number(entry.phaseNumber)) ? Math.max(1, Math.floor(Number(entry.phaseNumber))) : undefined,
    phaseWorkScope: normalizeOptionalText(entry.phaseWorkScope),
    phaseCount: Math.max(phases.length || 0, Number(entry.phaseCount || 0)),
    phases,
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
  } as T;
}

function normalizeJobPhase(entry: JobPhase): JobPhase {
  const status = String(entry.status || '').trim().toUpperCase();
  const laborStatus = String(entry.laborStatus || '').trim().toUpperCase() === 'COMPLETE' ? 'COMPLETE' : 'ACTIVE';
  return {
    ...entry,
    phaseId: String(entry.phaseId || entry.id || '').trim(),
    id: String(entry.id || entry.phaseId || '').trim() || undefined,
    jobId: String(entry.jobId || '').trim() || undefined,
    phaseNumber: Math.max(1, Math.floor(Number(entry.phaseNumber || 1))),
    workScope: normalizeOptionalText(entry.workScope ?? entry.sections),
    sections: normalizeOptionalText(entry.sections ?? entry.workScope),
    installDate: String(entry.installDate || '').trim(),
    crewLeader: String(entry.crewLeader || '').trim(),
    laborStatus,
    status: (status || 'READY') as JobPhase['status'],
    isComplete: Boolean(entry.isComplete || status === 'COMPLETED' || laborStatus === 'COMPLETE'),
    isPrimary: Boolean(entry.isPrimary),
    isNextRelevant: Boolean(entry.isNextRelevant),
    isExpandedByDefault: Boolean(entry.isExpandedByDefault),
    requiredFeet: Math.max(0, Number(entry.requiredFeet || 0)),
    allocatedFeet: Math.max(0, Number(entry.allocatedFeet || 0)),
    allocatedWithInstallDateFeet: Math.max(0, Number(entry.allocatedWithInstallDateFeet || 0)),
    allocatedWithoutInstallDateFeet: Math.max(0, Number(entry.allocatedWithoutInstallDateFeet || 0)),
    remainingFeet: Math.max(0, Number(entry.remainingFeet || 0)),
    requiredTubes: Math.max(0, Number(entry.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(entry.remainingTubes || 0)),
    requirementCount: Math.max(0, Number(entry.requirementCount || 0)),
    caulkRequirementCount: Math.max(0, Number(entry.caulkRequirementCount || 0)),
    filmOrderCount: Math.max(0, Number(entry.filmOrderCount || 0)),
    allocationCount: Math.max(0, Number(entry.allocationCount || 0)),
    createdAt: String(entry.createdAt || '').trim(),
    updatedAt: String(entry.updatedAt || '').trim()
  };
}

function normalizeCaulkRequirementLine(entry: JobCaulkRequirementLine): JobCaulkRequirementLine {
  const status = normalizeRequirementStatus(entry.status);
  const requiredTubes = Math.max(0, Number(entry.requiredTubes || 0));
  const actualUsedTubes = Math.max(0, Number(entry.actualUsedTubes || 0));
  return {
    ...entry,
    phaseId: String(entry.phaseId || '').trim() || undefined,
    phaseNumber: Number.isFinite(Number(entry.phaseNumber)) ? Math.max(1, Math.floor(Number(entry.phaseNumber))) : undefined,
    phaseWorkScope: normalizeOptionalText(entry.phaseWorkScope),
    phaseInstallDate: String(entry.phaseInstallDate || '').trim(),
    phaseCrewLeader: String(entry.phaseCrewLeader || '').trim(),
    requiredTubes,
    status,
    isComplete: status === 'COMPLETE',
    actualUsedTubes,
    completedAt: String(entry.completedAt || '').trim(),
    completedBy: String(entry.completedBy || '').trim(),
    completionResult: status === 'COMPLETE' ? (actualUsedTubes <= requiredTubes ? 'ON_TARGET' : 'OVERUSED') : '',
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: status === 'COMPLETE' ? 0 : Math.max(0, Number(entry.remainingTubes || 0)),
    autoPlanningSuppressed: Boolean(entry.autoPlanningSuppressed)
  };
}

function normalizeRequirementStatus(value: unknown): 'ACTIVE' | 'COMPLETE' {
  return String(value || '').trim().toUpperCase() === 'COMPLETE' ? 'COMPLETE' : 'ACTIVE';
}

function normalizeJobDetail(detail: JobDetail): JobDetail {
  return {
    ...detail,
    summary: normalizeJobListEntry(detail.summary),
    phases: (detail.phases || detail.summary?.phases || []).map(normalizeJobPhase),
    requirements: (detail.requirements || []).map((entry) => ({
      ...entry,
      phaseId: String(entry.phaseId || '').trim() || undefined,
      phaseNumber: Number.isFinite(Number(entry.phaseNumber)) ? Math.max(1, Math.floor(Number(entry.phaseNumber))) : undefined,
      phaseWorkScope: normalizeOptionalText(entry.phaseWorkScope),
      phaseInstallDate: String(entry.phaseInstallDate || '').trim(),
      phaseCrewLeader: String(entry.phaseCrewLeader || '').trim(),
      status: normalizeRequirementStatus(entry.status),
      isComplete: normalizeRequirementStatus(entry.status) === 'COMPLETE',
      actualUsedFeet: Math.max(0, Number(entry.actualUsedFeet || 0)),
      completedAt: String(entry.completedAt || '').trim(),
      completedBy: String(entry.completedBy || '').trim(),
      completionResult:
        normalizeRequirementStatus(entry.status) === 'COMPLETE'
          ? Math.max(0, Number(entry.actualUsedFeet || 0)) <= Math.max(0, Number(entry.requiredFeet || 0))
            ? 'ON_TARGET'
            : 'OVERUSED'
          : '',
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

function normalizeOptionalQueryText(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

export async function checkJobDuplicate(
  jobNumber: string,
  options: CheckJobDuplicateOptions = {}
): Promise<JobDuplicateCheckResult> {
  assertFeatureAccess('jobs', 'read');
  const normalizedJobNumber = String(jobNumber || '').trim();
  const query: {
    jobNumber: string;
    workScope?: string;
    sections?: string;
  } = { jobNumber: normalizedJobNumber };
  const workScope = normalizeOptionalQueryText(options.workScope);
  const sections = normalizeOptionalQueryText(options.sections);
  if (workScope !== undefined) {
    query.workScope = workScope;
  }
  if (sections !== undefined) {
    query.sections = sections;
  }
  const result = await requestReadWithFallback<{
    exists?: boolean;
    allowed?: boolean;
    canCreate?: boolean;
    duplicatesEnabled?: boolean;
    reason?: JobDuplicateCheckResult['reason'];
    blockingReason?: JobDuplicateCheckResult['reason'] | null;
    duplicateScopeMode?: JobDuplicateCheckResult['duplicateScopeMode'];
    jobNumber?: string;
    workScope?: string | null;
    workScopeKey?: string;
    requestedWorkScope?: string | null;
    requestedWorkScopeKey?: string;
    exactScopeDuplicateExists?: boolean;
    sameJobNumberDifferentScopeExists?: boolean;
    futureCanCreateAfterEnablement?: boolean;
    job?: JobListEntry | null;
    existingJob?: JobListEntry | null;
    sameJobNumberJobs?: JobListEntry[];
    exactScopeJobs?: JobListEntry[];
    differentScopeJobs?: JobListEntry[];
  }>(
    '/jobs/check-duplicate',
    query,
    query
  );
  const job = result.job ? normalizeJobListEntry(result.job) : null;
  const existingJob = result.existingJob ? normalizeJobListEntry(result.existingJob) : job;
  const sameJobNumberJobs = (result.sameJobNumberJobs || []).map(normalizeJobListEntry);
  const exactScopeJobs = (result.exactScopeJobs || []).map(normalizeJobListEntry);
  const differentScopeJobs = (result.differentScopeJobs || []).map(normalizeJobListEntry);
  return {
    exists: Boolean(result.exists && (job || sameJobNumberJobs.length)),
    allowed: result.allowed,
    canCreate: result.canCreate === undefined ? result.allowed : Boolean(result.canCreate),
    duplicatesEnabled: result.duplicatesEnabled === true,
    reason: result.reason,
    blockingReason: result.blockingReason || null,
    duplicateScopeMode: result.duplicateScopeMode,
    jobNumber: normalizeOptionalText(result.jobNumber) || undefined,
    workScope: normalizeOptionalText(result.workScope),
    workScopeKey: normalizeOptionalText(result.workScopeKey) || undefined,
    requestedWorkScope: normalizeOptionalText(result.requestedWorkScope),
    requestedWorkScopeKey: normalizeOptionalText(result.requestedWorkScopeKey) || undefined,
    exactScopeDuplicateExists: Boolean(result.exactScopeDuplicateExists),
    sameJobNumberDifferentScopeExists: Boolean(result.sameJobNumberDifferentScopeExists),
    futureCanCreateAfterEnablement: Boolean(result.futureCanCreateAfterEnablement),
    existingJob,
    sameJobNumberJobs,
    exactScopeJobs,
    differentScopeJobs,
    job
  };
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

export async function setJobRequirementState(
  payload: SetJobRequirementStatePayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/requirement-state', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function setJobPhaseState(
  payload: SetJobPhaseStatePayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/phase-state', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export interface CompleteJobPayload {
  jobId?: string;
  jobNumber: string;
  reason?: string;
}

export async function completeJob(
  payload: CompleteJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/complete', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export interface ReopenJobPayload {
  jobId?: string;
  jobNumber?: string;
  reason?: string;
}

export async function reopenJob(
  payload: ReopenJobPayload
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

export interface CheckoutAllJobMaterialsPayload {
  jobId?: string;
  jobNumber: string;
}

export async function checkoutAllJobMaterials(
  payload: CheckoutAllJobMaterialsPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  const response = await request<JobDetail>('POST', '/jobs/checkout-all', { body: payload });
  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}
