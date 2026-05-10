import { useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { checkJobDuplicate } from '../../../../api/features/jobsClient';
import type { CreateJobPayload, JobListEntry } from '../../../../domain';
import type { JobEditorSubmitPayload } from '../../components/JobEditorDialog';
import { shouldPromptForLaborOnlyConfirmation } from '../../utils/laborOnlyJobs';
import { buildAllocationJobRoute } from '../../utils/jobRoutes';

interface CreateJobMutationLike {
  isPending: boolean;
  mutateAsync: (
    payload: CreateJobPayload
  ) => Promise<{ result: { summary: { jobNumber: string; jobId?: string } } }>;
}

interface ToastLike {
  push: (toast: {
    title: string;
    description?: string;
    variant?: 'success' | 'error' | 'warning';
  }) => void;
}

interface AuthLike {
  clientIdConfigured: boolean;
  isAuthenticated: boolean;
}

export interface DuplicateJobPrompt {
  job: JobListEntry;
}

interface UseJobCreationWorkflowOptions {
  auth: AuthLike;
  createJobMutation: CreateJobMutationLike;
  navigate: NavigateFunction;
  toast: ToastLike;
}

function buildCreateJobPayload(
  submitPayload: JobEditorSubmitPayload,
  isLaborOnly: boolean
): CreateJobPayload {
  return {
    jobNumber: submitPayload.jobNumber,
    warehouse: submitPayload.warehouse,
    workScope: submitPayload.workScope,
    sections: submitPayload.sections,
    installDate: submitPayload.installDate,
    crewLeader: submitPayload.crewLeader,
    requirements: submitPayload.requirements,
    caulkRequirements: submitPayload.caulkRequirements,
    isLaborOnly
  };
}

export function useJobCreationWorkflow({
  auth,
  createJobMutation,
  navigate,
  toast
}: UseJobCreationWorkflowOptions) {
  const [isNewJobOpen, setIsNewJobOpen] = useState(false);
  const [pendingLaborOnlyCreate, setPendingLaborOnlyCreate] =
    useState<JobEditorSubmitPayload | null>(null);
  const [duplicateJobPrompt, setDuplicateJobPrompt] = useState<DuplicateJobPrompt | null>(null);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);

  function ensureCreateAuthorized() {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating jobs.',
        variant: 'error'
      });
      return false;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a job.',
        variant: 'error'
      });
      return false;
    }

    return true;
  }

  async function preflightDuplicateJob(submitPayload: JobEditorSubmitPayload) {
    setIsCheckingDuplicate(true);
    try {
      const duplicate = await checkJobDuplicate(submitPayload.jobNumber, {
        workScope: submitPayload.workScope,
        sections: submitPayload.sections
      });
      if (duplicate.exists && duplicate.job) {
        setPendingLaborOnlyCreate(null);
        setDuplicateJobPrompt({ job: duplicate.job });
        return false;
      }
      return true;
    } catch (error) {
      toast.push({
        title: 'Unable to check job number',
        description: error instanceof Error ? error.message : 'The job number could not be checked.',
        variant: 'error'
      });
      return false;
    } finally {
      setIsCheckingDuplicate(false);
    }
  }

  async function submitCreateJob(submitPayload: JobEditorSubmitPayload, isLaborOnly: boolean) {
    if (!ensureCreateAuthorized()) {
      return;
    }

    const payload = buildCreateJobPayload(submitPayload, isLaborOnly);

    try {
      setPendingLaborOnlyCreate(null);
      setIsNewJobOpen(false);
      const destination = `/allocations/${encodeURIComponent(payload.jobNumber)}`;
      const savePromise = createJobMutation.mutateAsync(payload);
      navigate(destination);
      const { result } = await savePromise;
      navigate(buildAllocationJobRoute(result.summary), {
        replace: true
      });
    } catch (error) {
      navigate('/allocations', { replace: true });
      toast.push({
        title: 'Unable to save job',
        description: error instanceof Error ? error.message : 'The job could not be saved.',
        variant: 'error'
      });
    }
  }

  async function handleCreateJob(submitPayload: JobEditorSubmitPayload) {
    if (!ensureCreateAuthorized()) {
      return;
    }

    if (!(await preflightDuplicateJob(submitPayload))) {
      return;
    }

    if (shouldPromptForLaborOnlyConfirmation(submitPayload)) {
      setPendingLaborOnlyCreate(submitPayload);
      return;
    }

    await submitCreateJob(submitPayload, false);
  }

  function confirmLaborOnlyCreate() {
    if (!pendingLaborOnlyCreate) {
      return;
    }

    void submitCreateJob(pendingLaborOnlyCreate, true);
  }

  function dismissDuplicateJobPrompt() {
    setDuplicateJobPrompt(null);
    setIsNewJobOpen(true);
  }

  function goToDuplicateJob() {
    const job = duplicateJobPrompt?.job;
    if (!job) {
      return;
    }

    setDuplicateJobPrompt(null);
    setPendingLaborOnlyCreate(null);
    setIsNewJobOpen(false);
    navigate(buildAllocationJobRoute(job));
  }

  return {
    isNewJobOpen,
    setIsNewJobOpen,
    pendingLaborOnlyCreate,
    setPendingLaborOnlyCreate,
    duplicateJobPrompt,
    isCreateSubmitting: createJobMutation.isPending || isCheckingDuplicate,
    handleCreateJob,
    confirmLaborOnlyCreate,
    dismissDuplicateJobPrompt,
    goToDuplicateJob
  };
}
