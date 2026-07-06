import { getPhysicalStockFeet, type Box, type SearchBoxesParams, type Warehouse } from '../domain';
import { matchesBoxSearchQuery, rankBoxSearchCandidates } from '../domain/boxSearchMatcher.mjs';
import { normalizeManufacturerLookupKey } from './manufacturerCanonicalization';

const OFFLINE_DB_NAME = 'inventory-offline';
export const OFFLINE_CACHE_VERSION = 2;
const OFFLINE_DB_VERSION = 2;
const BOX_STORE = 'boxes';
const SYNC_META_STORE = 'sync-meta';
const LOW_STOCK_THRESHOLD_LF = 10;
const STANDARD_OFFLINE_WIDTH_OPTIONS = ['36', '48', '60', '72'] as const;

/**
 * PURPOSE:
 * Keeps default inventory visibility status-only so reserved boxes with 0 allocatable LF still appear.
 *
 * AFFECTS:
 * Inventory tab filtering, offline fallback search, and warehouse snapshot browsing.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * /boxes/search filtering, InventoryTable stock columns, and explicit Zeroed status filter behavior.
 *
 * COMMON FAILURE MODES:
 * Hiding fully reserved boxes, treating 0 allocatable LF as zeroed stock, or blocking box detail access.
 */
function shouldHideFromDefaultInventory(box: Pick<Box, 'status'>, status: string, showRetired: boolean): boolean {
  return !showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED');
}

export interface OfflineInventoryScope {
  userId: string;
  orgId: string;
}

export interface OfflineInventorySyncMeta {
  warehouse: Warehouse;
  boxCount: number;
  lastSyncedAt: string;
  scopeKey: string;
  userId: string;
  orgId: string;
  cacheVersion: number;
}

export interface OfflineSearchBoxesParams extends Omit<SearchBoxesParams, 'warehouse' | 'warehouses'> {
  warehouse?: Warehouse | '';
  warehouses?: Warehouse[];
  widths?: string[];
}

type ScopedOfflineBoxRecord = Box & {
  cacheKey: string;
  scopeKey: string;
  scopeWarehouseKey: string;
  userId: string;
  orgId: string;
  cacheVersion: number;
};

type ScopedOfflineSyncMetaRecord = OfflineInventorySyncMeta & {
  scopeWarehouseKey: string;
};

export function isOfflineInventorySupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function buildOfflineInventoryScopeKey(
  scope: OfflineInventoryScope | null | undefined
): string {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  if (!normalizedScope) {
    return '';
  }

  return `v${OFFLINE_CACHE_VERSION}|user:${normalizedScope.userId}|org:${normalizedScope.orgId}`;
}

export function isOfflineInventoryScopeValid(
  scope: OfflineInventoryScope | null | undefined
): scope is OfflineInventoryScope {
  return Boolean(normalizeOfflineInventoryScope(scope));
}

export function createScopedOfflineBoxRecord(
  scope: OfflineInventoryScope,
  box: Box
): ScopedOfflineBoxRecord | null {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  const scopeKey = buildOfflineInventoryScopeKey(normalizedScope);
  const boxId = String(box.boxId || '').trim();
  const warehouse = String(box.warehouse || '').trim().toUpperCase() as Warehouse;
  if (!normalizedScope || !scopeKey || !boxId || !warehouse) {
    return null;
  }

  return {
    ...box,
    warehouse,
    cacheKey: buildScopedBoxCacheKey(scopeKey, boxId),
    scopeKey,
    scopeWarehouseKey: buildScopedWarehouseKey(scopeKey, warehouse),
    userId: normalizedScope.userId,
    orgId: normalizedScope.orgId,
    cacheVersion: OFFLINE_CACHE_VERSION
  };
}

