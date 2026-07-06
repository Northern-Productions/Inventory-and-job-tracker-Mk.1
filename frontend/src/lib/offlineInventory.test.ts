import { describe, expect, it } from 'vitest';
import type { Box, Warehouse } from '../domain';
import {
  OFFLINE_CACHE_VERSION,
  buildOfflineInventoryScopeKey,
  createScopedOfflineBoxRecord,
  createScopedOfflineSyncMetaRecord,
  filterOfflineBoxes,
  getOfflineInventorySnapshotBoxes,
  isOfflineInventoryScopeValid,
  searchOfflineBoxes,
  stripScopedOfflineBoxRecord
} from './offlineInventory';

function createBox(overrides: Partial<Box>): Box {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 36,
    initialFeet: 100,
    feetAvailable: 100,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-03-01',
    receivedDate: '2026-03-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3M|PRESTIGE 40',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

describe('offline inventory filters', () => {
  it('builds scoped cache keys from user, org, and cache version', () => {
    expect(buildOfflineInventoryScopeKey({ userId: 'user-a', orgId: 'org-a' })).toBe(
      `v${OFFLINE_CACHE_VERSION}|user:user-a|org:org-a`
    );
    expect(buildOfflineInventoryScopeKey({ userId: ' user-a ', orgId: ' org-a ' })).toBe(
      `v${OFFLINE_CACHE_VERSION}|user:user-a|org:org-a`
    );
    expect(buildOfflineInventoryScopeKey({ userId: '', orgId: 'org-a' })).toBe('');
    expect(buildOfflineInventoryScopeKey(null)).toBe('');
    expect(isOfflineInventoryScopeValid({ userId: 'user-a', orgId: 'org-a' })).toBe(true);
    expect(isOfflineInventoryScopeValid({ userId: 'user-a', orgId: '' })).toBe(false);
  });

  it('creates scoped records and rejects legacy unscoped records', () => {
    const box = createBox({ boxId: 'IL1-1001', warehouse: 'IL1' });
    const scopedRecord = createScopedOfflineBoxRecord({ userId: 'user-a', orgId: 'org-a' }, box);

    expect(scopedRecord).toMatchObject({
      boxId: 'IL1-1001',
      warehouse: 'IL1',
      userId: 'user-a',
      orgId: 'org-a',
      cacheVersion: OFFLINE_CACHE_VERSION,
      scopeKey: `v${OFFLINE_CACHE_VERSION}|user:user-a|org:org-a`,
      cacheKey: `v${OFFLINE_CACHE_VERSION}|user:user-a|org:org-a|box:IL1-1001`
    });
    expect(stripScopedOfflineBoxRecord(scopedRecord)).toMatchObject({
      boxId: 'IL1-1001',
      warehouse: 'IL1'
    });
    expect(stripScopedOfflineBoxRecord(box)).toBeNull();
    expect(stripScopedOfflineBoxRecord({ ...scopedRecord, cacheVersion: 1 })).toBeNull();
  });

  it('keeps user/org cache records isolated even for the same box id', () => {
    const box = createBox({ boxId: 'IL1-1001', warehouse: 'IL1' });
    const userAOrgA = createScopedOfflineBoxRecord({ userId: 'user-a', orgId: 'org-a' }, box);
    const userBOrgB = createScopedOfflineBoxRecord({ userId: 'user-b', orgId: 'org-b' }, box);
    const userAOrgB = createScopedOfflineBoxRecord({ userId: 'user-a', orgId: 'org-b' }, box);

    expect(userAOrgA?.scopeKey).not.toBe(userBOrgB?.scopeKey);
    expect(userAOrgA?.cacheKey).not.toBe(userBOrgB?.cacheKey);
    expect(userAOrgA?.scopeKey).not.toBe(userAOrgB?.scopeKey);
    expect(userAOrgA?.cacheKey).not.toBe(userAOrgB?.cacheKey);
  });

  it('creates scoped sync metadata per user, org, cache version, and warehouse', () => {
    const meta = createScopedOfflineSyncMetaRecord(
      { userId: 'user-a', orgId: 'org-a' },
      'il1' as Warehouse,
      3,
      '2026-07-06T00:00:00.000Z'
    );

    expect(meta).toMatchObject({
      warehouse: 'IL1',
      boxCount: 3,
      lastSyncedAt: '2026-07-06T00:00:00.000Z',
      userId: 'user-a',
      orgId: 'org-a',
      cacheVersion: OFFLINE_CACHE_VERSION,
      scopeWarehouseKey: `v${OFFLINE_CACHE_VERSION}|user:user-a|org:org-a|warehouse:IL1`
    });
  });

  it('returns safe-empty offline results when scope is missing', async () => {
    await expect(searchOfflineBoxes(null, { warehouse: 'IL1' })).resolves.toEqual([]);
    await expect(getOfflineInventorySnapshotBoxes(null, 'IL1')).resolves.toEqual([]);
  });

  it('matches the default inventory behavior and hides retired or zeroed boxes', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M' }),
      createBox({ boxId: 'IL1-6734', status: 'CHECKED_OUT', feetAvailable: 0, allocatableNowFeet: 0 }),
      createBox({ boxId: 'IL1-6942', status: 'TRANSFER', feetAvailable: 0, allocatableNowFeet: 0 }),
      createBox({ boxId: 'IL1-7001', status: 'ORDERED', feetAvailable: 0, allocatableNowFeet: 0 }),
      createBox({ boxId: 'IL1-1002', status: 'ZEROED' }),
      createBox({ boxId: 'IL1-1003', status: 'RETIRED' })
    ];

    const result = filterOfflineBoxes(boxes, { warehouse: 'IL1' });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'IL1-6734', 'IL1-6942', 'IL1-7001']);
  });

  it('keeps reserved in-stock boxes visible even when available and allocatable feet are zero', () => {
    const boxes = [
      createBox({
        boxId: 'IL1-5130',
        feetAvailable: 0,
        physicalFeetAvailable: 6,
        allocatableNowFeet: 0,
        allocationPlanningFeet: 0
      }),
      createBox({
        boxId: 'IL1-5131',
        feetAvailable: 0,
        physicalFeetAvailable: 100,
        allocatableNowFeet: 0,
        allocationPlanningFeet: 0,
        allocatedWithInstallDateFeet: 100
      }),
      createBox({ boxId: 'IL1-5132', status: 'ZEROED', feetAvailable: 0 })
    ];

    const result = filterOfflineBoxes(boxes, { warehouse: 'IL1' });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-5130', 'IL1-5131']);
  });

  it('filters by search text, manufacturer, film, width, and explicit statuses', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M Fasara', filmName: 'Night Vision', widthIn: 36 }),
      createBox({ boxId: 'IL1-1002', manufacturer: 'Llumar', filmName: 'Dual Reflective', widthIn: 48 }),
      createBox({ boxId: 'IL1-1003', status: 'ZEROED', widthIn: 48 })
    ];

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL1',
        manufacturer: '  llumar  ',
        q: 'llumar',
        film: 'dual',
        width: '48',
        status: 'IN_STOCK'
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1002']);

    expect(
      filterOfflineBoxes(boxes, {
        warehouse: 'IL1',
        status: 'ZEROED'
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1003']);
  });

  it('matches any selected width when multiple widths are active', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', widthIn: 36 }),
      createBox({ boxId: 'IL1-1002', widthIn: 48 }),
      createBox({ boxId: 'IL1-1003', widthIn: 60 })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      widths: ['48', '36', '48']
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'IL1-1002']);
  });

  it('treats an empty or invalid multi-width filter as all widths', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', widthIn: 36 }),
      createBox({ boxId: 'IL1-1002', widthIn: 48 })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      widths: ['', 'not-a-number']
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'IL1-1002']);
  });

  it('matches manufacturers exactly after normalizing case and whitespace', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: '3M Fasara' }),
      createBox({ boxId: 'IL1-1002', manufacturer: '3M' }),
      createBox({ boxId: 'IL1-1003', manufacturer: '3M  FASARA' })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      manufacturer: ' 3m fasara '
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'IL1-1003']);
  });

  it('matches legacy manufacturer filters against canonical labels', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', manufacturer: 'Solar Gard' }),
      createBox({ boxId: 'IL1-1002', manufacturer: 'Llumar' })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      manufacturer: 'Solar Guard'
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001']);
  });

  it('moves low stock boxes to the front when a film filter is used', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1002', filmName: 'Ceramic 30', feetAvailable: 40 }),
      createBox({ boxId: 'IL1-1003', filmName: 'Ceramic 30', feetAvailable: 4 }),
      createBox({ boxId: 'IL1-1001', filmName: 'Ceramic 30', feetAvailable: 7 })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      film: 'ceramic'
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1003', 'IL1-1001', 'IL1-1002']);
  });

  it('uses the broader shared matcher for inventory search queries', () => {
    const boxes = [
      createBox({
        boxId: 'IL1-6727',
        manufacturer: 'SOLYX',
        filmName: 'Frosted Stripes SXC-1418',
        filmKey: 'SOLYX|FROSTED STRIPES SXC-1418'
      }),
      createBox({
        boxId: 'IL1-6728',
        manufacturer: 'SOLYX',
        filmName: 'Whiteout SXWF-WO',
        filmKey: 'SOLYX|WHITEOUT SXWF-WO'
      })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      q: 'sx-1418'
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-6727']);
  });

  it('keeps boxes from all warehouses when the warehouse filter is all', () => {
    const boxes = [
      createBox({ boxId: 'IL1-1001', warehouse: 'IL1' }),
      createBox({ boxId: 'MS1-2001', warehouse: 'MS1' })
    ];

    const result = filterOfflineBoxes(boxes, {
      warehouse: '',
      showRetired: true
    });

    expect(result.map((box) => box.boxId)).toEqual(['IL1-1001', 'MS1-2001']);
  });
});
