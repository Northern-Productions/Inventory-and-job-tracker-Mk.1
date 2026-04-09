import { Button } from '../../../../components/Button';
import { Input } from '../../../../components/Input';
import type { CaulkRequirementDraftLine } from './types';

interface CaulkProductOption {
  value: string;
  label: string;
}

interface JobCaulkRequirementsSectionProps {
  caulkProductOptions: CaulkProductOption[];
  caulkProductLabelById: Record<string, string>;
  caulkProductId: string;
  caulkRequiredTubes: string;
  caulkRequirements: CaulkRequirementDraftLine[];
  caulkProductLoading: boolean;
  caulkProductError?: unknown;
  submitting: boolean;
  onCaulkProductChange: (value: string) => void;
  onCaulkRequiredTubesChange: (value: string) => void;
  onAddCaulkRequirement: () => void;
  onUpdateCaulkRequirementLine: (id: string, patch: Partial<CaulkRequirementDraftLine>) => void;
  onRemoveCaulkRequirementLine: (id: string) => void;
  onClearError: () => void;
}

export function JobCaulkRequirementsSection({
  caulkProductOptions,
  caulkProductLabelById,
  caulkProductId,
  caulkRequiredTubes,
  caulkRequirements,
  caulkProductLoading,
  caulkProductError,
  submitting,
  onCaulkProductChange,
  onCaulkRequiredTubesChange,
  onAddCaulkRequirement,
  onUpdateCaulkRequirementLine,
  onRemoveCaulkRequirementLine,
  onClearError
}: JobCaulkRequirementsSectionProps) {
  return (
    <div className="dialog-section">
      <div className="dialog-section-header">
        <h3>Caulk Requirements</h3>
        <p className="muted-text">Add each caulk draft to the list before saving the job.</p>
      </div>

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Caulk Product</span>
          <select
            className="field-input"
            value={caulkProductId}
            onChange={(event) => {
              onCaulkProductChange(event.target.value);
              onClearError();
            }}
            disabled={caulkProductLoading || !caulkProductOptions.length}
          >
            {caulkProductOptions.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Caulk Required Tubes"
          value={caulkRequiredTubes}
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => {
            onCaulkRequiredTubesChange(event.target.value.replace(/[^0-9]/g, ''));
            onClearError();
          }}
        />
      </div>

      <div className="dialog-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={onAddCaulkRequirement}
          disabled={submitting || caulkProductLoading || !caulkProductOptions.length}
        >
          Add Caulk Requirement
        </Button>
      </div>

      {caulkProductError ? (
        <p className="error-text">
          {caulkProductError instanceof Error
            ? caulkProductError.message
            : 'Caulk products failed to load.'}
        </p>
      ) : null}

      {caulkRequirements.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Caulk Product</th>
                <th>Required Tubes</th>
                <th>Remove</th>
              </tr>
            </thead>
            <tbody>
              {caulkRequirements.map((line) => (
                <tr key={line.id}>
                  <td>{caulkProductLabelById[line.productId] || line.productId}</td>
                  <td>
                    <input
                      className="field-input"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={line.requiredTubes}
                      onChange={(event) => {
                        onUpdateCaulkRequirementLine(line.id, {
                          requiredTubes: event.target.value.replace(/[^0-9]/g, '')
                        });
                        onClearError();
                      }}
                    />
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemoveCaulkRequirementLine(line.id)}
                      disabled={submitting}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted-text">No caulk requirements added yet.</p>
      )}
    </div>
  );
}
