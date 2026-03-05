import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import type { FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  STANDARD_WIDTH_OPTIONS,
  addManufacturerOption,
  getManufacturerOptionsWithCatalog,
  hasManufacturerOption
} from '../utils/boxHelpers';
import { FilmNameAutocompleteInput } from './FilmNameAutocompleteInput';
import { WarehouseToggle } from './WarehouseToggle';

export interface JobRequirementEditorLine {
  requirementId?: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
}

export interface JobEditorSubmitPayload {
  jobNumber: string;
  warehouse: Warehouse;
  sections: string;
  dueDate: string;
  requirements: JobRequirementEditorLine[];
}

interface JobEditorDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  title: string;
  submitLabel: string;
  submitting?: boolean;
  initialJobNumber?: string;
  initialWarehouse?: Warehouse;
  initialSections?: string | number | null;
  initialDueDate?: string;
  initialRequirements?: JobRequirementEditorLine[];
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onCancel: () => void;
  onSubmit: (payload: JobEditorSubmitPayload) => void;
}

const EMPTY_REQUIREMENT_LINES: JobRequirementEditorLine[] = [];
const WIDTH_BUTTON_VALUES = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
type WidthButtonValue = (typeof WIDTH_BUTTON_VALUES)[number];
const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';

interface RequirementDraftLine {
  id: string;
  requirementId: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  requiredFeet: string;
}

