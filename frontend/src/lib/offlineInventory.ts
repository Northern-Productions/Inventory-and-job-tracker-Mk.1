import { getPhysicalStockFeet, type Box, type SearchBoxesParams, type Warehouse } from '../domain';
import { matchesBoxSearchQuery, rankBoxSearchCandidates } from '../domain/boxSearchMatcher.mjs';
import { normalizeManufacturerLookupKey } from './manufacturerCanonicalization';

const OFFLINE_DB_NAME = 'inventory-offline';
const OFFLINE_DB_VERSION = 1;
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

export interface OfflineInventorySyncMeta {
  warehouse: Warehouse;
  boxCount: number;
  lastSyncedAt: string;
}

export interface OfflineSearchBoxesParams extends Omit<SearchBoxesParams, 'warehouse' | 'warehouses'> {
  warehouse?: Warehouse | '';
  warehouses?: Warehouse[];
  widths?: string[];
}

export function isOfflineInventorySupported(): boolean {
  return typeof indexedDB !== 'undefined';
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

export async function searchOfflineBoxes(params: OfflineSearchBoxesParams): Promise<Box[]> {
  const snapshotWarehouse =
    !params.warehouses?.length && params.warehouse ? params.warehouse : '';
  const boxes = await getOfflineInventorySnapshotBoxes(snapshotWarehouse || '');
  return filterOfflineBoxes(boxes, params);
}

export async function getOfflineInventorySnapshotBoxes(warehouse: Warehouse | ''): Promise<Box[]> {
  return warehouse ? await getOfflineBoxesByWarehouse(warehouse) : await getAllOfflineBoxes();
}

export async function getOfflineBox(boxId: string): Promise<Box | null> {
  if (!isOfflineInventorySupported()) {
    return null;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction.objectStore(BOX_STORE).get(boxId);
    const result = await requestToPromise<Box | undefined>(request);
    return result || null;
  } finally {
    database.close();
  }
}

export async function getOfflineInventorySyncMeta(
  warehouse: Warehouse
): Promise<OfflineInventorySyncMeta | null> {
  if (!isOfflineInventorySupported()) {
    return null;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(SYNC_META_STORE, 'readonly');
    const request = transaction.objectStore(SYNC_META_STORE).get(warehouse);
    const result = await requestToPromise<OfflineInventorySyncMeta | undefined>(request);
    return result || null;
  } finally {
    database.close();
  }
}

export async function replaceOfflineInventoryBoxes(
  warehouse: Warehouse,
  boxes: Box[],
  lastSyncedAt = new Date().toISOString()
): Promise<OfflineInventorySyncMeta | null> {
  if (!isOfflineInventorySupported()) {
    return null;
  }

  const existingBoxes = await getOfflineBoxesByWarehouse(warehouse);
  const database = await openOfflineInventoryDatabase();
  const nextMeta: OfflineInventorySyncMeta = {
    warehouse,
    boxCount: boxes.length,
    lastSyncedAt
  };

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);

    for (let index = 0; index < existingBoxes.length; index += 1) {
      boxStore.delete(existingBoxes[index].boxId);
    }

    for (let index = 0; index < boxes.length; index += 1) {
      boxStore.put(boxes[index]);
    }

    transaction.objectStore(SYNC_META_STORE).put(nextMeta);
    await waitForTransaction(transaction);
    return nextMeta;
  } finally {
    database.close();
  }
}

export async function upsertOfflineInventoryBox(box: Box): Promise<void> {
  if (!isOfflineInventorySupported()) {
    return;
  }

  const [existingBox, warehouseMeta] = await Promise.all([
    getOfflineBox(box.boxId),
    getOfflineInventorySyncMeta(box.warehouse)
  ]);
  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);
    const metaStore = transaction.objectStore(SYNC_META_STORE);

    boxStore.put(box);

    if (!warehouseMeta) {
      await waitForTransaction(transaction);
      return;
    }

    const nextMeta: OfflineInventorySyncMeta = {
      ...warehouseMeta,
      boxCount: existingBox ? warehouseMeta.boxCount : warehouseMeta.boxCount + 1
    };

    metaStore.put(nextMeta);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function deleteOfflineInventoryBox(
  box: Pick<Box, 'boxId' | 'warehouse'>
): Promise<void> {
  if (!isOfflineInventorySupported()) {
    return;
  }

  const [existingBox, warehouseMeta] = await Promise.all([
    getOfflineBox(box.boxId),
    getOfflineInventorySyncMeta(box.warehouse)
  ]);

  if (!existingBox) {
    return;
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction([BOX_STORE, SYNC_META_STORE], 'readwrite');
    const boxStore = transaction.objectStore(BOX_STORE);
    const metaStore = transaction.objectStore(SYNC_META_STORE);

    boxStore.delete(box.boxId);

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

async function getOfflineBoxesByWarehouse(warehouse: Warehouse): Promise<Box[]> {
  if (!isOfflineInventorySupported()) {
    return [];
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction.objectStore(BOX_STORE).index('warehouse').getAll(IDBKeyRange.only(warehouse));
    const result = await requestToPromise<Box[]>(request);
    return result;
  } finally {
    database.close();
  }
}

async function getAllOfflineBoxes(): Promise<Box[]> {
  if (!isOfflineInventorySupported()) {
    return [];
  }

  const database = await openOfflineInventoryDatabase();

  try {
    const transaction = database.transaction(BOX_STORE, 'readonly');
    const request = transaction.objectStore(BOX_STORE).getAll();
    const result = await requestToPromise<Box[]>(request);
    return result;
  } finally {
    database.close();
  }
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
      const boxStore = database.objectStoreNames.contains(BOX_STORE)
        ? request.transaction?.objectStore(BOX_STORE)
        : database.createObjectStore(BOX_STORE, { keyPath: 'boxId' });

      if (boxStore && !boxStore.indexNames.contains('warehouse')) {
        boxStore.createIndex('warehouse', 'warehouse', { unique: false });
      }

      if (!database.objectStoreNames.contains(SYNC_META_STORE)) {
        database.createObjectStore(SYNC_META_STORE, { keyPath: 'warehouse' });
      }
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
