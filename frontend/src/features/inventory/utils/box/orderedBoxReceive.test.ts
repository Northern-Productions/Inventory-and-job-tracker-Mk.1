import { describe, expect, it } from 'vitest';
import {
  buildReceiveOrderedBoxPayload,
  createOrderedBoxReceiveDraft,
  validateOrderedBoxReceiveDraft
} from './orderedBoxReceive';

describe('orderedBoxReceive', () => {
  it('creates a receive draft with the existing lot run', () => {
    expect(createOrderedBoxReceiveDraft({ lotRun: 'LR-1' })).toEqual({
      receivedWeightLbs: '',
      lotRun: 'LR-1'
    });
  });

  it('allows blank optional values', () => {
    expect(validateOrderedBoxReceiveDraft({ receivedWeightLbs: '', lotRun: '   ' })).toEqual({
      receivedWeightLbs: undefined,
      lotRun: ''
    });
  });

  it('rejects negative receive weights', () => {
    expect(() =>
      validateOrderedBoxReceiveDraft({ receivedWeightLbs: '-1', lotRun: '' })
    ).toThrow('Weight must be a valid non-negative number.');
  });

  it('rejects receive weights with more than 2 decimal places', () => {
    expect(() =>
      validateOrderedBoxReceiveDraft({ receivedWeightLbs: '5.234', lotRun: '' })
    ).toThrow('Weight must be a valid non-negative number with up to 2 decimal places.');
  });

  it('builds the ordered receive payload from the trimmed optional inputs', () => {
    expect(
      buildReceiveOrderedBoxPayload(
        { boxId: 'IL1-1234' },
        { receivedWeightLbs: '18.5', lotRun: '  LOT-7  ' }
      )
    ).toEqual({
      boxId: 'IL1-1234',
      receivedWeightLbs: 18.5,
      lotRun: 'LOT-7'
    });
  });
});
