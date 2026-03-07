import type { Box, SearchBoxesParams, Warehouse } from '../domain';

const OFFLINE_DB_NAME = 'inventory-offline';
const OFFLINE_DB_VERSION = 1;
const BOX_STORE = 'boxes';
const SYNC_META_STORE = 'sync-meta';
const LOW_STOCK_THRESHOLD_LF = 10;

export interface OfflineInventorySyncMeta {
  warehouse: Warehouse;
  boxCount: number;
  lastSyncedAt: string;
}

export function isOfflineInventorySupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function filterOfflineBoxes(boxes: Box[], params: SearchBoxesParams): Box[] {
  const query = (params.q || '').trim().toLowerCase();
  const film = (params.film || '').trim().toLowerCase();
  const status = params.status || '';
  const width = (params.width || '').trim();
  const showRetired = params.showRetired ?? false;
  const filtered: Box[] = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
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
      const haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
        .join(' ')
        .toLowerCase();

      if (haystack.indexOf(query) === -1) {
        continue;
      }
    }

    filtered.push(box);
  }

  if (!film) {
    return filtered;
  }

  const lowStock: Box[] = [];
  const remaining: Box[] = [];

  for (let index = 0; index < filtered.length; index += 1) {
    if (isLowStockBox(filtered[index])) {
      lowStock.push(filtered[index]);
      continue;
    }

    remaining.push(filtered[index]);
  }

  lowStock.sort((a, b) => {
    if (a.feetAvailable !== b.feetAvailable) {
      return a.feetAvailable - b.feetAvailable;
    }

    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  return lowStock.concat(remaining);
}

export async function searchOfflineBoxes(params: SearchBoxesParams): Promise<Box[]> {
  const boxes = await getOfflineBoxesByWarehouse(params.warehouse);
  return filterOfflineBoxes(boxes, params);
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

function isLowStockBox(box: Box): boolean {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < LOW_STOCK_THRESHOLD_LF;
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
