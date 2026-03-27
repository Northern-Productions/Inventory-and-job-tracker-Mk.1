import { describe, expect, it } from 'vitest';
import { dedupeBoxesByDisplayBoxId } from './boxIds';

describe('boxIds', () => {
  it('dedupes repeated display ids by preferring canonical warehouse-prefixed records', () => {
    const boxes = [
      { boxId: '6895', warehouse: 'IL1' as const, manufacturer: 'Legacy' },
      { boxId: 'IL1-6895', warehouse: 'IL1' as const, manufacturer: 'Canonical' }
    ];

    expect(dedupeBoxesByDisplayBoxId(boxes)).toEqual([
      { boxId: 'IL1-6895', warehouse: 'IL1', manufacturer: 'Canonical' }
    ]);
  });

  it('prefers legacy-prefixed ids over bare ids when no canonical row exists yet', () => {
    const boxes = [
      { boxId: '6881', warehouse: 'IL1' as const },
      { boxId: 'IL-6881', warehouse: 'IL1' as const }
    ];

    expect(dedupeBoxesByDisplayBoxId(boxes)).toEqual([{ boxId: 'IL-6881', warehouse: 'IL1' }]);
  });

  it('keeps same suffixes from different warehouses as separate boxes', () => {
    const boxes = [
      { boxId: '6895', warehouse: 'IL1' as const },
      { boxId: '6895', warehouse: 'MS1' as const }
    ];

    expect(dedupeBoxesByDisplayBoxId(boxes)).toEqual(boxes);
  });
});
