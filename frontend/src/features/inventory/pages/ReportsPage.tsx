import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { Select } from '../../../components/Select';
import type { ReportsSummaryFilters } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { searchOfflineBoxes } from '../../../lib/offlineInventory';
import { formatDate } from '../../../lib/date';
import { useFilmCatalog, useReportsSummary } from '../hooks/useInventoryQueries';
import {
  STANDARD_WIDTH_OPTIONS,
  getManufacturerOptionsWithCatalog,
  getWidthMode
} from '../utils/boxHelpers';
import {
  buildZeroedManufacturerOptions,
  filterZeroedBoxes,
  type ZeroedBoxesFilters
} from '../utils/reportsZeroedFilters';
import { parseWarehouseFilterValue } from '../utils/warehouseOptions';
import { WarehouseSelectField } from '../components/WarehouseSelectField';

type ReportType = 'never_checked_out' | 'zeroed_boxes' | 'completed_jobs' | 'cancelled_jobs';

const REPORT_TYPE_OPTIONS = [
  { label: 'Received But Never Checked Out', value: 'never_checked_out' },
  { label: 'All Zeroed Boxes', value: 'zeroed_boxes' },
  { label: 'Completed Jobs', value: 'completed_jobs' },
  { label: 'Cancelled Jobs', value: 'cancelled_jobs' }
];

const REPORT_TYPE_TITLES: Record<ReportType, string> = {
  never_checked_out: 'Received But Never Checked Out',
  zeroed_boxes: 'All Zeroed Boxes',
  completed_jobs: 'Completed Jobs',
  cancelled_jobs: 'Cancelled Jobs'
};

const EMPTY_FILTERS: ReportsSummaryFilters = {
  warehouse: ''
};

const EMPTY_ZEROED_FILTERS: ZeroedBoxesFilters = {
  manufacturer: '',
  q: '',
  width: ''
};

