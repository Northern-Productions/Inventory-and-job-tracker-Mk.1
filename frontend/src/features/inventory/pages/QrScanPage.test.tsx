// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QrScanPage from './QrScanPage';
import { getBox } from '../../../api/features/inventoryClient';

const navigateMock = vi.fn();
let scannedCode = 'IL1-100';

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}));

vi.mock('../../../api/features/inventoryClient', () => ({
  getBox: vi.fn()
}));

vi.mock('../components/QrScanner', () => ({
  QrScanner: ({ onResolved }: { onResolved: (code: string) => Promise<boolean> | boolean }) => (
    <button type="button" onClick={() => void onResolved(scannedCode)}>
      Resolve scan
    </button>
  )
}));

const getBoxMock = vi.mocked(getBox);

describe('QrScanPage scan routing', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    navigateMock.mockReset();
    getBoxMock.mockReset();
    scannedCode = 'IL1-100';
  });

  it('routes a checked-out box with canonical job identity to Job Details check-in workflow', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
      lastCheckoutJob: '000123'
    } as Awaited<ReturnType<typeof getBox>>);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/allocations/jobs/11111111-1111-4111-8111-111111111111?scanAction=checkin&boxId=IL1-100'
      )
    );
  });

  it('routes a checked-out box without canonical job identity to Box Details with a scan notice', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: '000123'
    } as Awaited<ReturnType<typeof getBox>>);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/inventory/IL1-100?scanNotice=checkout-job-unknown'
      )
    );
  });

  it('routes an in-stock box to Box Details without opening check-in flow', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'IN_STOCK',
      lastCheckoutJobId: '',
      lastCheckoutJob: ''
    } as Awaited<ReturnType<typeof getBox>>);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/inventory/IL1-100'));
  });
});
