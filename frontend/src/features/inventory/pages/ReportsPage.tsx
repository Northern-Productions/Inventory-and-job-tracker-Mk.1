import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import type { ReportsSummaryFilters } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { useReportsSummary } from '../hooks/useInventoryQueries';
import { MANUFACTURER_OPTIONS, STANDARD_WIDTH_OPTIONS, getWidthMode } from '../utils/boxHelpers';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';

const EMPTY_FILTERS: ReportsSummaryFilters = {
  warehouse: '',
  manufacturer: '',
  film: '',
  width: '72',
  from: '',
  to: ''
};

export default function ReportsPage() {
  const isPhoneLayout = useIsPhoneLayout();
  const [filters, setFilters] = useState<ReportsSummaryFilters>(EMPTY_FILTERS);
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const reportsQuery = useReportsSummary(filters);
  const widthMode = getWidthMode(filters.width || '72');
  const widthButtonValues = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
  const isKnownManufacturer = MANUFACTURER_OPTIONS.includes(
    (filters.manufacturer || '') as (typeof MANUFACTURER_OPTIONS)[number]
  );
  const manufacturerSelectValue = !filters.manufacturer
    ? ''
    : isKnownManufacturer
      ? filters.manufacturer
      : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;

  useEffect(() => {
    if (widthMode === 'CUSTOM') {
      setCustomWidthDraft(filters.width || '');
      return;
    }

    setCustomWidthDraft('');
  }, [filters.width, widthMode]);

  function patchFilters(next: Partial<ReportsSummaryFilters>) {
    setFilters((current) => ({ ...current, ...next }));
  }

  function handleWidthButtonClick(value: (typeof widthButtonValues)[number]) {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(widthMode === 'CUSTOM' ? filters.width || '' : '');
      setIsCustomWidthOpen(true);
      return;
    }

    patchFilters({ width: value });
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    patchFilters({ width: customWidthDraft.trim() });
    setIsCustomWidthOpen(false);
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Reports</h2>
            <p className="muted-text">Operational totals and exception lists for the current inventory.</p>
          </div>
          <div className="page-actions">
            <Button type="button" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear Filters
            </Button>
          </div>
        </div>

        <div className="toolbar-grid reports-filters">
          <label className="field">
            <span className="field-label">Warehouse</span>
            <select
              className="field-input"
              value={filters.warehouse || ''}
              onChange={(event) =>
                patchFilters({ warehouse: event.target.value === 'ALL' ? '' : (event.target.value as 'IL' | 'MS') })
              }
            >
              <option value="ALL">All</option>
              <option value="IL">IL</option>
              <option value="MS">MS</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Manufacturer</span>
            <select
              className="field-input"
              value={manufacturerSelectValue}
              onChange={(event) => {
                const nextValue = event.target.value;
                if (nextValue === CUSTOM_MANUFACTURER_OPTION) {
                  if (!filters.manufacturer || isKnownManufacturer) {
                    patchFilters({ manufacturer: '' });
                  }
                  return;
                }

                patchFilters({ manufacturer: nextValue });
              }}
            >
              <option value="">All</option>
              {MANUFACTURER_OPTIONS.map((manufacturer) => (
                <option key={manufacturer} value={manufacturer}>
                  {manufacturer}
                </option>
              ))}
              <option value={CUSTOM_MANUFACTURER_OPTION}>Enter New Manufacturer</option>
            </select>
          </label>
          {isCustomManufacturerSelected ? (
            <Input
              label="New Manufacturer"
              value={filters.manufacturer || ''}
              onChange={(event) => patchFilters({ manufacturer: event.target.value })}
              placeholder="Type manufacturer..."
            />
          ) : null}
          <Input
            label="Film"
            value={filters.film || ''}
            onChange={(event) => patchFilters({ film: event.target.value })}
            placeholder="Contains..."
          />
          <div className="field width-selector reports-width-selector">
            <span className="field-label">Width</span>
            <div className="width-button-grid">
              {widthButtonValues.map((value) => {
                const isActive = value === 'CUSTOM' ? widthMode === 'CUSTOM' : widthMode === value;
                const buttonLabel =
                  value === 'CUSTOM' && widthMode === 'CUSTOM' && filters.width
                    ? filters.width
                    : value === 'CUSTOM'
                      ? 'Cust.'
                      : value;

                return (
                  <button
                    key={value}
                    type="button"
                    className={`width-chip ${isActive ? 'width-chip-active' : ''}`.trim()}
                    onClick={() => handleWidthButtonClick(value)}
                  >
                    {buttonLabel}
                  </button>
                );
              })}
            </div>
          </div>
          <Input
            label="From"
            type="date"
            value={filters.from || ''}
            onChange={(event) => patchFilters({ from: event.target.value })}
          />
          <Input
            label="To"
            type="date"
            value={filters.to || ''}
            onChange={(event) => patchFilters({ to: event.target.value })}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Available Feet By Width</h2>
        </div>
        {reportsQuery.isLoading ? <LoadingState label="Loading reports..." /> : null}
        {reportsQuery.isError ? <p className="error-text">{reportsQuery.error.message}</p> : null}
        {!reportsQuery.isLoading && !reportsQuery.isError && !reportsQuery.data?.availableFeetByWidth.length ? (
          <div className="empty-state">No active inventory matched the current filters.</div>
        ) : null}
        {reportsQuery.data?.availableFeetByWidth.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {reportsQuery.data.availableFeetByWidth.map((row) => (
                <MobileRecordCard key={row.widthIn}>
                  <MobileRecordHeader title={`${row.widthIn}"`} />
                  <MobileFieldList>
                    <MobileField label="Total Feet" value={row.totalFeetAvailable} />
                    <MobileField label="Box Count" value={row.boxCount} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Width</th>
                    <th>Total Feet</th>
                    <th>Box Count</th>
                  </tr>
                </thead>
                <tbody>
                  {reportsQuery.data.availableFeetByWidth.map((row) => (
                    <tr key={row.widthIn}>
                      <td>{row.widthIn}</td>
                      <td>{row.totalFeetAvailable}</td>
                      <td>{row.boxCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Received But Never Checked Out</h2>
        </div>
        {!reportsQuery.isLoading && !reportsQuery.isError && !reportsQuery.data?.neverCheckedOut.length ? (
          <div className="empty-state">No received boxes matched this report.</div>
        ) : null}
        {reportsQuery.data?.neverCheckedOut.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {reportsQuery.data.neverCheckedOut.map((row) => (
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
                  {reportsQuery.data.neverCheckedOut.map((row) => (
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
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Zeroed Boxes Over Time</h2>
        </div>
        {!reportsQuery.isLoading && !reportsQuery.isError && !reportsQuery.data?.zeroedByMonth.length ? (
          <div className="empty-state">No zeroed boxes matched this report.</div>
        ) : null}
        {reportsQuery.data?.zeroedByMonth.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {reportsQuery.data.zeroedByMonth.map((row) => (
                <MobileRecordCard key={row.month}>
                  <MobileRecordHeader title={row.month} />
                  <MobileFieldList>
                    <MobileField label="Zeroed Count" value={row.zeroedCount} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Zeroed Count</th>
                  </tr>
                </thead>
                <tbody>
                  {reportsQuery.data.zeroedByMonth.map((row) => (
                    <tr key={row.month}>
                      <td>{row.month}</td>
                      <td>{row.zeroedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      {isCustomWidthOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => setIsCustomWidthOpen(false)}
        >
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
