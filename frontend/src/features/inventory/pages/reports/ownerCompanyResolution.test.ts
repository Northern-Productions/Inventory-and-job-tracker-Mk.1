import { describe, expect, it } from 'vitest';
import type { Box, OwnerCompanyEntry } from '../../../../domain';
import {
  buildOwnershipOwnerOptions,
  buildOwnershipReportReadModel,
  filterOwnershipReportRows,
  NO_OWNER_FILTER_VALUE,
  OwnershipReportResolutionError,
  summarizeOwnershipReportRows,
  type OwnershipReportFilters
} from './ownerCompanyResolution';

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    ownerCompanyId: '11111111-1111-4111-8111-111111111111',
    ownerCompanyCode: '',
    ownerCompanyDisplayName: '',
    manufacturer: 'Synthetic Films',
    filmName: 'Clear 70',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 75,
    physicalFeetAvailable: 80,
    allocatableNowFeet: 75,
    allocationPlanningFeet: 75,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-05-01',
    receivedDate: '2026-05-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: 'SYNTHETIC FILMS|CLEAR 70',
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

function buildOwner(overrides: Partial<OwnerCompanyEntry> = {}): OwnerCompanyEntry {
  return {
    ownerCompanyId: '11111111-1111-4111-8111-111111111111',
    code: 'ALP',
    displayName: 'Alpha Holdings',
    lookupKey: 'alp',
    isActive: true,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
    updatedBy: '',
    deactivatedAt: '',
    deactivatedBy: '',
    ...overrides
  };
}

function filters(overrides: Partial<OwnershipReportFilters> = {}): OwnershipReportFilters {
  return {
    warehouse: '',
    manufacturer: '',
    filmName: '',
    width: '',
    status: '',
    q: '',
    ownerCompanyId: '',
    ...overrides
  };
}

describe('ownerCompanyResolution', () => {
  it('uses the current registry label and keeps referenced inactive owners assigned and filterable', () => {
    const owner = buildOwner({ isActive: false });
    const readModel = buildOwnershipReportReadModel({
      boxes: [buildBox()],
      ownerCompanies: [owner]
    });

    expect(readModel.rows[0].owner).toEqual({
      groupKey: owner.ownerCompanyId,
      filterValue: owner.ownerCompanyId,
      displayLabel: 'ALP - Alpha Holdings (inactive)',
      state: 'assigned',
      ownerCompanyId: owner.ownerCompanyId,
      isActive: false
    });
    expect(buildOwnershipOwnerOptions({ readModel, selectedOwnerCompanyId: '' })).toContainEqual({
      label: 'ALP - Alpha Holdings (inactive)',
      value: owner.ownerCompanyId
    });
  });

  it('uses unique code fallback only when ID is absent and distinguishes true unassigned rows', () => {
    const owner = buildOwner();
    const readModel = buildOwnershipReportReadModel({
      boxes: [
        buildBox({ ownerCompanyId: '', ownerCompanyCode: 'alp' }),
        buildBox({
          boxId: 'IL1-1002',
          ownerCompanyId: '',
          ownerCompanyCode: '',
          ownerCompanyDisplayName: ''
        })
      ],
      ownerCompanies: [owner]
    });

    expect(readModel.rows.map((row) => row.owner.state)).toEqual(['assigned', 'unassigned']);
    expect(readModel.rows[0].owner.ownerCompanyId).toBe(owner.ownerCompanyId);
    expect(readModel.rows[1].owner).toMatchObject({
      groupKey: NO_OWNER_FILTER_VALUE,
      displayLabel: 'No owner assigned'
    });
  });

  it('assigns safe unknown ordinals from the complete dataset before filters are applied', () => {
    const firstUnknownId = '22222222-2222-4222-8222-222222222222';
    const secondUnknownId = '99999999-9999-4999-8999-999999999999';
    const readModel = buildOwnershipReportReadModel({
      boxes: [
        buildBox({
          boxId: 'IL1-1002',
          ownerCompanyId: secondUnknownId,
          ownerCompanyCode: '',
          manufacturer: 'Second Synthetic Maker'
        }),
        buildBox({
          boxId: 'IL1-1001',
          ownerCompanyId: firstUnknownId,
          ownerCompanyCode: '',
          manufacturer: 'First Synthetic Maker'
        })
      ],
      ownerCompanies: []
    });
    const firstRow = readModel.rows.find((row) => row.box.ownerCompanyId === firstUnknownId)!;
    const secondRow = readModel.rows.find((row) => row.box.ownerCompanyId === secondUnknownId)!;

    expect(firstRow.owner.displayLabel).toBe('Unknown owner 1');
    expect(secondRow.owner.displayLabel).toBe('Unknown owner 2');
    expect(
      filterOwnershipReportRows(
        readModel.rows,
        filters({ manufacturer: 'Second Synthetic Maker' })
      )[0].owner.displayLabel
    ).toBe('Unknown owner 2');

    const safeVisibleProjection = JSON.stringify({
      owners: readModel.rows.map((row) => row.owner),
      options: buildOwnershipOwnerOptions({ readModel, selectedOwnerCompanyId: '' }),
      summaries: summarizeOwnershipReportRows(readModel.rows)
    });
    expect(safeVisibleProjection).not.toContain(firstUnknownId);
    expect(safeVisibleProjection).not.toContain(secondUnknownId);
  });

  it('keeps duplicate display names separate by canonical owner identity', () => {
    const first = buildOwner();
    const second = buildOwner({
      ownerCompanyId: '33333333-3333-4333-8333-333333333333',
      code: 'BET',
      displayName: first.displayName,
      lookupKey: 'bet'
    });
    const readModel = buildOwnershipReportReadModel({
      boxes: [
        buildBox(),
        buildBox({ boxId: 'IL1-1002', ownerCompanyId: second.ownerCompanyId })
      ],
      ownerCompanies: [first, second]
    });

    expect(summarizeOwnershipReportRows(readModel.rows)).toEqual([
      { key: first.ownerCompanyId, label: 'ALP - Alpha Holdings', count: 1 },
      { key: second.ownerCompanyId, label: 'BET - Alpha Holdings', count: 1 }
    ]);
  });

  it('fails closed with one safe error for ambiguous or noncanonical projections', () => {
    const owner = buildOwner();
    const otherOwner = buildOwner({
      ownerCompanyId: '33333333-3333-4333-8333-333333333333',
      code: 'BET',
      displayName: 'Beta Holdings',
      lookupKey: 'bet'
    });
    const unsafeInputs = [
      {
        boxes: [buildBox()],
        ownerCompanies: [owner, { ...owner }]
      },
      {
        boxes: [buildBox()],
        ownerCompanies: [owner, { ...otherOwner, code: owner.code, lookupKey: owner.lookupKey }]
      },
      {
        boxes: [buildBox({ ownerCompanyCode: otherOwner.code })],
        ownerCompanies: [owner, otherOwner]
      },
      {
        boxes: [
          buildBox({
            ownerCompanyId: '',
            ownerCompanyCode: '',
            ownerCompanyDisplayName: 'Display Only Owner'
          })
        ],
        ownerCompanies: [owner]
      }
    ];

    for (const input of unsafeInputs) {
      expect(() => buildOwnershipReportReadModel(input)).toThrow(OwnershipReportResolutionError);
      try {
        buildOwnershipReportReadModel(input);
      } catch (error) {
        expect((error as Error).message).toBe(
          'Owner company identities could not be resolved safely for this report.'
        );
        expect((error as Error).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
      }
    }
  });
});
