import { describe, expect, it } from 'vitest';
import type { BoxDraft } from '../utils/boxHelpers';
import { createEmptyBoxDraft } from '../utils/boxHelpers';
import { parseAddBoxDraft, parseUpdateBoxDraft } from './boxSchemas';

function buildDraft(overrides: Partial<BoxDraft> = {}): BoxDraft {
  return {
    ...createEmptyBoxDraft('3M Solar'),
    boxId: 'IL1-100',
    filmName: 'Crystalline 70',
    widthIn: '48',
    initialFeet: '200',
    feetAvailable: '200',
    orderDate: '2026-03-22',
    ...overrides
  };
}

describe('boxSchemas price derivation', () => {
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
});
