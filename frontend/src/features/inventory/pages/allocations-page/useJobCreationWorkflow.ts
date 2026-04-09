import { useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { CreateJobPayload } from '../../../../domain';
import type { JobEditorSubmitPayload } from '../../components/JobEditorDialog';
import { shouldPromptForLaborOnlyConfirmation } from '../../utils/laborOnlyJobs';

interface CreateJobMutationLike {
  isPending: boolean;
  mutateAsync: (
    payload: CreateJobPayload
  ) => Promise<{ result: { summary: { jobNumber: string } } }>;
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
    sections: submitPayload.sections,
    dueDate: submitPayload.dueDate,
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

  async function submitCreateJob(submitPayload: JobEditorSubmitPayload, isLaborOnly: boolean) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a job.',
        variant: 'error'
      });
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
      navigate(`/allocations/${encodeURIComponent(result.summary.jobNumber)}`, {
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

  return {
    isNewJobOpen,
    setIsNewJobOpen,
    pendingLaborOnlyCreate,
    setPendingLaborOnlyCreate,
    handleCreateJob,
    confirmLaborOnlyCreate
  };
}
