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

function isFilmBoxReference(entry: JobUsageTimelineEntry) {
  return entry.usageType === 'FILM' || entry.usageType === 'FILM_ORDER';
}

function HistoryField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="job-material-history-field">
      <span className="job-material-history-label">{label}:</span>
      <strong>{value}</strong>
    </div>
  );
}

function HistoryGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="job-material-history-group" aria-label={title}>
      <h4>{title}</h4>
      <div className="job-material-history-fields">{children}</div>
    </section>
  );
}

function renderFilmGroups(entry: JobUsageTimelineEntry) {
  return (
    <>
      <HistoryGroup title="Leaving">
        <HistoryField label="Leaving Date" value={entry.checkedOutAt ? renderDateTime(entry.checkedOutAt) : UNKNOWN_VALUE} />
        <HistoryField label="Leaving Weight" value={formatLbs(entry.checkedOutWeightLbs)} />
        <HistoryField label="Leaving LF" value={formatLf(getLeavingLf(entry))} />
      </HistoryGroup>
      <HistoryGroup title="Returning">
        <HistoryField label="Returning Date" value={entry.checkedInAt ? renderDateTime(entry.checkedInAt) : PENDING_VALUE} />
        <HistoryField
          label="Returning Weight"
          value={formatPendingAwareLbs(isPendingFilmReturn(entry) ? undefined : entry.checkedInWeightLbs)}
        />
        <HistoryField label="Returning LF" value={formatPendingAwareLf(getReturningLf(entry))} />
      </HistoryGroup>
      <HistoryGroup title="Usage">
        <HistoryField label="Weight Used" value={formatPendingAwareLbs(getUsedWeight(entry))} />
        <HistoryField label="LF Used" value={formatPendingAwareLf(getUsedLf(entry))} />
      </HistoryGroup>
    </>
  );
}

function renderOrderGroups(entry: JobUsageTimelineEntry) {
  return (
    <HistoryGroup title="Order">
      <HistoryField label="Ordered LF" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
    </HistoryGroup>
  );
}

function renderCaulkGroups(entry: JobUsageTimelineEntry) {
  return (
    <>
      <HistoryGroup title="Leaving">
        <HistoryField label="Quantity" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
      </HistoryGroup>
      <HistoryGroup title="Returning">
        <HistoryField label="Returned" value={formatUsageQuantity(entry.returnedQuantity, entry.unit)} />
      </HistoryGroup>
      <HistoryGroup title="Usage">
        <HistoryField label="Used" value={formatUsageQuantity(entry.usedQuantity, entry.unit)} />
      </HistoryGroup>
    </>
  );
}

function MaterialHistoryCard({
  entry,
  index,
  onOpenFilmBox
}: {
  entry: JobUsageTimelineEntry;
  index: number;
  onOpenFilmBox: (boxId: string) => void;
}) {
  const cardKey = `${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`;

  return (
    <article className="job-material-history-card" data-history-key={cardKey}>
      <div className="job-material-history-card-header">
        <div>
          <span className="badge badge-neutral">{getEventLabel(entry)}</span>
          <h3>{entry.referenceId}</h3>
          <p className="muted-text">{getMaterialLabel(entry)}</p>
        </div>
        <div className="job-material-history-meta">
          <span>{entry.warehouse}</span>
          <span>{renderDateTime(entry.occurredAt)}</span>
          <span>{entry.actor || '--'}</span>
        </div>
      </div>

      <div className="job-material-history-groups">
        {entry.usageType === 'FILM_ORDER'
          ? renderOrderGroups(entry)
          : entry.usageType === 'FILM'
            ? renderFilmGroups(entry)
            : renderCaulkGroups(entry)}
      </div>

      <div className="job-material-history-footer">
        <div>
          <span className="job-material-history-label">Notes</span>
          <p>{entry.notes || '--'}</p>
        </div>
        <div>
          <span className="job-material-history-label">Reference</span>
          {isFilmBoxReference(entry) ? (
            <button
              type="button"
              className="row-button"
              onClick={() => onOpenFilmBox(entry.referenceId)}
            >
              {entry.referenceId}
            </button>
          ) : (
            <strong>{entry.referenceId}</strong>
          )}
        </div>
      </div>
    </article>
  );
}

export function JobUsageHistorySection({
  entries,
  isPhoneLayout,
  onOpenFilmBox
}: JobUsageHistorySectionProps) {
  return (
    <section className="panel panel-subtle">
      <div className="panel-title-row">
        <h2>Job Material History</h2>
      </div>
      {!entries.length ? (
        <div className="empty-state">No usage has been recorded for this job yet.</div>
      ) : (
        <div className={`job-material-history-list ${isPhoneLayout ? 'job-material-history-list-phone' : ''}`.trim()}>
          {entries.map((entry, index) => (
            <MaterialHistoryCard
              key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}
              entry={entry}
              index={index}
              onOpenFilmBox={onOpenFilmBox}
            />
          ))}
        </div>
      )}
    </section>
  );
}
