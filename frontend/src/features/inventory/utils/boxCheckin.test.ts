import { describe, expect, it } from 'vitest';
import type { Box } from '../../../domain';
import {
  buildFilmCheckinPayload,
  createFilmCheckinDraft
} from './boxHelpers';

function createBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'MS1-919',
    warehouse: 'MS1',
    manufacturer: '3M Fasara',
    filmName: 'Milano Milky White SH2MAML',
    widthIn: 50,
    initialFeet: 45,
    feetAvailable: 5,
    allocationPlanningFeet: 5,
    lotRun: '108442367A',
    status: 'CHECKED_OUT',
    orderDate: '2023-07-31',
    receivedDate: '2023-07-31',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3M FASARA|MILANO MILKY WHITE SH2MAML',
    coreType: 'Red plastic',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: true,
    lastCheckoutJob: '4580',
    lastCheckoutDate: '2026-04-15',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

describe('boxCheckin helpers', () => {
  it('always creates a blank returned-weight draft instead of reusing the prior weight', () => {
    expect(createFilmCheckinDraft(createBox({ lastRollWeightLbs: 7.25 }))).toEqual({
      lastRollWeightLbs: ''
    });
  });

  it('builds a weight-only check-in payload when saved calibration is present', () => {
    const payload = buildFilmCheckinPayload(
      createBox({
        coreWeightLbs: 1.2847,
        lfWeightLbsPerFt: 0.108174
      }),
      {
        lastRollWeightLbs: '3.34'
      }
    );

    expect(payload).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      auditNote: 'Checked in at 3.34 lbs'
    });
  });

  it('does not send LF or core overrides when calibration must self-heal on the server', () => {
    const box = createBox({
      coreType: 'Red plastic',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null
    });
    const draft = createFilmCheckinDraft(box);
    draft.lastRollWeightLbs = '3.34';

    const payload = buildFilmCheckinPayload(box, draft);

    expect(payload).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      auditNote: 'Checked in at 3.34 lbs'
    });
    expect(payload).not.toHaveProperty('currentFeetOnRoll');
    expect(payload).not.toHaveProperty('coreType');
  });

  it('uses the same weight-only contract for direct-to-site first returns', () => {
    const box = createBox({
      receivedDate: '',
      directToJobSite: true,
      lastRollWeightLbs: null,
      coreWeightLbs: null,
      lfWeightLbsPerFt: null
    });

    expect(
      buildFilmCheckinPayload(box, {
        lastRollWeightLbs: '3.34'
      })
    ).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      auditNote: 'Checked in at 3.34 lbs'
    });
  });

  it('requires a returned weight', () => {
    expect(() =>
      buildFilmCheckinPayload(createBox(), {
        lastRollWeightLbs: ''
      })
    ).toThrow('Returned Roll Weight is required.');
  });

  it('rejects negative returned weight without consulting LF or core data', () => {
    expect(() =>
      buildFilmCheckinPayload(createBox(), {
        lastRollWeightLbs: '-0.01'
      })
    ).toThrow('Returned Roll Weight must be a valid non-negative number.');
  });
});
