import { describe, expect, it } from 'vitest';
import {
  addOptimisticLinkedBoxToFilmOrder,
  deriveFilmOrderStatusFromLinkedBoxes,
  formatFilmOrderDealerLabel,
  formatFilmOrderLinkedBoxIds,
  formatFilmOrderOriginLabel,
  getFilmOrderDealerNames,
  getFilmOrderLinkedBoxes,
  getFilmOrderLinkedBoxIds,
  getNextFilmOrderLinkedBoxToReceive,
  getFilmOrderOrigin,
  getFilmOrderOriginSourceBoxId,
  hasFilmOrdersNeedingAttention,
  hasFilmOrderInstallDate,
  isFilmOrderNeedingAttention,
  markFilmOrderLinkedBoxReceived
} from './filmOrders';

describe('filmOrders helpers', () => {
  it('treats scheduled film orders that still need ordering as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 24,
        installDate: '2026-04-13'
      })
    ).toBe(true);
  });

  it('does not treat unscheduled film orders as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 24
      })
    ).toBe(false);
    expect(
      hasFilmOrderInstallDate({
        installDate: '   '
      })
    ).toBe(false);
  });

  it('does not treat film that is already on the way as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ON_THE_WAY',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
  });

  it('ignores resolved film orders even when they still have an install date', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FULFILLED',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
    expect(
      hasFilmOrdersNeedingAttention([
        {
          status: 'CANCELLED',
          remainingToOrderFeet: 0,
          installDate: '2026-04-13'
        }
      ])
    ).toBe(false);
  });

  it('does not treat zero remaining film-order shortages as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
  });

  it('derives auto-shortage origin from the source box when the API payload does not spell it out', () => {
    expect(getFilmOrderOrigin({ sourceBoxId: 'IL1-6923' })).toBe('AUTO_SHORTAGE');
    expect(formatFilmOrderOriginLabel({ sourceBoxId: 'IL1-6923' })).toBe('Auto shortage');
    expect(getFilmOrderOriginSourceBoxId({ sourceBoxId: 'IL1-6923' })).toBe('IL1-6923');
  });

  it('preserves explicit manual origin and hides the source box helper text', () => {
    expect(getFilmOrderOrigin({ origin: 'MANUAL', sourceBoxId: 'IL1-6923' })).toBe('MANUAL');
    expect(formatFilmOrderOriginLabel({ origin: 'MANUAL', sourceBoxId: '' })).toBe('Manual');
    expect(getFilmOrderOriginSourceBoxId({ origin: 'MANUAL', sourceBoxId: '' })).toBe('');
  });

  it('returns an empty linked-box list and placeholder when no ordered boxes are linked', () => {
    expect(getFilmOrderLinkedBoxIds({ linkedBoxes: [] })).toEqual([]);
    expect(formatFilmOrderLinkedBoxIds({ linkedBoxes: [] })).toBe('--');
  });

  it('returns the linked box id when a film order has one ordered box', () => {
    expect(
      getFilmOrderLinkedBoxIds({
        linkedBoxes: [
          {
            boxId: 'IL1-0042',
            dealer: 'Eastman Performance Films',
            orderedFeet: 42,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toEqual(['IL1-0042']);
    expect(
      formatFilmOrderLinkedBoxIds({
        linkedBoxes: [
          {
            boxId: 'IL1-0042',
            dealer: 'Eastman Performance Films',
            orderedFeet: 42,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toBe('IL1-0042');
  });

  it('preserves received state while normalizing linked ordered boxes for display', () => {
    expect(
      getFilmOrderLinkedBoxes({
        linkedBoxes: [
          {
            boxId: ' il1-0042 ',
            dealer: 'Eastman Performance Films',
            orderedFeet: 42,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0042',
            dealer: 'Eastman Performance Films',
            orderedFeet: 12,
            autoAllocatedFeet: 0,
            isReceived: true
          },
          {
            boxId: 'MS1-0100',
            dealer: 'Accent',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toEqual([
      { boxId: 'IL1-0042', isReceived: true },
      { boxId: 'MS1-0100', isReceived: false }
    ]);
  });

  it('normalizes, dedupes, and sorts linked ordered box ids for stable display', () => {
    expect(
      getFilmOrderLinkedBoxIds({
        linkedBoxes: [
          {
            boxId: ' ms1-0100 ',
            dealer: 'Accent',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'Decorative Films',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: true
          },
          {
            boxId: 'il1-0001',
            dealer: 'Eastman Performance Films',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'Decorative Films',
            orderedFeet: 5,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: '',
            dealer: '',
            orderedFeet: 0,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toEqual(['IL1-0001', 'IL1-0002', 'MS1-0100']);
    expect(
      formatFilmOrderLinkedBoxIds({
        linkedBoxes: [
          {
            boxId: ' ms1-0100 ',
            dealer: 'Accent',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'Decorative Films',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'il1-0001',
            dealer: 'Eastman Performance Films',
            orderedFeet: 10,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'Decorative Films',
            orderedFeet: 5,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toBe('IL1-0001, IL1-0002, MS1-0100');
  });

  it('formats unique linked-box dealers for display', () => {
    expect(
      getFilmOrderDealerNames({
        linkedBoxes: [
          {
            boxId: 'IL1-0001',
            dealer: 'Eastman Performance Films',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'accent',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0003',
            dealer: 'Accent',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toEqual(['Eastman Performance Films', 'accent']);
    expect(
      formatFilmOrderDealerLabel({
        linkedBoxes: [
          {
            boxId: 'IL1-0001',
            dealer: 'Eastman Performance Films',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0002',
            dealer: 'Accent',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toBe('Eastman Performance Films, Accent');
    expect(formatFilmOrderDealerLabel({ linkedBoxes: [] })).toBe('--');
  });

  it('selects the next unreceived linked box in display order', () => {
    expect(
      getNextFilmOrderLinkedBoxToReceive({
        linkedBoxes: [
          {
            boxId: 'IL1-0002',
            dealer: 'Accent',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: true
          },
          {
            boxId: 'IL1-0003',
            dealer: 'Decorative Films',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          },
          {
            boxId: 'IL1-0001',
            dealer: 'Eastman Performance Films',
            orderedFeet: 30,
            autoAllocatedFeet: 0,
            isReceived: false
          }
        ]
      })
    ).toEqual({
      boxId: 'IL1-0001',
      isReceived: false
    });
  });

  it('derives on-the-way and fulfilled states from linked box receipt progress', () => {
    const withLinkedBox = addOptimisticLinkedBoxToFilmOrder(
      {
        filmOrderId: 'FO-1',
        jobNumber: '2941',
        warehouse: 'IL1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requestedFeet: 30,
        coveredFeet: 0,
        orderedFeet: 0,
        remainingToOrderFeet: 30,
        installDate: '2026-04-18',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        sourceBoxId: '',
        origin: 'MANUAL',
        createdAt: '2026-04-18T10:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
        linkedBoxes: []
      },
      {
        boxId: 'IL1-0001',
        dealer: 'Accent',
        orderedFeet: 30
      }
    );

    expect(withLinkedBox.status).toBe('FILM_ON_THE_WAY');
    expect(withLinkedBox.linkedBoxes[0]).toEqual({
      boxId: 'IL1-0001',
      dealer: 'Accent',
      orderedFeet: 30,
      autoAllocatedFeet: 0,
      isReceived: false
    });

    const receivedOrder = markFilmOrderLinkedBoxReceived(withLinkedBox, 'IL1-0001', {
      actor: 'Pending...',
      now: '2026-04-18T12:00:00Z'
    });
    expect(receivedOrder.status).toBe('FULFILLED');
    expect(receivedOrder.resolvedAt).toBe('2026-04-18T12:00:00Z');
    expect(receivedOrder.resolvedBy).toBe('Pending...');

    expect(
      deriveFilmOrderStatusFromLinkedBoxes({
        ...receivedOrder,
        status: 'FILM_ON_THE_WAY'
      })
    ).toEqual({
      status: 'FULFILLED',
      resolvedAt: '2026-04-18T12:00:00Z',
      resolvedBy: 'Pending...'
    });
  });
});
