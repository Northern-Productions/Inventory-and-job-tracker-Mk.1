// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from './ReportsPage';
import { useReportsPageModel } from './reports/useReportsPageModel';

vi.mock('./reports/useReportsPageModel', () => ({
  REPORT_TYPE_TITLES: {
    most_used_film: 'Most Used Film'
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
    reportType: 'most_used_film',
    setReportType: vi.fn(),
    reportTypeOptions: [{ label: 'Most Used Film', value: 'most_used_film' }],
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
    showReportLoading: false,
    reportError: null,
    dateRangeError: '',
    patchMostUsedFilmFilters: patchMostUsedFilmFiltersMock,
    ...overrides
  } as ReturnType<typeof useReportsPageModel>;
}

describe('ReportsPage', () => {
  afterEach(cleanup);

  beforeEach(() => {
    patchMostUsedFilmFiltersMock.mockReset();
    useReportsPageModelMock.mockReset();
  });

  it('exposes only the Most Used Film report and renders requested columns', () => {
    useReportsPageModelMock.mockReturnValue(buildModel());

    render(<ReportsPage />);

    const reportType = screen.getByLabelText('Report Type') as HTMLSelectElement;
    expect(Array.from(reportType.options).map((option) => option.textContent)).toEqual([
      'Most Used Film'
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