export function stripScopedOfflineBoxRecord(record: unknown): Box | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const scopedRecord = record as Partial<ScopedOfflineBoxRecord>;
  if (
    scopedRecord.cacheVersion !== OFFLINE_CACHE_VERSION ||
    !scopedRecord.scopeKey ||
    !scopedRecord.userId ||
    !scopedRecord.orgId ||
    !scopedRecord.boxId
  ) {
    return null;
  }

  const {
    cacheKey: _cacheKey,
    scopeKey: _scopeKey,
    scopeWarehouseKey: _scopeWarehouseKey,
    userId: _userId,
    orgId: _orgId,
    cacheVersion: _cacheVersion,
    ...box
  } = scopedRecord;

  return box as Box;
}

export function createScopedOfflineSyncMetaRecord(
  scope: OfflineInventoryScope,
  warehouse: Warehouse,
  boxCount: number,
  lastSyncedAt: string
): ScopedOfflineSyncMetaRecord | null {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  const scopeKey = buildOfflineInventoryScopeKey(normalizedScope);
  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase() as Warehouse;
  if (!normalizedScope || !scopeKey || !normalizedWarehouse) {
    return null;
  }

  return {
    warehouse: normalizedWarehouse,
    boxCount: Math.max(0, Math.trunc(Number(boxCount || 0))),
    lastSyncedAt,
    scopeKey,
    scopeWarehouseKey: buildScopedWarehouseKey(scopeKey, normalizedWarehouse),
    userId: normalizedScope.userId,
    orgId: normalizedScope.orgId,
    cacheVersion: OFFLINE_CACHE_VERSION
  };
}

export function filterOfflineBoxes(boxes: Box[], params: OfflineSearchBoxesParams): Box[] {
  const manufacturerKey = normalizeManufacturerLookup(params.manufacturer || '');
  const query = (params.q || '').trim().toLowerCase();
  const film = (params.film || '').trim().toLowerCase();
  const status = params.status || '';
  const showRetired = params.showRetired ?? false;
  const selectedWidths = normalizeOfflineSelectedWidths([
    ...(params.widths || []),
    params.width || ''
  ]);
  const selectedWarehouses = normalizeOfflineSelectedWarehouses(params);
  const filtered: Box[] = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];

    if (selectedWarehouses.length && !selectedWarehouses.includes(box.warehouse)) {
      continue;
    }

    if (manufacturerKey && normalizeManufacturerLookup(box.manufacturer) !== manufacturerKey) {
      continue;
    }

    if (shouldHideFromDefaultInventory(box, status, showRetired)) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (!matchesOfflineSelectedWidths(box.widthIn, selectedWidths)) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query) {
      if (!matchesBoxSearchQuery(box, query)) {
        continue;
      }
    }

    filtered.push(box);
  }

  let ordered = filtered;

  if (film) {
    ordered = prioritizeLowStockBoxes(ordered);
  }

  if (query) {
    ordered = rankBoxSearchCandidates(ordered, query);
  }

  return ordered;
}

export async function searchOfflineBoxes(
  scope: OfflineInventoryScope | null | undefined,
  params: OfflineSearchBoxesParams
): Promise<Box[]> {
  if (!isOfflineInventoryScopeValid(scope)) {
    return [];
  }

  const snapshotWarehouse =
    !params.warehouses?.length && params.warehouse ? params.warehouse : '';
  const boxes = await getOfflineInventorySnapshotBoxes(scope, snapshotWarehouse || '');
  return filterOfflineBoxes(boxes, params);
}

export async function getOfflineInventorySnapshotBoxes(
  scope: OfflineInventoryScope | null | undefined,
  warehouse: Warehouse | ''
): Promise<Box[]> {
  if (!isOfflineInventoryScopeValid(scope)) {
    return [];
  }

  return warehouse
    ? await getOfflineBoxesByWarehouse(scope, warehouse)
    : await getAllOfflineBoxes(scope);
}