const ZEROED_WIDTH_OPTIONS = ['ALL', ...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;

function formatStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const [filters, setFilters] = useState<ReportsSummaryFilters>(EMPTY_FILTERS);
  const [reportType, setReportType] = useState<ReportType>('never_checked_out');
  const [zeroedFilters, setZeroedFilters] = useState<ZeroedBoxesFilters>(EMPTY_ZEROED_FILTERS);
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');

  const reportsQuery = useReportsSummary(filters);
  const filmCatalogQuery = useFilmCatalog();
  const zeroedFallbackQuery = useQuery({
    queryKey: ['reports', 'zeroed-fallback', filters.warehouse || 'ALL'],
    queryFn: () =>
      searchOfflineBoxes({
        warehouse: filters.warehouse || '',
        manufacturer: '',
        q: '',
        status: 'ZEROED',
        film: '',
        width: '',
        showRetired: true
      })
  });
  const knownManufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogQuery.data),
    [filmCatalogQuery.data]
  );
  const neverCheckedOut = reportsQuery.data?.neverCheckedOut || [];
  const completedJobs = reportsQuery.data?.completedJobs || [];
  const cancelledJobs = reportsQuery.data?.cancelledJobs || [];
  const zeroedBoxes = useMemo(() => {
    const fromSummary = reportsQuery.data?.zeroedBoxes || [];
    if (fromSummary.length) {
      return fromSummary;
    }

    return (zeroedFallbackQuery.data || [])
      .filter((box) => box.status === 'ZEROED' && box.zeroedDate)
      .map((box) => ({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        zeroedDate: box.zeroedDate
      }));
  }, [reportsQuery.data?.zeroedBoxes, zeroedFallbackQuery.data]);
  const zeroedManufacturerOptions = useMemo(
    () =>
      buildZeroedManufacturerOptions(
        zeroedBoxes,
        knownManufacturerOptions,
        zeroedFilters.manufacturer
      ),
    [knownManufacturerOptions, zeroedBoxes, zeroedFilters.manufacturer]
  );
  const filteredZeroedBoxes = useMemo(
    () => filterZeroedBoxes(zeroedBoxes, zeroedFilters),
    [zeroedBoxes, zeroedFilters]
  );
  const zeroedWidthMode = zeroedFilters.width ? getWidthMode(zeroedFilters.width) : '';
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;

  useEffect(() => {
    if (reportType !== 'zeroed_boxes') {
      setIsCustomWidthOpen(false);
      setCustomWidthDraft('');
    }
  }, [reportType]);

  function patchWarehouse(warehouse: string) {
    setFilters({ warehouse: parseWarehouseFilterValue(warehouse) });
  }

  function patchZeroedFilters(next: Partial<ZeroedBoxesFilters>) {
    setZeroedFilters((current) => ({ ...current, ...next }));
  }

  function handleZeroedWidthClick(value: (typeof ZEROED_WIDTH_OPTIONS)[number]) {
    if (value === 'ALL') {
      patchZeroedFilters({ width: '' });
      return;
    }

    if (value === 'CUSTOM') {
      setCustomWidthDraft(zeroedWidthMode === 'CUSTOM' ? zeroedFilters.width : '');
      setIsCustomWidthOpen(true);
      return;
    }

    patchZeroedFilters({ width: value });
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    patchZeroedFilters({ width: customWidthDraft.trim() });
    setIsCustomWidthOpen(false);
  }

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
            options={REPORT_TYPE_OPTIONS}
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
            <div className="field width-selector reports-width-selector">
              <span className="field-label">Width</span>
              <div className="width-button-grid">
                {ZEROED_WIDTH_OPTIONS.map((value) => {
                  const isActive =
                    value === 'ALL'
                      ? !zeroedFilters.width
                      : value === 'CUSTOM'
                        ? zeroedWidthMode === 'CUSTOM' && Boolean(zeroedFilters.width)
                        : zeroedWidthMode === value;
                  const buttonLabel =
                    value === 'CUSTOM' && zeroedWidthMode === 'CUSTOM' && zeroedFilters.width
                      ? zeroedFilters.width
                      : value === 'CUSTOM'
                        ? 'Cust.'
                        : value;

                  return (
                    <button
                      key={value}
                      type="button"
                      className={`width-chip ${isActive ? 'width-chip-active' : ''}`.trim()}
                      onClick={() => handleZeroedWidthClick(value)}
                    >
                      {buttonLabel}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>{REPORT_TYPE_TITLES[reportType]}</h2>
        </div>

        {reportsQuery.isLoading ? <LoadingState label="Loading reports..." /> : null}
        {reportsQuery.isError ? <p className="error-text">{reportsQuery.error.message}</p> : null}

        {!reportsQuery.isLoading && !reportsQuery.isError ? (
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
                        onTitleClick={() => navigate(`/inventory/${encodeURIComponent(row.boxId)}`)}
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
                              onClick={() => navigate(`/inventory/${encodeURIComponent(row.boxId)}`)}
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
                        onTitleClick={() => navigate(`/allocations/${encodeURIComponent(row.jobNumber)}`)}
                      />
                      <MobileFieldList>
                        <MobileField label="Install Date" value={formatDate(row.dueDate)} />
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
                              onClick={() => navigate(`/allocations/${encodeURIComponent(row.jobNumber)}`)}
                            >
                              {row.jobNumber}
                            </button>
                          </td>
                          <td>{row.warehouse}</td>
                          <td>{formatDate(row.dueDate)}</td>
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
                        onTitleClick={() => navigate(`/allocations/${encodeURIComponent(row.jobNumber)}`)}
                      />
                      <MobileFieldList>
                        <MobileField label="Install Date" value={formatDate(row.dueDate)} />
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
                              onClick={() => navigate(`/allocations/${encodeURIComponent(row.jobNumber)}`)}
                            >
                              {row.jobNumber}
                            </button>
                          </td>
                          <td>{row.warehouse}</td>
                          <td>{formatDate(row.dueDate)}</td>
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

      {isCustomWidthOpen ? (
        <div className="dialog-backdrop" role="presentation" onClick={() => setIsCustomWidthOpen(false)}>
          <div
            className="dialog width-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reports-custom-width-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="reports-custom-width-title">Custom Width</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close custom width dialog"
                onClick={() => setIsCustomWidthOpen(false)}
              >
                X
              </button>
            </div>
            <Input
              label="Width In"
              type="number"
              step="0.01"
              min="0"
              value={customWidthDraft}
              onChange={(event) => setCustomWidthDraft(event.target.value)}
              autoFocus
            />
            <div className="dialog-actions dialog-actions-center">
              <Button
                type="button"
                variant="primary"
                className="custom-width-save"
                onClick={saveCustomWidth}
                disabled={!isCustomWidthValid}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
