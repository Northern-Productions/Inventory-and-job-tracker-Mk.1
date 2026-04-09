import type { AccessRequestEntry, FeatureAccessMap, FeatureArea } from '../../../../domain';

export type AccessRequestStatusFilter = '' | 'pending' | 'approved' | 'denied';

export function formatFeatureLabel(feature: FeatureArea) {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatRoleLabel(role: string) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') {
    return 'owner';
  }
  if (normalized === 'admin') {
    return 'admin';
  }
  if (normalized === 'member') {
    return 'regular';
  }
  return 'no membership';
}

export function getRolePillClassName(role: string) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'owner') {
    return 'access-role-pill access-role-pill-owner';
  }
  if (normalized === 'admin') {
    return 'access-role-pill access-role-pill-admin';
  }
  if (normalized === 'member') {
    return 'access-role-pill access-role-pill-regular';
  }
  return 'access-role-pill';
}

export function getRequestsSummary(statusFilter: AccessRequestStatusFilter) {
  if (statusFilter === 'pending') {
    return 'Pending requests stay in this queue until approved or denied.';
  }
  if (statusFilter === 'approved') {
    return 'Showing approved accounts.';
  }
  if (statusFilter === 'denied') {
    return 'Showing denied accounts.';
  }
  return 'Showing all access requests. If Create Account says "User already registered", the user is usually in Approved or Denied.';
}

export function sortAccessRequests(
  requests: AccessRequestEntry[],
  statusFilter: AccessRequestStatusFilter
) {
  const entries = [...requests];
  entries.sort((left, right) => {
    if (statusFilter === '') {
      const leftPending = left.status === 'pending';
      const rightPending = right.status === 'pending';
      if (leftPending !== rightPending) {
        return leftPending ? -1 : 1;
      }
    }

    const requestedCompare = parseRequestTimestamp(left.requestedAt) - parseRequestTimestamp(right.requestedAt);
    if (requestedCompare !== 0) {
      return requestedCompare;
    }

    return left.userId.localeCompare(right.userId);
  });

  return entries;
}

export function sanitizeMemberPermissionsForReadOnly(source: FeatureAccessMap): FeatureAccessMap {
  return {
    ...source,
    inventory: { read: Boolean(source.inventory?.read), write: false },
    allocations: { read: Boolean(source.allocations?.read), write: false },
    jobs: { read: Boolean(source.jobs?.read), write: false },
    film_orders: { read: Boolean(source.film_orders?.read), write: false },
    activity_history: { read: Boolean(source.activity_history?.read), write: false },
    reports: { read: Boolean(source.reports?.read), write: false },
    access_management: { read: false, write: false }
  };
}

function parseRequestTimestamp(value: string) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
