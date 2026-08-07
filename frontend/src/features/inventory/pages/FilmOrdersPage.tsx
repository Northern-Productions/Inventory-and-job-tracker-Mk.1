import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { Select } from '../../../components/Select';
import {
  MobileActionStack,
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import type {
  CreateFilmOrderPayload,
  DeleteFilmOrderPayload,
  FilmOrderEntry
} from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { formatMutationWarningDescription } from '../../../lib/mutationWarnings';
import { useAuth } from '../../auth/AuthContext';
import { CreateFilmOrderDialog } from '../components/CreateFilmOrderDialog';
import { FilmOrderStatusLink } from '../components/FilmOrderStatusLink';
import { FilmOrderLinkedBoxes } from '../components/FilmOrderLinkedBoxes';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import { useDefaultWarehouse } from '../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import {
  useCreateFilmOrder,
  useDeleteFilmOrder,
  useFilmCatalog,
  useFilmOrders,
  usePendingDeleteFilmOrderIds
} from '../hooks/useInventoryQueries';
import {
  canOrderMoreFilmForFilmOrder,
  formatFilmOrderDealerLabel,
  getFilmOrderDisplayStatus,
  getFilmOrderRemainingFeet,
  getNextFilmOrderLinkedBoxToReceive,
  isFilmOrderNeedingAttention,
  isUnresolvedFilmOrder
} from '../utils/filmOrders';
import { getSafeWarehouseFilterValue } from '../utils/warehouseOptions';

function getFilmOrderJobId(order: Pick<FilmOrderEntry, 'jobId'>) {
  return String(order.jobId || '').trim();
}

function buildJobHref(order: Pick<FilmOrderEntry, 'jobId' | 'jobNumber'>) {
  const jobId = getFilmOrderJobId(order);
  return jobId
    ? `/allocations/jobs/${encodeURIComponent(jobId)}`
    : `/allocations/${encodeURIComponent(order.jobNumber)}`;
}

function buildDeleteFilmOrderPayload(order: FilmOrderEntry, reason: string): DeleteFilmOrderPayload {
  const jobId = getFilmOrderJobId(order);

  return {
    ...(jobId ? { jobId } : {}),
    filmOrderId: order.filmOrderId,
    jobNumber: order.jobNumber,
    reason: reason || `Deleted from Film Orders (${order.filmOrderId})`
  };
}

function compareDateAscending(left: string, right: string) {
  const normalizedLeft = String(left || '').trim();
  const normalizedRight = String(right || '').trim();

  if (normalizedLeft === normalizedRight) {
    return 0;
  }

  if (normalizedLeft && normalizedRight) {
    return normalizedLeft < normalizedRight ? -1 : 1;
  }

  if (normalizedLeft) {
    return -1;
  }

  if (normalizedRight) {
    return 1;
  }

  return 0;
}

function sortFilmOrders(entries: FilmOrderEntry[]) {
  return [...entries].sort((a, b) => {
    const aNeedsAttention = isFilmOrderNeedingAttention(a);
    const bNeedsAttention = isFilmOrderNeedingAttention(b);
    if (aNeedsAttention !== bNeedsAttention) {
      return aNeedsAttention ? -1 : 1;
    }

    const aOpen = isUnresolvedFilmOrder(a);
    const bOpen = isUnresolvedFilmOrder(b);

    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }

    if (aNeedsAttention && bNeedsAttention) {
      const installDateOrder = compareDateAscending(a.installDate, b.installDate);
      if (installDateOrder !== 0) {
        return installDateOrder;
      }
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
    remainingToOrderFeet: String(getFilmOrderRemainingFeet(order)),
    notes: `Ordered for job ${order.jobNumber} via ${order.filmOrderId}`
  });
  const jobId = getFilmOrderJobId(order);
  if (jobId) {
    params.set('jobId', jobId);
  }
  const workScope = String(order.workScope ?? '').trim();
  if (workScope) {
    params.set('workScope', workScope);
  }
  const sections = String(order.sections ?? '').trim();
  if (sections) {
    params.set('sections', sections);
  }

  return `/inventory/add?${params.toString()}`;
}

function buildReceiveOrderedTarget(order: FilmOrderEntry) {
  const nextLinkedBox = getNextFilmOrderLinkedBoxToReceive(order);
  if (!nextLinkedBox) {
    return '';
  }

  const params = new URLSearchParams({
    filmOrderId: order.filmOrderId,
    receiveOrdered: '1',
    returnTo: 'film-orders'
  });

  return `/inventory/${encodeURIComponent(nextLinkedBox.boxId)}?${params.toString()}`;
}

