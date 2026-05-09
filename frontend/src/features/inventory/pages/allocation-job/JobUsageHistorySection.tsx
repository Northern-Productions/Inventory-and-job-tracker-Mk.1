import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { ReactNode } from 'react';
import type { JobUsageTimelineEntry } from '../../../../domain';
import { formatUsageQuantity, formatUsageTypeLabel, renderDateTime } from './helpers';

const UNKNOWN_VALUE = 'Unknown';
const PENDING_VALUE = 'Pending';

interface JobUsageHistorySectionProps {
  entries: JobUsageTimelineEntry[];
  isPhoneLayout: boolean;
  onOpenFilmBox: (boxId: string) => void;
}

function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatWidth(value: number | null | undefined) {
  return isKnownNumber(value) && value > 0 ? `${value}"` : UNKNOWN_VALUE;
}

function formatLbs(value: number | null | undefined, fallback = UNKNOWN_VALUE) {
  return isKnownNumber(value) ? `${value} lbs` : fallback;
}

function formatLf(value: number | null | undefined, fallback = UNKNOWN_VALUE) {
  return isKnownNumber(value) ? `${value} LF` : fallback;
}

function hasTrustedLegacyLf(entry: JobUsageTimelineEntry) {
  return entry.checkedOutQuantity > 0 || entry.returnedQuantity > 0 || entry.usedQuantity > 0;
}

function isPendingFilmReturn(entry: JobUsageTimelineEntry) {
  return entry.usageType === 'FILM' && Boolean(entry.checkedOutAt) && !entry.checkedInAt;
}

function getLeavingLf(entry: JobUsageTimelineEntry) {
  if (entry.feetBefore !== undefined) {
    return entry.feetBefore;
  }

  return hasTrustedLegacyLf(entry) ? entry.checkedOutQuantity : null;
}

function getReturningLf(entry: JobUsageTimelineEntry) {
  if (isPendingFilmReturn(entry)) {
    return undefined;
  }

  if (entry.feetAfter !== undefined) {
    return entry.feetAfter;
  }

  return hasTrustedLegacyLf(entry) ? entry.returnedQuantity : null;
}

function getUsedLf(entry: JobUsageTimelineEntry) {
  if (isPendingFilmReturn(entry)) {
    return undefined;
  }

  if (entry.usedLinearFeet !== undefined) {
    return entry.usedLinearFeet;
  }

  const leavingLf = getLeavingLf(entry);
  const returningLf = getReturningLf(entry);
  if (isKnownNumber(leavingLf) && isKnownNumber(returningLf)) {
    return Math.max(leavingLf - returningLf, 0);
  }

  return hasTrustedLegacyLf(entry) ? entry.usedQuantity : null;
}

function getUsedWeight(entry: JobUsageTimelineEntry) {
  if (isPendingFilmReturn(entry)) {
    return undefined;
  }

  if (entry.weightDeltaLbs !== undefined) {
    return entry.weightDeltaLbs;
  }

  if (isKnownNumber(entry.checkedOutWeightLbs) && isKnownNumber(entry.checkedInWeightLbs)) {
    return Math.max(entry.checkedOutWeightLbs - entry.checkedInWeightLbs, 0);
  }

  return null;
}

function formatPendingAwareLf(value: number | null | undefined) {
  return value === undefined ? PENDING_VALUE : formatLf(value);
}

function formatPendingAwareLbs(value: number | null | undefined) {
  return value === undefined ? PENDING_VALUE : formatLbs(value);
}

function renderDetailLine(label: string, value: ReactNode) {
  return (
    <div>
      <strong>{label}:</strong> {value}
    </div>
  );
}

function getEventLabel(entry: JobUsageTimelineEntry) {
  if (entry.usageType === 'FILM_ORDER') {
    return 'Film Order';
  }

  if (entry.usageType === 'FILM') {
    return isPendingFilmReturn(entry) ? 'Film Checkout' : 'Film Used';
  }

  return formatUsageTypeLabel(entry.usageType);
}

function getMaterialLabel(entry: JobUsageTimelineEntry) {
  const itemCode = entry.itemCode ? ` (${entry.itemCode})` : '';
  const width = entry.usageType === 'FILM' || entry.usageType === 'FILM_ORDER'
    ? `, ${formatWidth(entry.widthIn)}`
    : '';
  return `${entry.manufacturer} ${entry.itemName}${itemCode}${width}`;
}

