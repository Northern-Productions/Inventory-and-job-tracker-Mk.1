// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobFilmTransferAlert } from '../../../../domain';
import { FilmTransferAlertsPanel } from './FilmTransferAlertsPanel';

function buildAlert(overrides: Partial<JobFilmTransferAlert> = {}): JobFilmTransferAlert {
  return {
    boxId: 'MS1-505',
    sourceWarehouse: 'MS1',
    destinationWarehouse: 'IL1',
    state: 'NEEDS_TRANSFER',
    ...overrides
  };
}

describe('FilmTransferAlertsPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps historical needs-transfer alerts review-only', () => {
    const onStartTransfer = vi.fn();
    render(
      <FilmTransferAlertsPanel
        alerts={[buildAlert()]}
        jobWarehouse="IL1"
        onOpenBox={vi.fn()}
        onStartTransfer={onStartTransfer}
      />
    );

    expect(screen.queryByRole('button', { name: 'Start Transfer' })).toBeNull();
    expect(onStartTransfer).not.toHaveBeenCalled();
  });

  it('shows cancel transfer for pending transfer alerts', () => {
    const onCancelTransfer = vi.fn();
    render(
      <FilmTransferAlertsPanel
        alerts={[buildAlert({ state: 'TRANSFER_PENDING', transferId: 'TRF-505' })]}
        jobWarehouse="IL1"
        onOpenBox={vi.fn()}
        onCancelTransfer={onCancelTransfer}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Transfer' }));

    expect(onCancelTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        boxId: 'MS1-505',
        transferId: 'TRF-505',
        state: 'TRANSFER_PENDING'
      })
    );
  });

  it('shows a row-scoped loading state for transfer actions', () => {
    render(
      <FilmTransferAlertsPanel
        alerts={[buildAlert({ state: 'TRANSFER_REVIEW_REQUIRED', transferId: 'TRF-505' })]}
        jobWarehouse="IL1"
        onOpenBox={vi.fn()}
        onCancelTransfer={vi.fn()}
        actionBoxId="MS1-505"
        actionPending
      />
    );

    const button = screen.getByRole('button', { name: /Cancelling/ });
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