function makeRequirementLineId() {
  return `job-req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftLine(entry?: JobRequirementEditorLine): RequirementDraftLine {
  return {
    id: makeRequirementLineId(),
    requirementId: entry?.requirementId || '',
    manufacturer: entry?.manufacturer || '',
    filmName: entry?.filmName || '',
    widthIn: entry ? String(entry.widthIn) : '',
    requiredFeet: entry ? String(entry.requiredFeet) : ''
  };
}

function getSectionsInputValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function normalizeKey(manufacturer: string, filmName: string, widthIn: number) {
  return `${manufacturer.trim().toLowerCase().replace(/\s+/g, ' ')}|${filmName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}|${widthIn}`;
}

function mergeRequirementLines(lines: JobRequirementEditorLine[]) {
  const merged = new Map<string, JobRequirementEditorLine>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = normalizeKey(line.manufacturer, line.filmName, line.widthIn);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...line });
      continue;
    }

    existing.requiredFeet += line.requiredFeet;
  }

  return Array.from(merged.values());
}

export function JobEditorDialog({
  open,
  mode,
  title,
  submitLabel,
  submitting = false,
  initialJobNumber = '',
  initialWarehouse = 'IL',
  initialSections = null,
  initialDueDate = '',
  initialRequirements = EMPTY_REQUIREMENT_LINES,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onCancel,
  onSubmit
}: JobEditorDialogProps) {
  const manufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogEntries),
    [filmCatalogEntries]
  );
  const [jobNumber, setJobNumber] = useState(initialJobNumber);
  const [warehouse, setWarehouse] = useState<Warehouse>(initialWarehouse);
  const [sections, setSections] = useState(getSectionsInputValue(initialSections));
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [requirements, setRequirements] = useState<RequirementDraftLine[]>(
    initialRequirements.map((entry) => createDraftLine(entry))
  );
  const [manufacturer, setManufacturer] = useState(manufacturerOptions[0] || '');
  const [filmName, setFilmName] = useState('');
  const [widthIn, setWidthIn] = useState('');
  const [requiredFeet, setRequiredFeet] = useState('');
  const [error, setError] = useState('');
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const hasCustomWidth =
    widthIn.trim() !== '' &&
    !STANDARD_WIDTH_OPTIONS.includes(widthIn as (typeof STANDARD_WIDTH_OPTIONS)[number]);
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) > 0;
  const isKnownManufacturer = hasManufacturerOption(manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer ? manufacturer : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;

  useEffect(() => {
    if (!open) {
      return;
    }

    setJobNumber(initialJobNumber);
    setWarehouse(initialWarehouse);
    setSections(getSectionsInputValue(initialSections));
    setDueDate(initialDueDate);
    setRequirements(initialRequirements.map((entry) => createDraftLine(entry)));
    setManufacturer(manufacturerOptions[0] || '');
    setFilmName('');
    setWidthIn('');
    setRequiredFeet('');
    setCustomWidthDraft('');
    setIsCustomWidthOpen(false);
    setError('');
  }, [
    initialDueDate,
    initialJobNumber,
    initialRequirements,
    initialSections,
    initialWarehouse,
    open
  ]);

  if (!open) {
    return null;
  }

  function updateRequirementLine(id: string, patch: Partial<RequirementDraftLine>) {
    setRequirements((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line))
    );
  }

  function removeRequirementLine(id: string) {
    setRequirements((current) => current.filter((line) => line.id !== id));
  }

  function handleAddRequirement() {
    const parsedWidth = Number(widthIn);
    const parsedRequiredFeet = Number(requiredFeet);

    if (!manufacturer.trim()) {
      setError('Manufacturer is required for each film line.');
      return;
    }

    if (!filmName.trim()) {
      setError('Film Name is required for each film line.');
      return;
    }

    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
      setError('Width must be greater than zero.');
      return;
    }

    if (!Number.isFinite(parsedRequiredFeet) || parsedRequiredFeet <= 0) {
      setError('LF Required must be greater than zero.');
      return;
    }

    setError('');
    addManufacturerOption(manufacturer);
    const nextLine: RequirementDraftLine = {
      id: makeRequirementLineId(),
      requirementId: '',
      manufacturer: manufacturer.trim(),
      filmName: filmName.trim(),
      widthIn: String(parsedWidth),
      requiredFeet: String(Math.floor(parsedRequiredFeet))
    };
    const nextKey = normalizeKey(nextLine.manufacturer, nextLine.filmName, parsedWidth);

    setRequirements((current) => {
      const existingIndex = current.findIndex((line) => {
        const lineWidth = Number(line.widthIn);
        if (!Number.isFinite(lineWidth)) {
          return false;
        }

        return normalizeKey(line.manufacturer, line.filmName, lineWidth) === nextKey;
      });

      if (existingIndex === -1) {
        return [...current, nextLine];
      }

      const currentLine = current[existingIndex];
      const mergedFeet = Math.floor(Number(currentLine.requiredFeet || 0)) + Math.floor(parsedRequiredFeet);
      const next = [...current];
      next[existingIndex] = {
        ...currentLine,
        requiredFeet: String(mergedFeet)
      };
      return next;
    });

    setFilmName('');
    setWidthIn('');
    setRequiredFeet('');
  }

  function handleWidthButtonClick(value: WidthButtonValue) {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(hasCustomWidth ? widthIn : '');
      setIsCustomWidthOpen(true);
      return;
    }

    setWidthIn(value);
    setError('');
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    setWidthIn(customWidthDraft.trim());
    setIsCustomWidthOpen(false);
    setError('');
  }

  function handleSave() {
    const normalizedJobNumber = jobNumber.replace(/[^0-9]/g, '');
    if (!normalizedJobNumber) {
      setError('Job ID number is required.');
      return;
    }

    const normalizedLines: JobRequirementEditorLine[] = [];

    for (let index = 0; index < requirements.length; index += 1) {
      const line = requirements[index];
      const parsedWidth = Number(line.widthIn);
      const parsedRequiredFeet = Number(line.requiredFeet);

      if (!line.manufacturer.trim() || !line.filmName.trim()) {
        setError(`Line ${index + 1}: Manufacturer and Film Name are required.`);
        return;
      }

      if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
        setError(`Line ${index + 1}: Width must be greater than zero.`);
        return;
      }

      if (!Number.isFinite(parsedRequiredFeet) || parsedRequiredFeet <= 0) {
        setError(`Line ${index + 1}: LF Required must be greater than zero.`);
        return;
      }

      normalizedLines.push({
        requirementId: line.requirementId || undefined,
        manufacturer: line.manufacturer.trim(),
        filmName: line.filmName.trim(),
        widthIn: parsedWidth,
        requiredFeet: Math.floor(parsedRequiredFeet)
      });
    }

    const mergedLines = mergeRequirementLines(normalizedLines);
    setError('');
    onSubmit({
      jobNumber: mode === 'edit' ? initialJobNumber : normalizedJobNumber,
      warehouse,
      sections,
      dueDate,
      requirements: mergedLines
    });
  }

  const disableJobNumber = mode === 'edit';

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="dialog dialog-job-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-editor-title"
      >
        <div className="dialog-header">
          <h2 id="job-editor-title">{title}</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close job editor dialog"
            onClick={onCancel}
          >
            X
          </button>
        </div>

        <div className="form-grid">
          <Input
            label="Job ID number"
            value={jobNumber}
            hint="Numbers only. Leading zeros are kept."
            placeholder="000123"
            inputMode="numeric"
            pattern="[0-9]*"
            onChange={(event) => {
              setJobNumber(event.target.value.replace(/[^0-9]/g, ''));
              setError('');
            }}
            required
            autoFocus={mode === 'create'}
            disabled={disableJobNumber}
          />
          <Input
            label="Sections"
            value={sections}
            hint='Optional. Comma-separated section numbers (example: "2, 4, 5").'
            inputMode="text"
            pattern="[0-9, ]*"
            onChange={(event) => {
              setSections(event.target.value.replace(/[^0-9,\s]/g, ''));
              setError('');
            }}
          />
          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(event) => {
              setDueDate(event.target.value);
              setError('');
            }}
          />
          <div className="field">
            <span className="field-label">Warehouse</span>
            <WarehouseToggle value={warehouse} onChange={setWarehouse} />
          </div>
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
                    setManufacturer('');
                  }
                } else {
                  setManufacturer(nextValue);
                }
                setError('');
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
                setManufacturer(event.target.value);
                setError('');
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
              setFilmName(nextValue);
              setError('');
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
                    onClick={() => handleWidthButtonClick(value)}
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
              setRequiredFeet(event.target.value.replace(/[^0-9]/g, ''));
              setError('');
            }}
          />
        </div>

        <div className="dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={handleAddRequirement}
            disabled={submitting}
          >
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
                          updateRequirementLine(line.id, { manufacturer: event.target.value });
                          setError('');
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field-input"
                        value={line.filmName}
                        onChange={(event) => {
                          updateRequirementLine(line.id, { filmName: event.target.value });
                          setError('');
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
                          updateRequirementLine(line.id, { widthIn: event.target.value });
                          setError('');
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
                          updateRequirementLine(line.id, {
                            requiredFeet: event.target.value.replace(/[^0-9]/g, '')
                          });
                          setError('');
                        }}
                      />
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => removeRequirementLine(line.id)}
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
          <p className="muted-text">No film requirements added yet. You can still save an empty job.</p>
        )}

        {error ? <p className="error-text">{error}</p> : null}

        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" fullWidth onClick={handleSave} disabled={submitting}>
            {submitting ? 'Saving...' : submitLabel}
          </Button>
        </div>
      </div>

      {isCustomWidthOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => setIsCustomWidthOpen(false)}
        >
          <div
            className="dialog width-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-custom-width-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="job-custom-width-title">Custom Width</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close custom width dialog"
                onClick={() => setIsCustomWidthOpen(false)}
              >
                X
              </button>
            </div>
            <Input
              label="Width In"
              type="number"
              step="0.01"
              min="0.01"
              value={customWidthDraft}
              onChange={(event) => setCustomWidthDraft(event.target.value)}
              autoFocus
            />
            <div className="dialog-actions dialog-actions-center">
              <Button
                type="button"
                variant="primary"
                className="custom-width-save"
                onClick={saveCustomWidth}
                disabled={!isCustomWidthValid}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
