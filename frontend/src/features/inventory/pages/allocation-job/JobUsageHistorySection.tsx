import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { JobUsageTimelineEntry } from '../../../../domain';
import { formatUsageQuantity, formatUsageTypeLabel, renderDateTime } from './helpers';

interface JobUsageHistorySectionProps {
  entries: JobUsageTimelineEntry[];
  isPhoneLayout: boolean;
  onOpenFilmBox: (boxId: string) => void;
}

export function JobUsageHistorySection({
  entries,
  isPhoneLayout,
  onOpenFilmBox
}: JobUsageHistorySectionProps) {
  const isFilmBoxReference = (entry: JobUsageTimelineEntry) =>
    entry.usageType === 'FILM' || entry.usageType === 'FILM_ORDER';

  return (
    <section className="panel panel-subtle">
      <div className="panel-title-row">
        <h2>Job Material History</h2>
      </div>
      {!entries.length ? (
        <div className="empty-state">No usage has been recorded for this job yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {entries.map((entry, index) => (
            <MobileRecordCard key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}>
              <MobileRecordHeader
                title={`${formatUsageTypeLabel(entry.usageType)} ${entry.itemName}`}
                subtitle={entry.itemCode ? `${entry.manufacturer} (${entry.itemCode})` : entry.manufacturer}
                onTitleClick={isFilmBoxReference(entry) ? () => onOpenFilmBox(entry.referenceId) : undefined}
              />
              <MobileFieldList>
                <MobileField label="Warehouse" value={entry.warehouse} />
                <MobileField label="Quantity" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
                <MobileField label="Returned" value={formatUsageQuantity(entry.returnedQuantity, entry.unit)} />
                <MobileField label="Used" value={formatUsageQuantity(entry.usedQuantity, entry.unit)} />
                <MobileField label="By" value={entry.actor || '--'} />
                <MobileField label="When" value={renderDateTime(entry.occurredAt)} />
                <MobileField label="Notes" value={entry.notes || '--'} />
              </MobileFieldList>
            </MobileRecordCard>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Quantity</th>
                <th>Returned</th>
                <th>Used</th>
                <th>By</th>
                <th>Notes</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}>
                  <td>{renderDateTime(entry.occurredAt)}</td>
                  <td>{formatUsageTypeLabel(entry.usageType)}</td>
                  <td>
                    {entry.manufacturer} {entry.itemName}
                    {entry.itemCode ? ` (${entry.itemCode})` : ''}
                  </td>
                  <td>{entry.warehouse}</td>
                  <td>{formatUsageQuantity(entry.checkedOutQuantity, entry.unit)}</td>
                  <td>{formatUsageQuantity(entry.returnedQuantity, entry.unit)}</td>
                  <td>{formatUsageQuantity(entry.usedQuantity, entry.unit)}</td>
                  <td>{entry.actor || '--'}</td>
                  <td>{entry.notes || '--'}</td>
                  <td>
                    {isFilmBoxReference(entry) ? (
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => onOpenFilmBox(entry.referenceId)}
                      >
                        {entry.referenceId}
                      </button>
                    ) : (
                      entry.referenceId
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
