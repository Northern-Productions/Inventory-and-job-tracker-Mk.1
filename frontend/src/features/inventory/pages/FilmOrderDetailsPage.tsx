import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { useToast } from '../../../components/Toast';
import type { FilmOrderDetail, FilmOrderDetailLinkedBox, FilmOrderDisplayStatus } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { safeDecodePathParam } from '../../../lib/url';
import { useAuth } from '../../auth/AuthContext';
import { CorrectFilmOrderReceiptDialog } from '../components/CorrectFilmOrderReceiptDialog';
import { useFilmOrderDetail } from '../hooks/useInventoryQueries';
import {
  useCorrectFilmOrderReceipt,
  useManualFulfillFilmOrder
} from '../hooks/mutations/planning/filmOrderMutations';
import { canManuallyFulfillFilmOrder, formatFilmOrderDealerLabel } from '../utils/filmOrders';

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

const USD_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatInitialCost(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? USD_CURRENCY_FORMATTER.format(value) : '--';
}

function renderChangedData(value: Record<string, unknown> | null | undefined) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const boxId = String(value.boxId || '').trim();
  const initialFeet = Number(value.initialFeet);
  const status = String(value.status || '').trim();
  const receiptContributionFeet = Number(value.receiptContributionFeet);
  const receivedFeet = Number(value.receivedFeet);
  const parts = [
    boxId ? `Box ${boxId}` : '',
    Number.isFinite(receiptContributionFeet) ? `Receipt ${receiptContributionFeet} LF` : '',
    Number.isFinite(receivedFeet) ? `${receivedFeet} credited LF` : '',
    Number.isFinite(initialFeet) ? `${initialFeet} LF` : '',
    status
  ].filter(Boolean);

  return parts.length ? <span className="muted-text">{parts.join(' / ')}</span> : null;
}

