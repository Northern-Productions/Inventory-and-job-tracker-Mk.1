import { Input } from '../../../../components/Input';
import type { JobRequirementLine } from '../../../../domain';

interface RequirementFieldsProps {
  allocatableRequirements: JobRequirementLine[];
  selectedRequirementId: string;
  requestedFeet: string;
  onRequirementChange: (requirementId: string) => void;
  onRequestedFeetChange: (requestedFeet: string) => void;
}

export function RequirementFields({
  allocatableRequirements,
  selectedRequirementId,
  requestedFeet,
  onRequirementChange,
  onRequestedFeetChange
}: RequirementFieldsProps) {
  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">Requirement</span>
        <select
          className="field-input"
          value={selectedRequirementId}
          onChange={(event) => onRequirementChange(event.target.value)}
        >
          {allocatableRequirements.map((entry) => (
            <option key={entry.requirementId} value={entry.requirementId}>
              {entry.manufacturer} {entry.filmName} {entry.widthIn}" ({entry.remainingFeet} LF remaining)
            </option>
          ))}
        </select>
      </label>
      <Input
        label="Requested LF"
        value={requestedFeet}
        inputMode="numeric"
        pattern="[0-9]*"
        onChange={(event) => onRequestedFeetChange(event.target.value)}
      />
    </div>
  );
}
