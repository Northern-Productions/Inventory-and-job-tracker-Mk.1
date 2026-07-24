import { describe, expect, it } from 'vitest';
import {
  normalizeWarehouseAssetAuditFilters,
  toWarehouseAssetAuditRequestFilters,
  warehouseAssetAuditFiltersEqual
} from './warehouseAssetAuditFilters';

describe('warehouse asset audit filter normalization', () => {
  it('canonicalizes every filter identity and search whitespace', () => {
    const normalized = normalizeWarehouseAssetAuditFilters({
      warehouse: ' il1 ',
      ownerCompanyId: ' owner-alpha ',
      manufacturer: ' 3M ',
      filmName: ' Fasara ',
      width: ' 60 ',
      statuses: ['TRANSFER', 'IN_STOCK', 'TRANSFER'],
      q: '  matte   deep\tblack  '
    });

    expect(normalized).toEqual({
      warehouse: 'IL1',
      ownerCompanyId: 'owner-alpha',
      manufacturer: '3M',
      filmName: 'Fasara',
      width: 60,
      statuses: ['IN_STOCK', 'TRANSFER'],
      q: 'matte deep black'
    });
  });

  it('normalizes blank selections and empty statuses to canonical All values', () => {
    expect(
      normalizeWarehouseAssetAuditFilters({
        warehouse: ' ',
        ownerCompanyId: '',
        manufacturer: ' ',
        filmName: '',
        width: '',
        statuses: [],
        q: ' '
      })
    ).toEqual({
      warehouse: '',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: null,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: ''
    });
  });

  it('compares canonical values instead of object identity and builds request filters', () => {
    const fromControls = normalizeWarehouseAssetAuditFilters({
      warehouse: 'il1',
      statuses: ['TRANSFER', 'CHECKED_OUT', 'IN_STOCK'],
      width: '48',
      q: ' box   12 '
    });
    const fromServer = normalizeWarehouseAssetAuditFilters({
      warehouse: 'IL1',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: 48,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: 'box 12'
    });

    expect(warehouseAssetAuditFiltersEqual(fromControls, fromServer)).toBe(true);
    expect(toWarehouseAssetAuditRequestFilters(fromControls)).toEqual({
      warehouse: 'IL1',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: '48',
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: 'box 12'
    });
  });
});
