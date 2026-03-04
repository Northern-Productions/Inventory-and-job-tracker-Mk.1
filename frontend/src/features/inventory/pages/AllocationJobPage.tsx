import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { LoadingState } from '../../../components/LoadingState';
import type { FilmOrderEntry } from '../../../domain';
import { formatDate, formatDateTime } from '../../../lib/date';
import { useAllocationJob } from '../hooks/useInventoryQueries';

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
  const params = useParams();
  const jobNumber = decodeURIComponent(params.jobNumber || '');
  const jobQuery = useAllocationJob(jobNumber);

  if (jobQuery.isLoading) {
    return <LoadingState label="Loading job details..." />;
  }

  if (jobQuery.isError || !jobQuery.data) {
    return (
      <section className="panel">
        <p className="error-text">{jobQuery.error?.message || 'Job not found.'}</p>
        <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
          Back to Allocations
        </Button>
      </section>
    );
  }

  const { summary, allocations, filmOrders } = jobQuery.data;

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>JOB ID {summary.jobNumber}</h2>
            <p className="muted-text">Job allocation detail</p>
          </div>
          <div className="detail-actions">
            <span className={`badge badge-${summary.status}`}>{formatBadgeLabel(summary.status)}</span>
            <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
              Back
            </Button>
          </div>
        </div>
        <div className="stat-grid allocation-stat-grid">
          <div className="key-value">
            <dt>Due Date</dt>
            <dd>{renderDate(summary.jobDate)}</dd>
          </div>
          <div className="key-value">
            <dt>Crew Leader</dt>
            <dd>{summary.crewLeader || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Active LF</dt>
            <dd>{summary.activeAllocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Checked Out LF</dt>
            <dd>{summary.fulfilledAllocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Open Film Orders</dt>
            <dd>{summary.openFilmOrderCount}</dd>
          </div>
          <div className="key-value">
            <dt>Boxes</dt>
            <dd>{summary.boxCount}</dd>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Allocated Boxes</h2>
        </div>
        {!allocations.length ? (
          <div className="empty-state">No box allocations are tied to this job yet.</div>
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
                        onClick={() =>
                          navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)
                        }
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
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Film Order</th>
                  <th>Status</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Requested</th>
                  <th>Covered</th>
                  <th>On The Way</th>
                  <th>Still Short</th>
                  <th>Linked Boxes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filmOrders.map((order) => (
                  <tr key={order.filmOrderId}>
                    <td>{order.filmOrderId}</td>
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
                    <td>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
