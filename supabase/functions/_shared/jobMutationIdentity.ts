// Purpose: Edge job mutation identity resolution for the jobId transition.
import { HttpError } from "./http.ts";
import {
  normalizeJobMutationIdentityInput,
  validateResolvedJobMutationIdentity,
} from "../../../shared/domain/jobMutationIdentity.mjs";

type ResolveJobMutationTargetDeps = {
  findJobById: (client: any, orgId: string, jobId: string) => Promise<any>;
  normalizeJobNumberDigits: (value: unknown, fieldName?: string) => string;
};

export function normalizeEdgeJobMutationIdentity(
  payload: Record<string, unknown>,
  deps: Pick<ResolveJobMutationTargetDeps, "normalizeJobNumberDigits">,
) {
  return normalizeJobMutationIdentityInput(payload, {
    normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
  });
}

export async function resolveEdgeJobMutationTargetById(
  client: any,
  orgId: string,
  payload: Record<string, unknown>,
  deps: ResolveJobMutationTargetDeps,
) {
  const input = normalizeEdgeJobMutationIdentity(payload, deps);
  if (!input.hasJobId) {
    return {
      usedJobId: false,
      input,
      job: null,
    };
  }

  const job = await deps.findJobById(client, orgId, input.jobId);
  if (!job) {
    throw new HttpError(404, `Job ${input.jobId} was not found.`);
  }

  const validation = validateResolvedJobMutationIdentity(input, job, {
    normalizeJobNumberDigits: deps.normalizeJobNumberDigits,
  });
  if (!validation.ok) {
    throw new HttpError(validation.status || 409, validation.message || "Job identity mismatch.");
  }

  return {
    usedJobId: true,
    input,
    job,
    jobId: String((job && (job.id || job.jobId || job.job_id)) || input.jobId).trim(),
    jobNumber: validation.jobNumber,
  };
}
