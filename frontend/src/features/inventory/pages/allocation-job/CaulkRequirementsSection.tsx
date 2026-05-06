import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { JobCaulkRequirementLine } from '../../../../domain';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import { formatCaulkTubeBreakdown } from '../../utils/caulkAllocationPlanning';

interface CaulkRequirementsSectionProps {
  requirements: JobCaulkRequirementLine[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  isResumeAutoPlanningPending: boolean;
  onResumeAutoPlanning: (requirement: JobCaulkRequirementLine) => void;
}

export function CaulkRequirementsSection({
  requirements,
  isPhoneLayout,
  isReadOnlyJob,
  isAuthenticated,
  clientIdConfigured,
  isResumeAutoPlanningPending,
  onResumeAutoPlanning
}: CaulkRequirementsSectionProps) {
  function renderRequirementAction(entry: JobCaulkRequirementLine) {
    const remainingTubes = Math.max(0, Number(entry.remainingTubes || 0));
    if (!entry.autoPlanningSuppressed || remainingTubes <= 0) {
      return <span className="muted-text">--</span>;
    }

    if (isReadOnlyJob) {
      return <span className="muted-text">Auto planning paused</span>;
    }

    return (
      <div className="film-order-actions film-order-actions--stacked">
        <span className="muted-text">Auto planning paused</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!isAuthenticated || !clientIdConfigured}
          loading={isResumeAutoPlanningPending}
          loadingLabel="Resuming"
          onClick={() => onResumeAutoPlanning(entry)}
        >
          Resume auto-plan
        </Button>
      </div>
    );
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Caulk Requirements</h2>
      </div>
      {!requirements.length ? (
        <div className="empty-state">No caulk requirements added yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {requirements.map((entry) => (
            <MobileRecordCard key={entry.requirementId}>
              <MobileRecordHeader
                title={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                subtitle={`Tubes/Case ${entry.tubesPerCase}`}
              />
              <MobileFieldList>
                <MobileField label="Required Tubes" value={entry.requiredTubes} />
                <MobileField
                  label="Required Breakdown"
                  value={formatCaulkTubeBreakdown(entry.requiredTubes, entry.tubesPerCase)}
                />
                <MobileField label="Allocated Tubes" value={entry.allocatedTubes} />
                <MobileField label="Remaining Tubes" value={entry.remainingTubes} />
                <MobileField
                  label="Remaining Breakdown"
                  value={formatCaulkTubeBreakdown(entry.remainingTubes, entry.tubesPerCase)}
                />
              </MobileFieldList>
              <div className="film-order-actions">
                {renderRequirementAction(entry)}
              </div>
            </MobileRecordCard>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Product</th>
                <th>Code</th>
                <th>Tubes/Case</th>
                <th>Required Tubes</th>
                <th>Required Breakdown</th>
                <th>Allocated Tubes</th>
                <th>Remaining Tubes</th>
                <th>Remaining Breakdown</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((entry) => (
                <tr key={entry.requirementId}>
                  <td>{entry.manufacturer}</td>
                  <td>{entry.productName}</td>
                  <td>{entry.productCode || '--'}</td>
                  <td>{entry.tubesPerCase}</td>
                  <td>{entry.requiredTubes}</td>
                  <td>{formatCaulkTubeBreakdown(entry.requiredTubes, entry.tubesPerCase)}</td>
                  <td>{entry.allocatedTubes}</td>
                  <td>{entry.remainingTubes}</td>
                  <td>{formatCaulkTubeBreakdown(entry.remainingTubes, entry.tubesPerCase)}</td>
                  <td>{renderRequirementAction(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
