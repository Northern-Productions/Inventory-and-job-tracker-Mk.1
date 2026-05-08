import { describe, expect, it } from 'vitest';
import {
  buildReceiveOrderedBoxPayload,
  createOrderedBoxReceiveDraft,
  validateOrderedBoxReceiveDraft
} from './orderedBoxReceive';

describe('orderedBoxReceive', () => {
  it('creates a receive draft with the existing lot run', () => {
    expect(createOrderedBoxReceiveDraft({ lotRun: 'LR-1', coreType: 'Red plastic' })).toEqual({
      receivedWeightLbs: '',
      lotRun: 'LR-1',
      coreType: 'Red plastic'
    });
  });

  it('leaves an invalid existing core type unselected in the receive draft', () => {
    expect(createOrderedBoxReceiveDraft({ lotRun: 'LR-1', coreType: 'Unsupported core' as never })).toEqual({
      receivedWeightLbs: '',
      lotRun: 'LR-1',
      coreType: ''
    });
  });

  it('allows blank optional values', () => {
    expect(validateOrderedBoxReceiveDraft({ receivedWeightLbs: '', lotRun: '   ', coreType: '' })).toEqual({
      receivedWeightLbs: undefined,
      lotRun: '',
      coreType: ''
    });
  });

  it('rejects negative receive weights', () => {
    expect(() =>
      validateOrderedBoxReceiveDraft({ receivedWeightLbs: '-1', lotRun: '', coreType: '' })
    ).toThrow('Weight must be a valid non-negative number.');
  });

  it('rejects receive weights with more than 2 decimal places', () => {
    expect(() =>
      validateOrderedBoxReceiveDraft({ receivedWeightLbs: '5.234', lotRun: '', coreType: '' })
    ).toThrow('Weight must be a valid non-negative number with up to 2 decimal places.');
  });

  it('rejects invalid core types', () => {
    expect(() =>
      validateOrderedBoxReceiveDraft({ receivedWeightLbs: '', lotRun: '', coreType: 'Unsupported core' })
    ).toThrow('Select a core type.');
  });

  it('builds the ordered receive payload from the trimmed optional inputs', () => {
    expect(
      buildReceiveOrderedBoxPayload(
        { boxId: 'IL1-1234' },
        { receivedWeightLbs: '18.5', lotRun: '  LOT-7  ', coreType: 'Red plastic' }
      )
    ).toEqual({
      boxId: 'IL1-1234',
      receivedWeightLbs: 18.5,
      lotRun: 'LOT-7',
      coreType: 'Red plastic'
    });
  });

  it('omits blank core type from the ordered receive payload', () => {
    expect(
      buildReceiveOrderedBoxPayload(
        { boxId: 'IL1-1234' },
        { receivedWeightLbs: '', lotRun: '', coreType: '   ' }
      )
    ).toEqual({
      boxId: 'IL1-1234'
    });
  });
});
