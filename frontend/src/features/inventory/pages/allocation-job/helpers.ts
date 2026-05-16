import type { FilmOrderEntry, JobCaulkTransferAlert, JobDetail, JobFilmTransferAlert } from '../../../../domain';
import { formatDate, formatDateTime } from '../../../../lib/date';

export function renderDate(value: string) {
  return value ? formatDate(value) : '--';
}

export function renderDateTime(value: string) {
  return value ? formatDateTime(value) : '--';
}

export function formatBadgeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

export function formatAllocationFeet(allocatedFeet: number, coveredFeet: number, allocationKind: string) {
  if (allocationKind === 'EXTRA') {
    return 'EXTRA';
  }

  if (coveredFeet > 0 && coveredFeet !== allocatedFeet) {
    return `${allocatedFeet} physical / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
}

export function formatFilmOrderStatusLabel(value: string) {
  if (value === 'FILM_ON_THE_WAY') {
    return 'FILM ORDERED';
  }

  return formatBadgeLabel(value);
}

export function formatUsageTypeLabel(value: string) {
  return formatBadgeLabel(value);
}

export function formatUsageQuantity(quantity: number, unit: 'LF' | 'TUBES') {
  return `${quantity} ${unit}`;
}

export function buildFilmTransferCheckoutMessage(alert: JobFilmTransferAlert) {
  if (alert.state === 'TRANSFER_PENDING') {
    return `Box ${alert.boxId} is transferring from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}. Receive it there before checking it out for this job.`;
  }

  return `Box ${alert.boxId} must be transferred from ${alert.sourceWarehouse} to ${alert.destinationWarehouse} before it can be checked out for this job.`;
}

export function getFilmTransferBulkCheckoutMessage(alerts: JobFilmTransferAlert[]) {
  if (!alerts.length) {
    return '';
  }

  return 'Receive transferred film before checking out this job.';
}

export function getCaulkTransferBulkCheckoutMessage(alerts: JobCaulkTransferAlert[]) {
  if (!alerts.length) {
    return '';
  }

  return 'Receive transferred caulk before checking out this job.';
}

export function getMaterialTransferBulkCheckoutMessage(
  filmAlerts: JobFilmTransferAlert[],
  caulkAlerts: JobCaulkTransferAlert[]
) {
  if (filmAlerts.length > 0 && caulkAlerts.length > 0) {
    return 'Receive transferred film and caulk before checking out this job.';
  }
  if (filmAlerts.length > 0) {
    return getFilmTransferBulkCheckoutMessage(filmAlerts);
  }
  if (caulkAlerts.length > 0) {
    return getCaulkTransferBulkCheckoutMessage(caulkAlerts);
  }

  return '';
}

export function getOrderedReceiptBulkCheckoutMessage(
  detail: Pick<JobDetail, 'allocations'> | null | undefined
) {
  const hasOrderedRequirementAllocations = (detail?.allocations || []).some(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.allocationKind !== 'EXTRA' &&
      entry.allocatedFeet > 0 &&
      entry.boxStatus === 'ORDERED'
  );

  return hasOrderedRequirementAllocations
    ? 'Receive ordered film before checking out all materials for this job.'
    : '';
}

export function describeFilmTransferAlert(alert: JobFilmTransferAlert) {
  if (alert.state === 'TRANSFER_PENDING') {
    return `Transfer in progress from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}.`;
  }

  return `Send this box from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}.`;
}

export function formatFilmTransferStateLabel(alert: JobFilmTransferAlert) {
  return alert.state === 'TRANSFER_PENDING' ? 'Transfer Pending' : 'Needs Transfer';
}

export function describeCaulkTransferAlert(alert: JobCaulkTransferAlert) {
  if (alert.state === 'TRANSFER_PENDING' && alert.sourceWarehouse) {
    return `Transfer ${alert.pendingTubes} tube${alert.pendingTubes === 1 ? '' : 's'} from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}, then receive it before checkout.`;
  }

  if (alert.sourceWarehouse) {
    return `Send ${alert.pendingTubes} tube${alert.pendingTubes === 1 ? '' : 's'} from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}.`;
  }

  return `${alert.destinationWarehouse} still needs ${alert.pendingTubes} tube${alert.pendingTubes === 1 ? '' : 's'} transferred in before checkout.`;
}

export function formatCaulkTransferStateLabel(alert: JobCaulkTransferAlert) {
  return alert.state === 'TRANSFER_PENDING' ? 'Transfer Pending' : 'Needs Transfer';
}

export function buildAddBoxTarget(order: FilmOrderEntry) {
  const params = new URLSearchParams({
    filmOrderId: order.filmOrderId,
    jobNumber: order.jobNumber,
    warehouse: order.warehouse,
    manufacturer: order.manufacturer,
    filmName: order.filmName,
    width: String(order.widthIn),
    remainingToOrderFeet: String(Math.max(order.remainingToOrderFeet, 0)),
    notes: `Ordered for job ${order.jobNumber} via ${order.filmOrderId}`
  });
  const jobId = String(order.jobId || '').trim();
  if (jobId) {
    params.set('jobId', jobId);
  }

  return `/inventory/add?${params.toString()}`;
}
