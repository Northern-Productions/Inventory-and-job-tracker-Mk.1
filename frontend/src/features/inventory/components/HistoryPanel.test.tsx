// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RollHistoryEntry } from '../../../domain';
import { HistoryPanel } from './HistoryPanel';

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
    notes: 'Returned after install',
    ...overrides
  };
}

describe('HistoryPanel', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useRollHistoryMock.mockReset();
  });

  it('renders usage and check-in history without raw audit columns', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [buildRollHistoryEntry()],
      error: null
    });

    render(<HistoryPanel boxId="IL1-100" />);

    expect(screen.getByText('Date')).toBeTruthy();
    expect(screen.getByText('Job Number')).toBeTruthy();
    expect(screen.getByText('LF Used')).toBeTruthy();
    expect(screen.getByText('Crew Leader')).toBeTruthy();
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('000123')).toBeTruthy();
    expect(screen.getByText('12 LF')).toBeTruthy();
    expect(screen.getByText('Returned after install')).toBeTruthy();
    expect(screen.queryByText('Action')).toBeNull();
    expect(screen.queryByText('User')).toBeNull();
    expect(screen.queryByText('SET_STATUS')).toBeNull();
  });

  it('renders an empty state for boxes without usage history', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
      error: null
    });

    render(<HistoryPanel boxId="IL1-100" />);

    expect(screen.getByText('No usage or check-in history yet.')).toBeTruthy();
  });

  it('supports the default-collapsed Box Details card state', () => {
    useRollHistoryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [buildRollHistoryEntry()],
      error: null
    });

    render(<HistoryPanel boxId="IL1-100" collapsed onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Expand history' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(document.getElementById('history-panel-body-IL1-100')?.hidden).toBe(true);
  });
});
