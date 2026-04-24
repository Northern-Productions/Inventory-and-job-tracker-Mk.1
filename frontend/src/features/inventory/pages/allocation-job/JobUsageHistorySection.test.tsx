// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobUsageHistorySection } from './JobUsageHistorySection';

describe('JobUsageHistorySection', () => {
  it('renders usage notes so direct-to-site and return history stays visible in the job timeline', () => {
    const onOpenFilmBox = vi.fn();

    render(
      <JobUsageHistorySection
        isPhoneLayout={false}
        onOpenFilmBox={onOpenFilmBox}
        entries={[
          {
            usageType: 'FILM',
            occurredAt: '2026-04-22T10:00:00Z',
            actor: 'warehouse',
            warehouse: 'IL1',
            referenceId: 'IL1-100',
            manufacturer: '3M',
            itemName: 'Night Vision 35',
            itemCode: '',
            unit: 'LF',
            checkedOutQuantity: 50,
            returnedQuantity: 0,
            usedQuantity: 0,
            notes: 'DIRECT_TO_SITE_CHECKED_OUT: Box committed directly to job 000123 from Film Order FO-1.'
          }
        ]}
      />
    );

    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText(/DIRECT_TO_SITE_CHECKED_OUT/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'IL1-100' }));
    expect(onOpenFilmBox).toHaveBeenCalledWith('IL1-100');
  });
});
