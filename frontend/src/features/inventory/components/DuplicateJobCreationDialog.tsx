import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import type { JobDuplicateCheckResult } from '../../../api/features/jobsClient';
import type { JobListEntry } from '../../../domain';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';

interface DuplicateJobCreationDialogProps {
  open: boolean;
  duplicate: JobDuplicateCheckResult | null;
  job: JobListEntry | null;
  canConfirmCreate?: boolean;
  onEditNewJob: () => void;
  onGoToJob: () => void;
  onConfirmCreate?: () => void;
}

function isCompletedJob(job: JobListEntry | null | undefined) {
  return job?.lifecycleStatus === 'COMPLETED' || job?.status === 'COMPLETED';
}

function uniqueJobs(jobs: Array<JobListEntry | null | undefined>) {
  const seen = new Set<string>();
  const result: JobListEntry[] = [];

  for (const job of jobs) {
    if (!job) {
      continue;
    }

    const key = [
      String(job.jobId || '').trim(),
      String(job.jobNumber || '').trim(),
      String(job.workScopeKey || '').trim(),
      String(job.workScope ?? job.sections ?? '').trim(),
      String(job.lifecycleStatus || '').trim(),
      String(job.status || '').trim()
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(job);
  }

  return result;
}

function formatWorkScope(job: JobListEntry) {
  return String(job.workScope ?? job.sections ?? '').trim() || 'Blank Work Scope';
}

function formatStatus(job: JobListEntry) {
  const lifecycleStatus = String(job.lifecycleStatus || '').trim();
  const status = String(job.status || '').trim();

  if (lifecycleStatus && status && lifecycleStatus !== status) {
    return `${lifecycleStatus} / ${status}`;
  }

  return lifecycleStatus || status;
}

function CandidateGroup({
  title,
  jobs
}: {
  title: string;
  jobs: JobListEntry[];
}) {
  if (jobs.length === 0) {
    return null;
  }

  return (
    <section className="duplicate-job-group" aria-label={title}>
      <h3>{title}</h3>
      <ul className="duplicate-job-list">
        {jobs.map((candidate) => {
          const metadata = [
            ['Work Scope', formatWorkScope(candidate)],
            ['Warehouse', String(candidate.warehouse || '').trim()],
            ['Status', formatStatus(candidate)],
            ['Install date', String(candidate.installDate || '').trim()],
            ['Crew leader', String(candidate.crewLeader || '').trim()]
          ].filter(([, value]) => value);
          const key = [
            candidate.jobId,
            candidate.jobNumber,
            candidate.workScopeKey,
            candidate.workScope,
            candidate.sections,
            candidate.lifecycleStatus,
            candidate.status
          ].join('|');

          return (
            <li key={key} className="duplicate-job-list-item">
              <strong>{formatJobDisplayLabel(candidate)}</strong>
              <dl className="duplicate-job-metadata">
                {metadata.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DuplicateJobCreationDialog({
  open,
  duplicate,
  job,
  canConfirmCreate = false,
  onEditNewJob,
  onGoToJob,
  onConfirmCreate
}: DuplicateJobCreationDialogProps) {
  if (!open || !duplicate) {
    return null;
  }

  const exactScopeJobs = uniqueJobs(duplicate.exactScopeJobs || []);
  const differentScopeJobs = uniqueJobs(duplicate.differentScopeJobs || []);
  const fallbackJobs = uniqueJobs([duplicate.job, duplicate.existingJob, job]);
  const hasExactScopeSignal =
    exactScopeJobs.length > 0 ||
    duplicate.exactScopeDuplicateExists === true ||
    duplicate.duplicateScopeMode === 'EXACT_SCOPE' ||
    duplicate.duplicateScopeMode === 'MIXED_SCOPE';
  const hasDifferentScopeSignal =
    differentScopeJobs.length > 0 ||
    duplicate.sameJobNumberDifferentScopeExists === true ||
    duplicate.duplicateScopeMode === 'DIFFERENT_SCOPE' ||
    duplicate.duplicateScopeMode === 'MIXED_SCOPE';
  const hasGroupedContract =
    hasExactScopeSignal || hasDifferentScopeSignal || duplicate.duplicateScopeMode === 'NO_MATCH';
  const fallbackOnly = !hasGroupedContract && fallbackJobs.length > 0;
  const displayedFallbackJobs =
    exactScopeJobs.length === 0 && differentScopeJobs.length === 0 ? fallbackJobs : [];
  const primaryJob =
    exactScopeJobs[0] ?? fallbackJobs[0] ?? differentScopeJobs[0] ?? job ?? null;
  const isCompleted = isCompletedJob(primaryJob);
  const differentScopeOnly = !hasExactScopeSignal && hasDifferentScopeSignal;
  const mixedScope = hasExactScopeSignal && hasDifferentScopeSignal;
  const canCreateDifferentScope =
    differentScopeOnly &&
    canConfirmCreate &&
    duplicate.canCreate === true &&
    duplicate.duplicatesEnabled === true;

  let title = 'This job number already exists.';
  if (differentScopeOnly) {
    title = 'This job number exists with a different Work Scope.';
  } else if (fallbackOnly) {
    title = isCompleted
      ? 'This job was already completed. What would you like to do?'
      : 'This job already exists and is active.';
  } else if (hasExactScopeSignal) {
    title = isCompleted
      ? 'This job number was already completed for this Work Scope.'
      : 'This job number already exists for this Work Scope.';
  }

  let message =
    'This job number already exists. Creation is blocked until the duplicate can be reviewed.';
  if (differentScopeOnly) {
    message = canCreateDifferentScope
      ? 'The Work Scope is different, so creating this same-number job is now allowed. Review the existing job first, then continue only if this is intentional.'
      : 'Same-number jobs with different Work Scopes are not enabled yet, so this job cannot be created. Edit the new job or open the existing job.';
  } else if (mixedScope) {
    message =
      'An exact Work Scope match exists, so creation is blocked. Other jobs with this number are shown for context.';
  } else if (hasExactScopeSignal) {
    message =
      'Creation remains blocked because this job number matches the requested Work Scope. Edit the new job or open the existing job.';
  }

  const goLabel = isCompleted ? 'Go to Completed Job' : 'Go to Existing Job';

  return (
    <DialogSurface open={open} onClose={onEditNewJob} titleId="duplicate-job-dialog-title">
      <div className="dialog-header">
        <h2 id="duplicate-job-dialog-title">{title}</h2>
        <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onEditNewJob}>
          x
        </button>
      </div>
      <p className="muted-text dialog-message">{message}</p>
      <div className="duplicate-job-groups">
        <CandidateGroup title="Exact Work Scope match" jobs={exactScopeJobs} />
        <CandidateGroup title="Same number, different Work Scope" jobs={differentScopeJobs} />
        <CandidateGroup title="Existing job" jobs={displayedFallbackJobs} />
      </div>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" fullWidth onClick={onEditNewJob}>
          Edit New Job
        </Button>
        {primaryJob ? (
          <Button type="button" fullWidth onClick={onGoToJob}>
            {goLabel}
          </Button>
        ) : null}
        {canCreateDifferentScope && onConfirmCreate ? (
          <Button type="button" fullWidth onClick={onConfirmCreate}>
            Create Different Work Scope Job
          </Button>
        ) : null}
      </div>
    </DialogSurface>
  );
}
