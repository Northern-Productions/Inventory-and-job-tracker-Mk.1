import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { FilmOrderEntry } from '../../../../domain';
import { FilmOrderStatusLink } from '../../components/FilmOrderStatusLink';
import { FilmOrderLinkedBoxes } from '../../components/FilmOrderLinkedBoxes';

interface RelatedFilmOrdersSectionProps {
  orders: FilmOrderEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  pendingDeleteFilmOrderIds: Set<string>;
  onOrderFilm: (order: FilmOrderEntry) => void;
  onDeleteOrder: (order: FilmOrderEntry) => void;
}

function renderFilmOrderActions({
  order,
  isReadOnlyJob,
  pendingDeleteFilmOrderIds,
  onOrderFilm,
  onDeleteOrder
}: {
  order: FilmOrderEntry;
  isReadOnlyJob: boolean;
  pendingDeleteFilmOrderIds: Set<string>;
  onOrderFilm: (order: FilmOrderEntry) => void;
  onDeleteOrder: (order: FilmOrderEntry) => void;
}) {
  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  return (
    <>
      {order.status === 'FULFILLED' ? null : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onOrderFilm(order)}
          disabled={order.status !== 'FILM_ORDER'}
        >
          Order Film
        </Button>
      )}
      {order.status === 'FILM_ORDER' ? (
        <Button
          type="button"
          variant="danger"
          onClick={() => onDeleteOrder(order)}
          disabled={pendingDeleteFilmOrderIds.has(order.filmOrderId.trim().toUpperCase())}
        >
          Cancel
        </Button>
      ) : null}
    </>
  );
}

export function RelatedFilmOrdersSection({
  orders,
  isPhoneLayout,
  isReadOnlyJob,
  pendingDeleteFilmOrderIds,
  onOrderFilm,
  onDeleteOrder
}: RelatedFilmOrdersSectionProps) {
  return (
    <section className="panel panel-subtle">
      <div className="panel-title-row">
        <h2>Related Film Orders</h2>
      </div>
      <p className="muted-text">
        Film orders are created only from explicit order actions. Cancel an unresolved order before
        creating another for the same film requirement.
      </p>
      {!orders.length ? (
        <div className="empty-state">No film orders were created for this job.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {orders.map((order) => (
            <MobileRecordCard key={order.filmOrderId}>
              <MobileRecordHeader
                title={`${order.manufacturer} ${order.filmName}`}
                subtitle={`${order.widthIn}" / ${order.requestedFeet} LF requested`}
                badge={<FilmOrderStatusLink order={order} />}
              />
              <MobileFieldList>
                <MobileField label="Ordered Box IDs" value={<FilmOrderLinkedBoxes order={order} />} />
                <MobileField label="Width" value={order.widthIn} />
                <MobileField label="Requested LF" value={order.requestedFeet} />
                <MobileField label="Covered LF" value={order.coveredFeet} />
                <MobileField label="On The Way LF" value={order.orderedFeet} />
                <MobileField label="Still Short LF" value={order.remainingToOrderFeet} />
              </MobileFieldList>
              <div className="film-order-actions">
                {renderFilmOrderActions({
                  order,
                  isReadOnlyJob,
                  pendingDeleteFilmOrderIds,
                  onOrderFilm,
                  onDeleteOrder
                })}
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
                <th>Ordered Box IDs</th>
                <th>Width</th>
                <th>Requested</th>
                <th>Covered</th>
                <th>On The Way</th>
                <th>Still Short</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.filmOrderId}>
                  <td>
                    <FilmOrderStatusLink order={order} />
                  </td>
                  <td>
                    {order.manufacturer} {order.filmName}
                  </td>
                  <td>
                    <FilmOrderLinkedBoxes order={order} />
                  </td>
                  <td>{order.widthIn}</td>
                  <td>{order.requestedFeet}</td>
                  <td>{order.coveredFeet}</td>
                  <td>{order.orderedFeet}</td>
                  <td>{order.remainingToOrderFeet}</td>
                  <td>
                    <div className="film-order-actions">
                      {renderFilmOrderActions({
                        order,
                        isReadOnlyJob,
                        pendingDeleteFilmOrderIds,
                        onOrderFilm,
                        onDeleteOrder
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
