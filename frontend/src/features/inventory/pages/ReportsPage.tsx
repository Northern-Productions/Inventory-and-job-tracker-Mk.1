import { useNavigate } from 'react-router-dom';
import { Input } from '../../../components/Input';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import { getAllocatableStockFeet, getPhysicalStockFeet } from '../../../domain';
import type { Box } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import { formatBoxIdWithWarehousePrefix } from '../utils/boxHelpers';
import {
  REPORT_TYPE_TITLES,
  type MostUsedFilmDateRange,
  type ReportType,
  useReportsPageModel
} from './reports/useReportsPageModel';
import { WarehouseAssetAuditReport } from './reports/WarehouseAssetAuditReport';

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

const USD_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatMoney(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? USD_CURRENCY_FORMATTER.format(value) : '--';
}

function formatBoxDate(box: Box) {
  return formatDate(box.lastWeighedDate || box.receivedDate || box.orderDate);
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const {
    isPhoneLayout,
    filters,
    ownershipFilters,
    reportType,
    setReportType,
    reportTypeOptions,
    dateRangeOptions,
    rankByOptions,
    mostUsedFilm,
    manufacturerOptions,
    filmNameOptions,
    widthOptions,
    ownershipManufacturerOptions,
    ownershipWidthOptions,
    ownerCompanyOptions,
    ownershipRows,
    ownershipCountsByOwner,
    unresolvedOwnerCount,
    showReportLoading,
    showOwnershipLoading,
    reportError,
    ownershipError,
    dateRangeError,
    patchMostUsedFilmFilters,
    patchOwnershipFilters
  } = useReportsPageModel();
  const isOwnershipReport = reportType === 'ownership';
  const isWarehouseAssetAudit = reportType === 'warehouse_asset_audit';

  function openBox(box: Box) {
    const displayBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
    navigate(`/inventory/${encodeURIComponent(displayBoxId)}`);
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Reports</h2>
            <p className="muted-text">
              {isWarehouseAssetAudit
                ? 'Review and print current warehouse custody, physical LF, and known on-hand asset cost.'
                : isOwnershipReport
                ? 'Search and filter boxes by owner company, warehouse, film, width, and status.'
                : 'Most Used Film ranks job demand and actual consumed LF by manufacturer, film, and width.'}
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
          {isWarehouseAssetAudit ? null : isOwnershipReport ? (
            <>
              <WarehouseSelectField
                value={ownershipFilters.warehouse || ''}
                onChange={(warehouse) => patchOwnershipFilters({ warehouse })}
                allowAll
              />
              <Input
                label="Search"
                value={ownershipFilters.q}
                onChange={(event) => patchOwnershipFilters({ q: event.target.value })}
                placeholder="BoxID, film"
              />
              <Select
                label="Owner Company"
                value={ownershipFilters.ownerCompanyId}
                onChange={(event) => patchOwnershipFilters({ ownerCompanyId: event.target.value })}
                options={ownerCompanyOptions}
              />
              <Select
                label="Manufacturer"
                value={ownershipFilters.manufacturer}
                onChange={(event) => patchOwnershipFilters({ manufacturer: event.target.value })}
                options={[
                  { label: 'All', value: '' },
                  ...ownershipManufacturerOptions.map((manufacturer) => ({
                    label: manufacturer,
                    value: manufacturer
                  }))
                ]}
              />
              <Input
                label="Film Name"
                value={ownershipFilters.filmName}
                onChange={(event) => patchOwnershipFilters({ filmName: event.target.value })}
                placeholder="Search film"
              />
              <Select
                label="Width"
                value={ownershipFilters.width}
                onChange={(event) => patchOwnershipFilters({ width: event.target.value })}
                options={[
                  { label: 'All', value: '' },
                  ...ownershipWidthOptions.map((width) => ({
                    label: `${width}"`,
                    value: String(width)
                  }))
                ]}
              />
              <Select
                label="Status"
                value={ownershipFilters.status}
                onChange={(event) =>
                  patchOwnershipFilters({ status: event.target.value as typeof ownershipFilters.status })
                }
                options={[
                  { label: 'All', value: '' },
                  { label: 'Ordered', value: 'ORDERED' },
                  { label: 'In Stock', value: 'IN_STOCK' },
                  { label: 'Checked Out', value: 'CHECKED_OUT' },
                  { label: 'Transfer', value: 'TRANSFER' },
                  { label: 'Zeroed', value: 'ZEROED' }
                ]}
              />
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        {!isWarehouseAssetAudit && !isOwnershipReport && filters.dateRange === 'custom' ? (
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

      {isWarehouseAssetAudit ? <WarehouseAssetAuditReport /> : <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>{REPORT_TYPE_TITLES[reportType]}</h2>
            <p className="muted-text">
              {isOwnershipReport
                ? 'Ownership is separate from warehouse location: warehouse filters where boxes physically are, owner filters who owns them.'
                : 'Based on job film requirements and requirement-level actual used LF. Warehouse filtering follows the job warehouse.'}
            </p>
          </div>
          {isOwnershipReport ? <span className="muted-text">{ownershipRows.length} box(es)</span> : null}
        </div>

        <DeferredLoadingState
          when={isOwnershipReport ? showOwnershipLoading : showReportLoading}
          label={isOwnershipReport ? 'Loading ownership report...' : 'Loading reports...'}
        />
        {isOwnershipReport && ownershipError ? <p className="error-text">{ownershipError.message}</p> : null}
        {!isOwnershipReport && reportError ? <p className="error-text">{reportError.message}</p> : null}

        {isOwnershipReport && !showOwnershipLoading && !ownershipError ? (
          <>
            {unresolvedOwnerCount ? (
              <p className="error-text" role="status">
                {unresolvedOwnerCount} matching box(es) have an owner identity that could not be resolved.
              </p>
            ) : null}
            <div className="ownership-report-summary" aria-label="Ownership report summary">
              <div className="summary-card">
                <span className="summary-label">Matching Boxes</span>
                <strong>{ownershipRows.length}</strong>
              </div>
              {ownershipCountsByOwner.map((entry) => (
                <div className="summary-card" key={entry.key}>
                  <span className="summary-label">{entry.label}</span>
                  <strong>{entry.count}</strong>
                </div>
              ))}
            </div>
            {!ownershipRows.length ? (
              <div className="empty-state">No matching boxes found.</div>
            ) : isPhoneLayout ? (
              <div className="mobile-record-list">
                {ownershipRows.map(({ box, owner }) => {
                  const displayBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
                  return (
                    <MobileRecordCard key={box.boxId}>
                      <MobileRecordHeader
                        title={displayBoxId}
                        subtitle={`${owner.displayLabel} / ${box.warehouse}`}
                        badge={<span className={`badge badge-${box.status}`}>{box.status}</span>}
                        onTitleClick={() => openBox(box)}
                      />
                      <MobileFieldList>
                        <MobileField label="Manufacturer" value={box.manufacturer || '--'} />
                        <MobileField label="Film Name" value={box.filmName || '--'} />
                        <MobileField label="Width" value={`${box.widthIn}"`} />
                        <MobileField label="Current LF" value={getPhysicalStockFeet(box)} />
                        <MobileField label="Available LF" value={getAllocatableStockFeet(box)} />
                        <MobileField label="Initial Cost" value={formatMoney(box.purchaseCost)} />
                        <MobileField label="Updated" value={formatBoxDate(box)} />
                      </MobileFieldList>
                    </MobileRecordCard>
                  );
                })}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Box ID</th>
                      <th>Owner Company</th>
                      <th>Warehouse</th>
                      <th>Manufacturer</th>
                      <th>Film Name</th>
                      <th>Width</th>
                      <th>Status</th>
                      <th>Current LF</th>
                      <th>Available LF</th>
                      <th>Initial Cost</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ownershipRows.map(({ box, owner }) => {
                      const displayBoxId = formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse);
                      return (
                        <tr key={box.boxId}>
                          <td>
                            <button className="row-button" type="button" onClick={() => openBox(box)}>
                              {displayBoxId}
                            </button>
                          </td>
                          <td>{owner.displayLabel}</td>
                          <td>{box.warehouse}</td>
                          <td>{box.manufacturer || '--'}</td>
                          <td>{box.filmName || '--'}</td>
                          <td>{box.widthIn}"</td>
                          <td>
                            <span className={`badge badge-${box.status}`}>{box.status}</span>
                          </td>
                          <td>{getPhysicalStockFeet(box)}</td>
                          <td>{getAllocatableStockFeet(box)}</td>
                          <td>{formatMoney(box.purchaseCost)}</td>
                          <td>{formatBoxDate(box)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {!isOwnershipReport && !showReportLoading && !reportError ? (
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
      </section>}
    </>
  );
}
