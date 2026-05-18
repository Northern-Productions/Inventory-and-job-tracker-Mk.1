// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RollHistoryEntry } from '../../../domain';
import { RollHistoryPanel } from './RollHistoryPanel';

const useRollHistoryMock = vi.fn();

vi.mock('../hooks/useInventoryQueries', () => ({
  useRollHistory: (boxId: string) => useRollHistoryMock(boxId)
}));

vi.mock('../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

function buildRollHistoryEntry(overrides: Partial<RollHistoryEntry> = {}): RollHistoryEntry {
  return {
    logId: 'roll-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    jobNumber: '000123',
    checkedOutAt: '2026-04-22T10:00:00Z',
    checkedOutBy: 'warehouse',
    checkedOutWeightLbs: 20,
    checkedInAt: '2026-04-22T16:00:00Z',
    checkedInBy: 'warehouse',
    checkedInWeightLbs: 18,
    weightDeltaLbs: 2,
    feetBefore: 50,
    feetAfter: 38,
    notes: '',
    ...overrides
  };
}

describe('RollHistoryPanel', () => {
  beforeEach(() => {
    useRollHistoryMock.mockReset();
  });

  it('uses human-friendly leaving, returning, and used labels for roll history', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [buildRollHistoryEntry()],
      error: null
    });

    render(<RollHistoryPanel boxId="IL1-100" />);

    expect(screen.getByText('Leaving Date')).toBeTruthy();
    expect(screen.getByText('Returning Date')).toBeTruthy();
    expect(screen.getByText('Leaving Weight')).toBeTruthy();
    expect(screen.getByText('Returning Weight')).toBeTruthy();
    expect(screen.getByText('Weight Used')).toBeTruthy();
    expect(screen.getByText('Leaving LF')).toBeTruthy();
    expect(screen.getByText('Returning LF')).toBeTruthy();
    expect(screen.getByText('LF Used')).toBeTruthy();
    expect(screen.getByText('20 lbs')).toBeTruthy();
    expect(screen.getByText('18 lbs')).toBeTruthy();
    expect(screen.getByText('2 lbs')).toBeTruthy();
    expect(screen.getByText('50 LF')).toBeTruthy();
    expect(screen.getByText('38 LF')).toBeTruthy();
    expect(screen.getByText('12 LF')).toBeTruthy();
  });

  it('displays formatted roll history job labels with Work Scope when available', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildRollHistoryEntry({
          jobId: '11111111-1111-4111-8111-111111111111',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5'
        })
      ],
      error: null
    });

    render(<RollHistoryPanel boxId="IL1-100" />);

    expect(screen.getByText('IL1-000123 · Sections 4, 5')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('falls back to job number only for legacy roll history without Work Scope', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildRollHistoryEntry({
          jobId: undefined,
          jobNumber: '4953'
        })
      ],
      error: null
    });

    render(<RollHistoryPanel boxId="IL1-100" />);

    expect(screen.getByText('IL1-4953')).toBeTruthy();
    expect(screen.queryByText(/Unscoped/)).toBeNull();
  });

  it('renders untrusted zero LF history as unknown instead of known zero usage', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        buildRollHistoryEntry({
          checkedOutWeightLbs: null,
          checkedInWeightLbs: null,
          weightDeltaLbs: null,
          feetBefore: 0,
          feetAfter: 0
        })
      ],
      error: null
    });

    render(<RollHistoryPanel boxId="IL1-100" />);

    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0 LF')).toBeNull();
  });
});
