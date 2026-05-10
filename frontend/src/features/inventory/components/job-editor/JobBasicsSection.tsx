import { Input } from '../../../../components/Input';
import type { Warehouse } from '../../../../domain';
import { WarehouseSelectField } from '../WarehouseSelectField';

interface JobBasicsSectionProps {
  mode: 'create' | 'edit';
  jobNumber: string;
  sections: string;
  installDate: string;
  crewLeader: string;
  warehouse: Warehouse;
  onJobNumberChange: (value: string) => void;
  onSectionsChange: (value: string) => void;
  onInstallDateChange: (value: string) => void;
  onCrewLeaderChange: (value: string) => void;
  onWarehouseChange: (value: Warehouse) => void;
  onClearError: () => void;
}

export function JobBasicsSection({
  mode,
  jobNumber,
  sections,
  installDate,
  crewLeader,
  warehouse,
  onJobNumberChange,
  onSectionsChange,
  onInstallDateChange,
  onCrewLeaderChange,
  onWarehouseChange,
  onClearError
}: JobBasicsSectionProps) {
  const disableJobNumber = mode === 'edit';

  return (
    <div className="dialog-section">
      <div className="dialog-section-header">
        <h3>Job Basics</h3>
        <p className="muted-text">
          Keep the current create and edit flow intact while making the first fields easier to scan.
        </p>
      </div>

      <div className="job-editor-basics-layout">
        <div className="job-editor-basics-primary-grid">
          <Input
            label="Job ID number"
            value={jobNumber}
            hint="Numbers only. Leading zeros are kept."
            placeholder="000123"
            inputMode="numeric"
            pattern="[0-9]*"
            onChange={(event) => {
              onJobNumberChange(event.target.value.replace(/[^0-9]/g, ''));
              onClearError();
            }}
            required
            autoFocus={mode === 'create'}
            disabled={disableJobNumber}
          />
          <Input
            label="Work Scope"
            value={sections}
            hint="Optional. Examples: Section 1, Sections 4, 5, Lobby, Phase 2."
            inputMode="text"
            onChange={(event) => {
              onSectionsChange(event.target.value);
              onClearError();
            }}
          />
          <Input
            label="Install Date"
            type="date"
            value={installDate}
            onChange={(event) => {
              onInstallDateChange(event.target.value);
              onClearError();
            }}
          />
        </div>

        <div className="job-editor-basics-secondary-grid">
          <Input
            label="Crew Leader"
            value={crewLeader}
            onChange={(event) => {
              onCrewLeaderChange(event.target.value);
              onClearError();
            }}
          />
          <WarehouseSelectField
            label="Warehouse"
            value={warehouse}
            onChange={(nextWarehouse) => onWarehouseChange(nextWarehouse as Warehouse)}
          />
        </div>
      </div>
    </div>
  );
}
