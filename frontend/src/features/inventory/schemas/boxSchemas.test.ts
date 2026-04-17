import { describe, expect, it } from 'vitest';
import type { AllocationEntry, Box } from '../../../domain';
import type { BoxDraft } from '../utils/boxHelpers';
import { createEmptyBoxDraft } from '../utils/boxHelpers';
import { parseAddBoxDraft, parseUpdateBoxDraft } from './boxSchemas';

function buildDraft(overrides: Partial<BoxDraft> = {}): BoxDraft {
  const resolvedInitialFeet = overrides.initialFeet ?? '200';

  return {
    ...createEmptyBoxDraft('3M Solar'),
    boxId: 'IL1-100',
    filmName: 'Crystalline 70',
    widthIn: '48',
    initialFeet: resolvedInitialFeet,
    currentFeetOnRoll: overrides.currentFeetOnRoll ?? resolvedInitialFeet,
    feetAvailable: '200',
    orderDate: '2026-03-22',
    ...overrides
  };
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-6919',
    warehouse: 'IL1',
    manufacturer: '3M Fasara',
    filmName: 'Dusted Crystal',
    widthIn: 18,
    initialFeet: 20,
    feetAvailable: 0,
    allocationPlanningFeet: 0,
    lotRun: 'G2605505',
    status: 'IN_STOCK',
    orderDate: '2026-03-26',
    receivedDate: '2026-03-30',
    initialWeightLbs: 3.3,
    lastRollWeightLbs: 3.3,
    lastWeighedDate: '2026-03-30',
    filmKey: '3M FASARA|DUSTED CRYSTAL',
    coreType: 'Cardboard 1/8"',
    coreWeightLbs: 1.025,
    lfWeightLbsPerFt: 0.11375,
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

function buildAllocation(overrides: Partial<AllocationEntry> = {}): AllocationEntry {
  return {
    allocationId: 'ALLOC-1',
    boxId: 'IL1-6919',
    warehouse: 'IL1',
    jobNumber: 'JOB-1',
    installDate: '2026-04-01',
    crewLeader: 'Crew Lead',
    allocatedFeet: 5,
    coveredFeet: Number(overrides.coveredFeet ?? overrides.allocatedFeet ?? 5),
    allocationKind: 'REQUIREMENT',
    status: 'ACTIVE',
    createdAt: '2026-04-01T12:00:00.000Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    reservationState: 'WITH_INSTALL_DATE',
    ...overrides
  };
}

describe('boxSchemas price derivation', () => {
  it('accepts SECURITY White plastic 3/8" as a selectable core type', () => {
    const payload = parseAddBoxDraft(
      buildDraft({
        coreType: 'SECURITY White plastic 3/8"'
      })
    );

    expect(payload.coreType).toBe('SECURITY White plastic 3/8"');
  });

  it('derives add payload pricePerLf from purchaseCost and initialFeet', () => {
    const payload = parseAddBoxDraft(
      buildDraft({
        purchaseCost: '1000',
        initialFeet: '200',
        pricePerLf: '9.9999'
      })
    );

    expect(payload.purchaseCost).toBe(1000);
    expect(payload.pricePerLf).toBe(5);
  });

  it('ignores submitted pricePerLf when purchaseCost is present', () => {
    const payload = parseAddBoxDraft(
      buildDraft({
        purchaseCost: '1000',
        initialFeet: '200',
        pricePerLf: '-99'
      })
    );

    expect(payload.pricePerLf).toBe(5);
  });

  it('rounds derived pricePerLf to four decimals', () => {
    const payload = parseAddBoxDraft(
      buildDraft({
        purchaseCost: '1',
        initialFeet: '3'
      })
    );

    expect(payload.pricePerLf).toBe(0.3333);
  });

  it('derives update payload pricePerLf from purchaseCost and initialFeet', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        purchaseCost: '1000',
        initialFeet: '250',
        feetAvailable: '125',
        pricePerLf: '1.25'
      })
    );

    expect(payload.purchaseCost).toBe(1000);
    expect(payload.pricePerLf).toBe(4);
  });

  it('rejects purchaseCost when initialFeet is zero on add', () => {
    expect(() =>
      parseAddBoxDraft(
        buildDraft({
          purchaseCost: '1200',
          initialFeet: '0'
        })
      )
    ).toThrowError('PurchaseCost requires InitialFeet > 0 to derive PricePerLf.');
  });

  it('rejects purchaseCost when initialFeet is zero on update', () => {
    expect(() =>
      parseUpdateBoxDraft(
        buildDraft({
          purchaseCost: '1200',
          initialFeet: '0',
          feetAvailable: '0'
        })
      )
    ).toThrowError('PurchaseCost requires InitialFeet > 0 to derive PricePerLf.');
  });

  it('uses submitted pricePerLf when purchaseCost is empty', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        purchaseCost: '',
        pricePerLf: '4.4444'
      })
    );

    expect(payload.purchaseCost).toBeNull();
    expect(payload.pricePerLf).toBe(4.4444);
  });

  it('derives received-box feet from roll weight and locked allocations on edit', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '20',
        feetAvailable: '0',
        lastRollWeightLbs: '3.3',
        coreWeightLbs: '1.025',
        lfWeightLbsPerFt: '0.11375'
      }),
      buildBox(),
      [buildAllocation()]
    );

    expect(payload.feetAvailable).toBe(15);
  });

  it('derives first-receipt feet from initial feet minus locked allocations', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '20',
        feetAvailable: '0'
      }),
      buildBox({ receivedDate: '', status: 'ORDERED', feetAvailable: 0 }),
      [buildAllocation()]
    );

    expect(payload.feetAvailable).toBe(15);
  });

  it('falls back to the stored feet when received-box weight metadata is incomplete', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        initialFeet: '20',
        currentFeetOnRoll: '13',
        receivedDate: '2026-03-30',
        feetAvailable: '0',
        lastRollWeightLbs: '',
        coreWeightLbs: '',
        lfWeightLbsPerFt: ''
      }),
      buildBox({ feetAvailable: 13, lastRollWeightLbs: null, coreWeightLbs: null, lfWeightLbsPerFt: null }),
      []
    );

    expect(payload.feetAvailable).toBe(13);
  });

  it('preserves both explicitly edited received-box roll tracking fields', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '100',
        currentFeetOnRoll: '40',
        feetAvailable: '0',
        lastRollWeightLbs: '21',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.5',
        currentFeetOnRollManuallyEdited: true,
        lastRollWeightLbsManuallyEdited: true
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 50,
        initialWeightLbs: 51,
        lastRollWeightLbs: 26,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.5
      }),
      [buildAllocation({ allocatedFeet: 5 })]
    );

    expect(payload.currentFeetOnRoll).toBe(40);
    expect(payload.feetAvailable).toBe(35);
    expect(payload.lastRollWeightLbs).toBe(21);
  });

  it('derives received-box weight from current feet when only current feet was manually edited', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '100',
        currentFeetOnRoll: '40',
        feetAvailable: '0',
        lastRollWeightLbs: '26',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.5',
        currentFeetOnRollManuallyEdited: true
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 50,
        initialWeightLbs: 51,
        lastRollWeightLbs: 26,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.5
      }),
      [buildAllocation({ allocatedFeet: 5 })]
    );

    expect(payload.currentFeetOnRoll).toBe(40);
    expect(payload.feetAvailable).toBe(35);
    expect(payload.lastRollWeightLbs).toBe(21);
  });

  it('derives received-box current feet from roll weight when only roll weight was manually edited', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '100',
        currentFeetOnRoll: '50',
        feetAvailable: '0',
        lastRollWeightLbs: '16',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.5',
        lastRollWeightLbsManuallyEdited: true
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 50,
        initialWeightLbs: 51,
        lastRollWeightLbs: 26,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.5
      }),
      [buildAllocation({ allocatedFeet: 5 })]
    );

    expect(payload.currentFeetOnRoll).toBe(30);
    expect(payload.feetAvailable).toBe(25);
    expect(payload.lastRollWeightLbs).toBe(16);
  });

  it('keeps both received-box roll tracking fields when the submitted values are inconsistent', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '100',
        currentFeetOnRoll: '40',
        feetAvailable: '0',
        lastRollWeightLbs: '30',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.5',
        currentFeetOnRollManuallyEdited: true,
        lastRollWeightLbsManuallyEdited: true
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 50,
        initialWeightLbs: 51,
        lastRollWeightLbs: 26,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.5
      }),
      [buildAllocation({ allocatedFeet: 5 })]
    );

    expect(payload.currentFeetOnRoll).toBe(40);
    expect(payload.feetAvailable).toBe(35);
    expect(payload.lastRollWeightLbs).toBe(30);
  });

  it('does not overwrite an explicitly submitted roll weight with the stored weight', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '100',
        currentFeetOnRoll: '35',
        feetAvailable: '0',
        lastRollWeightLbs: '18',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.5',
        currentFeetOnRollManuallyEdited: true,
        lastRollWeightLbsManuallyEdited: true
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 50,
        initialWeightLbs: 51,
        lastRollWeightLbs: 26,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.5
      }),
      []
    );

    expect(payload.lastRollWeightLbs).toBe(18);
  });

  it('caps recalculated received-box feet to the new initial feet value', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        receivedDate: '2026-03-30',
        initialFeet: '10',
        feetAvailable: '0',
        lastRollWeightLbs: '15',
        coreWeightLbs: '1',
        lfWeightLbsPerFt: '0.14'
      }),
      buildBox({
        initialFeet: 100,
        feetAvailable: 90,
        lastRollWeightLbs: 15,
        coreWeightLbs: 1,
        lfWeightLbsPerFt: 0.14
      }),
      []
    );

    expect(payload.feetAvailable).toBe(10);
  });

  it('preserves stored feet for ordered boxes instead of trusting the hidden draft value', () => {
    const payload = parseUpdateBoxDraft(
      buildDraft({
        feetAvailable: '999'
      }),
      buildBox({ receivedDate: '', status: 'ORDERED', feetAvailable: 42 }),
      []
    );

    expect(payload.feetAvailable).toBe(42);
  });
});
