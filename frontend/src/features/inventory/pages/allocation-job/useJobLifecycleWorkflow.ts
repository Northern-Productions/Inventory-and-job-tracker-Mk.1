import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { useToast } from '../../../../components/Toast';
import type {
  FilmOrderEntry,
  JobDetail,
  JobFilmTransferAlert,
  JobListEntry,
  UpdateJobPayload
} from '../../../../domain';
import type { JobEditorSubmitPayload } from '../../components/JobEditorDialog';
import { inventoryKeys } from '../../hooks/inventoryQueryKeys';
import {
  getDeleteJobBlockingMessage,
  shouldPromptForCompletedJobAfterReturns,
  summarizeReturnedMaterials
} from '../../utils/jobReturnedMaterials';
import { shouldPromptForLaborOnlyConfirmation } from '../../utils/laborOnlyJobs';
import { getFilmTransferBulkCheckoutMessage } from './helpers';

type PushToast = ReturnType<typeof useToast>['push'];
type MutationFn<Payload, Result> = (payload: Payload) => Promise<Result>;

interface UseJobLifecycleWorkflowArgs {
  detail: JobDetail | undefined;
  summary: JobListEntry | undefined;
  isReadOnlyJob: boolean;
  stagingBlockingMessage: string;
  filmTransferAlerts: JobFilmTransferAlert[];
  isOwner: boolean;
  isAdmin: boolean;
  ensureSignedIn: (actionLabel: string) => boolean;
  pushToast: PushToast;
  navigateToAllocations: () => void;
  navigateToJobDetail: (jobNumber: string) => void;
  updateJob: MutationFn<UpdateJobPayload, { warnings: string[] }>;
  completeJob: MutationFn<{ jobNumber: string; reason: string }, { warnings: string[] }>;
  deleteJob: MutationFn<{ jobNumber: string }, unknown>;
  reopenJob: MutationFn<{ jobNumber: string; reason: string }, { warnings: string[] }>;
  deleteFilmOrder: MutationFn<
    { filmOrderId: string; jobNumber: string; reason: string },
    { warnings: string[] }
  >;
  checkoutAllJobMaterials: MutationFn<{ jobNumber: string }, { warnings: string[] }>;
  setJobStagedForPickup: MutationFn<
    { jobNumber: string; isStagedForPickup: boolean; autoCheckoutRemaining?: boolean },
    { warnings: string[] }
  >;
}

