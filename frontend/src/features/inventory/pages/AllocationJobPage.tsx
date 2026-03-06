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
import type { FilmOrderEntry, UpdateJobPayload } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, formatDateTime } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { JobAllocateDialog } from '../components/JobAllocateDialog';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { useDeleteFilmOrder, useFilmCatalog, useJob, useUpdateJob } from '../hooks/useInventoryQueries';

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
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const filmCatalogQuery = useFilmCatalog();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [filmOrderToDelete, setFilmOrderToDelete] = useState<FilmOrderEntry | null>(null);

  const detail = jobQuery.data;
  const summary = detail?.summary;
  const requirements = detail?.requirements || [];
  const allocations = detail?.allocations || [];
  const filmOrders = detail?.filmOrders || [];
  const canAllocate = useMemo(
    () => requirements.some((entry) => entry.remainingFeet > 0),
    [requirements]
  );

  async function handleUpdateJob(submitPayload: JobEditorSubmitPayload) {
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

  async function handleDeleteFilmOrder(order: FilmOrderEntry, reason: string) {
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
            <Button type="button" onClick={() => setIsEditOpen(true)}>
              Edit
            </Button>
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
        </div>
        {!allocations.length ? (
          <div className="empty-state">No allocations are tied to this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {allocations.map((entry) => (
              <MobileRecordCard key={entry.allocationId}>
                <MobileRecordHeader
                  title={entry.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  badge={<span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>}
                  onTitleClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                />
                <MobileFieldList>
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                  <MobileField label="Created" value={renderDateTime(entry.createdAt)} />
                  <MobileField label="Resolved" value={renderDateTime(entry.resolvedAt)} />
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
                  <th>LF</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Resolved</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((entry) => (
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
                    <td>
                      <span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>
                    </td>
                    <td>{renderDateTime(entry.createdAt)}</td>
                    <td>{renderDateTime(entry.resolvedAt)}</td>
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="page-actions detail-status-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setIsAllocateOpen(true)}
            disabled={
              !canAllocate ||
              summary.status === 'CANCELLED' ||
              !auth.isAuthenticated ||
              !auth.clientIdConfigured
            }
          >
            Allocate
          </Button>
        </div>
      </section>

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
        requirements={requirements}
        onCancel={() => setIsAllocateOpen(false)}
      />
    </>
  );
}
