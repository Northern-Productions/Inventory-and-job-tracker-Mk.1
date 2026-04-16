import { Input } from '../../../components/Input';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import { formatDate } from '../../../lib/date';
import { WidthFilterField } from '../components/WidthFilterField';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import { REPORT_TYPE_TITLES, type ReportType, useReportsPageModel } from './reports/useReportsPageModel';

const USD_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatCurrency(value: number) {
  return USD_CURRENCY_FORMATTER.format(value);
}

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

export default function ReportsPage() {
  const {
    auth,
    isPhoneLayout,
    filters,
    reportType,
    setReportType,
    zeroedFilters,
    rememberedCustomWidth,
    setRememberedCustomWidth,
    neverCheckedOut,
    completedJobs,
    cancelledJobs,
    ownerAssetTotalCost,
    reportTypeOptions,
    zeroedManufacturerOptions,
    filteredZeroedBoxes,
    showReportLoading,
    reportError,
    patchWarehouse,
    patchZeroedFilters,
    openInventoryBox,
    openAllocationJob
  } = useReportsPageModel();

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Reports</h2>
            <p className="muted-text">Select a report view and filter by warehouse.</p>
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
            onChange={(warehouse) => patchWarehouse(warehouse)}
            allowAll
          />
        </div>

        {reportType === 'zeroed_boxes' ? (
          <div className="toolbar-grid reports-filters">
            <label className="field">
              <span className="field-label">Manufacturer</span>
              <select
                className="field-input"
                value={zeroedFilters.manufacturer}
                onChange={(event) => patchZeroedFilters({ manufacturer: event.target.value })}
              >
                <option value="">All</option>
                {zeroedManufacturerOptions.map((manufacturer) => (
                  <option key={manufacturer} value={manufacturer}>
                    {manufacturer}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Search"
              value={zeroedFilters.q}
              onChange={(event) => patchZeroedFilters({ q: event.target.value })}
              placeholder="BoxID, manufacturer, film"
            />
            <WidthFilterField
              widths={zeroedFilters.widths}
              rememberedCustomWidth={rememberedCustomWidth}
              onWidthsChange={(widths) => patchZeroedFilters({ widths })}
              onRememberedCustomWidthChange={setRememberedCustomWidth}
              className="reports-width-selector"
              dialogTitle="Custom Width"
              dialogTitleId="reports-custom-width-title"
            />
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>{REPORT_TYPE_TITLES[reportType]}</h2>
        </div>

        <DeferredLoadingState when={showReportLoading} label="Loading reports..." />
        {reportError ? <p className="error-text">{reportError.message}</p> : null}

        {!showReportLoading && !reportError ? (
          <>
            {reportType === 'never_checked_out' ? (
              !neverCheckedOut.length ? (
                <div className="empty-state">No received boxes matched this report.</div>
              ) : isPhoneLayout ? (
                <div className="mobile-record-list">
                  {neverCheckedOut.map((row) => (
                    <MobileRecordCard key={row.boxId}>
                      <MobileRecordHeader
                        title={row.boxId}
                        subtitle={`${row.manufacturer} ${row.filmName}`}
                        badge={<span className={`badge badge-${row.status}`}>{row.status}</span>}
                      />
                      <MobileFieldList>
                        <MobileField label="Warehouse" value={row.warehouse} />
                        <MobileField label="Width" value={row.widthIn} />
                        <MobileField label="Received" value={formatDate(row.receivedDate)} />
                        <MobileField label="Feet Available" value={row.feetAvailable} />
                      </MobileFieldList>
                    </MobileRecordCard>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>BoxID</th>
                        <th>Warehouse</th>
                        <th>Manufacturer</th>
                        <th>Film</th>
                        <th>Width</th>
                        <th>Received</th>
                        <th>Status</th>
                        <th>Feet Available</th>
                      </tr>
                    </thead>
                    <tbody>
                      {neverCheckedOut.map((row) => (
                        <tr key={row.boxId}>
                          <td>{row.boxId}</td>
                          <td>{row.warehouse}</td>
                          <td>{row.manufacturer}</td>
                          <td>{row.filmName}</td>
                          <td>{row.widthIn}</td>
                          <td>{formatDate(row.receivedDate)}</td>
                          <td>{row.status}</td>
                          <td>{row.feetAvailable}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}

            {reportType === 'zeroed_boxes' ? (
              !filteredZeroedBoxes.length ? (
                <div className="empty-state">No zeroed boxes matched this report.</div>
              ) : isPhoneLayout ? (
                <div className="mobile-record-list">
                  {filteredZeroedBoxes.map((row) => (
                    <MobileRecordCard key={row.boxId}>
                      <MobileRecordHeader
                        title={row.boxId}
                        subtitle={`${row.manufacturer} ${row.filmName}`}
                        onTitleClick={() => openInventoryBox(row.boxId)}
                      />
                      <MobileFieldList>
                        <MobileField label="Warehouse" value={row.warehouse} />
                        <MobileField label="Zeroed Date" value={formatDate(row.zeroedDate)} />
                      </MobileFieldList>
                    </MobileRecordCard>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>BoxID</th>
                        <th>Warehouse</th>
                        <th>Manufacturer</th>
                        <th>Film</th>
                        <th>Zeroed Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredZeroedBoxes.map((row) => (
                        <tr key={row.boxId}>
                          <td>
                            <button
                              type="button"
                              className="row-button"
                              onClick={() => openInventoryBox(row.boxId)}
                            >
                              {row.boxId}
                            </button>
                          </td>
                          <td>{row.warehouse}</td>
                          <td>{row.manufacturer}</td>
                          <td>{row.filmName}</td>
                          <td>{formatDate(row.zeroedDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}

            {reportType === 'asset_total_cost' ? (
              !auth.isOwner ? (
                <div className="empty-state">Only owners can view this report.</div>
              ) : !ownerAssetTotalCost ? (
                <div className="empty-state">No asset cost data is available.</div>
              ) : (
                <div className="detail-grid">
                  <div className="key-value">
                    <dt className="detail-label-pill detail-label-pill-green">Total On-Hand Asset Cost</dt>
                    <dd>{formatCurrency(ownerAssetTotalCost.totalAssetCost)}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Included Boxes</dt>
                    <dd>{ownerAssetTotalCost.includedBoxCount}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Included LF</dt>
                    <dd>{ownerAssetTotalCost.includedFeet}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Priced Boxes</dt>
                    <dd>{ownerAssetTotalCost.pricedBoxCount}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Priced LF</dt>
                    <dd>{ownerAssetTotalCost.pricedFeet}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Unpriced Boxes</dt>
                    <dd>{ownerAssetTotalCost.unpricedBoxCount}</dd>
                  </div>
                  <div className="key-value">
                    <dt>Unpriced LF</dt>
                    <dd>{ownerAssetTotalCost.unpricedFeet}</dd>
                  </div>
                  <div className="key-value">
                    <dt>LF Coverage</dt>
                    <dd>{(ownerAssetTotalCost.coveragePercentByFeet * 100).toFixed(1)}%</dd>
                  </div>
                </div>
              )
            ) : null}

            {reportType === 'completed_jobs' ? (
              !completedJobs.length ? (
                <div className="empty-state">No completed jobs matched the current filters.</div>
              ) : isPhoneLayout ? (
                <div className="mobile-record-list">
                  {completedJobs.map((row) => (
                    <MobileRecordCard key={`completed-${row.jobNumber}`}>
                      <MobileRecordHeader
                        title={row.jobNumber}
                        subtitle={`${row.warehouse} warehouse`}
                        badge={<span className={`badge badge-${row.status}`}>{formatStatusLabel(row.status)}</span>}
                        onTitleClick={() => openAllocationJob(row.jobNumber)}
                      />
                      <MobileFieldList>
                        <MobileField label="Install Date" value={formatDate(row.installDate)} />
                        <MobileField label="Crew Leader" value={row.crewLeader || '--'} />
                      </MobileFieldList>
                    </MobileRecordCard>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Job ID</th>
                        <th>Warehouse</th>
                        <th>Install Date</th>
                        <th>Crew Leader</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {completedJobs.map((row) => (
                        <tr key={`completed-${row.jobNumber}`}>
                          <td>
                            <button
                              type="button"
                              className="row-button"
                              onClick={() => openAllocationJob(row.jobNumber)}
                            >
                              {row.jobNumber}
                            </button>
                          </td>
                          <td>{row.warehouse}</td>
                          <td>{formatDate(row.installDate)}</td>
                          <td>{row.crewLeader || '--'}</td>
                          <td>
                            <span className={`badge badge-${row.status}`}>{formatStatusLabel(row.status)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}

            {reportType === 'cancelled_jobs' ? (
              !cancelledJobs.length ? (
                <div className="empty-state">No cancelled jobs matched the current filters.</div>
              ) : isPhoneLayout ? (
                <div className="mobile-record-list">
                  {cancelledJobs.map((row) => (
                    <MobileRecordCard key={`cancelled-${row.jobNumber}`}>
                      <MobileRecordHeader
                        title={row.jobNumber}
                        subtitle={`${row.warehouse} warehouse`}
                        badge={<span className={`badge badge-${row.status}`}>{formatStatusLabel(row.status)}</span>}
                        onTitleClick={() => openAllocationJob(row.jobNumber)}
                      />
                      <MobileFieldList>
                        <MobileField label="Install Date" value={formatDate(row.installDate)} />
                        <MobileField label="Crew Leader" value={row.crewLeader || '--'} />
                        <MobileField label="Required LF" value={row.requiredFeet} />
                        <MobileField label="Allocated LF" value={row.allocatedFeet} />
                        <MobileField label="Remaining LF" value={row.remainingFeet} />
                        <MobileField label="Closed" value={formatDate(row.closedAt)} />
                      </MobileFieldList>
                    </MobileRecordCard>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Job ID</th>
                        <th>Warehouse</th>
                        <th>Install Date</th>
                        <th>Crew Leader</th>
                        <th>Status</th>
                        <th>Required LF</th>
                        <th>Allocated LF</th>
                        <th>Remaining LF</th>
                        <th>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cancelledJobs.map((row) => (
                        <tr key={`cancelled-${row.jobNumber}`}>
                          <td>
                            <button
                              type="button"
                              className="row-button"
                              onClick={() => openAllocationJob(row.jobNumber)}
                            >
                              {row.jobNumber}
                            </button>
                          </td>
                          <td>{row.warehouse}</td>
                          <td>{formatDate(row.installDate)}</td>
                          <td>{row.crewLeader || '--'}</td>
                          <td>
                            <span className={`badge badge-${row.status}`}>{formatStatusLabel(row.status)}</span>
                          </td>
                          <td>{row.requiredFeet}</td>
                          <td>{row.allocatedFeet}</td>
                          <td>{row.remainingFeet}</td>
                          <td>{formatDate(row.closedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}
