import { Input } from '../../../../components/Input';
import { formatOwnerCompanyLabel, type FilmCatalogEntry, type OwnerCompanyEntry } from '../../../../domain';
import type { BoxDraft } from '../../utils/boxHelpers';
import { FilmNameAutocompleteInput } from '../FilmNameAutocompleteInput';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
type WidthButtonValue = '36' | '48' | '60' | '72' | 'CUSTOM';

interface BoxIdentitySectionProps {
  customManufacturerSelected: boolean;
  draft: BoxDraft;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogError?: unknown;
  filmCatalogLoading?: boolean;
  footageSectionCopy: string;
  manufacturerOptions: string[];
  manufacturerSelectValue: string;
  mode: 'create' | 'edit';
  ownerCompanies?: OwnerCompanyEntry[];
  ownerCompaniesError?: unknown;
  ownerCompaniesLoading?: boolean;
  originalOwnerCompanyId?: string;
  canEditExistingOwner?: boolean;
  showCurrentFeetField: boolean;
  widthButtonValues: readonly WidthButtonValue[];
  widthMode: string;
  onBoxIdChange: (value: string) => void;
  onFilmNameChange: (value: string) => void;
  onCurrentFeetChange: (value: string) => void;
  onInitialFeetChange: (value: string) => void;
  onLotRunChange: (value: string) => void;
  onManufacturerChange: (value: string) => void;
  onOwnerCompanyChange: (value: string) => void;
  onOwnershipNoteChange: (value: string) => void;
  onWidthButtonClick: (value: WidthButtonValue) => void;
}

export function BoxIdentitySection({
  customManufacturerSelected,
  draft,
  filmCatalogEntries,
  filmCatalogError,
  filmCatalogLoading = false,
  footageSectionCopy,
  manufacturerOptions,
  manufacturerSelectValue,
  mode,
  ownerCompanies = [],
  ownerCompaniesError,
  ownerCompaniesLoading = false,
  originalOwnerCompanyId = '',
  canEditExistingOwner = false,
  showCurrentFeetField,
  widthButtonValues,
  widthMode,
  onBoxIdChange,
  onFilmNameChange,
  onCurrentFeetChange,
  onInitialFeetChange,
  onLotRunChange,
  onManufacturerChange,
  onOwnerCompanyChange,
  onOwnershipNoteChange,
  onWidthButtonClick
}: BoxIdentitySectionProps) {
  const selectedOwnerId = String(draft.ownerCompanyId || '').trim();
  const ownerOptions = ownerCompanies
    .filter((entry) => entry.isActive || entry.ownerCompanyId === selectedOwnerId)
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code, undefined, { sensitivity: 'base' }));
  const ownerFieldDisabled = ownerCompaniesLoading || (mode === 'edit' && !canEditExistingOwner);
  const ownerChanged =
    mode === 'edit' &&
    selectedOwnerId &&
    originalOwnerCompanyId &&
    selectedOwnerId !== originalOwnerCompanyId;

  return (
    <div className={`form-section ${mode === 'create' ? 'form-section-first' : ''}`.trim()}>
      <div className="form-section-header">
        <h3>Box Identity</h3>
        <p className="muted-text">{footageSectionCopy}</p>
      </div>
      <div className="form-grid">
        <Input
          label="BoxID"
          value={draft.boxId}
          onChange={(event) => onBoxIdChange(event.target.value)}
          disabled={mode === 'edit'}
          required
        />
        <label className="field">
          <span className="field-label">Owner Company</span>
          <select
            className="field-input"
            value={selectedOwnerId}
            onChange={(event) => onOwnerCompanyChange(event.target.value)}
            disabled={ownerFieldDisabled}
            required={mode === 'create'}
          >
            <option value="">
              {ownerCompaniesLoading ? 'Loading owner companies...' : 'Select owner company'}
            </option>
            {ownerOptions.map((entry) => (
              <option key={entry.ownerCompanyId} value={entry.ownerCompanyId}>
                {formatOwnerCompanyLabel(entry)}
                {entry.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
          {ownerCompaniesError ? (
            <span className="field-error">Owner companies could not be loaded.</span>
          ) : null}
          {mode === 'edit' && !canEditExistingOwner ? (
            <span className="field-hint">Only owner-role users can change existing inventory ownership.</span>
          ) : null}
        </label>
        {mode === 'edit' && canEditExistingOwner && ownerChanged ? (
          <Input
            label="Ownership Note"
            value={draft.ownershipNote}
            onChange={(event) => onOwnershipNoteChange(event.target.value)}
            placeholder="Optional reason for ownership change"
          />
        ) : null}
        <label className="field">
          <span className="field-label">Manufacturer</span>
          <select
            className="field-input"
            value={manufacturerSelectValue}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (nextValue === CUSTOM_MANUFACTURER_OPTION) {
                if (!customManufacturerSelected) {
                  onManufacturerChange('');
                }
                return;
              }

              onManufacturerChange(nextValue);
            }}
            required
          >
            {manufacturerOptions.map((manufacturer) => (
              <option key={manufacturer} value={manufacturer}>
                {manufacturer}
              </option>
            ))}
            <option value={CUSTOM_MANUFACTURER_OPTION}>Enter New Manufacturer</option>
          </select>
        </label>
        {customManufacturerSelected ? (
          <Input
            label="New Manufacturer"
            value={draft.manufacturer}
            onChange={(event) => onManufacturerChange(event.target.value)}
            required
          />
        ) : null}
        <FilmNameAutocompleteInput
          label="Film Name"
          value={draft.filmName}
          manufacturer={draft.manufacturer}
          catalogEntries={filmCatalogEntries}
          catalogLoading={filmCatalogLoading}
          catalogError={filmCatalogError}
          onChange={onFilmNameChange}
          required
        />
        <div className="field width-selector">
          <span className="field-label">Width</span>
          <div className="width-button-grid">
            {widthButtonValues.map((value) => {
              const isActive = value === 'CUSTOM' ? widthMode === 'CUSTOM' : widthMode === value;
              const buttonLabel =
                value === 'CUSTOM' && widthMode === 'CUSTOM' && draft.widthIn
                  ? draft.widthIn
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
          label="Initial Linear Feet"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft.initialFeet}
          onChange={(event) => onInitialFeetChange(event.target.value)}
          required
        />
        {showCurrentFeetField ? (
          <Input
            label="Current Linear Feet"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft.currentFeetOnRoll}
            onChange={(event) => onCurrentFeetChange(event.target.value)}
            required
          />
        ) : null}
        <Input
          label="Lot Run"
          value={draft.lotRun}
          onChange={(event) => onLotRunChange(event.target.value)}
        />
      </div>
    </div>
  );
}
