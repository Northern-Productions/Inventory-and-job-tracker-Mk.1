import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { LoadingState } from '../../../components/LoadingState';
import {
  MobileActionStack,
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import type { CreateFilmOrderPayload, FilmOrderEntry } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { CreateFilmOrderDialog } from '../components/CreateFilmOrderDialog';
import { useCancelJob, useCreateFilmOrder, useFilmOrders } from '../hooks/useInventoryQueries';
import { addManufacturerOption } from '../utils/boxHelpers';

function isOpenFilmOrder(order: FilmOrderEntry) {
  return order.status === 'FILM_ORDER' || order.status === 'FILM_ON_THE_WAY';
}

function sortFilmOrders(entries: FilmOrderEntry[]) {
  return [...entries].sort((a, b) => {
    const aOpen = isOpenFilmOrder(a);
    const bOpen = isOpenFilmOrder(b);

    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }

    const aKey = aOpen ? a.createdAt : a.resolvedAt || a.createdAt;
    const bKey = bOpen ? b.createdAt : b.resolvedAt || b.createdAt;
    if (aKey !== bKey) {
      return aKey < bKey ? -1 : 1;
    }

    return a.filmOrderId < b.filmOrderId ? -1 : a.filmOrderId > b.filmOrderId ? 1 : 0;
  });
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

function formatBadgeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

export default function FilmOrdersPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const filmOrdersQuery = useFilmOrders();
  const createFilmOrderMutation = useCreateFilmOrder();
  const cancelJobMutation = useCancelJob();
  const [isCreateFilmOrderOpen, setIsCreateFilmOrderOpen] = useState(false);
  const [jobToCancel, setJobToCancel] = useState<FilmOrderEntry | null>(null);

  const orderedEntries = useMemo(
    () => sortFilmOrders(filmOrdersQuery.data || []),
    [filmOrdersQuery.data]
  );

  async function handleCancelJob() {
    if (!jobToCancel) {
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before cancelling jobs.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with Google before cancelling a job.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await cancelJobMutation.mutateAsync({
        jobNumber: jobToCancel.jobNumber,
        reason: `Cancelled from Film Orders (${jobToCancel.filmOrderId})`
      });
      toast.push({
        title: `Cancelled job ${jobToCancel.jobNumber}`,
        description:
          warnings.join(' ') || `Released all active film reservations tied to ${jobToCancel.jobNumber}.`,
        variant: 'success'
      });
      setJobToCancel(null);
    } catch (error) {
      toast.push({
        title: 'Unable to cancel job',
        description: error instanceof Error ? error.message : 'The cancel request failed.',
        variant: 'error'
      });
    }
  }

  async function handleCreateFilmOrder(payload: CreateFilmOrderPayload) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before creating film orders.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with Google before creating a film order.',
        variant: 'error'
      });
      return;
    }

    try {
      const { result, warnings } = await createFilmOrderMutation.mutateAsync(payload);
      addManufacturerOption(result.manufacturer);
      setIsCreateFilmOrderOpen(false);
      toast.push({
        title: `Film Order ${result.filmOrderId} created`,
        description:
          warnings.join(' ') || `Continue in Add Box to create the incoming box records for job ${result.jobNumber}.`,
        variant: 'success'
      });
      navigate(buildAddBoxTarget(result));
    } catch (error) {
      toast.push({
        title: 'Unable to create film order',
        description: error instanceof Error ? error.message : 'The create request failed.',
        variant: 'error'
      });
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <h2>Film Orders</h2>
          <Button type="button" variant="secondary" onClick={() => setIsCreateFilmOrderOpen(true)}>
            Order Film
          </Button>
        </div>
        <p className="muted-text">
          Shortage alerts stay at the top. Use FILM ORDERED to add an incoming box tied to the job.
        </p>
        {filmOrdersQuery.isLoading ? <LoadingState label="Loading film orders..." /> : null}
        {filmOrdersQuery.isError ? <p className="error-text">{filmOrdersQuery.error.message}</p> : null}
        {!filmOrdersQuery.isLoading && !filmOrdersQuery.isError && !orderedEntries.length ? (
          <div className="empty-state">No film order alerts have been created yet.</div>
        ) : null}
        {orderedEntries.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {orderedEntries.map((order) => (
                <MobileRecordCard key={order.filmOrderId}>
                  <MobileRecordHeader
                    title={order.filmOrderId}
                    subtitle={`Job ${order.jobNumber}`}
                    badge={<span className={`badge badge-${order.status}`}>{formatBadgeLabel(order.status)}</span>}
                  />
                  <MobileFieldList>
                    <MobileField label="Warehouse" value={order.warehouse} />
                    <MobileField label="Film" value={`${order.manufacturer} ${order.filmName}`} />
                    <MobileField label="Width" value={order.widthIn} />
                    <MobileField label="Requested LF" value={order.requestedFeet} />
                    <MobileField label="Covered LF" value={order.coveredFeet} />
                    <MobileField label="On The Way LF" value={order.orderedFeet} />
                    <MobileField label="Still Short LF" value={order.remainingToOrderFeet} />
                    <MobileField label="Job Date" value={formatDate(order.jobDate)} />
                    <MobileField label="Crew" value={order.crewLeader || '--'} />
                    <MobileField label="Created" value={formatDate(order.createdAt)} />
                    <MobileField
                      label="Linked Boxes"
                      value={
                        (order.linkedBoxes || []).length ? (
                          <div className="film-order-linked-boxes">
                            {(order.linkedBoxes || []).map((link) => (
                              <div key={`${order.filmOrderId}-${link.boxId}`}>
                                <strong>{link.boxId}</strong>: {link.orderedFeet} LF ordered,{' '}
                                {link.autoAllocatedFeet} LF allocated
                              </div>
                            ))}
                          </div>
                        ) : (
                          '--'
                        )
                      }
                    />
                  </MobileFieldList>
                  {order.status === 'FULFILLED' ? null : (
                    <MobileActionStack>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => navigate(buildAddBoxTarget(order))}
                        disabled={order.status !== 'FILM_ORDER'}
                      >
                        FILM ORDERED
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setJobToCancel(order)}
                        disabled={!isOpenFilmOrder(order) || cancelJobMutation.isPending}
                      >
                        Cancel Job
                      </Button>
                    </MobileActionStack>
                  )}
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Film Order</th>
                    <th>Job</th>
                    <th>Warehouse</th>
                    <th>Film</th>
                    <th>Width</th>
                    <th>Requested</th>
                    <th>Covered</th>
                    <th>On The Way</th>
                    <th>Still Short</th>
                    <th>Job Date</th>
                    <th>Crew</th>
                    <th>Linked Boxes</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedEntries.map((order) => (
                    <tr key={order.filmOrderId}>
                      <td>
                        <span className={`badge badge-${order.status}`}>{formatBadgeLabel(order.status)}</span>
                      </td>
                      <td>{order.filmOrderId}</td>
                      <td>{order.jobNumber}</td>
                      <td>{order.warehouse}</td>
                      <td>
                        {order.manufacturer} {order.filmName}
                      </td>
                      <td>{order.widthIn}</td>
                      <td>{order.requestedFeet}</td>
                      <td>{order.coveredFeet}</td>
                      <td>{order.orderedFeet}</td>
                      <td>{order.remainingToOrderFeet}</td>
                      <td>{formatDate(order.jobDate)}</td>
                      <td>{order.crewLeader || '--'}</td>
                      <td>
                        {(order.linkedBoxes || []).length ? (
                          <div className="film-order-linked-boxes">
                            {(order.linkedBoxes || []).map((link) => (
                              <div key={`${order.filmOrderId}-${link.boxId}`}>
                                <strong>{link.boxId}</strong>: {link.orderedFeet} LF ordered,{' '}
                                {link.autoAllocatedFeet} LF allocated
                              </div>
                            ))}
                          </div>
                        ) : (
                          '--'
                        )}
                      </td>
                      <td>{formatDate(order.createdAt)}</td>
                      <td>
                        {order.status === 'FULFILLED' ? null : (
                          <div className="film-order-actions">
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => navigate(buildAddBoxTarget(order))}
                              disabled={order.status !== 'FILM_ORDER'}
                            >
                              FILM ORDERED
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setJobToCancel(order)}
                              disabled={!isOpenFilmOrder(order) || cancelJobMutation.isPending}
                            >
                              Cancel Job
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <ConfirmDialog
        open={Boolean(jobToCancel)}
        title="Cancel Job"
        message={
          jobToCancel
            ? `Cancel every active allocation and film order tied to job ${jobToCancel.jobNumber}? This releases reserved LF back into inventory.`
            : ''
        }
        confirmLabel="Cancel Job"
        cancelLabel="Keep Job"
        onCancel={() => setJobToCancel(null)}
        onConfirm={() => void handleCancelJob()}
      />

      <CreateFilmOrderDialog
        open={isCreateFilmOrderOpen}
        submitting={createFilmOrderMutation.isPending}
        onCancel={() => setIsCreateFilmOrderOpen(false)}
        onSubmit={(payload) => void handleCreateFilmOrder(payload)}
      />
    </>
  );
}
