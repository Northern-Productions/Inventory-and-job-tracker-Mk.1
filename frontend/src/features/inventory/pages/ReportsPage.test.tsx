// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from './ReportsPage';
import { useReportsPageModel } from './reports/useReportsPageModel';

vi.mock('./reports/useReportsPageModel', () => ({
  REPORT_TYPE_TITLES: {
    never_checked_out: 'Received But Never Checked Out',
    zeroed_boxes: 'All Zeroed Boxes',
    completed_jobs: 'Completed Jobs',
    cancelled_jobs: 'Cancelled Jobs',
    asset_total_cost: 'Asset Total Cost'
  },
  useReportsPageModel: vi.fn()
}));

vi.mock('../components/WarehouseSelectField', () => ({
  WarehouseSelectField: ({
    value,
    onChange
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select aria-label="Warehouse" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">All Warehouses</option>
      <option value="IL1">IL1</option>
      <option value="MS1">MS1</option>
    </select>
  )
}));

const useReportsPageModelMock = vi.mocked(useReportsPageModel);
const openAllocationJobMock = vi.fn();

function buildModel(overrides: Partial<ReturnType<typeof useReportsPageModel>> = {}) {
  return {
    auth: {
      isOwner: false
    },
    isPhoneLayout: false,
    filters: {
      warehouse: ''
    },
    reportType: 'completed_jobs',
    setReportType: vi.fn(),
    zeroedFilters: {
      manufacturer: '',
      q: '',
      widths: []
    },
    rememberedCustomWidth: '',
    setRememberedCustomWidth: vi.fn(),
    neverCheckedOut: [],
    completedJobs: [],
    cancelledJobs: [],
    ownerAssetTotalCost: null,
    reportTypeOptions: [
      { label: 'Completed Jobs', value: 'completed_jobs' },
      { label: 'Cancelled Jobs', value: 'cancelled_jobs' }
    ],
    zeroedManufacturerOptions: [],
    filteredZeroedBoxes: [],
    showReportLoading: false,
    reportError: null,
    patchWarehouse: vi.fn(),
    patchZeroedFilters: vi.fn(),
    openInventoryBox: vi.fn(),
    openAllocationJob: openAllocationJobMock,
    ...overrides
  } as ReturnType<typeof useReportsPageModel>;
}

describe('ReportsPage', () => {
  beforeEach(() => {
    openAllocationJobMock.mockReset();
    useReportsPageModelMock.mockReset();
  });

  it('shows completed report jobs with work scope while preserving canonical job links', () => {
    const row = {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5',
      warehouse: 'IL1' as const,
      installDate: '2026-04-10',
      crewLeader: 'Crew',
      status: 'COMPLETED' as const,
      lifecycleStatus: 'COMPLETED' as const,
      requiredFeet: 100,
      allocatedFeet: 100,
      remainingFeet: 0,
      closedAt: '2026-04-11T10:00:00Z'
    };
    useReportsPageModelMock.mockReturnValue(buildModel({ completedJobs: [row] }));

    render(<ReportsPage />);

    const jobButton = screen.getByRole('button', { name: /IL1-4953.*Sections 4, 5/ });
    expect(screen.getByRole('columnheader', { name: 'Work Scope' })).toBeTruthy();
    expect(screen.getAllByText('Sections 4, 5').length).toBeGreaterThan(0);

    fireEvent.click(jobButton);

    expect(openAllocationJobMock).toHaveBeenCalledWith(row);
  });

  it('keeps report job labels compatible when work scope and jobId are absent', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        reportType: 'cancelled_jobs',
        cancelledJobs: [
          {
            jobNumber: '81234',
            warehouse: 'MS1' as const,
            installDate: '2026-04-12',
            crewLeader: '',
            status: 'CANCELLED' as const,
            lifecycleStatus: 'CANCELLED' as const,
            requiredFeet: 0,
            allocatedFeet: 0,
            remainingFeet: 0,
            closedAt: '2026-04-13T10:00:00Z'
          }
        ]
      })
    );

    render(<ReportsPage />);

    expect(screen.getByRole('button', { name: 'MS1-81234' })).toBeTruthy();
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });
});
