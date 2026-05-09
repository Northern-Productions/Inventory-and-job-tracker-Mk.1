// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobUsageHistorySection } from './JobUsageHistorySection';

afterEach(() => {
  cleanup();
});

describe('JobUsageHistorySection', () => {
  it('renders film order rows with concise film and LF details', () => {
    render(
      <JobUsageHistorySection
        isPhoneLayout={false}
        onOpenFilmBox={vi.fn()}
        entries={[
          {
            usageType: 'FILM_ORDER',
            occurredAt: '2026-04-22T08:00:00Z',
            actor: 'planner',
            warehouse: 'IL1',
            referenceId: 'IL1-ORDERED',
            jobNumber: '000123',
            manufacturer: '3M',
            itemName: 'Night Vision 35',
            itemCode: '',
            widthIn: 48,
            unit: 'LF',
            checkedOutQuantity: 75,
            returnedQuantity: 0,
            usedQuantity: 0,
            notes: ''
          }
        ]}
      />
    );

    expect(screen.getByText('Film Order')).toBeTruthy();
    expect(screen.getByText('3M Night Vision 35, 48"')).toBeTruthy();
    expect(screen.getByText('Ordered LF:')).toBeTruthy();
    expect(screen.getByText('75 LF')).toBeTruthy();
    expect(screen.queryByText('Leaving Weight:')).toBeNull();
  });

  it('renders completed film usage with leaving, returning, and used weight and LF details', () => {
    const onOpenFilmBox = vi.fn();

    render(
      <JobUsageHistorySection
        isPhoneLayout={false}
        onOpenFilmBox={onOpenFilmBox}
        entries={[
          {
            usageType: 'FILM',
            occurredAt: '2026-04-22T16:00:00Z',
            actor: 'warehouse',
            warehouse: 'IL1',
            referenceId: 'IL1-100',
            jobNumber: '000123',
            manufacturer: '3M',
            itemName: 'Night Vision 35',
            itemCode: '',
            widthIn: 60,
            unit: 'LF',
            checkedOutQuantity: 50,
            returnedQuantity: 38,
            usedQuantity: 12,
            checkedOutAt: '2026-04-22T10:00:00Z',
            checkedInAt: '2026-04-22T16:00:00Z',
            checkedOutWeightLbs: 20,
            checkedInWeightLbs: 18,
            weightDeltaLbs: 2,
            feetBefore: 50,
            feetAfter: 38,
            usedLinearFeet: 12,
            notes: 'returned after install'
          }
        ]}
      />
    );

    expect(screen.getByText('Film Used')).toBeTruthy();
    expect(screen.getByText('3M Night Vision 35, 60"')).toBeTruthy();
    expect(screen.getByText('Leaving Weight:')).toBeTruthy();
    expect(screen.getByText('Returning Weight:')).toBeTruthy();
    expect(screen.getByText('Weight Used:')).toBeTruthy();
    expect(screen.getByText('Leaving LF:')).toBeTruthy();
    expect(screen.getByText('Returning LF:')).toBeTruthy();
    expect(screen.getByText('LF Used:')).toBeTruthy();
    expect(screen.getAllByText('20 lbs').length).toBeGreaterThan(0);
    expect(screen.getAllByText('18 lbs').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 lbs').length).toBeGreaterThan(0);
    expect(screen.getAllByText('50 LF').length).toBeGreaterThan(0);
    expect(screen.getAllByText('38 LF').length).toBeGreaterThan(0);
    expect(screen.getAllByText('12 LF').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'IL1-100' }));
    expect(onOpenFilmBox).toHaveBeenCalledWith('IL1-100');
  });

  it('renders unknown LF instead of treating untrusted zero history as known usage', () => {
    render(
      <JobUsageHistorySection
        isPhoneLayout={false}
        onOpenFilmBox={vi.fn()}
        entries={[
          {
            usageType: 'FILM',
            occurredAt: '2026-04-22T16:00:00Z',
            actor: 'warehouse',
            warehouse: 'IL1',
            referenceId: 'IL1-100',
            manufacturer: '3M',
            itemName: 'Night Vision 35',
            itemCode: '',
            widthIn: 60,
            unit: 'LF',
            checkedOutQuantity: 0,
            returnedQuantity: 0,
            usedQuantity: 0,
            checkedOutAt: '2026-04-22T10:00:00Z',
            checkedInAt: '2026-04-22T16:00:00Z',
            checkedOutWeightLbs: null,
            checkedInWeightLbs: null,
            weightDeltaLbs: null,
            feetBefore: null,
            feetAfter: null,
            usedLinearFeet: null,
            notes: ''
          }
        ]}
      />
    );

    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('0 LF')).toBeNull();
  });

  it('renders active film checkout return values as pending when structured checkout data is present', () => {
    render(
      <JobUsageHistorySection
        isPhoneLayout={false}
        onOpenFilmBox={vi.fn()}
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
            widthIn: 60,
            unit: 'LF',
            checkedOutQuantity: 50,
            returnedQuantity: 0,
            usedQuantity: 0,
            checkedOutAt: '2026-04-22T10:00:00Z',
            checkedInAt: '',
            checkedOutWeightLbs: 20,
            checkedInWeightLbs: null,
            weightDeltaLbs: null,
            feetBefore: 50,
            feetAfter: null,
            usedLinearFeet: null,
            notes: 'WAREHOUSE_CHECKOUT: Box checked out from warehouse inventory for job 000123.'
          }
        ]}
      />
    );

    expect(screen.getByText('Film Checkout')).toBeTruthy();
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('50 LF').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20 lbs').length).toBeGreaterThan(0);
  });

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
