import { Link } from 'react-router-dom';
import type { FilmOrderEntry } from '../../../domain';
import { getFilmOrderDisplayStatus } from '../utils/filmOrders';

type FilmOrderStatusLinkProps = {
  order: Pick<FilmOrderEntry, 'filmOrderId' | 'status'> &
    Partial<Pick<FilmOrderEntry, 'displayStatus'>>;
  className?: string;
};

export function buildFilmOrderHref(order: Pick<FilmOrderEntry, 'filmOrderId'>) {
  return `/film-orders/${encodeURIComponent(order.filmOrderId)}`;
}

export function formatFilmOrderStatusPillLabel(status: string) {
  if (status === 'FULFILLED_COVERED') {
    return 'Fulfilled / Covered';
  }
  if (status === 'CANCELLED') {
    return 'Canceled';
  }

  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function FilmOrderStatusLink({ order, className = '' }: FilmOrderStatusLinkProps) {
  const displayStatus = getFilmOrderDisplayStatus(order);
  const label = formatFilmOrderStatusPillLabel(displayStatus);
  const classes = ['badge', `badge-${displayStatus}`, 'film-order-status-link', className]
    .filter(Boolean)
    .join(' ');

  return (
    <Link
      to={buildFilmOrderHref(order)}
      className={classes}
      aria-label={`Open film order ${order.filmOrderId} details`}
      title={`Open film order ${order.filmOrderId} details`}
    >
      {label}
    </Link>
  );
}
