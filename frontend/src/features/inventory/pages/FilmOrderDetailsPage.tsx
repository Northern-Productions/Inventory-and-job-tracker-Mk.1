import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { useToast } from '../../../components/Toast';
import type { FilmOrderDetail, FilmOrderDisplayStatus } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { safeDecodePathParam } from '../../../lib/url';
import { useFilmOrderDetail } from '../hooks/useInventoryQueries';
import { useManualFulfillFilmOrder } from '../hooks/mutations/planning/filmOrderMutations';
import { formatFilmOrderDealerLabel } from '../utils/filmOrders';

function buildJobHref(order: Pick<FilmOrderDetail, 'jobId' | 'jobNumber'>) {
  return order.jobId
    ? `/allocations/jobs/${encodeURIComponent(order.jobId)}`
    : `/allocations/${encodeURIComponent(order.jobNumber)}`;
}

function formatDisplayStatus(status: FilmOrderDisplayStatus) {
  if (status === 'FULFILLED_COVERED') {
    return 'Fulfilled / Covered';
  }
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatPhaseLabel(order: FilmOrderDetail) {
  const phaseNumber = Number(order.phase?.phaseNumber || 0);
  const workScope = String(order.phase?.workScope ?? order.phase?.sections ?? order.workScope ?? order.sections ?? '').trim();
  if (!phaseNumber && !workScope) {
    return 'No phase recorded';
  }
  if (!phaseNumber) {
    return workScope;
  }
  return workScope ? `Phase ${phaseNumber} - ${workScope}` : `Phase ${phaseNumber}`;
}

function renderChangedData(value: Record<string, unknown> | null | undefined) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const boxId = String(value.boxId || '').trim();
  const initialFeet = Number(value.initialFeet);
  const status = String(value.status || '').trim();
  const parts = [
    boxId ? `Box ${boxId}` : '',
    Number.isFinite(initialFeet) ? `${initialFeet} LF` : '',
    status
  ].filter(Boolean);

  return parts.length ? <span className="muted-text">{parts.join(' / ')}</span> : null;
}

