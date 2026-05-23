import { Fragment, useMemo, useState } from 'react';
import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { AllocationJobDetailEntry, JobFilmTransferAlert } from '../../../../domain';
import { formatAllocationFeet, formatFilmTransferStateLabel, renderDateTime } from './helpers';

interface AllocatedBoxesSectionProps {
  entries: AllocationJobDetailEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  canOpenAllocateDialog: boolean;
  allocateButtonLabel: string;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  isStatusMutationPending: (boxId: string) => boolean;
  filmTransferAlertsByBoxId: Partial<Record<string, JobFilmTransferAlert>>;
  isWorkflowActiveAllocation?: (entry: AllocationJobDetailEntry) => boolean;
  onOpenAllocateDialog: () => void;
  onOpenBox: (boxId: string) => void;
  onOpenFilmCheckin: (entry: AllocationJobDetailEntry) => void;
  onCheckoutAllocation: (entry: AllocationJobDetailEntry) => void;
  onRemoveAllocation: (entry: AllocationJobDetailEntry) => void;
  isAllocationRemovalPending: (allocationId: string) => boolean;
}

function formatBoxStatusLabel(status: string) {
  return status ? status.replace(/_/g, ' ') : '--';
}

interface AllocatedBoxGroup {
  groupKey: string;
  detailsId: string;
  boxId: string;
  entries: AllocationJobDetailEntry[];
  representativeEntry: AllocationJobDetailEntry;
}

function normalizeBoxGroupKey(entry: AllocationJobDetailEntry) {
  return (entry.boxId || entry.allocationId).trim().toUpperCase();
}