function renderDesktopDetails(entry: JobUsageTimelineEntry) {
  if (entry.usageType === 'FILM_ORDER') {
    return (
      <div>
        {renderDetailLine('Ordered LF', formatUsageQuantity(entry.checkedOutQuantity, entry.unit))}
      </div>
    );
  }

  if (entry.usageType === 'FILM') {
    const returningLf = getReturningLf(entry);
    const usedLf = getUsedLf(entry);
    const usedWeight = getUsedWeight(entry);

    return (
      <div>
        {renderDetailLine('Leaving Date', entry.checkedOutAt ? renderDateTime(entry.checkedOutAt) : UNKNOWN_VALUE)}
        {renderDetailLine('Returning Date', entry.checkedInAt ? renderDateTime(entry.checkedInAt) : PENDING_VALUE)}
        {renderDetailLine('Leaving Weight', formatLbs(entry.checkedOutWeightLbs))}
        {renderDetailLine('Returning Weight', formatPendingAwareLbs(isPendingFilmReturn(entry) ? undefined : entry.checkedInWeightLbs))}
        {renderDetailLine('Weight Used', formatPendingAwareLbs(usedWeight))}
        {renderDetailLine('Leaving LF', formatLf(getLeavingLf(entry)))}
        {renderDetailLine('Returning LF', formatPendingAwareLf(returningLf))}
        {renderDetailLine('LF Used', formatPendingAwareLf(usedLf))}
      </div>
    );
  }

  return (
    <div>
      {renderDetailLine('Quantity', formatUsageQuantity(entry.checkedOutQuantity, entry.unit))}
      {renderDetailLine('Returned', formatUsageQuantity(entry.returnedQuantity, entry.unit))}
      {renderDetailLine('Used', formatUsageQuantity(entry.usedQuantity, entry.unit))}
    </div>
  );
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
                title={`${getEventLabel(entry)} ${entry.itemName}`}
                subtitle={getMaterialLabel(entry)}
                onTitleClick={isFilmBoxReference(entry) ? () => onOpenFilmBox(entry.referenceId) : undefined}
              />
              <MobileFieldList>
                <MobileField label="Warehouse" value={entry.warehouse} />
                {entry.usageType === 'FILM_ORDER' ? (
                  <MobileField label="Ordered LF" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
                ) : entry.usageType === 'FILM' ? (
                  <>
                    <MobileField label="Box" value={entry.referenceId} />
                    <MobileField label="Width" value={formatWidth(entry.widthIn)} />
                    <MobileField label="Leaving Date" value={entry.checkedOutAt ? renderDateTime(entry.checkedOutAt) : UNKNOWN_VALUE} />
                    <MobileField label="Returning Date" value={entry.checkedInAt ? renderDateTime(entry.checkedInAt) : PENDING_VALUE} />
                    <MobileField label="Leaving Weight" value={formatLbs(entry.checkedOutWeightLbs)} />
                    <MobileField label="Returning Weight" value={formatPendingAwareLbs(isPendingFilmReturn(entry) ? undefined : entry.checkedInWeightLbs)} />
                    <MobileField label="Weight Used" value={formatPendingAwareLbs(getUsedWeight(entry))} />
                    <MobileField label="Leaving LF" value={formatLf(getLeavingLf(entry))} />
                    <MobileField label="Returning LF" value={formatPendingAwareLf(getReturningLf(entry))} />
                    <MobileField label="LF Used" value={formatPendingAwareLf(getUsedLf(entry))} />
                  </>
                ) : (
                  <>
                    <MobileField label="Quantity" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
                    <MobileField label="Returned" value={formatUsageQuantity(entry.returnedQuantity, entry.unit)} />
                    <MobileField label="Used" value={formatUsageQuantity(entry.usedQuantity, entry.unit)} />
                  </>
                )}
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
                <th>Event</th>
                <th>Material</th>
                <th>Warehouse</th>
                <th>Details</th>
                <th>By</th>
                <th>Notes</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}>
                  <td>{renderDateTime(entry.occurredAt)}</td>
                  <td>{getEventLabel(entry)}</td>
                  <td>{getMaterialLabel(entry)}</td>
                  <td>{entry.warehouse}</td>
                  <td>{renderDesktopDetails(entry)}</td>
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