export default function FilmOrderDetailsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const filmOrderId = safeDecodePathParam(params.filmOrderId);
  const detailQuery = useFilmOrderDetail(filmOrderId);
  const manualFulfillMutation = useManualFulfillFilmOrder();
  const [manualFulfillOpen, setManualFulfillOpen] = useState(false);
  const order = detailQuery.data;

  async function handleManualFulfillConfirm() {
    if (!order) {
      return;
    }

    try {
      const { warnings } = await manualFulfillMutation.mutateAsync({
        filmOrderId: order.filmOrderId,
        jobId: order.jobId,
        jobNumber: order.jobNumber
      });
      setManualFulfillOpen(false);
      toast.push({
        title: 'Film order fulfilled',
        description: warnings[0] || `${order.filmOrderId} was manually marked fulfilled.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to fulfill film order',
        description: error instanceof Error ? error.message : 'The film order could not be marked fulfilled.',
        variant: 'error'
      });
    }
  }

  return (
    <section className="panel film-order-detail-page">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Film Order Details</p>
          <h2>{filmOrderId || 'Film Order'}</h2>
        </div>
        <div className="button-row">
          <Button type="button" variant="secondary" onClick={() => navigate('/film-orders')}>
            Back
          </Button>
          {order ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => setManualFulfillOpen(true)}
              loading={manualFulfillMutation.isPending}
              loadingLabel="Fulfilling..."
            >
              Fulfill Order
            </Button>
          ) : null}
        </div>
      </div>

      <DeferredLoadingState when={detailQuery.isLoading} label="Loading film order..." />
      {detailQuery.isError ? <p className="error-text">{detailQuery.error.message}</p> : null}

      {order ? (
        <>
          <div className="film-order-detail-summary">
            <div>
              <span className={`badge badge-${order.displayStatus}`}>
                {formatDisplayStatus(order.displayStatus)}
              </span>
              <p className="muted-text">Stored status: {order.storedStatus.replace(/_/g, ' ')}</p>
            </div>
            <div>
              <span className="detail-label">Job Ordered For</span>
              <Link to={buildJobHref(order)}>{formatJobDisplayLabel(order)}</Link>
            </div>
            <div>
              <span className="detail-label">Phase / Work Scope</span>
              <strong>{formatPhaseLabel(order)}</strong>
            </div>
            <div>
              <span className="detail-label">Material</span>
              <strong>
                {order.manufacturer} {order.filmName} / {order.widthIn}"
              </strong>
            </div>
          </div>

          <div className="metric-grid film-order-detail-metrics">
            <div>
              <span className="detail-label">Current Needed LF</span>
              <strong>{order.neededFeet}</strong>
              <span className="muted-text">{order.needSource.replace(/_/g, ' ')}</span>
            </div>
            <div>
              <span className="detail-label">Fulfilled LF</span>
              <strong>{order.fulfilledFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Remaining LF</span>
              <strong>{order.remainingFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Overage LF</span>
              <strong>{order.overageFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Ordered Date</span>
              <strong>{formatDate(order.orderedDate || order.createdAt)}</strong>
            </div>
            <div>
              <span className="detail-label">Received Date</span>
              <strong>{order.receivedDate ? formatDate(order.receivedDate) : 'Not received'}</strong>
            </div>
            <div>
              <span className="detail-label">Dealer</span>
              <strong>{formatFilmOrderDealerLabel(order)}</strong>
            </div>
          </div>

          {order.displayStatus === 'NO_LONGER_NEEDED' ? (
            <div className="notice-card">
              This film order is linked to a requirement that was removed or changed to a different
              material/width. It remains traceable, but it is not counted as current job demand.
            </div>
          ) : null}

          <section className="detail-subsection">
            <div className="panel-title-row">
              <h3>Connected Boxes</h3>
              <span className="muted-text">{order.linkedBoxes.length} box{order.linkedBoxes.length === 1 ? '' : 'es'}</span>
            </div>
            {order.linkedBoxes.length ? (
              <div className="table-wrap">
                <table className="film-order-detail-table">
                  <thead>
                    <tr>
                      <th>Box</th>
                      <th>Status</th>
                      <th>Initial LF</th>
                      <th>Ordered LF</th>
                      <th>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.linkedBoxes.map((box) => (
                      <tr key={box.boxId}>
                        <td>
                          <Link to={`/inventory/${encodeURIComponent(box.boxId)}`}>{box.boxId}</Link>
                        </td>
                        <td>{box.status}</td>
                        <td>{box.initialFeet}</td>
                        <td>{box.orderedFeet}</td>
                        <td>{box.receivedDate ? formatDate(box.receivedDate) : 'Not received'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">No boxes are connected to this film order yet.</div>
            )}
          </section>

          <section className="detail-subsection">
            <h3>History</h3>
            {order.history.length ? (
              <div className="history-list film-order-history-list">
                {order.history.map((event) => (
                  <article key={event.eventId} className="history-entry">
                    <div>
                      <strong>{event.eventType.replace(/_/g, ' ')}</strong>
                      <p className="muted-text">
                        {formatDate(event.createdAt)} by {event.actor || 'system'}
                      </p>
                    </div>
                    {event.relatedBoxId ? (
                      <Link to={`/inventory/${encodeURIComponent(event.relatedBoxId)}`}>
                        {event.relatedBoxId}
                      </Link>
                    ) : null}
                    {event.note ? <p>{event.note}</p> : null}
                    <div className="film-order-history-change">
                      {renderChangedData(event.before)}
                      {renderChangedData(event.after)}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">No history has been recorded for this film order yet.</div>
            )}
          </section>
        </>
      ) : null}

      <ConfirmDialog
        open={manualFulfillOpen}
        title="Fulfill Film Order"
        message="Do you want to consider this film order fulfilled?"
        cancelLabel="No"
        confirmLabel="Yes"
        pending={manualFulfillMutation.isPending}
        pendingLabel="Fulfilling..."
        onCancel={() => setManualFulfillOpen(false)}
        onConfirm={() => void handleManualFulfillConfirm()}
      />
    </section>
  );
}