export async function getOfflineBox(
  scope: OfflineInventoryScope | null | undefined,
  boxId: string
): Promise<Box | null> {
  const scopeKey = buildOfflineInventoryScopeKey(scope);
  const normalizedBoxId = String(boxId || '').trim();
  if (!isOfflineInventorySupported() || !scopeKey || !normalizedBoxId) {
    return null;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction
      .objectStore(BOX_STORE)
      .index('scopeBoxId')
      .get(IDBKeyRange.only([scopeKey, normalizedBoxId]));
    const result = await requestToPromise<ScopedOfflineBoxRecord | undefined>(request);
    return stripScopedOfflineBoxRecord(result);
  } finally {
    database.close();
  }
}

export async function getOfflineInventorySyncMeta(
  scope: OfflineInventoryScope | null | undefined,
  warehouse: Warehouse
): Promise<OfflineInventorySyncMeta | null> {
  const metaRecord = await getOfflineInventorySyncMetaRecord(scope, warehouse);
  return metaRecord ? stripScopedOfflineSyncMetaRecord(metaRecord) : null;
}

export async function replaceOfflineInventoryBoxes(
  scope: OfflineInventoryScope | null | undefined,
  warehouse: Warehouse,
  boxes: Box[],
  lastSyncedAt = new Date().toISOString()
): Promise<OfflineInventorySyncMeta | null> {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  if (!isOfflineInventorySupported() || !normalizedScope) {
    return null;
  }

  const nextMetaRecord = createScopedOfflineSyncMetaRecord(
    normalizedScope,
    warehouse,
    boxes.length,
    lastSyncedAt
  );
  if (!nextMetaRecord) {
    return null;
  }

  const existingBoxes = await getOfflineBoxesByWarehouse(normalizedScope, nextMetaRecord.warehouse);
  const scopedBoxRecords = boxes
    .map((box) => createScopedOfflineBoxRecord(normalizedScope, box))
    .filter((record): record is ScopedOfflineBoxRecord => Boolean(record));
  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);

    for (let index = 0; index < existingBoxes.length; index += 1) {
      boxStore.delete(buildScopedBoxCacheKey(nextMetaRecord.scopeKey, existingBoxes[index].boxId));
    }

    for (let index = 0; index < scopedBoxRecords.length; index += 1) {
      boxStore.put(scopedBoxRecords[index]);
    }

    transaction.objectStore(SYNC_META_STORE).put(nextMetaRecord);
    await waitForTransaction(transaction);
    return stripScopedOfflineSyncMetaRecord(nextMetaRecord);
  } finally {
    database.close();
  }
}