const FILM_ORDER_STATUS_FILTER_OPTIONS = [
  { label: 'All statuses', value: 'all' },
  { label: 'Film Order', value: 'FILM_ORDER' },
  { label: 'Incomplete', value: 'INCOMPLETE' },
  { label: 'Needs Receiving', value: 'FILM_ON_THE_WAY' },
  { label: 'Fulfilled / Covered', value: 'FULFILLED_COVERED' },
  { label: 'Manually Fulfilled', value: 'MANUALLY_FULFILLED' },
  { label: 'Canceled', value: 'CANCELLED' },
  { label: 'No Longer Needed', value: 'NO_LONGER_NEEDED' }
] as const;

type FilmOrderStatusFilter = (typeof FILM_ORDER_STATUS_FILTER_OPTIONS)[number]['value'];

const DEFAULT_FILM_ORDER_STATUS_FILTER: FilmOrderStatusFilter = 'FILM_ORDER';

function parseFilmOrderStatusFilter(value: string | null): FilmOrderStatusFilter {
  if (value === 'FULFILLED') {
    return 'FULFILLED_COVERED';
  }

  if (FILM_ORDER_STATUS_FILTER_OPTIONS.some((option) => option.value === value)) {
    return value as FilmOrderStatusFilter;
  }

  return DEFAULT_FILM_ORDER_STATUS_FILTER;
}

