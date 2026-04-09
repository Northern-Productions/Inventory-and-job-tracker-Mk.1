import { Button } from '../../../../components/Button';
import { Input } from '../../../../components/Input';
import type { FilmCatalogEntry } from '../../../../domain';
import { hasManufacturerOption } from '../../utils/boxHelpers';
import { FilmNameAutocompleteInput } from '../FilmNameAutocompleteInput';
import {
  CUSTOM_MANUFACTURER_OPTION,
  WIDTH_BUTTON_VALUES,
  type WidthButtonValue
} from './helpers';
import type { RequirementDraftLine } from './types';

interface JobFilmRequirementsSectionProps {
  manufacturerOptions: string[];
  manufacturer: string;
  filmName: string;
  widthIn: string;
  requiredFeet: string;
  requirements: RequirementDraftLine[];
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  submitting: boolean;
  hasCustomWidth: boolean;
  onManufacturerChange: (value: string) => void;
  onFilmNameChange: (value: string) => void;
  onWidthButtonClick: (value: WidthButtonValue) => void;
  onRequiredFeetChange: (value: string) => void;
  onAddRequirement: () => void;
  onUpdateRequirementLine: (id: string, patch: Partial<RequirementDraftLine>) => void;
  onRemoveRequirementLine: (id: string) => void;
  onClearError: () => void;
}

export function JobFilmRequirementsSection({
  manufacturerOptions,
  manufacturer,
  filmName,
  widthIn,
  requiredFeet,
  requirements,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  submitting,
  hasCustomWidth,
  onManufacturerChange,
  onFilmNameChange,
  onWidthButtonClick,
  onRequiredFeetChange,
  onAddRequirement,
  onUpdateRequirementLine,
  onRemoveRequirementLine,
  onClearError
}: JobFilmRequirementsSectionProps) {
  const isKnownManufacturer = hasManufacturerOption(manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected =
    manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;

  return (
    <div className="dialog-section">
      <div className="dialog-section-header">
        <h3>Film Requirements</h3>
        <p className="muted-text">
          Add the film lines the job needs, then fine-tune the table if anything changes.
        </p>
      </div>

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Manufacturer</span>
          <select
            className="field-input"
            value={manufacturerSelectValue}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (nextValue === CUSTOM_MANUFACTURER_OPTION) {
                if (isKnownManufacturer) {
                  onManufacturerChange('');
                }
              } else {
                onManufacturerChange(nextValue);
              }
              onClearError();
            }}
            required
          >
            {manufacturerOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value={CUSTOM_MANUFACTURER_OPTION}>Enter New Manufacturer</option>
          </select>
        </label>
        {isCustomManufacturerSelected ? (
          <Input
            label="New Manufacturer"
            value={manufacturer}
            onChange={(event) => {
              onManufacturerChange(event.target.value);
              onClearError();
            }}
            required
          />
        ) : null}
        <FilmNameAutocompleteInput
          label="Film Name"
          value={filmName}
          manufacturer={manufacturer}
          catalogEntries={filmCatalogEntries}
          catalogLoading={filmCatalogLoading}
          catalogError={filmCatalogError}
          onChange={(nextValue) => {
            onFilmNameChange(nextValue);
            onClearError();
          }}
        />
        <div className="field width-selector">
          <span className="field-label">Width</span>
          <div className="width-button-grid">
            {WIDTH_BUTTON_VALUES.map((value) => {
              const isActive = value === 'CUSTOM' ? hasCustomWidth : widthIn === value;
              const buttonLabel =
                value === 'CUSTOM' && hasCustomWidth
                  ? widthIn
                  : value === 'CUSTOM'
                    ? 'Cust.'
                    : value;

              return (
                <button
                  key={value}
                  type="button"
                  className={`width-chip ${isActive ? 'width-chip-active' : ''}`.trim()}
                  onClick={() => onWidthButtonClick(value)}
                >
                  {buttonLabel}
                </button>
              );
            })}
          </div>
        </div>
        <Input
          label="LF Required"
          value={requiredFeet}
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => {
            onRequiredFeetChange(event.target.value.replace(/[^0-9]/g, ''));
            onClearError();
          }}
        />
      </div>

      <div className="dialog-actions">
        <Button type="button" variant="secondary" onClick={onAddRequirement} disabled={submitting}>
          Add
        </Button>
      </div>

      {requirements.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Film Name</th>
                <th>Width</th>
                <th>LF Required</th>
                <th>Remove</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((line) => (
                <tr key={line.id}>
                  <td>
                    <input
                      className="field-input"
                      value={line.manufacturer}
                      onChange={(event) => {
                        onUpdateRequirementLine(line.id, { manufacturer: event.target.value });
                        onClearError();
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input"
                      value={line.filmName}
                      onChange={(event) => {
                        onUpdateRequirementLine(line.id, { filmName: event.target.value });
                        onClearError();
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={line.widthIn}
                      onChange={(event) => {
                        onUpdateRequirementLine(line.id, { widthIn: event.target.value });
                        onClearError();
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="field-input"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={line.requiredFeet}
                      onChange={(event) => {
                        onUpdateRequirementLine(line.id, {
                          requiredFeet: event.target.value.replace(/[^0-9]/g, '')
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
                      onClick={() => onRemoveRequirementLine(line.id)}
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
        <p className="muted-text">
          No film requirements added yet. You can still save an empty job.
        </p>
      )}
    </div>
  );
}