export async function upsertOfflineInventoryBox(
  scope: OfflineInventoryScope | null | undefined,
  box: Box
): Promise<void> {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  const scopedRecord = normalizedScope ? createScopedOfflineBoxRecord(normalizedScope, box) : null;
  if (!isOfflineInventorySupported() || !normalizedScope || !scopedRecord) {
    return;
  }

  const [existingBox, warehouseMeta] = await Promise.all([
    getOfflineBox(normalizedScope, box.boxId),
    getOfflineInventorySyncMetaRecord(normalizedScope, scopedRecord.warehouse)
  ]);
  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);
    const metaStore = transaction.objectStore(SYNC_META_STORE);

    boxStore.put(scopedRecord);

    if (!warehouseMeta) {
      await waitForTransaction(transaction);
      return;
    }

    const nextMetaRecord: ScopedOfflineSyncMetaRecord = {
      ...warehouseMeta,
      boxCount: existingBox ? warehouseMeta.boxCount : warehouseMeta.boxCount + 1
    };

    metaStore.put(nextMetaRecord);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function deleteOfflineInventoryBox(
  scope: OfflineInventoryScope | null | undefined,
  box: Pick<Box, 'boxId' | 'warehouse'>
): Promise<void> {
  const normalizedScope = normalizeOfflineInventoryScope(scope);
  const normalizedBoxId = String(box.boxId || '').trim();
  const normalizedWarehouse = String(box.warehouse || '').trim().toUpperCase() as Warehouse;
  if (!isOfflineInventorySupported() || !normalizedScope || !normalizedBoxId || !normalizedWarehouse) {
    return;
  }

  const scopeKey = buildOfflineInventoryScopeKey(normalizedScope);
  const [existingBox, warehouseMeta] = await Promise.all([
    getOfflineBox(normalizedScope, normalizedBoxId),
    getOfflineInventorySyncMetaRecord(normalizedScope, normalizedWarehouse)
  ]);

  if (!existingBox) {
    return;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);
    const metaStore = transaction.objectStore(SYNC_META_STORE);

    boxStore.delete(buildScopedBoxCacheKey(scopeKey, normalizedBoxId));

    if (warehouseMeta) {
      metaStore.put({
        ...warehouseMeta,
        boxCount: Math.max(warehouseMeta.boxCount - 1, 0)
      });
    }

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export function clearOfflineInventoryDatabase(): Promise<void> {
  return new Promise((resolve) => {
    if (!isOfflineInventorySupported()) {
      resolve();
      return;
    }

    const request = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function getOfflineBoxesByWarehouse(
  scope: OfflineInventoryScope,
  warehouse: Warehouse
): Promise<Box[]> {
  const scopeKey = buildOfflineInventoryScopeKey(scope);
  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase() as Warehouse;
  if (!isOfflineInventorySupported() || !scopeKey || !normalizedWarehouse) {
    return [];
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction
      .objectStore(BOX_STORE)
      .index('scopeWarehouse')
      .getAll(IDBKeyRange.only([scopeKey, normalizedWarehouse]));
    const result = await requestToPromise<ScopedOfflineBoxRecord[]>(request);
    return result
      .map((record) => stripScopedOfflineBoxRecord(record))
      .filter((box): box is Box => Boolean(box));
  } finally {
    database.close();
  }
}

async function getAllOfflineBoxes(scope: OfflineInventoryScope): Promise<Box[]> {
  const scopeKey = buildOfflineInventoryScopeKey(scope);
  if (!isOfflineInventorySupported() || !scopeKey) {
    return [];
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction
      .objectStore(BOX_STORE)
      .index('scopeKey')
      .getAll(IDBKeyRange.only(scopeKey));
    const result = await requestToPromise<ScopedOfflineBoxRecord[]>(request);
    return result
      .map((record) => stripScopedOfflineBoxRecord(record))
      .filter((box): box is Box => Boolean(box));
  } finally {
    database.close();
  }
}

async function getOfflineInventorySyncMetaRecord(
  scope: OfflineInventoryScope | null | undefined,
  warehouse: Warehouse
): Promise<ScopedOfflineSyncMetaRecord | null> {
  const scopeKey = buildOfflineInventoryScopeKey(scope);
  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase() as Warehouse;
  if (!isOfflineInventorySupported() || !scopeKey || !normalizedWarehouse) {
    return null;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(SYNC_META_STORE, 'readonly');
    const request = transaction
      .objectStore(SYNC_META_STORE)
      .get(buildScopedWarehouseKey(scopeKey, normalizedWarehouse));
    const result = await requestToPromise<ScopedOfflineSyncMetaRecord | undefined>(request);
    return result || null;
  } finally {
    database.close();
  }
}

function stripScopedOfflineSyncMetaRecord(
  record: ScopedOfflineSyncMetaRecord
): OfflineInventorySyncMeta {
  const {
    scopeWarehouseKey: _scopeWarehouseKey,
    ...meta
  } = record;

  return meta;
}

function normalizeOfflineInventoryScope(
  scope: OfflineInventoryScope | null | undefined
): OfflineInventoryScope | null {
  const userId = String(scope?.userId || '').trim();
  const orgId = String(scope?.orgId || '').trim();
  if (!userId || !orgId) {
    return null;
  }

  return { userId, orgId };
}

function buildScopedBoxCacheKey(scopeKey: string, boxId: string): string {
  return `${scopeKey}|box:${boxId}`;
}

function buildScopedWarehouseKey(scopeKey: string, warehouse: Warehouse): string {
  return `${scopeKey}|warehouse:${warehouse}`;
}

function isLowStockBox(box: Box): boolean {
  const physicalStockFeet = getPhysicalStockFeet(box);
  return box.status === 'IN_STOCK' && physicalStockFeet > 0 && physicalStockFeet < LOW_STOCK_THRESHOLD_LF;
}

function prioritizeLowStockBoxes(boxes: Box[]): Box[] {
  const lowStock: Box[] = [];
  const remaining: Box[] = [];

  for (let index = 0; index < boxes.length; index += 1) {
    if (isLowStockBox(boxes[index])) {
      lowStock.push(boxes[index]);
      continue;
    }

    remaining.push(boxes[index]);
  }

  lowStock.sort((a, b) => {
    const leftPhysicalStockFeet = getPhysicalStockFeet(a);
    const rightPhysicalStockFeet = getPhysicalStockFeet(b);
    if (leftPhysicalStockFeet !== rightPhysicalStockFeet) {
      return leftPhysicalStockFeet - rightPhysicalStockFeet;
    }

    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  return lowStock.concat(remaining);
}

function normalizeOfflineWidthToken(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '';
  }

  return String(parsed);
}

function normalizeOfflineSelectedWarehouses(params: OfflineSearchBoxesParams): Warehouse[] {
  return Array.from(
    new Set(
      [...(params.warehouses || []), params.warehouse || '']
        .map((entry) => String(entry || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function normalizeOfflineSelectedWidths(values: readonly unknown[]): string[] {
  const selectedStandardWidths = new Set<string>();
  let selectedCustomWidth = '';

  for (const value of values) {
    const normalizedWidth = normalizeOfflineWidthToken(value);
    if (!normalizedWidth) {
      continue;
    }

    if (STANDARD_OFFLINE_WIDTH_OPTIONS.includes(normalizedWidth as (typeof STANDARD_OFFLINE_WIDTH_OPTIONS)[number])) {
      selectedStandardWidths.add(normalizedWidth);
      continue;
    }

    if (!selectedCustomWidth) {
      selectedCustomWidth = normalizedWidth;
    }
  }

  const orderedStandardWidths = STANDARD_OFFLINE_WIDTH_OPTIONS.filter((value) =>
    selectedStandardWidths.has(value)
  );

  return selectedCustomWidth
    ? [...orderedStandardWidths, selectedCustomWidth]
    : orderedStandardWidths;
}

function matchesOfflineSelectedWidths(widthIn: unknown, selectedWidths: readonly unknown[]): boolean {
  const normalizedSelectedWidths = normalizeOfflineSelectedWidths(selectedWidths);
  if (!normalizedSelectedWidths.length) {
    return true;
  }

  const normalizedWidth = normalizeOfflineWidthToken(widthIn);
  if (!normalizedWidth) {
    return false;
  }

  return normalizedSelectedWidths.includes(normalizedWidth);
}

function normalizeManufacturerLookup(value: string): string {
  return normalizeManufacturerLookupKey(value);
}

function openOfflineInventoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isOfflineInventorySupported()) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (database.objectStoreNames.contains(BOX_STORE)) {
        database.deleteObjectStore(BOX_STORE);
      }

      if (database.objectStoreNames.contains(SYNC_META_STORE)) {
        database.deleteObjectStore(SYNC_META_STORE);
      }

      const boxStore = database.createObjectStore(BOX_STORE, { keyPath: 'cacheKey' });
      boxStore.createIndex('scopeKey', 'scopeKey', { unique: false });
      boxStore.createIndex('scopeWarehouse', ['scopeKey', 'warehouse'], { unique: false });
      boxStore.createIndex('scopeBoxId', ['scopeKey', 'boxId'], { unique: true });

      const metaStore = database.createObjectStore(SYNC_META_STORE, { keyPath: 'scopeWarehouseKey' });
      metaStore.createIndex('scopeKey', 'scopeKey', { unique: false });
      metaStore.createIndex('scopeWarehouse', ['scopeKey', 'warehouse'], { unique: true });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open offline inventory storage.'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
}
