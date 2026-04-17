import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { JobRequirementLine } from '../../../../domain';

interface FilmRequirementsSectionProps {
  requirements: JobRequirementLine[];
  isPhoneLayout: boolean;
}

export function FilmRequirementsSection({
  requirements,
  isPhoneLayout
}: FilmRequirementsSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Film Requirements</h2>
      </div>
      {!requirements.length ? (
        <div className="empty-state">No film requirements added yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {requirements.map((entry) => (
            <MobileRecordCard key={entry.requirementId}>
              <MobileRecordHeader
                title={`${entry.manufacturer} ${entry.filmName}`}
                subtitle={`Width ${entry.widthIn}"`}
              />
              <MobileFieldList>
                <MobileField label="Required LF" value={entry.requiredFeet} />
                <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                <MobileField
                  label="Locked LF"
                  value={entry.allocatedWithInstallDateFeet ?? 0}
                />
                <MobileField
                  label="Placeholder LF"
                  value={entry.allocatedWithoutInstallDateFeet ?? 0}
                />
                <MobileField label="Remaining LF" value={entry.remainingFeet} />
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
                <th>Film</th>
                <th>Width</th>
                <th>Required LF</th>
                <th>Allocated LF</th>
                <th>Locked LF</th>
                <th>Placeholder LF</th>
                <th>Remaining LF</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((entry) => (
                <tr key={entry.requirementId}>
                  <td>{entry.manufacturer}</td>
                  <td>{entry.filmName}</td>
                  <td>{entry.widthIn}</td>
                  <td>{entry.requiredFeet}</td>
                  <td>{entry.allocatedFeet}</td>
                  <td>{entry.allocatedWithInstallDateFeet ?? 0}</td>
                  <td>{entry.allocatedWithoutInstallDateFeet ?? 0}</td>
                  <td>{entry.remainingFeet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
