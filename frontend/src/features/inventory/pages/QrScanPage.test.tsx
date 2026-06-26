// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QrScanPage from './QrScanPage';
import { getBox } from '../../../api/features/inventoryClient';
import { getJobs } from '../../../api/features/jobsClient';
import type { JobListEntry } from '../../../domain';

const navigateMock = vi.fn();
let scannedCode = 'IL1-100';

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}));

vi.mock('../../../api/features/inventoryClient', () => ({
  getBox: vi.fn()
}));

vi.mock('../../../api/features/jobsClient', () => ({
  getJobs: vi.fn()
}));

vi.mock('../components/QrScanner', () => ({
  QrScanner: ({ onResolved }: { onResolved: (code: string) => Promise<boolean> | boolean }) => (
    <button type="button" onClick={() => void onResolved(scannedCode)}>
      Resolve scan
    </button>
  )
}));

const getBoxMock = vi.mocked(getBox);
const getJobsMock = vi.mocked(getJobs);

function buildJob(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobId: '22222222-2222-4222-8222-222222222222',
    jobNumber: '000123',
    warehouse: 'IL1',
    installDate: '2026-03-20',
    installEndDate: '',
    crewLeader: 'Crew',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    requiredFeet: 0,
    allocatedFeet: 0,
    allocatedWithInstallDateFeet: 0,
    allocatedWithoutInstallDateFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    filmOrderCount: 0,
    caulkRequirementCount: 0,
    phaseCount: 1,
    phases: [],
    isLaborOnly: false,
    isStagedForPickup: false,
    hasOrderedAllocations: false,
    ...overrides
  } as JobListEntry;
}

describe('QrScanPage scan routing', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    navigateMock.mockReset();
    getBoxMock.mockReset();
    getJobsMock.mockReset();
    scannedCode = 'IL1-100';
  });

  it('preserves canonical job check-in scan routes without looking up the box', async () => {
    scannedCode =
      'https://inventorymk1.vercel.app/#/allocations/jobs/11111111-1111-4111-8111-111111111111?scanAction=checkin&boxId=IL1-100';

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/allocations/jobs/11111111-1111-4111-8111-111111111111?scanAction=checkin&boxId=IL1-100'
      )
    );
    expect(getBoxMock).not.toHaveBeenCalled();
    expect(getJobsMock).not.toHaveBeenCalled();
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

  it('resolves a checked-out box without canonical job identity by exact job number', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: '000123'
    } as Awaited<ReturnType<typeof getBox>>);
    getJobsMock.mockResolvedValue([buildJob()]);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/allocations/jobs/22222222-2222-4222-8222-222222222222?scanAction=checkin&boxId=IL1-100'
      )
    );
    expect(getJobsMock).toHaveBeenCalledWith(0, { jobNumbers: ['000123'] });
  });

  it('falls back safely when no exact checked-out job candidate resolves', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: '000123'
    } as Awaited<ReturnType<typeof getBox>>);
    getJobsMock.mockResolvedValue([]);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/inventory/IL1-100?scanNotice=checkout-job-unresolved'
      )
    );
  });

  it('falls back safely when checked-out job number resolution is ambiguous', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: '000123'
    } as Awaited<ReturnType<typeof getBox>>);
    getJobsMock.mockResolvedValue([
      buildJob({ jobId: '22222222-2222-4222-8222-222222222222' }),
      buildJob({ jobId: '33333333-3333-4333-8333-333333333333' })
    ]);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/inventory/IL1-100?scanNotice=checkout-job-ambiguous'
      )
    );
  });

  it('falls back safely when a checked-out box has no job number to resolve', async () => {
    getBoxMock.mockResolvedValue({
      boxId: 'IL1-100',
      status: 'CHECKED_OUT',
      lastCheckoutJobId: '',
      lastCheckoutJob: ''
    } as Awaited<ReturnType<typeof getBox>>);

    render(<QrScanPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve scan' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        '/inventory/IL1-100?scanNotice=checkout-job-unknown'
      )
    );
    expect(getJobsMock).not.toHaveBeenCalled();
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
    expect(getJobsMock).not.toHaveBeenCalled();
  });
});
