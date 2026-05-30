import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Box } from '../../../domain';
import {
  buildLabelDraftFromBox,
  buildLabelDraftWarnings,
  getLabelJobIdFromBox,
  getLabelBoxId,
  getMissingRequiredLabelFields,
  type LabelDraft
} from './labelMaker';

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'MO1-0028',
    warehouse: 'MO1',
    dealer: '',
    manufacturer: 'Llumar',
    filmName: 'DR 15',
    widthIn: 48,
    initialFeet: 100,
    feetAvailable: 87,
    physicalFeetAvailable: 92,
    allocatableNowFeet: 87,
    allocationPlanningFeet: 87,
    lotRun: '405G021',
    status: 'IN_STOCK',
    orderDate: '2026-04-01',
    receivedDate: '2026-04-02',
    initialWeightLbs: 10.25,
    lastRollWeightLbs: 8.15,
    lastWeighedDate: '2026-04-29',
    filmKey: '',
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

describe('label maker mapping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the exact LabelDraft shape from a box', () => {
    const draft = buildLabelDraftFromBox(buildBox());
    const expectedKeys: Array<keyof LabelDraft> = [
      'date',
      'jobId',
      'weightLbs',
      'by',
      'balance',
      'checked',
      'filmName',
      'width',
      'boxId',
      'runNumber'
    ];

    expect(Object.keys(draft).sort()).toEqual([...expectedKeys].sort());
    expect(draft).toEqual({
      date: '05/03/2026',
      jobId: '',
      weightLbs: '8.15',
      by: '',
      balance: '92',
      checked: '',
      filmName: 'Llumar DR 15',
      width: '48"',
      boxId: '0028',
      runNumber: '405G021'
    });
  });

  it('uses current date and does not fall back to received date or initial weight', () => {
    const draft = buildLabelDraftFromBox(
      buildBox({
        lastWeighedDate: '',
        receivedDate: '2026-04-15',
        lastRollWeightLbs: null,
        initialWeightLbs: 11.5,
        physicalFeetAvailable: null,
        feetAvailable: 74
      })
    );

    expect(draft.date).toBe('05/03/2026');
    expect(draft.weightLbs).toBe('');
    expect(draft.balance).toBe('74');
  });

  it('uses derived physical current feet for balance instead of available or allocatable feet', () => {
    const draft = buildLabelDraftFromBox(
      buildBox({
        initialFeet: 100,
        feetAvailable: 99,
        physicalFeetAvailable: 99,
        allocatableNowFeet: 99,
        allocationPlanningFeet: 99,
        lastRollWeightLbs: 24.65,
        coreWeightLbs: 1.3333,
        lfWeightLbsPerFt: 0.233167
      })
    );

    expect(draft.balance).toBe('100');
  });

  it('prefills job id from one canonical ordered job origin', () => {
    const box = buildBox({
      orderedForJobs: [
        {
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '4953',
          workScope: 'Lobby',
          filmOrderId: 'FO-4953'
        }
      ]
    });

    expect(getLabelJobIdFromBox(box)).toBe('4953');
    expect(buildLabelDraftFromBox(box).jobId).toBe('4953');
  });

  it('does not guess a job id when ordered origins are ambiguous', () => {
    const box = buildBox({
      orderedForJobs: [
        { jobId: 'job-a', jobNumber: '7777', workScope: 'North', filmOrderId: 'FO-A' },
        { jobId: 'job-b', jobNumber: '7777', workScope: 'South', filmOrderId: 'FO-B' }
      ]
    });
    const draft = buildLabelDraftFromBox(box);

    expect(draft.jobId).toBe('');
    expect(buildLabelDraftWarnings(box, draft)).toContain(
      'Box is tied to multiple jobs. Enter the Job ID manually.'
    );
  });

  it('uses current feet only and does not fall back to initial feet', () => {
    const draft = buildLabelDraftFromBox(
      buildBox({
        initialFeet: 100,
        feetAvailable: Number.NaN,
        physicalFeetAvailable: null
      })
    );

    expect(draft.balance).toBe('');
  });

  it('preserves local numeric Box ID suffixes and leading zeros', () => {
    expect(getLabelBoxId(buildBox({ boxId: 'MO1-0028', warehouse: 'MO1' }))).toBe('0028');
    expect(getLabelBoxId(buildBox({ boxId: '0029', warehouse: 'MO1' }))).toBe('0029');
  });

  it('returns non-blocking warnings for missing important label data', () => {
    const box = buildBox({
      manufacturer: '',
      filmName: '',
      widthIn: Number.NaN,
      lotRun: '',
      initialWeightLbs: null,
      lastRollWeightLbs: null
    });
    const draft = buildLabelDraftFromBox(box);

    expect(buildLabelDraftWarnings(box, draft)).toEqual(
      expect.arrayContaining([
        'Width is missing. Confirm the label width before printing.',
        'Run number is missing.',
        'Film name is missing.',
        "Doesn't have weight."
      ])
    );
  });

  it('treats only label-critical fields as required', () => {
    const draft = buildLabelDraftFromBox(buildBox());

    expect(getMissingRequiredLabelFields({
      ...draft,
      jobId: '',
      by: '',
      checked: '',
      runNumber: ''
    })).toEqual([]);
    expect(getMissingRequiredLabelFields({ ...draft, weightLbs: '', balance: '' })).toEqual([
      'weightLbs',
      'balance'
    ]);
  });
});