export function useJobLifecycleWorkflow({
  detail,
  summary,
  isReadOnlyJob,
  stagingBlockingMessage,
  filmTransferAlerts,
  isOwner,
  isAdmin,
  ensureSignedIn,
  pushToast,
  navigateToAllocations,
  navigateToJobDetail,
  updateJob,
  completeJob,
  deleteJob,
  reopenJob,
  deleteFilmOrder,
  checkoutAllJobMaterials,
  setJobStagedForPickup
}: UseJobLifecycleWorkflowArgs) {
  const queryClient = useQueryClient();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [pendingLaborOnlyUpdate, setPendingLaborOnlyUpdate] = useState<JobEditorSubmitPayload | null>(
    null
  );
  const [isCompleteConfirmOpen, setIsCompleteConfirmOpen] = useState(false);
  const [isReturnCompletePromptOpen, setIsReturnCompletePromptOpen] = useState(false);
  const [isDeleteJobConfirmOpen, setIsDeleteJobConfirmOpen] = useState(false);
  const [isReopenConfirmOpen, setIsReopenConfirmOpen] = useState(false);
  const [filmOrderToDelete, setFilmOrderToDelete] = useState<FilmOrderEntry | null>(null);

  function buildUpdateJobPayload(
    submitPayload: JobEditorSubmitPayload,
    isLaborOnly: boolean
  ): UpdateJobPayload {
    return {
      jobNumber: summary?.jobNumber || submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      crewLeader: submitPayload.crewLeader,
      requirements: submitPayload.requirements,
      caulkRequirements: submitPayload.caulkRequirements,
      isLaborOnly
    };
  }

  async function submitUpdateJob(submitPayload: JobEditorSubmitPayload, isLaborOnly: boolean) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${submitPayload.jobNumber} is closed and cannot be edited.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('editing jobs')) {
      return;
    }

    const payload = buildUpdateJobPayload(submitPayload, isLaborOnly);

    try {
      setPendingLaborOnlyUpdate(null);
      const { warnings } = await updateJob(payload);
      setIsEditOpen(false);
      pushToast({
        title: `Saved job ${payload.jobNumber}`,
        description: warnings.join(' ') || `Job ${payload.jobNumber} was updated.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to update job',
        description: error instanceof Error ? error.message : 'The update failed.',
        variant: 'error'
      });
    }
  }

  async function handleUpdateJob(submitPayload: JobEditorSubmitPayload) {
    if (shouldPromptForLaborOnlyConfirmation(submitPayload, Boolean(summary?.isLaborOnly))) {
      setPendingLaborOnlyUpdate(submitPayload);
      return;
    }

    await submitUpdateJob(submitPayload, Boolean(summary?.isLaborOnly));
  }

  async function handleCompleteJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('completing jobs')) {
      return;
    }

    try {
      const { warnings } = await completeJob({
        jobNumber: summary.jobNumber,
        reason: reason || `Marked job ${summary.jobNumber} as completed.`
      });
      pushToast({
        title: `Completed job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} was completed.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to complete job',
        description: error instanceof Error ? error.message : 'The completion request failed.',
        variant: 'error'
      });
    }
  }

  async function handleDeleteJob() {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('deleting jobs')) {
      return;
    }

    if (!isOwner && !isAdmin) {
      pushToast({
        title: 'Admin or owner access required',
        description: 'Only admins and owners can delete jobs.',
        variant: 'error'
      });
      return;
    }

    const deleteBlockedMessage = getDeleteJobBlockingMessage(detail);
    if (deleteBlockedMessage) {
      pushToast({
        title: 'Unable to delete job',
        description: deleteBlockedMessage,
        variant: 'error'
      });
      return;
    }

    try {
      const deletePromise = deleteJob({
        jobNumber: summary.jobNumber
      });
      navigateToAllocations();
      await deletePromise;
    } catch (error) {
      navigateToJobDetail(summary.jobNumber);
      pushToast({
        title: 'Unable to delete job',
        description: error instanceof Error ? error.message : 'The delete request failed.',
        variant: 'error'
      });
    }
  }

  function maybeOpenReturnCompletionPrompt(previousHasOutstandingMaterials: boolean) {
    if (!summary || !detail) {
      return;
    }

    const currentDetail =
      queryClient.getQueryData<JobDetail>(inventoryKeys.job(summary.jobNumber)) || detail;
    const currentSummary = currentDetail.summary;
    const currentReturnedMaterials = summarizeReturnedMaterials(currentDetail);

    if (
      shouldPromptForCompletedJobAfterReturns({
        previousHasOutstandingMaterials,
        currentHasOutstandingMaterials: currentReturnedMaterials.hasOutstandingMaterials,
        isLaborOnly: Boolean(currentSummary.isLaborOnly),
        lifecycleStatus: currentSummary.lifecycleStatus
      })
    ) {
      setIsReturnCompletePromptOpen(true);
    }
  }

  async function handleCheckoutAllMaterials() {
    if (!summary) {
      return;
    }

    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${summary.jobNumber} is closed and materials cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('checking out materials')) {
      return;
    }

    const transferBlockingMessage = getFilmTransferBulkCheckoutMessage(filmTransferAlerts);
    if (transferBlockingMessage) {
      pushToast({
        title: 'Receive transfer first',
        description: transferBlockingMessage,
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await checkoutAllJobMaterials({
        jobNumber: summary.jobNumber
      });
      pushToast({
        title: 'Checked out all materials',
        description:
          warnings.join(' ') ||
          `All eligible film and caulk allocations for job ${summary.jobNumber} were checked out.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to check out all materials',
        description: error instanceof Error ? error.message : 'The checkout-all request failed.',
        variant: 'error'
      });
    }
  }

  async function handleReopenJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('reopening jobs')) {
      return;
    }

    if (!isOwner) {
      pushToast({
        title: 'Owner access required',
        description: 'Only owners can reopen completed or cancelled jobs.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await reopenJob({
        jobNumber: summary.jobNumber,
        reason
      });
      pushToast({
        title: `Reopened job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} is active again.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to reopen job',
        description: error instanceof Error ? error.message : 'The reopen request failed.',
        variant: 'error'
      });
    }
  }

  async function handleDeleteFilmOrder(order: FilmOrderEntry, reason: string) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${order.jobNumber} is closed and film orders cannot be changed.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('deleting film orders')) {
      return;
    }

    try {
      const { warnings } = await deleteFilmOrder({
        filmOrderId: order.filmOrderId,
        jobNumber: order.jobNumber,
        reason: reason || `Deleted from Job ${order.jobNumber}`
      });
      pushToast({
        title: `Deleted ${order.filmOrderId}`,
        description: warnings.join(' ') || 'The film order was removed.',
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to delete film order',
        description: error instanceof Error ? error.message : 'The delete request failed.',
        variant: 'error'
      });
    }
  }

  async function handleSetStagedPickup(nextIsStaged: boolean) {
    if (!summary) {
      return;
    }

    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${summary.jobNumber} is closed and staged pickup cannot be changed.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('updating staged pickup')) {
      return;
    }

    if (nextIsStaged && stagingBlockingMessage) {
      pushToast({
        title: 'Unable to update staged pickup',
        description: stagingBlockingMessage,
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await setJobStagedForPickup({
        jobNumber: summary.jobNumber,
        isStagedForPickup: nextIsStaged,
        ...(nextIsStaged ? { autoCheckoutRemaining: true } : {})
      });
      pushToast({
        title: nextIsStaged ? 'Marked staged for pickup' : 'Cleared staged pickup',
        description:
          warnings.join(' ') ||
          (nextIsStaged
            ? `Installers can now see that job ${summary.jobNumber} is staged for pickup.`
            : `Job ${summary.jobNumber} is no longer marked staged for pickup.`),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to update staged pickup',
        description: error instanceof Error ? error.message : 'The staged pickup update failed.',
        variant: 'error'
      });
    }
  }

  return {
    isEditOpen,
    setIsEditOpen,
    pendingLaborOnlyUpdate,
    setPendingLaborOnlyUpdate,
    isCompleteConfirmOpen,
    setIsCompleteConfirmOpen,
    isReturnCompletePromptOpen,
    setIsReturnCompletePromptOpen,
    isDeleteJobConfirmOpen,
    setIsDeleteJobConfirmOpen,
    isReopenConfirmOpen,
    setIsReopenConfirmOpen,
    filmOrderToDelete,
    setFilmOrderToDelete,
    maybeOpenReturnCompletionPrompt,
    submitUpdateJob,
    handleUpdateJob,
    handleCompleteJob,
    handleDeleteJob,
    handleCheckoutAllMaterials,
    handleReopenJob,
    handleDeleteFilmOrder,
    handleSetStagedPickup
  };
}
