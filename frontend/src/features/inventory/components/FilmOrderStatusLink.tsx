import { Link } from 'react-router-dom';
import type { FilmOrderEntry } from '../../../domain';

type FilmOrderStatusLinkProps = {
  order: Pick<FilmOrderEntry, 'filmOrderId' | 'status'>;
  className?: string;
};

export function buildFilmOrderHref(order: Pick<FilmOrderEntry, 'filmOrderId'>) {
  return `/film-orders/${encodeURIComponent(order.filmOrderId)}`;
}

export function formatFilmOrderStatusPillLabel(status: string) {
  if (status === 'CANCELLED') {
    return 'Canceled';
  }

  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function FilmOrderStatusLink({ order, className = '' }: FilmOrderStatusLinkProps) {
  const label = formatFilmOrderStatusPillLabel(order.status);
  const classes = ['badge', `badge-${order.status}`, 'film-order-status-link', className]
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
