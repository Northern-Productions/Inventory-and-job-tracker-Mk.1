import { describe, expect, it } from 'vitest';
import type { Box } from '../../../domain';
import {
  buildFilmCheckinPayload,
  checkInNeedsCurrentFeet,
  createFilmCheckinDraft,
  requiresFirstReturnCalibration
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
  it('keeps the normal weight-only check-in payload when feet can already be derived from weight', () => {
    const payload = buildFilmCheckinPayload(
      createBox({
        coreWeightLbs: 1.2847,
        lfWeightLbsPerFt: 0.108174
      }),
      {
        lastRollWeightLbs: '3.34',
        currentFeetOnRoll: '',
        coreType: ''
      }
    );

    expect(checkInNeedsCurrentFeet(createBox({ coreWeightLbs: 1.2847, lfWeightLbsPerFt: 0.108174 }))).toBe(false);
    expect(payload).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      auditNote: 'Checked in at 3.34 lbs'
    });
  });

  it('includes current feet but omits an unchanged core type during missing-initial-weight calibration', () => {
    const box = createBox({
      coreType: 'Red plastic',
      coreWeightLbs: null,
      lfWeightLbsPerFt: null
    });
    const draft = createFilmCheckinDraft(box);
    draft.lastRollWeightLbs = '3.34';
    draft.currentFeetOnRoll = '19';

    const payload = buildFilmCheckinPayload(box, draft);

    expect(checkInNeedsCurrentFeet(box)).toBe(true);
    expect(payload).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 19,
      auditNote: 'Checked in at 3.34 lbs with 19 LF remaining'
    });
  });

  it('treats direct-to-site first returns without a received date as required calibration', () => {
    const box = createBox({
      receivedDate: '',
      directToJobSite: true,
      lastRollWeightLbs: null,
      coreWeightLbs: null,
      lfWeightLbsPerFt: null
    });

    expect(requiresFirstReturnCalibration(box)).toBe(true);
    expect(checkInNeedsCurrentFeet(box)).toBe(true);
    expect(
      buildFilmCheckinPayload(box, {
        lastRollWeightLbs: '3.34',
        currentFeetOnRoll: '19',
        coreType: ''
      })
    ).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 19,
      auditNote: 'Checked in at 3.34 lbs with 19 LF remaining'
    });
  });

  it('includes a submitted core type when calibration needs it', () => {
    const payload = buildFilmCheckinPayload(
      createBox({
        coreType: '',
        coreWeightLbs: null,
        lfWeightLbsPerFt: null
      }),
      {
        lastRollWeightLbs: '3.34',
        currentFeetOnRoll: '19',
        coreType: 'Red plastic'
      }
    );

    expect(payload).toEqual({
      boxId: 'MS1-919',
      status: 'IN_STOCK',
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 19,
      coreType: 'Red plastic',
      auditNote: 'Checked in at 3.34 lbs with 19 LF remaining'
    });
  });

  it('rejects impossible zero-foot returns that still have weight on the roll', () => {
    expect(() =>
      buildFilmCheckinPayload(createBox(), {
        lastRollWeightLbs: '3.34',
        currentFeetOnRoll: '0',
        coreType: 'Red plastic'
      })
    ).toThrow('Current Linear Feet cannot be 0 while Last Roll Weight is still above 0.');
  });

  it('rejects positive-foot calibration when no core type can be resolved', () => {
    expect(() =>
      buildFilmCheckinPayload(
        createBox({
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null
        }),
        {
          lastRollWeightLbs: '3.34',
          currentFeetOnRoll: '19',
          coreType: ''
        }
      )
    ).toThrow('Core Type is required before this return can establish future weight-based LF math.');
  });
});
