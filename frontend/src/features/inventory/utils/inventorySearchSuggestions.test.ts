import { describe, expect, it } from 'vitest';
import type { Box } from '../../../domain';
import { getInventorySearchSuggestions } from './inventorySearchSuggestions';

function createBox(overrides: Partial<Box>): Box {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    manufacturer: 'SOLYX',
    filmName: 'Frosted Stripes SXC-1418',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 50,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-03-01',
    receivedDate: '2026-03-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: 'SOLYX|FROSTED STRIPES SXC-1418',
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

describe('inventorySearchSuggestions', () => {
  it('returns the top three ranked box suggestions', () => {
    const suggestions = getInventorySearchSuggestions(
      [
        createBox({ boxId: 'exact', filmName: 'SX-1418', filmKey: 'SOLYX|SX-1418' }),
        createBox({ boxId: 'prefix', filmName: 'SX-1418 Frosted', filmKey: 'SOLYX|SX-1418 FROSTED' }),
        createBox({ boxId: 'contains', filmName: 'Frosted SX-1418', filmKey: 'SOLYX|FROSTED SX-1418' }),
        createBox({ boxId: 'subsequence', filmName: 'Frosted Stripes SXC-1418' })
      ],
      {
        warehouse: 'IL1',
        q: 'sx-1418'
      }
    );

    expect(suggestions).toEqual([
      expect.objectContaining({ boxId: 'exact' }),
      expect.objectContaining({ boxId: 'prefix' }),
      expect.objectContaining({ boxId: 'contains' })
    ]);
  });

  it('respects the active manufacturer and width filters before ranking suggestions', () => {
    const suggestions = getInventorySearchSuggestions(
      [
        createBox({ boxId: 'SOLYX-60', manufacturer: 'SOLYX', widthIn: 60 }),
        createBox({ boxId: 'SOLYX-48', manufacturer: 'SOLYX', widthIn: 48 }),
        createBox({ boxId: 'LLUMAR-60', manufacturer: 'Llumar', widthIn: 60 })
      ],
      {
        warehouse: 'IL1',
        manufacturer: 'SOLYX',
        widths: ['60'],
        q: 'sx-1418'
      }
    );

    expect(suggestions).toEqual([
      expect.objectContaining({ boxId: 'SOLYX-60' })
    ]);
  });
});
