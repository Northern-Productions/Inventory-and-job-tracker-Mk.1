// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from './ReportsPage';
import { NO_OWNER_FILTER_VALUE, useReportsPageModel } from './reports/useReportsPageModel';

const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}));

vi.mock('./reports/useReportsPageModel', () => ({
  NO_OWNER_FILTER_VALUE: '__NO_OWNER__',
  REPORT_TYPE_TITLES: {
    most_used_film: 'Most Used Film',
    ownership: 'Ownership'
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
const patchMostUsedFilmFiltersMock = vi.fn();
const patchOwnershipFiltersMock = vi.fn();

function buildModel(overrides: Partial<ReturnType<typeof useReportsPageModel>> = {}) {
  return {
    isPhoneLayout: false,
    filters: {
      warehouse: '',
      manufacturer: '',
      filmName: '',
      width: '',
      dateRange: 'all_time',
      customFrom: '',
      customTo: '',
      rankBy: 'actual_used_lf'
    },
    ownershipFilters: {
      warehouse: '',
      manufacturer: '',
      filmName: '',
      width: '',
      status: '',
      q: '',
      ownerCompanyId: ''
    },
    reportType: 'most_used_film',
    setReportType: vi.fn(),
    reportTypeOptions: [
      { label: 'Most Used Film', value: 'most_used_film' },
      { label: 'Ownership', value: 'ownership' }
    ],
    dateRangeOptions: [
      { label: 'Custom date range', value: 'custom' },
      { label: 'All time', value: 'all_time' },
      { label: 'This year', value: 'this_year' }
    ],
    rankByOptions: [
      { label: 'Actual Used LF', value: 'actual_used_lf' },
      { label: 'Jobs Using It', value: 'jobs_using_it' }
    ],
    mostUsedFilm: [
      {
        rank: 1,
        manufacturer: '3M Solar',
        filmName: 'Prestige 70',
        widthIn: 60,
        jobsUsingIt: 2,
        totalRequiredLf: 120,
        averageLfPerJob: 60,
        actualUsedLf: 95
      }
    ],
    manufacturerOptions: ['3M Solar'],
    filmNameOptions: ['Prestige 70'],
    widthOptions: [60],
    ownershipManufacturerOptions: ['3M Solar', 'Llumar'],
    ownershipWidthOptions: [36, 60],
    ownerCompanyOptions: [
      { label: 'All Owners', value: '' },
      { label: 'ALP - Alpha Holdings', value: 'owner-alpha' },
      { label: 'BET - Beta Holdings (inactive)', value: 'owner-beta' },
      { label: 'No owner assigned', value: NO_OWNER_FILTER_VALUE }
    ],
    ownershipRows: [
      {
        box: {
          boxId: '1001',
          warehouse: 'IL1',
          ownerCompanyId: 'owner-alpha',
          ownerCompanyCode: '',
          ownerCompanyDisplayName: '',
          ownerCompanyIsActive: true,
          dealer: '',
          manufacturer: '3M Solar',
          filmName: 'Prestige 70',
          widthIn: 60,
          initialFeet: 100,
          feetAvailable: 75,
          physicalFeetAvailable: 80,
          allocatableNowFeet: 75,
          allocationPlanningFeet: 75,
          lotRun: '',
          status: 'IN_STOCK',
          orderDate: '2026-05-01',
          receivedDate: '2026-05-02',
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '2026-05-03',
          filmKey: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null,
          pricePerLf: null,
          purchaseCost: 625,
          notes: '',
          hasEverBeenCheckedOut: false,
          lastCheckoutJob: '',
          lastCheckoutDate: '',
          zeroedDate: '',
          zeroedReason: '',
          zeroedBy: ''
        },
        owner: {
          groupKey: 'owner-alpha',
          filterValue: 'owner-alpha',
          displayLabel: 'ALP - Alpha Holdings',
          state: 'assigned',
          ownerCompanyId: 'owner-alpha',
          isActive: true
        }
      },
      {
        box: {
          boxId: '2001',
          warehouse: 'MS1',
          ownerCompanyId: '',
          ownerCompanyCode: '',
          ownerCompanyDisplayName: '',
          ownerCompanyIsActive: undefined,
          dealer: '',
          manufacturer: 'Llumar',
          filmName: 'Vista',
          widthIn: 36,
          initialFeet: 100,
          feetAvailable: 20,
          physicalFeetAvailable: 20,
          allocatableNowFeet: 20,
          allocationPlanningFeet: 20,
          lotRun: '',
          status: 'CHECKED_OUT',
          orderDate: '2026-05-01',
          receivedDate: '2026-05-02',
          initialWeightLbs: null,
          lastRollWeightLbs: null,
          lastWeighedDate: '',
          filmKey: '',
          coreType: '',
          coreWeightLbs: null,
          lfWeightLbsPerFt: null,
          pricePerLf: null,
          purchaseCost: null,
          notes: '',
          hasEverBeenCheckedOut: true,
          lastCheckoutJob: '',
          lastCheckoutDate: '',
          zeroedDate: '',
          zeroedReason: '',
          zeroedBy: ''
        },
        owner: {
          groupKey: NO_OWNER_FILTER_VALUE,
          filterValue: NO_OWNER_FILTER_VALUE,
          displayLabel: 'No owner assigned',
          state: 'unassigned',
          ownerCompanyId: null,
          isActive: null
        }
      }
    ],
    ownershipCountsByOwner: [
      { key: 'owner-alpha', label: 'ALP - Alpha Holdings', count: 1 },
      { key: NO_OWNER_FILTER_VALUE, label: 'No owner assigned', count: 1 }
    ],
    unresolvedOwnerCount: 0,
    showReportLoading: false,
    showOwnershipLoading: false,
    reportError: null,
    ownershipError: null,
    dateRangeError: '',
    patchMostUsedFilmFilters: patchMostUsedFilmFiltersMock,
    patchOwnershipFilters: patchOwnershipFiltersMock,
    ...overrides
  } as ReturnType<typeof useReportsPageModel>;
}

describe('ReportsPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    patchMostUsedFilmFiltersMock.mockReset();
    patchOwnershipFiltersMock.mockReset();
    useReportsPageModelMock.mockReset();
    navigateMock.mockReset();
  });

  it('exposes the report types and renders Most Used Film columns by default', () => {
    useReportsPageModelMock.mockReturnValue(buildModel());

    render(<ReportsPage />);

    const reportType = screen.getByLabelText('Report Type') as HTMLSelectElement;
    expect(Array.from(reportType.options).map((option) => option.textContent)).toEqual([
      'Most Used Film',
      'Ownership'
    ]);
    expect(screen.queryByText('Received But Never Checked Out')).toBeNull();
    expect(screen.queryByText('All Zeroed Boxes')).toBeNull();
    expect(screen.queryByText('Completed Jobs')).toBeNull();
    expect(screen.queryByText('Cancelled Jobs')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Rank' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Manufacturer' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Film Name' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Width' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Jobs Using It' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Total Required LF' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Average LF per Job' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Actual Used LF' })).toBeTruthy();
    expect(screen.getAllByText('Prestige 70').length).toBeGreaterThan(0);
    expect(screen.getByText('95')).toBeTruthy();
  });

  it('patches report filters from controls', () => {
    useReportsPageModelMock.mockReturnValue(buildModel());

    render(<ReportsPage />);

    fireEvent.change(screen.getByLabelText('Rank By'), { target: { value: 'jobs_using_it' } });
    fireEvent.change(screen.getByLabelText('Manufacturer'), { target: { value: '3M Solar' } });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '60' } });

    expect(patchMostUsedFilmFiltersMock).toHaveBeenCalledWith({ rankBy: 'jobs_using_it' });
    expect(patchMostUsedFilmFiltersMock).toHaveBeenCalledWith({ manufacturer: '3M Solar' });
    expect(patchMostUsedFilmFiltersMock).toHaveBeenCalledWith({ width: '60' });
  });

  it('renders Ownership filters, summary, row data, and box links', () => {
    useReportsPageModelMock.mockReturnValue(buildModel({ reportType: 'ownership' }));

    render(<ReportsPage />);

    expect(screen.getByRole('heading', { name: 'Ownership' })).toBeTruthy();
    expect(screen.getByLabelText('Owner Company')).toBeTruthy();
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Owner Company' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Current LF' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Initial Cost' })).toBeTruthy();
    expect(screen.getByText('Matching Boxes')).toBeTruthy();
    expect(screen.getAllByText('ALP - Alpha Holdings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No owner assigned').length).toBeGreaterThan(0);
    expect(screen.getByText('$625.00')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Owner Company'), { target: { value: 'owner-alpha' } });
    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: 'IL1' } });
    fireEvent.change(screen.getByLabelText('Manufacturer'), { target: { value: 'Llumar' } });
    fireEvent.change(screen.getByLabelText('Film Name'), { target: { value: 'Vista' } });

    expect(patchOwnershipFiltersMock).toHaveBeenCalledWith({ ownerCompanyId: 'owner-alpha' });
    expect(patchOwnershipFiltersMock).toHaveBeenCalledWith({ warehouse: 'IL1' });
    expect(patchOwnershipFiltersMock).toHaveBeenCalledWith({ manufacturer: 'Llumar' });
    expect(patchOwnershipFiltersMock).toHaveBeenCalledWith({ filmName: 'Vista' });

    fireEvent.click(screen.getByRole('button', { name: 'IL1-1001' }));

    expect(navigateMock).toHaveBeenCalledWith('/inventory/IL1-1001');
  });

  it('keeps inactive and no-owner options visible in Ownership', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        reportType: 'ownership',
        ownershipFilters: {
          warehouse: '',
          manufacturer: '',
          filmName: '',
          width: '',
          status: '',
          q: '',
          ownerCompanyId: 'owner-beta'
        }
      })
    );

    render(<ReportsPage />);

    const ownerSelect = screen.getByLabelText('Owner Company') as HTMLSelectElement;
    expect(Array.from(ownerSelect.options).map((option) => option.textContent)).toContain(
      'BET - Beta Holdings (inactive)'
    );
    expect(Array.from(ownerSelect.options).map((option) => option.textContent)).toContain('No owner assigned');
    expect(ownerSelect.value).toBe('owner-beta');
  });

  it('renders the Ownership empty state safely', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        reportType: 'ownership',
        ownershipRows: [],
        ownershipCountsByOwner: []
      })
    );

    render(<ReportsPage />);

    expect(screen.getByText('No matching boxes found.')).toBeTruthy();
  });

  it('uses resolved labels on mobile cards and never renders an unresolved identity', () => {
    const rawUnresolvedId = '99999999-9999-4999-8999-999999999999';
    const base = buildModel({ reportType: 'ownership' });
    const unresolvedRow = {
      ...base.ownershipRows[0],
      box: {
        ...base.ownershipRows[0].box,
        ownerCompanyId: rawUnresolvedId
      },
      owner: {
        groupKey: '__UNKNOWN_OWNER_1__',
        filterValue: '__UNKNOWN_OWNER_1__',
        displayLabel: 'Unknown owner',
        state: 'unresolved' as const,
        ownerCompanyId: null,
        isActive: null
      }
    };
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        reportType: 'ownership',
        isPhoneLayout: true,
        ownershipRows: [unresolvedRow],
        ownershipCountsByOwner: [
          { key: '__UNKNOWN_OWNER_1__', label: 'Unknown owner', count: 1 }
        ],
        ownerCompanyOptions: [
          { label: 'All Owners', value: '' },
          { label: 'Unknown owner', value: '__UNKNOWN_OWNER_1__' }
        ],
        unresolvedOwnerCount: 1
      })
    );

    const { container } = render(<ReportsPage />);

    expect(screen.getByText('Unknown owner / IL1')).toBeTruthy();
    expect(screen.getByText(/1 matching box\(es\) have an owner identity/)).toBeTruthy();
    expect(container.innerHTML).not.toContain(rawUnresolvedId);
  });

  it('renders only the safe report error when ownership resolution fails closed', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        reportType: 'ownership',
        ownershipError: new Error(
          'Owner company identities could not be resolved safely for this report.'
        ),
        ownershipRows: [],
        ownershipCountsByOwner: [],
        unresolvedOwnerCount: 0
      })
    );

    render(<ReportsPage />);

    expect(
      screen.getByText('Owner company identities could not be resolved safely for this report.')
    ).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Current LF' })).toBeNull();
    expect(screen.queryByText('$625.00')).toBeNull();
  });

  it('shows custom date inputs and the actual-usage empty state', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        mostUsedFilm: [],
        filters: {
          warehouse: '',
          manufacturer: '',
          filmName: '',
          width: '',
          dateRange: 'custom',
          customFrom: '',
          customTo: '',
          rankBy: 'actual_used_lf'
        }
      })
    );

    render(<ReportsPage />);

    expect(screen.getByLabelText('Custom Start')).toBeTruthy();
    expect(screen.getByLabelText('Custom End')).toBeTruthy();
    expect(
      screen.getByText('No actual film usage found for this filter range. Try Jobs Using It or widen the date range.')
    ).toBeTruthy();
  });

  it('shows zero-actual requirement rows in the Jobs Using It view', () => {
    useReportsPageModelMock.mockReturnValue(
      buildModel({
        filters: {
          warehouse: '',
          manufacturer: '',
          filmName: '',
          width: '',
          dateRange: 'this_year',
          customFrom: '',
          customTo: '',
          rankBy: 'jobs_using_it'
        },
        mostUsedFilm: [
          {
            rank: 1,
            manufacturer: 'Madico',
            filmName: 'Safetyshield',
            widthIn: 72,
            jobsUsingIt: 3,
            totalRequiredLf: 180,
            averageLfPerJob: 60,
            actualUsedLf: 0
          }
        ]
      })
    );

    render(<ReportsPage />);

    expect(screen.getByText('Safetyshield')).toBeTruthy();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });
});
