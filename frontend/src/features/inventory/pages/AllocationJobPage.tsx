import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import type { AllocationJobDetailEntry, FilmOrderEntry, UpdateJobPayload } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, formatDateTime } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobAllocateDialog } from '../components/JobAllocateDialog';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import {
  useCompleteJob,
  useDeleteFilmOrder,
  useFilmCatalog,
  useJob,
  useReopenJob,
  useRemoveJobBoxAllocations,
  useUpdateJob
} from '../hooks/useInventoryQueries';

function renderDate(value: string) {
  return value ? formatDate(value) : '--';
}

function renderDateTime(value: string) {
  return value ? formatDateTime(value) : '--';
}

function formatBadgeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function formatFilmOrderStatusLabel(value: string) {
  if (value === 'FILM_ON_THE_WAY') {
    return 'FILM ORDERED';
  }

  return formatBadgeLabel(value);
}

function buildAddBoxTarget(order: FilmOrderEntry) {
  const params = new URLSearchParams({
    filmOrderId: order.filmOrderId,
    jobNumber: order.jobNumber,
    warehouse: order.warehouse,
    manufacturer: order.manufacturer,
    filmName: order.filmName,
    width: String(order.widthIn),
    initialFeet: String(Math.max(order.remainingToOrderFeet, 1)),
    notes: `Ordered for job ${order.jobNumber} via ${order.filmOrderId}`
  });

  return `/inventory/add?${params.toString()}`;
}

