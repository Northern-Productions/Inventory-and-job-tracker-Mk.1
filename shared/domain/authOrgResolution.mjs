// Purpose: Pick a safe organization context for authenticated users.

function trim(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  const normalized = trim(value).toLowerCase();
  if (normalized === 'approved' || normalized === 'pending' || normalized === 'denied') {
    return normalized;
  }
  return '';
}

function normalizeMembership(entry) {
  const orgId = trim(entry?.orgId || entry?.org_id);
  if (!orgId) {
    return null;
  }
  return {
    orgId,
    role: trim(entry?.role).toLowerCase(),
    createdAt: trim(entry?.createdAt || entry?.created_at),
  };
}

function normalizeAccessRequest(entry) {
  const orgId = trim(entry?.orgId || entry?.org_id);
  const status = normalizeStatus(entry?.status);
  if (!orgId || !status) {
    return null;
  }
  return {
    orgId,
    status,
    requestedAt: trim(entry?.requestedAt || entry?.requested_at),
  };
}

function sortByCreatedAtThenOrgId(a, b) {
  const created = trim(a.createdAt).localeCompare(trim(b.createdAt));
  if (created !== 0) {
    return created;
  }
  return trim(a.orgId).localeCompare(trim(b.orgId));
}

function sortByRequestedAtThenOrgId(a, b) {
  const requested = trim(a.requestedAt).localeCompare(trim(b.requestedAt));
  if (requested !== 0) {
    return requested;
  }
  return trim(a.orgId).localeCompare(trim(b.orgId));
}

export function createDeniedFeaturePermissions() {
  return {
    inventory: { read: false, write: false },
    allocations: { read: false, write: false },
    jobs: { read: false, write: false },
    film_orders: { read: false, write: false },
    activity_history: { read: false, write: false },
    reports: { read: false, write: false },
    access_management: { read: false, write: false },
  };
}

export function resolvePilotOrgAccess({
  defaultOrgId = '',
  memberships = [],
  accessRequests = [],
} = {}) {
  const normalizedDefaultOrgId = trim(defaultOrgId);
  const approvedMemberships = (Array.isArray(memberships) ? memberships : [])
    .map(normalizeMembership)
    .filter(Boolean)
    .sort(sortByCreatedAtThenOrgId);
  const requests = (Array.isArray(accessRequests) ? accessRequests : [])
    .map(normalizeAccessRequest)
    .filter(Boolean)
    .sort(sortByRequestedAtThenOrgId);

  const defaultMembership = normalizedDefaultOrgId
    ? approvedMemberships.find((entry) => entry.orgId === normalizedDefaultOrgId)
    : null;
  if (defaultMembership) {
    return {
      kind: 'approved',
      orgId: normalizedDefaultOrgId,
      reason: 'default-org-approved-membership',
    };
  }

  if (approvedMemberships.length === 1) {
    return {
      kind: 'approved',
      orgId: approvedMemberships[0].orgId,
      reason: 'single-approved-membership',
    };
  }

  if (approvedMemberships.length > 1) {
    return {
      kind: 'org_selection_required',
      orgId: '',
      reason: 'multiple-approved-memberships',
      candidateOrgIds: approvedMemberships.map((entry) => entry.orgId),
    };
  }

  const pendingRequests = requests.filter((entry) => entry.status === 'pending');
  const defaultPendingRequest = normalizedDefaultOrgId
    ? pendingRequests.find((entry) => entry.orgId === normalizedDefaultOrgId)
    : null;
  if (defaultPendingRequest) {
    return {
      kind: 'pending',
      orgId: normalizedDefaultOrgId,
      reason: 'default-org-pending-request',
    };
  }

  if (pendingRequests.length === 1) {
    return {
      kind: 'pending',
      orgId: pendingRequests[0].orgId,
      reason: 'single-pending-request',
    };
  }

  if (pendingRequests.length > 1) {
    return {
      kind: 'org_selection_required',
      orgId: '',
      reason: 'multiple-pending-requests',
      candidateOrgIds: pendingRequests.map((entry) => entry.orgId),
    };
  }

  const deniedRequests = requests.filter((entry) => entry.status === 'denied');
  const defaultDeniedRequest = normalizedDefaultOrgId
    ? deniedRequests.find((entry) => entry.orgId === normalizedDefaultOrgId)
    : null;
  if (defaultDeniedRequest) {
    return {
      kind: 'denied',
      orgId: normalizedDefaultOrgId,
      reason: 'default-org-denied-request',
    };
  }

  if (deniedRequests.length === 1) {
    return {
      kind: 'denied',
      orgId: deniedRequests[0].orgId,
      reason: 'single-denied-request',
    };
  }

  return {
    kind: 'no_access',
    orgId: '',
    reason: 'no-approved-membership-or-access-request',
  };
}

export function buildSafeAccessContext({
  identity,
  decision,
  actor = '',
} = {}) {
  const statusByKind = {
    pending: 'pending',
    denied: 'denied',
    org_selection_required: 'org_selection_required',
    no_access: 'no_access',
  };
  const status = statusByKind[decision?.kind] || 'no_access';
  return {
    ...(identity || {}),
    orgId: trim(decision?.orgId),
    actor: trim(actor),
    role: '',
    accessStatus: status,
    permissions: createDeniedFeaturePermissions(),
    isAdminConsoleAllowed: false,
    pendingCount: 0,
    receivesInAppNotifications: false,
    defaultWarehouse: '',
    pendingRequestCreated: false,
    accessResolutionReason: trim(decision?.reason),
  };
}
