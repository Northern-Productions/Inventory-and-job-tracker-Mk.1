import { Input } from '../../../../components/Input';
import type { JobRequirementLine } from '../../../../domain';

interface RequirementFieldsProps {
  allocatableRequirements: JobRequirementLine[];
  isExtraFilmMode: boolean;
  selectedRequirementId: string;
  requestedFeet: string;
  onRequirementChange: (requirementId: string) => void;
  onRequestedFeetChange: (requestedFeet: string) => void;
}

export function RequirementFields({
  allocatableRequirements,
  isExtraFilmMode,
  selectedRequirementId,
  requestedFeet,
  onRequirementChange,
  onRequestedFeetChange
}: RequirementFieldsProps) {
  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">{isExtraFilmMode ? 'Film Type' : 'Requirement'}</span>
        <select
          className="field-input"
          value={selectedRequirementId}
          onChange={(event) => onRequirementChange(event.target.value)}
        >
          {allocatableRequirements.map((entry) => (
            <option key={entry.requirementId} value={entry.requirementId}>
              {isExtraFilmMode
                ? `${entry.manufacturer} ${entry.filmName} ${entry.widthIn}" (${entry.requiredFeet} LF required)`
                : `${entry.manufacturer} ${entry.filmName} ${entry.widthIn}" (${entry.remainingFeet} LF remaining)`}
            </option>
          ))}
        </select>
      </label>
      {!isExtraFilmMode ? (
        <Input
          label="Requested LF"
          value={requestedFeet}
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => onRequestedFeetChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