export default function AllocationJobPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const params = useParams();
  const jobNumber = decodeURIComponent(params.jobNumber || '');
  const jobQuery = useJob(jobNumber);
  const updateJobMutation = useUpdateJob();
  const completeJobMutation = useCompleteJob();
  const reopenJobMutation = useReopenJob();
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const removeJobBoxAllocationsMutation = useRemoveJobBoxAllocations();
  const filmCatalogQuery = useFilmCatalog();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [isCompleteConfirmOpen, setIsCompleteConfirmOpen] = useState(false);
  const [isReopenConfirmOpen, setIsReopenConfirmOpen] = useState(false);
  const [filmOrderToDelete, setFilmOrderToDelete] = useState<FilmOrderEntry | null>(null);
  const [allocationToRemove, setAllocationToRemove] = useState<AllocationJobDetailEntry | null>(null);

  const detail = jobQuery.data;
  const summary = detail?.summary;
  const requirements = detail?.requirements || [];
  const allocations = detail?.allocations || [];
  const usage = detail?.usage || [];
  const isClosedJob =
    summary?.lifecycleStatus === 'COMPLETED' || summary?.lifecycleStatus === 'CANCELLED';
  const isReadOnlyJob = isClosedJob;
  const visibleAllocations = useMemo(
    () => allocations.filter((entry) => entry.status === 'ACTIVE' || entry.checkedOutOnThisJob),
    [allocations]
  );
  const filmOrders = detail?.filmOrders || [];
  const canAllocate = useMemo(
    () => !isReadOnlyJob && requirements.some((entry) => entry.remainingFeet > 0),
    [isReadOnlyJob, requirements]
  );

  async function handleUpdateJob(submitPayload: JobEditorSubmitPayload) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${submitPayload.jobNumber} is closed and cannot be edited.`,
        variant: 'error'
      });
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before editing jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before editing this job.',
        variant: 'error'
      });
      return;
    }

    const payload: UpdateJobPayload = {
      jobNumber: summary?.jobNumber || submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      crewLeader: submitPayload.crewLeader,
      requirements: submitPayload.requirements
    };

    try {
      const { warnings } = await updateJobMutation.mutateAsync(payload);
      setIsEditOpen(false);
      toast.push({
        title: `Saved job ${payload.jobNumber}`,
        description: warnings.join(' ') || `Job ${payload.jobNumber} was updated.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update job',
        description: error instanceof Error ? error.message : 'The update failed.',
        variant: 'error'
      });
    }
  }

  async function handleCompleteJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before completing jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before completing this job.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await completeJobMutation.mutateAsync({
        jobNumber: summary.jobNumber,
        reason: reason || `Marked job ${summary.jobNumber} as completed.`
      });
      toast.push({
        title: `Completed job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} was completed.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to complete job',
        description: error instanceof Error ? error.message : 'The completion request failed.',
        variant: 'error'
      });
    }
  }

  async function handleReopenJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before reopening jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before reopening this job.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isOwner) {
      toast.push({
        title: 'Owner access required',
        description: 'Only owners can reopen completed or cancelled jobs.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await reopenJobMutation.mutateAsync({
        jobNumber: summary.jobNumber,
        reason
      });
      toast.push({
        title: `Reopened job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} is active again.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to reopen job',
        description: error instanceof Error ? error.message : 'The reopen request failed.',
        variant: 'error'
      });
    }
  }

  async function handleDeleteFilmOrder(order: FilmOrderEntry, reason: string) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${order.jobNumber} is closed and film orders cannot be changed.`,
        variant: 'error'
      });
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before deleting film orders.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before deleting a film order.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await deleteFilmOrderMutation.mutateAsync({
        filmOrderId: order.filmOrderId,
        jobNumber: order.jobNumber,
        reason: reason || `Deleted from Job ${order.jobNumber}`
      });
      toast.push({
        title: `Deleted ${order.filmOrderId}`,
        description: warnings.join(' ') || 'The film order was removed.',
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to delete film order',
        description: error instanceof Error ? error.message : 'The delete request failed.',
        variant: 'error'
      });
    }
  }

  async function handleRemoveAllocation(entry: AllocationJobDetailEntry, reason: string) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be removed.`,
        variant: 'error'
      });
      return;
    }

    if (entry.checkedOutOnThisJob) {
      toast.push({
        title: 'Cannot remove checked-out allocation',
        description: `Box ${entry.boxId} is currently checked out on job ${entry.jobNumber}. Check it in first.`,
        variant: 'error'
      });
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before removing allocations.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before removing an allocation.',
        variant: 'error'
      });
      return;
    }

    try {
      const { result, warnings } = await removeJobBoxAllocationsMutation.mutateAsync({
        jobNumber: summary?.jobNumber || entry.jobNumber,
        allocationId: entry.allocationId,
        reason:
          reason ||
          `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${summary?.jobNumber || entry.jobNumber}.`
      });
      toast.push({
        title: `Removed allocation ${result.allocationId}`,
        description:
          warnings.join(' ') ||
          `Removed ${result.removedAllocationCount} allocation${result.removedAllocationCount === 1 ? '' : 's'} for box ${result.boxId}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to remove allocation',
        description: error instanceof Error ? error.message : 'The remove request failed.',
        variant: 'error'
      });
    }
  }

  if (jobQuery.isLoading) {
    return <LoadingState label="Loading job details..." />;
  }

  if (jobQuery.isError || !detail || !summary) {
    return (
      <section className="panel">
        <p className="error-text">{jobQuery.error?.message || 'Job not found.'}</p>
        <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
          Back to Jobs
        </Button>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>JOB ID {summary.jobNumber}</h2>
            <p className="muted-text">Job detail</p>
          </div>
          <div className="detail-actions">
            <span className={`badge badge-${summary.status}`}>{formatBadgeLabel(summary.status)}</span>
            {isReadOnlyJob ? <span className="muted-text">Read-only</span> : null}
            {!isReadOnlyJob ? (
              <Button type="button" onClick={() => setIsEditOpen(true)}>
                Edit
              </Button>
            ) : null}
            {isReadOnlyJob && auth.isOwner ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsReopenConfirmOpen(true)}
                disabled={reopenJobMutation.isPending}
              >
                Reopen Job
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
              Back
            </Button>
          </div>
        </div>
        <div className="stat-grid allocation-stat-grid">
          <div className="key-value">
            <dt>Due Date</dt>
            <dd>{renderDate(summary.dueDate)}</dd>
          </div>
          <div className="key-value">
            <dt>Warehouse</dt>
            <dd>{summary.warehouse}</dd>
          </div>
          <div className="key-value">
            <dt>Sections</dt>
            <dd>{summary.sections ?? '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Crew Leader</dt>
            <dd>{summary.crewLeader || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Required LF</dt>
            <dd>{summary.requiredFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Allocated LF</dt>
            <dd>{summary.allocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Remaining LF</dt>
            <dd>{summary.remainingFeet}</dd>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Film Requirements</h2>
        </div>
        {!requirements.length ? (
          <div className="empty-state">No film requirements added yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {requirements.map((entry) => (
              <MobileRecordCard key={entry.requirementId}>
                <MobileRecordHeader
                  title={`${entry.manufacturer} ${entry.filmName}`}
                  subtitle={`Width ${entry.widthIn}"`}
                />
                <MobileFieldList>
                  <MobileField label="Required LF" value={entry.requiredFeet} />
                  <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                  <MobileField label="Remaining LF" value={entry.remainingFeet} />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Manufacturer</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Required LF</th>
                  <th>Allocated LF</th>
                  <th>Remaining LF</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((entry) => (
                  <tr key={entry.requirementId}>
                    <td>{entry.manufacturer}</td>
                    <td>{entry.filmName}</td>
                    <td>{entry.widthIn}</td>
                    <td>{entry.requiredFeet}</td>
                    <td>{entry.allocatedFeet}</td>
                    <td>{entry.remainingFeet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Allocated Boxes</h2>
          <div className="detail-actions allocation-header-actions">
            {!isReadOnlyJob ? (
              <Button
                type="button"
                onClick={() => setIsAllocateOpen(true)}
                disabled={!canAllocate || !auth.isAuthenticated || !auth.clientIdConfigured}
              >
                Allocate
              </Button>
            ) : null}
          </div>
        </div>
        {!visibleAllocations.length ? (
          <div className="empty-state">No allocations are tied to this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {visibleAllocations.map((entry) => (
              <MobileRecordCard key={entry.allocationId}>
                <MobileRecordHeader
                  title={entry.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  onTitleClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                />
                <MobileFieldList>
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                  <MobileField label="Created" value={renderDateTime(entry.createdAt)} />
                  <MobileField label="Resolved" value={renderDateTime(entry.resolvedAt)} />
                </MobileFieldList>
                <div className="film-order-actions">
                  {isReadOnlyJob ? (
                    <span className="muted-text">Read-only</span>
                  ) : entry.checkedOutOnThisJob ? (
                    <span className="muted-text">Checked out on this job</span>
                  ) : (
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => setAllocationToRemove(entry)}
                      disabled={removeJobBoxAllocationsMutation.isPending}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Box</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>LF</th>
                  <th>Created</th>
                  <th>Resolved</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleAllocations.map((entry) => (
                  <tr key={entry.allocationId}>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>
                      {entry.manufacturer} {entry.filmName}
                    </td>
                    <td>{entry.widthIn || '--'}</td>
                    <td>{entry.allocatedFeet}</td>
                    <td>{renderDateTime(entry.createdAt)}</td>
                    <td>{renderDateTime(entry.resolvedAt)}</td>
                    <td>
                      {isReadOnlyJob ? (
                        <span className="muted-text">Read-only</span>
                      ) : entry.checkedOutOnThisJob ? (
                        <span className="muted-text">Checked out on this job</span>
                      ) : (
                        <Button
                          type="button"
                          variant="danger"
                          onClick={() => setAllocationToRemove(entry)}
                          disabled={removeJobBoxAllocationsMutation.isPending}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Film Usage</h2>
        </div>
        {!usage.length ? (
          <div className="empty-state">No checked-in usage has been recorded for this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {usage.map((entry) => (
              <MobileRecordCard key={entry.boxId}>
                <MobileRecordHeader
                  title={entry.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  onTitleClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                />
                <MobileFieldList>
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField label="Used LF" value={entry.usedFeet} />
                  <MobileField label="Events" value={entry.usageEventCount} />
                  <MobileField label="Last Check-Out" value={renderDateTime(entry.latestCheckedOutAt)} />
                  <MobileField label="Latest Check-In" value={renderDateTime(entry.latestCheckedInAt)} />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Box</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Used LF</th>
                  <th>Events</th>
                  <th>Last Check-Out</th>
                  <th>Latest Check-In</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((entry) => (
                  <tr key={entry.boxId}>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>
                      {entry.manufacturer} {entry.filmName}
                    </td>
                    <td>{entry.widthIn || '--'}</td>
                    <td>{entry.usedFeet}</td>
                    <td>{entry.usageEventCount}</td>
                    <td>{renderDateTime(entry.latestCheckedOutAt)}</td>
                    <td>{renderDateTime(entry.latestCheckedInAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Related Film Orders</h2>
        </div>
        {!filmOrders.length ? (
          <div className="empty-state">No film orders were created for this job.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {filmOrders.map((order) => (
              <MobileRecordCard key={order.filmOrderId}>
                <MobileRecordHeader
                  title={order.filmOrderId}
                  subtitle={`${order.manufacturer} ${order.filmName}`}
                  badge={
                    <span className={`badge badge-${order.status}`}>
                      {formatFilmOrderStatusLabel(order.status)}
                    </span>
                  }
                />
                <MobileFieldList>
                  <MobileField label="Width" value={order.widthIn} />
                  <MobileField label="Requested LF" value={order.requestedFeet} />
                  <MobileField label="Covered LF" value={order.coveredFeet} />
                  <MobileField label="On The Way LF" value={order.orderedFeet} />
                  <MobileField label="Still Short LF" value={order.remainingToOrderFeet} />
                </MobileFieldList>
                <div className="film-order-actions">
                  {isReadOnlyJob ? (
                    <span className="muted-text">Read-only</span>
                  ) : (
                    <>
                      {order.status === 'FULFILLED' ? null : (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => navigate(buildAddBoxTarget(order))}
                          disabled={order.status !== 'FILM_ORDER'}
                        >
                          Order Film
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setFilmOrderToDelete(order)}
                        disabled={deleteFilmOrderMutation.isPending}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Requested</th>
                  <th>Covered</th>
                  <th>On The Way</th>
                  <th>Still Short</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filmOrders.map((order) => (
                  <tr key={order.filmOrderId}>
                    <td>
                      <span className={`badge badge-${order.status}`}>
                        {formatFilmOrderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td>
                      {order.manufacturer} {order.filmName}
                    </td>
                    <td>{order.widthIn}</td>
                    <td>{order.requestedFeet}</td>
                    <td>{order.coveredFeet}</td>
                    <td>{order.orderedFeet}</td>
                    <td>{order.remainingToOrderFeet}</td>
                    <td>
                      <div className="film-order-actions">
                        {isReadOnlyJob ? (
                          <span className="muted-text">Read-only</span>
                        ) : (
                          <>
                            {order.status === 'FULFILLED' ? null : (
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => navigate(buildAddBoxTarget(order))}
                                disabled={order.status !== 'FILM_ORDER'}
                              >
                                Order Film
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setFilmOrderToDelete(order)}
                              disabled={deleteFilmOrderMutation.isPending}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!isReadOnlyJob ? (
        <section className="panel">
          <div className="page-actions allocation-complete-footer">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsCompleteConfirmOpen(true)}
              disabled={completeJobMutation.isPending || !auth.isAuthenticated || !auth.clientIdConfigured}
            >
              Job Completed
            </Button>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(filmOrderToDelete)}
        title="Delete Film Order"
        message={
          filmOrderToDelete
            ? `Delete film order ${filmOrderToDelete.filmOrderId}? Any active allocations tied to this film order will be released back to inventory.`
            : ''
        }
        confirmLabel="Delete"
        cancelLabel="Keep Film Order"
        onCancel={() => setFilmOrderToDelete(null)}
        onConfirm={(reason) => {
          if (!filmOrderToDelete) {
            return;
          }

          const order = filmOrderToDelete;
          setFilmOrderToDelete(null);
          void handleDeleteFilmOrder(order, reason);
        }}
      />

      <ConfirmDialog
        open={Boolean(allocationToRemove)}
        title="Remove Box Allocation"
        message={
          allocationToRemove
            ? `Remove this allocation row for box ${allocationToRemove.boxId} on job ${summary.jobNumber}?`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep Allocation"
        onCancel={() => setAllocationToRemove(null)}
        onConfirm={(reason) => {
          if (!allocationToRemove) {
            return;
          }

          const entry = allocationToRemove;
          setAllocationToRemove(null);
          void handleRemoveAllocation(entry, reason);
        }}
      />

      <ConfirmDialog
        open={isCompleteConfirmOpen}
        title="Mark Job Completed"
        message={
          summary
            ? `Mark job ${summary.jobNumber} completed? This cancels active allocations and open film orders.`
            : ''
        }
        confirmLabel="Complete Job"
        cancelLabel="Keep Open"
        onCancel={() => setIsCompleteConfirmOpen(false)}
        onConfirm={(reason) => {
          setIsCompleteConfirmOpen(false);
          void handleCompleteJob(reason);
        }}
      />

      <ConfirmDialog
        open={isReopenConfirmOpen}
        title="Reopen Job"
        message={
          summary
            ? `Reopen job ${summary.jobNumber}? Cancelled allocations and film orders will stay cancelled.`
            : ''
        }
        confirmLabel="Reopen Job"
        cancelLabel="Keep Closed"
        onCancel={() => setIsReopenConfirmOpen(false)}
        onConfirm={(reason) => {
          setIsReopenConfirmOpen(false);
          void handleReopenJob(reason);
        }}
      />

      <JobEditorDialog
        open={isEditOpen}
        mode="edit"
        title={`Edit Job ${summary.jobNumber}`}
        submitLabel="Save Job"
        submitting={updateJobMutation.isPending}
        initialJobNumber={summary.jobNumber}
        initialWarehouse={summary.warehouse}
        initialSections={summary.sections}
        initialDueDate={summary.dueDate}
        initialCrewLeader={summary.crewLeader}
        initialRequirements={requirements}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        onCancel={() => setIsEditOpen(false)}
        onSubmit={(payload) => void handleUpdateJob(payload)}
      />

      <JobAllocateDialog
        open={isAllocateOpen}
        jobNumber={summary.jobNumber}
        warehouse={summary.warehouse}
        dueDate={summary.dueDate}
        crewLeader={summary.crewLeader}
        requirements={requirements}
        filmOrders={filmOrders}
        onCancel={() => setIsAllocateOpen(false)}
      />
    </>
  );
}
