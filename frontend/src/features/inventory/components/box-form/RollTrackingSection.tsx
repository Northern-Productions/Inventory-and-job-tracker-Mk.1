import { Input } from '../../../../components/Input';
import { CORE_TYPE_OPTIONS, type BoxDraft } from '../../utils/boxHelpers';

interface RollTrackingSectionProps {
  canCaptureReceivingDetails: boolean;
  draft: BoxDraft;
  mode: 'create' | 'edit';
  onCoreTypeChange: (value: string) => void;
  onInitialWeightChange: (value: string) => void;
  onLastRollWeightChange: (value: string) => void;
  onLastWeighedDateChange: (value: string) => void;
}

export function RollTrackingSection({
  canCaptureReceivingDetails,
  draft,
  mode,
  onCoreTypeChange,
  onInitialWeightChange,
  onLastRollWeightChange,
  onLastWeighedDateChange
}: RollTrackingSectionProps) {
  return (
    <div className="form-section">
      <div className="form-section-header">
        <h3>Roll Tracking</h3>
        <p className="muted-text">Store the physical roll details used for check-in and stock math.</p>
      </div>
      <div className="form-grid">
        <Input
          label="Initial Weight (lbs)"
          type="number"
          step="0.01"
          min="0"
          value={draft.initialWeightLbs}
          onChange={(event) => onInitialWeightChange(event.target.value)}
          disabled={!canCaptureReceivingDetails}
          hint={
            mode === 'create' && canCaptureReceivingDetails
              ? 'Required the first time a received film key is saved.'
              : mode === 'create'
                ? 'Add a received date to capture initial roll weight.'
                : undefined
          }
        />
        <label className="field">
          <span className="field-label">Core Type</span>
          <select
            className="field-input"
            value={draft.coreType}
            onChange={(event) => onCoreTypeChange(event.target.value)}
            disabled={!canCaptureReceivingDetails}
          >
            <option value="">Select core type</option>
            {CORE_TYPE_OPTIONS.map((coreType) => (
              <option key={coreType} value={coreType}>
                {coreType}
              </option>
            ))}
          </select>
          {mode === 'create' ? (
            <span className="field-hint">
              {canCaptureReceivingDetails
                ? 'Stored on the film key for future auto-filled boxes.'
                : 'Add a received date to set the core type.'}
            </span>
          ) : null}
        </label>
        {mode === 'edit' ? (
          <Input
            label="Last Roll Weight (lbs)"
            type="number"
            step="0.01"
            min="0"
            value={draft.lastRollWeightLbs}
            onChange={(event) => onLastRollWeightChange(event.target.value)}
          />
        ) : null}
        {mode === 'edit' ? (
          <Input
            label="Last Weighed Date"
            type="date"
            value={draft.lastWeighedDate}
            onChange={(event) => onLastWeighedDateChange(event.target.value)}
          />
        ) : null}
      </div>
    </div>
  );
}