export default function FilmOrdersPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseScopeReady = warehouseRegistry.scopeReady !== false;
  const [warehouseFilter, setWarehouseFilter] = useState(defaultWarehouse);
  const [statusFilter, setStatusFilter] = useState<FilmOrderStatusFilter>(() =>
    parseFilmOrderStatusFilter(searchParams.get('status'))
  );
  const safeWarehouseFilter = warehouseScopeReady
    ? getSafeWarehouseFilterValue(warehouseRegistry.entries, warehouseFilter)
    : '';
  const filmOrdersQuery = useFilmOrders({ warehouse: safeWarehouseFilter });
  const filmCatalogQuery = useFilmCatalog();
  const createFilmOrderMutation = useCreateFilmOrder();
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const pendingDeleteFilmOrderIds = usePendingDeleteFilmOrderIds();
  const [isCreateFilmOrderOpen, setIsCreateFilmOrderOpen] = useState(false);
  const [filmOrderToDelete, setFilmOrderToDelete] = useState<FilmOrderEntry | null>(null);

  const filteredEntries = useMemo(
    () =>
      statusFilter === 'all'
        ? filmOrdersQuery.data || []
        : (filmOrdersQuery.data || []).filter((order) =>
            statusFilter === 'FILM_ON_THE_WAY'
              ? order.status === 'FILM_ON_THE_WAY'
              : getFilmOrderDisplayStatus(order) === statusFilter
          ),
    [filmOrdersQuery.data, statusFilter]
  );
  const orderedEntries = useMemo(
    () => sortFilmOrders(filteredEntries),
    [filteredEntries]
  );
  const showFilmOrdersLoading = filmOrdersQuery.isLoading && !orderedEntries.length;

  useEffect(() => {
    if (!warehouseScopeReady || !warehouseFilter || warehouseFilter === safeWarehouseFilter) {
      return;
    }
    setWarehouseFilter(safeWarehouseFilter);
  }, [safeWarehouseFilter, warehouseFilter, warehouseScopeReady]);

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
      const { warnings } = await deleteFilmOrderMutation.mutateAsync(
        buildDeleteFilmOrderPayload(order, reason)
      );
      toast.push({
        title: `Deleted ${order.filmOrderId}`,
        description: formatMutationWarningDescription(
          warnings,
          'The film order was removed.',
          'delete-film-order'
        ),
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

  async function handleCreateFilmOrder(payload: CreateFilmOrderPayload) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating film orders.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a film order.',
        variant: 'error'
      });
      return;
    }

    try {
      setIsCreateFilmOrderOpen(false);
      const { result } = await createFilmOrderMutation.mutateAsync(payload);
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
          Shortages that still need ordering stay at the top. Use FILM ORDERED to add an incoming
          box tied to the job, or RECEIVE to walk in boxes that are already on the way.
        </p>
        <p className="muted-text">
          Film orders are created from explicit order actions in Film Orders before incoming boxes
          are added or received for the job.
        </p>
        <div className="toolbar-grid reports-filters film-orders-filters">
          <WarehouseSelectField
            value={safeWarehouseFilter}
            onChange={setWarehouseFilter}
            allowAll
          />
          <Select
            label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as FilmOrderStatusFilter)}
            options={FILM_ORDER_STATUS_FILTER_OPTIONS}
          />
        </div>
        <DeferredLoadingState when={showFilmOrdersLoading} label="Loading film orders..." />
        {filmOrdersQuery.isError ? <p className="error-text">{filmOrdersQuery.error.message}</p> : null}
        {!showFilmOrdersLoading && !filmOrdersQuery.isError && !orderedEntries.length ? (
          <div className="empty-state">No film order alerts have been created yet.</div>
        ) : null}
        {orderedEntries.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {orderedEntries.map((order) => {
                const isDeletePending = pendingDeleteFilmOrderIds.has(
                  order.filmOrderId.trim().toUpperCase()
                );
                const displayJobLabel = formatJobDisplayLabel(order);
                const receiveTarget = buildReceiveOrderedTarget(order);
                const isReceiveAction = order.status === 'FILM_ON_THE_WAY';
                const canOrderMoreFilm = canOrderMoreFilmForFilmOrder(order);
                const actionLabel = isReceiveAction ? 'RECEIVE' : 'FILM ORDERED';

                return (
                  <MobileRecordCard key={order.filmOrderId}>
                    <MobileRecordHeader
                      title={`${order.manufacturer} ${order.filmName}`}
                      subtitle={
                        <Link
                          to={buildJobHref(order)}
                          className="film-orders-job-link film-orders-job-link-mobile"
                        >
                          Job {displayJobLabel}
                        </Link>
                      }
                      badge={
                        <FilmOrderStatusLink order={order} />
                      }
                    />
                    <MobileFieldList>
                      <MobileField label="Warehouse" value={order.warehouse} />
                      <MobileField label="Film" value={`${order.manufacturer} ${order.filmName}`} />
                      <MobileField label="Width" value={order.widthIn} />
                      <MobileField label="Remaining LF" value={getFilmOrderRemainingFeet(order)} />
                      <MobileField label="Ordered Box ID" value={<FilmOrderLinkedBoxes order={order} />} />
                      <MobileField label="Install Date" value={formatDate(order.installDate)} />
                      <MobileField label="Created" value={formatDate(order.createdAt)} />
                      <MobileField label="Dealer" value={formatFilmOrderDealerLabel(order)} />
                    </MobileFieldList>
                    <MobileActionStack>
                      {isReceiveAction || canOrderMoreFilm ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            navigate(isReceiveAction ? receiveTarget : buildAddBoxTarget(order))
                          }
                          disabled={isReceiveAction && !receiveTarget}
                        >
                          {actionLabel}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setFilmOrderToDelete(order)}
                        disabled={isDeletePending}
                      >
                        Delete
                      </Button>
                    </MobileActionStack>
                  </MobileRecordCard>
                );
              })}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="film-orders-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Warehouse</th>
                    <th>Job ID</th>
                    <th>Film</th>
                    <th>Width</th>
                    <th>Remaining LF</th>
                    <th className="col-ordered-box-id">Ordered Box ID</th>
                    <th>Install Date</th>
                    <th>Created</th>
                    <th>Dealer</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedEntries.map((order) => {
                    const isDeletePending = pendingDeleteFilmOrderIds.has(
                      order.filmOrderId.trim().toUpperCase()
                    );
                    const displayJobLabel = formatJobDisplayLabel(order);
                    const receiveTarget = buildReceiveOrderedTarget(order);
                    const isReceiveAction = order.status === 'FILM_ON_THE_WAY';
                    const canOrderMoreFilm = canOrderMoreFilmForFilmOrder(order);
                    const actionLabel = isReceiveAction ? 'RECEIVE' : 'FILM ORDERED';

                    return (
                      <tr key={order.filmOrderId}>
                        <td>
                          <FilmOrderStatusLink order={order} />
                        </td>
                        <td>
                          {order.warehouse}
                        </td>
                        <td>
                          <Link to={buildJobHref(order)} className="film-orders-job-link">
                            {displayJobLabel}
                          </Link>
                        </td>
                        <td>
                          {order.manufacturer} {order.filmName}
                        </td>
                        <td>{order.widthIn}</td>
                        <td>{getFilmOrderRemainingFeet(order)}</td>
                        <td className="col-ordered-box-id">
                          <FilmOrderLinkedBoxes order={order} />
                        </td>
                        <td>{formatDate(order.installDate)}</td>
                        <td>{formatDate(order.createdAt)}</td>
                        <td>{formatFilmOrderDealerLabel(order)}</td>
                        <td>
                          <div className="film-order-actions">
                            {isReceiveAction || canOrderMoreFilm ? (
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() =>
                                  navigate(isReceiveAction ? receiveTarget : buildAddBoxTarget(order))
                                }
                                disabled={isReceiveAction && !receiveTarget}
                              >
                                {actionLabel}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setFilmOrderToDelete(order)}
                              disabled={isDeletePending}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : null}
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

      <CreateFilmOrderDialog
        open={isCreateFilmOrderOpen}
        submitting={createFilmOrderMutation.isPending}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        onCancel={() => setIsCreateFilmOrderOpen(false)}
        onSubmit={(payload) => void handleCreateFilmOrder(payload)}
      />
    </>
  );
}