export default function FilmOrderDetailsPage() {
  const params = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const filmOrderId = safeDecodePathParam(params.filmOrderId);
  const detailQuery = useFilmOrderDetail(filmOrderId);
  const manualFulfillMutation = useManualFulfillFilmOrder();
  const correctReceiptMutation = useCorrectFilmOrderReceipt();
  const [manualFulfillOpen, setManualFulfillOpen] = useState(false);
  const [receiptToCorrect, setReceiptToCorrect] = useState<FilmOrderDetailLinkedBox | null>(null);
  const order = detailQuery.data;
  const linkedBoxCostSummary = (order?.linkedBoxes || []).reduce(
    (summary, linkedBox) => {
      const purchaseCost = linkedBox.initialCost;
      if (typeof purchaseCost === 'number' && Number.isFinite(purchaseCost)) {
        summary.total += purchaseCost;
        summary.knownCount += 1;
      } else {
        summary.missingCount += 1;
      }
      return summary;
    },
    { total: 0, knownCount: 0, missingCount: 0 }
  );

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

  async function handleReceiptCorrection(correctedReceivedFeet: number, reason: string) {
    if (!order || !receiptToCorrect?.linkId) {
      return;
    }

    try {
      await correctReceiptMutation.mutateAsync({
        filmOrderId: order.filmOrderId,
        jobId: order.jobId,
        jobNumber: order.jobNumber,
        linkId: receiptToCorrect.linkId,
        boxId: receiptToCorrect.boxId,
        correctedReceivedFeet,
        reason
      });
      setReceiptToCorrect(null);
      toast.push({
        title: 'Received LF corrected',
        description: `${receiptToCorrect.boxId} now contributes ${correctedReceivedFeet} LF to this Film Order.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to correct Received LF',
        description: error instanceof Error ? error.message : 'The receipt history could not be corrected.',
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
          {order && canManuallyFulfillFilmOrder(order) ? (
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
              <span className="detail-label">Requested LF</span>
              <strong>{order.requestedFeet}</strong>
              <span className="muted-text">Historical order amount</span>
            </div>
            <div>
              <span className="detail-label">Ordered / Linked LF</span>
              <strong>{order.linkedFeet}</strong>
            </div>
            <div>
              <span className="detail-label">On The Way LF</span>
              <strong>{order.onTheWayFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Received LF</span>
              <strong>{order.receivedFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Covered / Allocated LF</span>
              <strong>{order.coveredFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Remaining To Order</span>
              <strong>{order.remainingToOrderFeet}</strong>
            </div>
            <div>
              <span className="detail-label">Order Overage</span>
              <strong>{order.orderOverageFeet}</strong>
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

          {order.receiptHistoryComplete === false ? (
            <div className="notice-card">
              Historical receipt evidence is incomplete for {order.receiptHistoryMissingCount || 1} linked
              box{order.receiptHistoryMissingCount === 1 ? '' : 'es'}. Current inventory LF is not being used as a substitute.
            </div>
          ) : null}

          <section className="detail-subsection">
            <h3>Current Requirement</h3>
            {order.currentRequirement?.availability === 'CURRENT' ? (
              <div className="metric-grid film-order-detail-metrics">
                <div>
                  <span className="detail-label">Required LF</span>
                  <strong>{order.currentRequirement.requiredFeet}</strong>
                </div>
                <div>
                  <span className="detail-label">Allocated LF</span>
                  <strong>{order.currentRequirement.allocatedFeet}</strong>
                </div>
                <div>
                  <span className="detail-label">On The Way LF</span>
                  <strong>{order.currentRequirement.onTheWayFeet}</strong>
                </div>
                <div>
                  <span className="detail-label">Still Short LF</span>
                  <strong>{order.currentRequirement.stillShortFeet}</strong>
                </div>
              </div>
            ) : (
              <div className="notice-card">
                Current requirement context is unavailable for this historical order. The order ledger
                and its fulfillment or cancellation history remain unchanged.
              </div>
            )}
          </section>

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
                      <th>Live Initial LF</th>
                      <th>Recorded Receipt LF</th>
                      <th>Credited LF (Order Width)</th>
                      <th>Receipt</th>
                      <th>Initial Cost</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.linkedBoxes.map((box) => {
                      return (
                        <tr key={box.boxId}>
                          <td>
                            <Link to={`/inventory/${encodeURIComponent(box.boxId)}`}>{box.boxId}</Link>
                          </td>
                          <td>{box.status}</td>
                          <td>{box.initialFeet}</td>
                          <td>{box.receiptContributionFeet ?? '--'}</td>
                          <td>{box.linkedFeet ?? box.orderedFeet}</td>
                          <td>
                            {box.receiptFinalizedAt
                              ? formatDate(box.receiptFinalizedAt)
                              : box.receiptHistoryStatus === 'MISSING'
                                ? 'History unavailable'
                                : 'Not received'}
                          </td>
                          <td>{formatInitialCost(box.initialCost)}</td>
                          <td>
                            {auth.hasFeatureAccess('film_orders', 'write') &&
                            box.linkId &&
                            box.receiptHistoryStatus === 'FINALIZED' ? (
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => setReceiptToCorrect(box)}
                              >
                                Correct Received LF
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={7}>
                        Total Initial Cost
                      </th>
                      <td>
                        {linkedBoxCostSummary.knownCount > 0
                          ? formatInitialCost(linkedBoxCostSummary.total)
                          : '--'}
                        {linkedBoxCostSummary.missingCount > 0 ? (
                          <span className="muted-text">
                            {' '}
                            ({linkedBoxCostSummary.missingCount} missing)
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  </tfoot>
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
      <CorrectFilmOrderReceiptDialog
        open={Boolean(receiptToCorrect)}
        filmOrderId={order?.filmOrderId || filmOrderId}
        receipt={receiptToCorrect}
        pending={correctReceiptMutation.isPending}
        onCancel={() => setReceiptToCorrect(null)}
        onConfirm={handleReceiptCorrection}
      />
    </section>
  );
}
