export const LIST_ROUTE_KINDS = {
  INVENTORY: 'INVENTORY_LIST',
  JOBS_LIST: 'JOBS_LIST',
  JOBS_CALENDAR: 'JOBS_CALENDAR'
} as const;

export type ListRouteKind = (typeof LIST_ROUTE_KINDS)[keyof typeof LIST_ROUTE_KINDS];

export interface NavigationScope {
  marker: string;
  fingerprint: string;
}

export interface ListPositionRecord {
  kind: ListRouteKind;
  locationKey: string;
  scrollY: number;
  anchorToken: string;
  anchorOffset: number;
  returnPending: boolean;
  updatedAt: number;
}

export interface DetailNavigationState {
  __listReturn: {
    version: 1;
    kind: ListRouteKind;
    locationKey: string;
    marker: string;
    fingerprint: string;
    createdAt: number;
  };
}

interface StoredNavigationState {
  version: 1;
  marker: string;
  fingerprint: string;
  records: Record<string, ListPositionRecord>;
}

const STORAGE_KEY = 'window-film:list-navigation:v1';
const MAX_RECORDS = 60;
const RECORD_TTL_MS = 8 * 60 * 60 * 1000;

function randomToken() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function opaqueHash(value: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }

  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function isListRouteKind(value: unknown): value is ListRouteKind {
  return Object.values(LIST_ROUTE_KINDS).includes(value as ListRouteKind);
}

function readStoredState(): StoredNavigationState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null') as
      | StoredNavigationState
      | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.marker !== 'string' ||
      typeof parsed.fingerprint !== 'string' ||
      !parsed.records ||
      typeof parsed.records !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredState(state: StoredNavigationState) {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function pruneRecords(records: Record<string, ListPositionRecord>, now = Date.now()) {
  const validEntries = Object.entries(records)
    .filter(([, record]) => {
      return (
        record &&
        isListRouteKind(record.kind) &&
        typeof record.locationKey === 'string' &&
        Number.isFinite(record.updatedAt) &&
        now - record.updatedAt <= RECORD_TTL_MS
      );
    })
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_RECORDS);

  return Object.fromEntries(validEntries);
}

function recordKey(kind: ListRouteKind, locationKey: string) {
  return `${kind}:${locationKey}`;
}

function stateForScope(
  scope: NavigationScope,
  initializeForScope = false
): StoredNavigationState | null {
  const stored = readStoredState();
  if (
    stored &&
    stored.marker === scope.marker &&
    stored.fingerprint === scope.fingerprint
  ) {
    return {
      ...stored,
      records: pruneRecords(stored.records)
    };
  }

  if (!initializeForScope) {
    return null;
  }

  const next: StoredNavigationState = {
    version: 1,
    marker: scope.marker,
    fingerprint: scope.fingerprint,
    records: {}
  };

  return writeStoredState(next) ? next : null;
}

export function getNavigationScope(
  userId: string | null | undefined,
  organizationId: string | null | undefined
): NavigationScope | null {
  const normalizedUserId = String(userId || '').trim();
  const normalizedOrganizationId = String(organizationId || '').trim();
  if (!normalizedUserId || !normalizedOrganizationId || typeof window === 'undefined') {
    return null;
  }

  const stored = readStoredState();
  const marker = stored?.marker || randomToken();
  const fingerprint = opaqueHash(
    `${marker}\u001f${normalizedUserId}\u001f${normalizedOrganizationId}`
  );
  const scope = { marker, fingerprint };

  return stateForScope(scope, true) ? scope : null;
}

export function createAnchorToken(scope: NavigationScope | null, identity: string) {
  if (!scope) {
    return '';
  }
  return opaqueHash(`${scope.marker}\u001f${scope.fingerprint}\u001f${identity}`);
}

