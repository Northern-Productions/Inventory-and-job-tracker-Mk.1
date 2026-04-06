import { describe, expect, it } from 'vitest';
import type { Box, UpdateBoxPayload } from '../../../domain';
import {
  buildZeroedInventoryPayloadForEdit,
  buildZeroedInventoryReactivationPayloadForEdit,
  buildZeroedInventoryWarningMessage,
  ZEROED_BOX_REACTIVATION_PROMPT,
  getZeroedInventoryEditTrigger,
  getIncompleteBoxHistoryFieldsForZeroedEdit,
  shouldPromptZeroedInventoryReactivationOnEdit,
  shouldPromptZeroedInventoryWarningOnEdit
} from './boxZeroedTransition';

function createBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-1234',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Ultra 70',
    widthIn: 30,
    initialFeet: 500,
    feetAvailable: 420,
    lotRun: 'LR-1',
    status: 'IN_STOCK',
    orderDate: '2026-03-20',
    receivedDate: '2026-03-21',
    initialWeightLbs: 12.5,
    lastRollWeightLbs: 11.9,
    lastWeighedDate: '2026-03-22',
    filmKey: '3m-ultra-70',
    coreType: 'Cardboard 1/8"',
    coreWeightLbs: 1.2,
    lfWeightLbsPerFt: 0.08,
    pricePerLf: 1.25,
    purchaseCost: 625,
    notes: 'Keep dry',
    hasEverBeenCheckedOut: true,
    lastCheckoutJob: '000123',
    lastCheckoutDate: '2026-03-22',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function createPayload(overrides: Partial<UpdateBoxPayload> = {}): UpdateBoxPayload {
  return {
    boxId: 'IL1-1234',
    manufacturer: '3M',
    filmName: 'Ultra 70',
    widthIn: 30,
    initialFeet: 500,
    feetAvailable: 420,
    lotRun: 'LR-1',
    orderDate: '2026-03-20',
    receivedDate: '2026-03-21',
    initialWeightLbs: 12.5,
    lastRollWeightLbs: 0,
    lastWeighedDate: '2026-03-22',
    filmKey: '',
    coreType: 'Cardboard 1/8"',
    coreWeightLbs: 1.2,
    lfWeightLbsPerFt: 0.08,
    pricePerLf: 1.25,
    purchaseCost: 625,
    notes: 'Keep dry',
    ...overrides
  };
}

describe('boxZeroedTransition', () => {
  it('prompts when Last Roll Weight is 0 and any required history field is missing', () => {
    const currentBox = createBox({ receivedDate: '' });
    const payload = createPayload();

    expect(getZeroedInventoryEditTrigger(currentBox, payload)).toBe('lastRollWeight');
    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(true);
    expect(getIncompleteBoxHistoryFieldsForZeroedEdit(currentBox, payload)).toContain('Received Date');
  });

  it('prompts when a received box is edited to 0 linear feet and preserves the original starting footage', () => {
    const currentBox = createBox({ initialFeet: 500, feetAvailable: 420 });
    const payload = createPayload({ initialFeet: 0, feetAvailable: 420, lastRollWeightLbs: 11.9 });

    expect(getZeroedInventoryEditTrigger(currentBox, payload)).toBe('linearFeet');
    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(true);
    expect(buildZeroedInventoryPayloadForEdit(currentBox, payload, 'linearFeet')).toMatchObject({
      initialFeet: 500,
      feetAvailable: 0,
      moveToZeroed: true,
      auditNote: 'Confirmed zero Linear Feet edit save'
    });
  });

  it('prompts zeroed boxes for reactivation when weight returns above 0 even if available feet stays 0', () => {
    const currentBox = createBox({ status: 'ZEROED', initialFeet: 500, feetAvailable: 0 });
    const payload = createPayload({ initialFeet: 500, feetAvailable: 0, lastRollWeightLbs: 11.9 });

    expect(getZeroedInventoryEditTrigger(currentBox, payload)).toBeNull();
    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(false);
    expect(shouldPromptZeroedInventoryReactivationOnEdit(currentBox, payload)).toBe(true);
    expect(buildZeroedInventoryReactivationPayloadForEdit(payload)).toMatchObject({
      reactivateFromZeroed: true,
      auditNote: 'Confirmed zeroed box reactivation edit save'
    });
  });

  it('prompts zeroed boxes for reactivation when positive available feet is entered', () => {
    const currentBox = createBox({ status: 'ZEROED', initialFeet: 500, feetAvailable: 0 });
    const payload = createPayload({ initialFeet: 500, feetAvailable: 24, lastRollWeightLbs: 11.9 });

    expect(getZeroedInventoryEditTrigger(currentBox, payload)).toBeNull();
    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(false);
    expect(shouldPromptZeroedInventoryReactivationOnEdit(currentBox, payload)).toBe(true);
    expect(buildZeroedInventoryReactivationPayloadForEdit(payload)).toMatchObject({
      reactivateFromZeroed: true,
      auditNote: 'Confirmed zeroed box reactivation edit save'
    });
  });

  it('does not prompt zeroed boxes for reactivation when only historical initial feet remain', () => {
    const currentBox = createBox({ status: 'ZEROED', initialFeet: 500, feetAvailable: 0 });
    const payload = createPayload({ initialFeet: 500, feetAvailable: 0, lastRollWeightLbs: 0 });

    expect(shouldPromptZeroedInventoryReactivationOnEdit(currentBox, payload)).toBe(false);
  });

  it('prompts when the current saved box is incomplete even if the submitted values fill the gap', () => {
    const currentBox = createBox({ coreWeightLbs: null });
    const payload = createPayload({ coreWeightLbs: 1.2 });

    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(true);
    expect(getIncompleteBoxHistoryFieldsForZeroedEdit(currentBox, payload)).toContain('Core Weight');
  });

  it('prompts when the submitted values remain incomplete even if the current box is complete', () => {
    const currentBox = createBox();
    const payload = createPayload({ lastWeighedDate: '' });

    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(true);
    expect(getIncompleteBoxHistoryFieldsForZeroedEdit(currentBox, payload)).toContain(
      'Last Weighed Date'
    );
  });

  it('does not prompt for blank, null, or non-zero Last Roll Weight values', () => {
    const currentBox = createBox({ receivedDate: '' });

    expect(
      shouldPromptZeroedInventoryWarningOnEdit(currentBox, createPayload({ lastRollWeightLbs: null }))
    ).toBe(false);
    expect(
      shouldPromptZeroedInventoryWarningOnEdit(currentBox, createPayload({ lastRollWeightLbs: 1 }))
    ).toBe(false);
  });

  it('does not prompt when both current and submitted history are complete, and builds the warning copy', () => {
    const currentBox = createBox();
    const payload = createPayload();
    const message = buildZeroedInventoryWarningMessage(['Received Date', 'Core Weight']);
    const zeroLinearFeetMessage = buildZeroedInventoryWarningMessage([], 'linearFeet');

    expect(shouldPromptZeroedInventoryWarningOnEdit(currentBox, payload)).toBe(false);
    expect(ZEROED_BOX_REACTIVATION_PROMPT).toBe(
      'Do you want to move this box back to the active IN_STOCK inventory?'
    );
    expect(message).toContain('Received Date and Core Weight');
    expect(message).toContain('move the box to zeroed inventory');
    expect(message).toContain('cancel any active allocations');
    expect(zeroLinearFeetMessage).toContain('saving Linear Feet as 0');
    expect(zeroLinearFeetMessage).toContain('preserve its original starting footage');
  });
});
