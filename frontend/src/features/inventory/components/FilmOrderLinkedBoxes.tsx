import { Link } from 'react-router-dom';
import type { FilmOrderEntry } from '../../../domain';
import {
  FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL,
  getFilmOrderLinkedBoxes
} from '../utils/filmOrders';

interface FilmOrderLinkedBoxesProps {
  order: Partial<Pick<FilmOrderEntry, 'linkedBoxes'>> | null | undefined;
  emptyLabel?: string;
}

export function FilmOrderLinkedBoxes({
  order,
  emptyLabel = FILM_ORDER_LINKED_BOX_IDS_EMPTY_LABEL
}: FilmOrderLinkedBoxesProps) {
  const linkedBoxes = getFilmOrderLinkedBoxes(order);

  if (!linkedBoxes.length) {
    return <span className="muted-text">{emptyLabel}</span>;
  }

  return (
    <div className="film-order-linked-boxes">
      {linkedBoxes.map((linkedBox) => (
        <div key={linkedBox.boxId} className="film-order-linked-box-entry">
          <Link
            to={`/inventory/${encodeURIComponent(linkedBox.boxId)}`}
            className="film-order-linked-box-link"
          >
            {linkedBox.boxId}
          </Link>
          {linkedBox.isDirectToJobSite ? (
            <span
              className="film-order-linked-box-tag"
              aria-label={`Direct to site ${linkedBox.boxId}`}
              title="Shipped directly to job site"
            >
              Direct to site
            </span>
          ) : null}
          {linkedBox.isReceived ? (
            <span
              className="film-order-linked-box-status"
              aria-label={`Received ${linkedBox.boxId}`}
              title="Received"
            >
              {'\u2713'}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
