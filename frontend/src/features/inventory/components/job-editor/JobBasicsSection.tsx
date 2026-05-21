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
  showPhaseFields?: boolean;
  onJobNumberChange: (value: string) => void;
  onSectionsChange?: (value: string) => void;
  onInstallDateChange?: (value: string) => void;
  onCrewLeaderChange?: (value: string) => void;
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
  showPhaseFields = true,
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
          {showPhaseFields
            ? 'Set the job details the crew should pull against.'
            : 'Set the job-level details shared by every phase.'}
        </p>
      </div>

      <div
        className={`job-editor-basics-layout ${
          showPhaseFields ? '' : 'job-editor-basics-layout--job-only'
        }`.trim()}
      >
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
          {showPhaseFields ? (
            <>
              <Input
                label="Work Scope"
                value={sections}
                hint="Optional. Examples: Section 1, Sections 4, 5, Lobby, Phase 2."
                inputMode="text"
                onChange={(event) => {
                  onSectionsChange?.(event.target.value);
                  onClearError();
                }}
              />
              <Input
                label="Install Date"
                type="date"
                value={installDate}
                onChange={(event) => {
                  onInstallDateChange?.(event.target.value);
                  onClearError();
                }}
              />
            </>
          ) : null}
        </div>

        <div className="job-editor-basics-secondary-grid">
          {showPhaseFields ? (
            <Input
              label="Crew Leader"
              value={crewLeader}
              onChange={(event) => {
                onCrewLeaderChange?.(event.target.value);
                onClearError();
              }}
            />
          ) : null}
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