function formatDetailsId(groupKey: string) {
  return `allocated-box-details-${groupKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function getRepresentativeEntry(entries: AllocationJobDetailEntry[]) {
  return (
    entries.find((entry) => entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT') ||
    entries.find((entry) => entry.status === 'ACTIVE' && !entry.resolvedAt) ||
    entries[0]
  );
}

export function buildAllocatedBoxGroups(entries: AllocationJobDetailEntry[]): AllocatedBoxGroup[] {
  const groups = new Map<string, AllocatedBoxGroup>();

  for (const entry of entries) {
    const groupKey = normalizeBoxGroupKey(entry);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.entries.push(entry);
      existing.representativeEntry = getRepresentativeEntry(existing.entries);
      continue;
    }

    groups.set(groupKey, {
      groupKey,
      detailsId: formatDetailsId(groupKey),
      boxId: entry.boxId,
      entries: [entry],
      representativeEntry: entry
    });
  }

  return Array.from(groups.values());
}

function formatGroupAllocationCount(group: AllocatedBoxGroup) {
  if (group.entries.length <= 1) {
    return '';
  }

  const requirementCount = group.entries.filter((entry) => entry.allocationKind !== 'EXTRA').length;
  if (requirementCount === group.entries.length) {
    return `Covers ${requirementCount} requirements`;
  }

  return `Covers ${group.entries.length} allocations`;
}

function formatGroupAllocationFeet(group: AllocatedBoxGroup) {
  const requirementEntries = group.entries.filter((entry) => entry.allocationKind !== 'EXTRA');
  const hasExtra = requirementEntries.length !== group.entries.length;

  if (!requirementEntries.length) {
    return 'EXTRA';
  }

  const allocatedFeet = requirementEntries.reduce((sum, entry) => sum + entry.allocatedFeet, 0);
  const coveredFeet = requirementEntries.reduce((sum, entry) => sum + entry.coveredFeet, 0);
  const formattedFeet = formatAllocationFeet(allocatedFeet, coveredFeet, 'REQUIREMENT');

  return hasExtra ? `${formattedFeet} + EXTRA` : formattedFeet;
}

function formatGroupDate(entries: AllocationJobDetailEntry[], field: 'createdAt' | 'resolvedAt') {
  const values = Array.from(new Set(entries.map((entry) => entry[field]).filter(Boolean)));
  if (!values.length) {
    return '--';
  }

  if (values.length === 1) {
    return renderDateTime(values[0]);
  }

  return 'See details';
}

function getAllocationStateLabel(entry: AllocationJobDetailEntry, transferAlert?: JobFilmTransferAlert) {
  if (entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT') {
    return 'Checked out on this job';
  }

  if (transferAlert) {
    return formatFilmTransferStateLabel(transferAlert);
  }

  if (entry.boxStatus === 'ORDERED') {
    return 'Waiting for receipt';
  }

  if (entry.boxStatus === 'IN_STOCK') {
    return 'Ready to check out';
  }

  return 'Not in stock';
}

function renderAllocationActions({
  entry,
  isReadOnlyJob,
  isStatusMutationPending,
  transferAlert,
  isWorkflowActive,
  onOpenFilmCheckin,
  onCheckoutAllocation,
  onRemoveAllocation,
  isAllocationRemovalPending,
  showRemove = true,
  removeHint = ''
}: {
  entry: AllocationJobDetailEntry;
  isReadOnlyJob: boolean;
  isStatusMutationPending: (boxId: string) => boolean;
  transferAlert?: JobFilmTransferAlert;
  isWorkflowActive: boolean;
  onOpenFilmCheckin: (entry: AllocationJobDetailEntry) => void;
  onCheckoutAllocation: (entry: AllocationJobDetailEntry) => void;
  onRemoveAllocation: (entry: AllocationJobDetailEntry) => void;
  isAllocationRemovalPending: (allocationId: string) => boolean;
  showRemove?: boolean;
  removeHint?: string;
}) {
  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  const statusPending = isStatusMutationPending(entry.boxId);

  return (
    <div className="film-order-actions">
      {entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT' ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onOpenFilmCheckin(entry)}
          disabled={statusPending}
        >
          Check In
        </Button>
      ) : transferAlert ? (
        <span className="muted-text">{formatFilmTransferStateLabel(transferAlert)}</span>
      ) : entry.boxStatus === 'ORDERED' ? (
        <span className="muted-text">Waiting for receipt</span>
      ) : !isWorkflowActive ? (
        <span className="muted-text">Placeholder phase</span>
      ) : entry.boxStatus === 'IN_STOCK' ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onCheckoutAllocation(entry)}
          disabled={statusPending}
        >
          Check Out
        </Button>
      ) : (
        <span className="muted-text">Not in stock</span>
      )}
      {showRemove && !entry.checkedOutOnThisJob ? (
        <Button
          type="button"
          variant="danger"
          onClick={() => onRemoveAllocation(entry)}
          disabled={isAllocationRemovalPending(entry.allocationId) || statusPending}
        >
          Remove
        </Button>
      ) : null}
      {!showRemove && removeHint ? <span className="muted-text">{removeHint}</span> : null}
    </div>
  );
}

function renderAllocationBreakdownActions({
  entry,
  isReadOnlyJob,
  isStatusMutationPending,
  onRemoveAllocation,
  isAllocationRemovalPending
}: {
  entry: AllocationJobDetailEntry;
  isReadOnlyJob: boolean;
  isStatusMutationPending: (boxId: string) => boolean;
  onRemoveAllocation: (entry: AllocationJobDetailEntry) => void;
  isAllocationRemovalPending: (allocationId: string) => boolean;
}) {
  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  if (entry.checkedOutOnThisJob) {
    return <span className="muted-text">Check in before removing</span>;
  }

  return (
    <Button
      type="button"
      variant="danger"
      onClick={() => onRemoveAllocation(entry)}
      disabled={isAllocationRemovalPending(entry.allocationId) || isStatusMutationPending(entry.boxId)}
    >
      Remove
    </Button>
  );
}

export function AllocatedBoxesSection({
  entries,
  isPhoneLayout,
  isReadOnlyJob,
  canOpenAllocateDialog,
  allocateButtonLabel,
  isAuthenticated,
  clientIdConfigured,
  isStatusMutationPending,
  filmTransferAlertsByBoxId,
  isWorkflowActiveAllocation = () => true,
  onOpenAllocateDialog,
  onOpenBox,
  onOpenFilmCheckin,
  onCheckoutAllocation,
  onRemoveAllocation,
  isAllocationRemovalPending
}: AllocatedBoxesSectionProps) {
  const groups = useMemo(() => buildAllocatedBoxGroups(entries), [entries]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey]
    }));
  };

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Allocated Boxes</h2>
        <div className="detail-actions allocation-header-actions">
          {!isReadOnlyJob ? (
            <Button
              type="button"
              onClick={onOpenAllocateDialog}
              disabled={!canOpenAllocateDialog || !isAuthenticated || !clientIdConfigured}
            >
              {allocateButtonLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {!groups.length ? (
        <div className="empty-state">No allocations are tied to this job yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {groups.map((group) => {
            const entry = group.representativeEntry;
            const actionEntry =
              group.entries.find((detailEntry) => isWorkflowActiveAllocation(detailEntry)) || entry;
            const transferAlert = filmTransferAlertsByBoxId[entry.boxId];
            const isExpanded = Boolean(expandedGroups[group.groupKey]);
            const canExpand = group.entries.length > 1;
            const allocationCountLabel = formatGroupAllocationCount(group);
            return (
              <MobileRecordCard key={group.groupKey}>
                <MobileRecordHeader
                  title={group.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  onTitleClick={() => onOpenBox(group.boxId)}
                />
                <MobileFieldList>
                  <MobileField label="Warehouse" value={entry.warehouse || '--'} />
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField
                    label="Status"
                    value={<span className={`badge badge-${entry.boxStatus}`}>{formatBoxStatusLabel(entry.boxStatus)}</span>}
                  />
                  <MobileField
                    label="Allocated LF"
                    value={formatGroupAllocationFeet(group)}
                  />
                  {allocationCountLabel ? <MobileField label="Coverage" value={allocationCountLabel} /> : null}
                  <MobileField label="Created" value={formatGroupDate(group.entries, 'createdAt')} />
                  <MobileField label="Resolved" value={formatGroupDate(group.entries, 'resolvedAt')} />
                </MobileFieldList>
                {canExpand ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleGroup(group.groupKey)}
                    aria-expanded={isExpanded}
                    aria-controls={group.detailsId}
                  >
                    {isExpanded ? 'Hide allocation details' : 'Show allocation details'}
                  </Button>
                ) : null}
                {isExpanded ? (
                  <div id={group.detailsId} className="mobile-record-list">
                    {group.entries.map((detailEntry) => {
                      const detailTransferAlert = filmTransferAlertsByBoxId[detailEntry.boxId];
                      return (
                        <div key={detailEntry.allocationId} className="mobile-record-card">
                          <MobileFieldList>
                            <MobileField label="Allocation" value={detailEntry.allocationId} />
                            <MobileField label="Requirement" value={detailEntry.requirementId || '--'} />
                            <MobileField
                              label="Film"
                              value={`${detailEntry.manufacturer} ${detailEntry.filmName}`}
                            />
                            <MobileField label="Width" value={detailEntry.widthIn || '--'} />
                            <MobileField
                              label="LF"
                              value={formatAllocationFeet(
                                detailEntry.allocatedFeet,
                                detailEntry.coveredFeet,
                                detailEntry.allocationKind
                              )}
                            />
                            <MobileField label="Kind" value={detailEntry.allocationKind} />
                            <MobileField label="Status" value={detailEntry.status} />
                            <MobileField
                              label="State"
                              value={getAllocationStateLabel(detailEntry, detailTransferAlert)}
                            />
                            <MobileField label="Created" value={renderDateTime(detailEntry.createdAt)} />
                            <MobileField label="Resolved" value={renderDateTime(detailEntry.resolvedAt)} />
                          </MobileFieldList>
                          {renderAllocationBreakdownActions({
                            entry: detailEntry,
                            isReadOnlyJob,
                            isStatusMutationPending,
                            onRemoveAllocation,
                            isAllocationRemovalPending
                          })}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {renderAllocationActions({
                  entry: actionEntry,
                  isReadOnlyJob,
                  isStatusMutationPending,
                  transferAlert,
                  isWorkflowActive: isWorkflowActiveAllocation(actionEntry),
                  onOpenFilmCheckin,
                  onCheckoutAllocation,
                  onRemoveAllocation,
                  isAllocationRemovalPending,
                  showRemove: group.entries.length === 1,
                  removeHint:
                    canExpand && !isExpanded && group.entries.some((detailEntry) => !detailEntry.checkedOutOnThisJob)
                      ? 'Expand to remove individual allocations'
                      : ''
                })}
              </MobileRecordCard>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Box</th>
                <th>Film</th>
                <th>Width</th>
                <th>Status</th>
                <th>LF</th>
                <th>Created</th>
                <th>Resolved</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const entry = group.representativeEntry;
                const actionEntry =
                  group.entries.find((detailEntry) => isWorkflowActiveAllocation(detailEntry)) || entry;
                const transferAlert = filmTransferAlertsByBoxId[entry.boxId];
                const isExpanded = Boolean(expandedGroups[group.groupKey]);
                const canExpand = group.entries.length > 1;
                const allocationCountLabel = formatGroupAllocationCount(group);
                return (
                  <Fragment key={group.groupKey}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="row-button"
                          onClick={() => onOpenBox(group.boxId)}
                        >
                          {group.boxId}
                        </button>
                        {entry.warehouse ? <div className="muted-text">{entry.warehouse}</div> : null}
                        {allocationCountLabel ? <div className="muted-text">{allocationCountLabel}</div> : null}
                        {canExpand ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleGroup(group.groupKey)}
                            aria-expanded={isExpanded}
                            aria-controls={group.detailsId}
                          >
                            {isExpanded ? 'Hide details' : 'Show details'}
                          </Button>
                        ) : null}
                      </td>
                      <td>
                        {entry.manufacturer} {entry.filmName}
                      </td>
                      <td>{entry.widthIn || '--'}</td>
                      <td>
                        <span className={`badge badge-${entry.boxStatus}`}>{formatBoxStatusLabel(entry.boxStatus)}</span>
                      </td>
                      <td>{formatGroupAllocationFeet(group)}</td>
                      <td>{formatGroupDate(group.entries, 'createdAt')}</td>
                      <td>{formatGroupDate(group.entries, 'resolvedAt')}</td>
                      <td>
                        {renderAllocationActions({
                          entry: actionEntry,
                          isReadOnlyJob,
                          isStatusMutationPending,
                          transferAlert,
                          isWorkflowActive: isWorkflowActiveAllocation(actionEntry),
                          onOpenFilmCheckin,
                          onCheckoutAllocation,
                          onRemoveAllocation,
                          isAllocationRemovalPending,
                          showRemove: group.entries.length === 1,
                          removeHint:
                            canExpand &&
                            !isExpanded &&
                            group.entries.some((detailEntry) => !detailEntry.checkedOutOnThisJob)
                              ? 'Expand to remove individual allocations'
                              : ''
                        })}
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr>
                        <td colSpan={8}>
                          <div id={group.detailsId} className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Allocation</th>
                                  <th>Requirement</th>
                                  <th>Film</th>
                                  <th>Width</th>
                                  <th>LF</th>
                                  <th>Kind</th>
                                  <th>Status</th>
                                  <th>State</th>
                                  <th>Created</th>
                                  <th>Resolved</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.entries.map((detailEntry) => {
                                  const detailTransferAlert = filmTransferAlertsByBoxId[detailEntry.boxId];
                                  return (
                                    <tr key={detailEntry.allocationId}>
                                      <td>{detailEntry.allocationId}</td>
                                      <td>{detailEntry.requirementId || '--'}</td>
                                      <td>
                                        {detailEntry.manufacturer} {detailEntry.filmName}
                                      </td>
                                      <td>{detailEntry.widthIn || '--'}</td>
                                      <td>
                                        {formatAllocationFeet(
                                          detailEntry.allocatedFeet,
                                          detailEntry.coveredFeet,
                                          detailEntry.allocationKind
                                        )}
                                      </td>
                                      <td>{detailEntry.allocationKind}</td>
                                      <td>{detailEntry.status}</td>
                                      <td>{getAllocationStateLabel(detailEntry, detailTransferAlert)}</td>
                                      <td>{renderDateTime(detailEntry.createdAt)}</td>
                                      <td>{renderDateTime(detailEntry.resolvedAt)}</td>
                                      <td>
                                        {renderAllocationBreakdownActions({
                                          entry: detailEntry,
                                          isReadOnlyJob,
                                          isStatusMutationPending,
                                          onRemoveAllocation,
                                          isAllocationRemovalPending
                                        })}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
