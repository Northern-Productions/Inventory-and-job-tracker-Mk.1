import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { CaulkJobCheckoutEntry } from '../../../../domain';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import { formatBadgeLabel, renderDateTime } from './helpers';

interface CaulkCheckoutCyclesSectionProps {
  entries: CaulkJobCheckoutEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isCaulkCheckoutPending: (caulkCheckoutId: string, caulkAllocationId?: string) => boolean;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
}

function renderCheckoutActions({
  entry,
  isReadOnlyJob,
  isCaulkCheckoutPending,
  onOpenCheckin
}: {
  entry: CaulkJobCheckoutEntry;
  isReadOnlyJob: boolean;
  isCaulkCheckoutPending: (caulkCheckoutId: string, caulkAllocationId?: string) => boolean;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
}) {
  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  if (entry.status === 'OPEN') {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => onOpenCheckin(entry)}
        disabled={isCaulkCheckoutPending(entry.caulkCheckoutId, entry.caulkAllocationId)}
      >
        Check In
      </Button>
    );
  }

  return <span className="muted-text">Closed</span>;
}

export function CaulkCheckoutCyclesSection({
  entries,
  isPhoneLayout,
  isReadOnlyJob,
  isCaulkCheckoutPending,
  onOpenCheckin
}: CaulkCheckoutCyclesSectionProps) {
  return (
    <section className="panel panel-subtle">
      <div className="panel-title-row">
        <h2>Caulk Checkout Cycles</h2>
      </div>
      {!entries.length ? (
        <div className="empty-state">No caulk checkout cycles have been recorded for this job yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {entries.map((entry) => (
            <MobileRecordCard key={entry.caulkCheckoutId}>
              <MobileRecordHeader
                title={entry.caulkCheckoutId}
                subtitle={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                badge={<span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>}
              />
              <MobileFieldList>
                <MobileField label="Warehouse" value={entry.warehouse} />
                <MobileField label="Checked Out Tubes" value={entry.checkoutTubes} />
                <MobileField label="Overage Tubes" value={entry.overageTubes} />
                <MobileField label="Unused Tubes" value={entry.unusedTubes} />
                <MobileField label="Used Tubes" value={entry.usedTubes} />
                <MobileField label="Checked Out At" value={renderDateTime(entry.checkedOutAt)} />
                <MobileField label="Checked In At" value={renderDateTime(entry.checkedInAt)} />
              </MobileFieldList>
              <div className="film-order-actions">
                {renderCheckoutActions({
                  entry,
                  isReadOnlyJob,
                  isCaulkCheckoutPending,
                  onOpenCheckin
                })}
              </div>
            </MobileRecordCard>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Checkout ID</th>
                <th>Product</th>
                <th>Warehouse</th>
                <th>Checked Out</th>
                <th>Overage</th>
                <th>Unused</th>
                <th>Used</th>
                <th>Checked Out At</th>
                <th>Checked In At</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.caulkCheckoutId}>
                  <td>{entry.caulkCheckoutId}</td>
                  <td>{buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}</td>
                  <td>{entry.warehouse}</td>
                  <td>{entry.checkoutTubes}</td>
                  <td>{entry.overageTubes}</td>
                  <td>{entry.unusedTubes}</td>
                  <td>{entry.usedTubes}</td>
                  <td>{renderDateTime(entry.checkedOutAt)}</td>
                  <td>{renderDateTime(entry.checkedInAt)}</td>
                  <td>
                    <span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>
                  </td>
                  <td>
                    {renderCheckoutActions({
                      entry,
                      isReadOnlyJob,
                      isCaulkCheckoutPending,
                      onOpenCheckin
                    })}
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
