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
}

export function CaulkRequirementsSection({
  requirements,
  isPhoneLayout
}: CaulkRequirementsSectionProps) {
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
