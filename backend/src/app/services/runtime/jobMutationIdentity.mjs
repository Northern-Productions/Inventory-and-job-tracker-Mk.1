// Purpose: JobId-first mutation identity resolution shared by lifecycle mutation slices.
import {
  HttpError,
  asTrimmedString,
  findJobById,
  normalizeJobNumberDigits,
} from '../runtimeDeps.mjs';
import {
  normalizeJobMutationIdentityInput,
  validateResolvedJobMutationIdentity,
} from '../../../../../shared/domain/jobMutationIdentity.mjs';

export function normalizeBackendJobMutationIdentity(payload) {
  return normalizeJobMutationIdentityInput(payload, { normalizeJobNumberDigits });
}

export async function resolveJobMutationTargetById(client, orgId, payload) {
  const input = normalizeBackendJobMutationIdentity(payload);
  if (!input.hasJobId) {
    return {
      usedJobId: false,
      input,
      job: null,
    };
  }

  const job = await findJobById(client, orgId, input.jobId);
  if (!job) {
    throw new HttpError(404, `Job ${input.jobId} was not found.`);
  }

  const validation = validateResolvedJobMutationIdentity(input, job, { normalizeJobNumberDigits });
  if (!validation.ok) {
    throw new HttpError(validation.status || 409, validation.message);
  }

  return {
    usedJobId: true,
    input,
    job,
    jobId: asTrimmedString(job.id || job.jobId || job.job_id) || input.jobId,
    jobNumber: validation.jobNumber,
  };
}
