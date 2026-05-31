import { Input } from '../../../components/Input';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import {
  REPORT_TYPE_TITLES,
  type MostUsedFilmDateRange,
  type ReportType,
  useReportsPageModel
} from './reports/useReportsPageModel';

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1
  }).format(value);
}

function buildEmptyState(rankBy: string) {
  if (rankBy === 'actual_used_lf') {
    return 'No actual film usage found for this filter range. Try Jobs Using It or widen the date range.';
  }

  return 'No film requirements matched this filter range.';
}

export default function ReportsPage() {
  const {
    isPhoneLayout,
    filters,
    reportType,
    setReportType,
    reportTypeOptions,
    dateRangeOptions,
    rankByOptions,
    mostUsedFilm,
    manufacturerOptions,
    filmNameOptions,
    widthOptions,
    showReportLoading,
    reportError,
    dateRangeError,
    patchMostUsedFilmFilters
  } = useReportsPageModel();

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Reports</h2>
            <p className="muted-text">
              Most Used Film ranks job demand and actual consumed LF by manufacturer, film, and width.
            </p>
          </div>
        </div>

        <div className="toolbar-grid reports-filters">
          <Select
            label="Report Type"
            value={reportType}
            onChange={(event) => setReportType(event.target.value as ReportType)}
            options={reportTypeOptions}
          />
          <WarehouseSelectField
            value={filters.warehouse || ''}
            onChange={(warehouse) => patchMostUsedFilmFilters({ warehouse })}
            allowAll
          />
          <Select
            label="Manufacturer"
            value={filters.manufacturer}
            onChange={(event) => patchMostUsedFilmFilters({ manufacturer: event.target.value })}
            options={[
              { label: 'All', value: '' },
              ...manufacturerOptions.map((manufacturer) => ({
                label: manufacturer,
                value: manufacturer
              }))
            ]}
          />
          <Select
            label="Film Name"
            value={filters.filmName}
            onChange={(event) => patchMostUsedFilmFilters({ filmName: event.target.value })}
            options={[
              { label: 'All', value: '' },
              ...filmNameOptions.map((filmName) => ({
                label: filmName,
                value: filmName
              }))
            ]}
          />
          <Select
            label="Width"
            value={filters.width}
            onChange={(event) => patchMostUsedFilmFilters({ width: event.target.value })}
            options={[
              { label: 'All', value: '' },
              ...widthOptions.map((width) => ({
                label: `${width}"`,
                value: String(width)
              }))
            ]}
          />
          <Select
            label="Date Range"
            value={filters.dateRange}
            onChange={(event) =>
              patchMostUsedFilmFilters({ dateRange: event.target.value as MostUsedFilmDateRange })
            }
            options={dateRangeOptions}
            error={dateRangeError}
          />
          <Select
            label="Rank By"
            value={filters.rankBy}
            onChange={(event) =>
              patchMostUsedFilmFilters({
                rankBy: event.target.value === 'jobs_using_it' ? 'jobs_using_it' : 'actual_used_lf'
              })
            }
            options={rankByOptions}
          />
        </div>

        {filters.dateRange === 'custom' ? (
          <div className="toolbar-grid reports-filters reports-custom-date-filters">
            <Input
              label="Custom Start"
              type="date"
              value={filters.customFrom}
              onChange={(event) => patchMostUsedFilmFilters({ customFrom: event.target.value })}
              error={dateRangeError}
            />
            <Input
              label="Custom End"
              type="date"
              value={filters.customTo}
              onChange={(event) => patchMostUsedFilmFilters({ customTo: event.target.value })}
              error={dateRangeError}
            />
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>{REPORT_TYPE_TITLES[reportType]}</h2>
            <p className="muted-text">
              Based on job film requirements and requirement-level actual used LF. Warehouse filtering follows
              the job warehouse.
            </p>
          </div>
        </div>

        <DeferredLoadingState when={showReportLoading} label="Loading reports..." />
        {reportError ? <p className="error-text">{reportError.message}</p> : null}

        {!showReportLoading && !reportError ? (
          !mostUsedFilm.length ? (
            <div className="empty-state">{buildEmptyState(filters.rankBy)}</div>
          ) : isPhoneLayout ? (
            <div className="mobile-record-list">
              {mostUsedFilm.map((row) => (
                <MobileRecordCard key={`${row.manufacturer}-${row.filmName}-${row.widthIn}`}>
                  <MobileRecordHeader
                    title={`#${row.rank} ${row.filmName}`}
                    subtitle={`${row.manufacturer} / ${row.widthIn}"`}
                  />
                  <MobileFieldList>
                    <MobileField label="Jobs Using It" value={row.jobsUsingIt} />
                    <MobileField label="Total Required LF" value={formatNumber(row.totalRequiredLf)} />
                    <MobileField label="Average LF per Job" value={formatNumber(row.averageLfPerJob)} />
                    <MobileField label="Actual Used LF" value={formatNumber(row.actualUsedLf)} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Manufacturer</th>
                    <th>Film Name</th>
                    <th>Width</th>
                    <th>Jobs Using It</th>
                    <th>Total Required LF</th>
                    <th>Average LF per Job</th>
                    <th>Actual Used LF</th>
                  </tr>
                </thead>
                <tbody>
                  {mostUsedFilm.map((row) => (
                    <tr key={`${row.manufacturer}-${row.filmName}-${row.widthIn}`}>
                      <td>{row.rank}</td>
                      <td>{row.manufacturer}</td>
                      <td>{row.filmName}</td>
                      <td>{row.widthIn}"</td>
                      <td>{row.jobsUsingIt}</td>
                      <td>{formatNumber(row.totalRequiredLf)}</td>
                      <td>{formatNumber(row.averageLfPerJob)}</td>
                      <td>{formatNumber(row.actualUsedLf)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
    </>
  );
}
