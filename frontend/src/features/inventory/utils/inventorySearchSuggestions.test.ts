import { describe, expect, it } from 'vitest';
import type { Box } from '../../../domain';
import { filterOfflineBoxes } from '../../../lib/offlineInventory';
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
    allocationPlanningFeet: 50,
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
  it('returns the top three ranked distinct film-name suggestions', () => {
    const suggestions = getInventorySearchSuggestions(
      [
        createBox({ boxId: 'exact', filmName: 'SX-1418', filmKey: 'SOLYX|SX-1418' }),
        createBox({ boxId: 'exact-duplicate', filmName: 'SX-1418', filmKey: 'SOLYX|SX-1418' }),
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
      expect.objectContaining({ suggestionKey: 'sx-1418', filmName: 'SX-1418' }),
      expect.objectContaining({ suggestionKey: 'sx-1418 frosted', filmName: 'SX-1418 Frosted' }),
      expect.objectContaining({ suggestionKey: 'frosted sx-1418', filmName: 'Frosted SX-1418' })
    ]);
  });

  it('respects the active manufacturer, width, and status filters before deduping suggestions', () => {
    const suggestions = getInventorySearchSuggestions(
      [
        createBox({ boxId: 'SOLYX-60-A', manufacturer: 'SOLYX', widthIn: 60, filmName: 'SX-1418' }),
        createBox({ boxId: 'SOLYX-60-B', manufacturer: 'SOLYX', widthIn: 60, filmName: 'SX-1418' }),
        createBox({ boxId: 'SOLYX-48', manufacturer: 'SOLYX', widthIn: 48, filmName: 'SX-1418' }),
        createBox({ boxId: 'SOLYX-60-ORDERED', manufacturer: 'SOLYX', widthIn: 60, filmName: 'SX-1418', status: 'ORDERED' }),
        createBox({ boxId: 'LLUMAR-60', manufacturer: 'Llumar', widthIn: 60, filmName: 'SX-1418' })
      ],
      {
        warehouse: 'IL1',
        manufacturer: 'SOLYX',
        widths: ['60'],
        status: 'IN_STOCK',
        q: 'sx-1418'
      }
    );

    expect(suggestions).toEqual([
      expect.objectContaining({ suggestionKey: 'sx-1418', filmName: 'SX-1418' })
    ]);
  });

  it('lets a selected film-name suggestion surface all matching boxes for that film name', () => {
    const boxes = [
      createBox({
        boxId: 'IL1-6391',
        manufacturer: '3M Fasara',
        filmName: 'Milky Milky Blue Gray SH2MAMMB',
        filmKey: '3M FASARA|MILKY MILKY BLUE GRAY SH2MAMMB',
        widthIn: 50
      }),
      createBox({
        boxId: 'IL1-6851',
        manufacturer: '3M Fasara',
        filmName: 'Milky Milky Blue Gray SH2MAMMB',
        filmKey: '3M FASARA|MILKY MILKY BLUE GRAY SH2MAMMB',
        widthIn: 50
      }),
      createBox({
        boxId: 'IL1-7000',
        manufacturer: '3M Fasara',
        filmName: 'San Marino Milky SH2MAMM',
        filmKey: '3M FASARA|SAN MARINO MILKY SH2MAMM',
        widthIn: 50
      })
    ];

    const [selectedSuggestion] = getInventorySearchSuggestions(boxes, {
      warehouse: 'IL1',
      q: 'milky blue'
    });

    expect(selectedSuggestion).toEqual(
      expect.objectContaining({ filmName: 'Milky Milky Blue Gray SH2MAMMB' })
    );

    const filteredBoxes = filterOfflineBoxes(boxes, {
      warehouse: 'IL1',
      q: selectedSuggestion.filmName
    });

    expect(filteredBoxes).toHaveLength(2);
    expect(filteredBoxes.map((box) => box.boxId)).toEqual(['IL1-6391', 'IL1-6851']);
  });
});