export function saveListPosition(
  scope: NavigationScope | null,
  kind: ListRouteKind,
  locationKey: string,
  position: Pick<ListPositionRecord, 'scrollY' | 'anchorToken' | 'anchorOffset'>
) {
  if (!scope || !locationKey) {
    return false;
  }

  const stored = stateForScope(scope);
  if (!stored) {
    return false;
  }

  const key = recordKey(kind, locationKey);
  const existing = stored.records[key];
  stored.records[key] = {
    kind,
    locationKey,
    scrollY: Math.max(0, Number(position.scrollY) || 0),
    anchorToken: String(position.anchorToken || ''),
    anchorOffset: Number(position.anchorOffset) || 0,
    returnPending: existing?.returnPending === true,
    updatedAt: Date.now()
  };
  stored.records = pruneRecords(stored.records);
  return writeStoredState(stored);
}

export function markListReturnPending(
  scope: NavigationScope | null,
  kind: ListRouteKind,
  locationKey: string
) {
  if (!scope || !locationKey) {
    return false;
  }

  const stored = stateForScope(scope);
  if (!stored) {
    return false;
  }

  const key = recordKey(kind, locationKey);
  const existing = stored.records[key];
  stored.records[key] = {
    kind,
    locationKey,
    scrollY: existing?.scrollY || 0,
    anchorToken: existing?.anchorToken || '',
    anchorOffset: existing?.anchorOffset || 0,
    returnPending: true,
    updatedAt: Date.now()
  };
  stored.records = pruneRecords(stored.records);
  return writeStoredState(stored);
}

export function getPendingListPosition(
  scope: NavigationScope | null,
  kind: ListRouteKind,
  locationKey: string
) {
  if (!scope || !locationKey) {
    return null;
  }

  const stored = stateForScope(scope);
  const record = stored?.records[recordKey(kind, locationKey)];
  return record?.returnPending ? record : null;
}

export function completeListReturn(
  scope: NavigationScope | null,
  kind: ListRouteKind,
  locationKey: string
) {
  if (!scope || !locationKey) {
    return;
  }

  const stored = stateForScope(scope);
  const key = recordKey(kind, locationKey);
  const record = stored?.records[key];
  if (!stored || !record) {
    return;
  }

  stored.records[key] = {
    ...record,
    returnPending: false,
    updatedAt: Date.now()
  };
  writeStoredState(stored);
}

export function createDetailNavigationState(
  scope: NavigationScope | null,
  kind: ListRouteKind,
  locationKey: string
): DetailNavigationState | undefined {
  if (!scope || !locationKey) {
    return undefined;
  }

  return {
    __listReturn: {
      version: 1,
      kind,
      locationKey,
      marker: scope.marker,
      fingerprint: scope.fingerprint,
      createdAt: Date.now()
    }
  };
}

export function hasValidDetailNavigationState(
  value: unknown,
  scope: NavigationScope | null,
  expectedKind: ListRouteKind
) {
  if (!scope || !value || typeof value !== 'object') {
    return false;
  }

  const detailState = (value as Partial<DetailNavigationState>).__listReturn;
  if (
    !detailState ||
    detailState.version !== 1 ||
    detailState.kind !== expectedKind ||
    detailState.marker !== scope.marker ||
    detailState.fingerprint !== scope.fingerprint ||
    !detailState.locationKey ||
    !Number.isFinite(detailState.createdAt) ||
    Date.now() - detailState.createdAt > RECORD_TTL_MS
  ) {
    return false;
  }

  return Boolean(getPendingListPosition(scope, expectedKind, detailState.locationKey));
}

export function clearNavigationSessionRecords(kind?: ListRouteKind) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!kind) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }

    const stored = readStoredState();
    if (!stored) {
      return;
    }

    stored.records = Object.fromEntries(
      Object.entries(stored.records).filter(([, record]) => record.kind !== kind)
    );
    writeStoredState(stored);
  } catch {
    // Navigation restoration is optional when browser storage is unavailable.
  }
}
