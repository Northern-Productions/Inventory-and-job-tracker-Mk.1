import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import type { CaulkProductEntry, FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  STANDARD_WIDTH_OPTIONS,
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog,
  hasManufacturerOption
} from '../utils/boxHelpers';
import { buildCaulkProductLabel } from '../utils/caulkProductLabels';
import { getPreferredCaulkProductId } from '../utils/caulkProductPreferences';
import {
  buildPendingJobEditorDraftMessage,
  getPendingJobEditorDrafts
} from '../utils/jobEditorDrafts';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { FilmNameAutocompleteInput } from './FilmNameAutocompleteInput';
import { WarehouseSelectField } from './WarehouseSelectField';

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
  crewLeader: string;
  requirements: JobRequirementEditorLine[];
  caulkRequirements: JobCaulkRequirementEditorLine[];
}

export interface JobCaulkRequirementEditorLine {
  requirementId?: string;
  productId: string;
  requiredTubes: number;
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
  initialCrewLeader?: string;
  initialRequirements?: JobRequirementEditorLine[];
  initialCaulkRequirements?: JobCaulkRequirementEditorLine[];
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  caulkProductEntries?: CaulkProductEntry[];
  caulkProductLoading?: boolean;
  caulkProductError?: unknown;
  onCancel: () => void;
  onSubmit: (payload: JobEditorSubmitPayload) => void;
}

const EMPTY_REQUIREMENT_LINES: JobRequirementEditorLine[] = [];
const EMPTY_CAULK_REQUIREMENT_LINES: JobCaulkRequirementEditorLine[] = [];
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

interface CaulkRequirementDraftLine {
  id: string;
  requirementId: string;
  productId: string;
  requiredTubes: string;
}

function makeRequirementLineId() {
  return `job-req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftLine(entry?: JobRequirementEditorLine): RequirementDraftLine {
  return {
    id: makeRequirementLineId(),
    requirementId: entry?.requirementId || '',
    manufacturer: canonicalizeManufacturerLabel(entry?.manufacturer || ''),
    filmName: entry?.filmName || '',
    widthIn: entry ? String(entry.widthIn) : '',
    requiredFeet: entry ? String(entry.requiredFeet) : ''
  };
}

function createCaulkDraftLine(entry?: JobCaulkRequirementEditorLine): CaulkRequirementDraftLine {
  return {
    id: makeRequirementLineId(),
    requirementId: entry?.requirementId || '',
    productId: entry?.productId || '',
    requiredTubes: entry ? String(entry.requiredTubes) : ''
  };
}

function getSectionsInputValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function normalizeKey(manufacturer: string, filmName: string, widthIn: number) {
  return `${canonicalizeManufacturerLabel(manufacturer).toLowerCase()}|${filmName
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
  initialWarehouse = '',
  initialSections = null,
  initialDueDate = '',
  initialCrewLeader = '',
  initialRequirements = EMPTY_REQUIREMENT_LINES,
  initialCaulkRequirements = EMPTY_CAULK_REQUIREMENT_LINES,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  caulkProductEntries = [],
  caulkProductLoading = false,
  caulkProductError,
  onCancel,
  onSubmit
}: JobEditorDialogProps) {
  const warehouseRegistry = useWarehouseRegistry();
  const defaultWarehouse = warehouseRegistry.entries[0]?.code || '';
  const manufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogEntries),
    [filmCatalogEntries]
  );
  const caulkProductOptions = useMemo(
    () =>
      caulkProductEntries.map((entry) => ({
        value: entry.productId,
        label: buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)
      })),
    [caulkProductEntries]
  );
  const caulkProductLabelById = useMemo(
    () =>
      Object.fromEntries(caulkProductOptions.map((entry) => [entry.value, entry.label])) as Record<string, string>,
    [caulkProductOptions]
  );
  const preferredCaulkProductId = useMemo(
    () => getPreferredCaulkProductId(caulkProductEntries),
    [caulkProductEntries]
  );
  const [jobNumber, setJobNumber] = useState(initialJobNumber);
  const [warehouse, setWarehouse] = useState<Warehouse>(initialWarehouse || defaultWarehouse);
  const [sections, setSections] = useState(getSectionsInputValue(initialSections));
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [crewLeader, setCrewLeader] = useState(initialCrewLeader);
  const [requirements, setRequirements] = useState<RequirementDraftLine[]>(
    initialRequirements.map((entry) => createDraftLine(entry))
  );
  const [caulkRequirements, setCaulkRequirements] = useState<CaulkRequirementDraftLine[]>(
    initialCaulkRequirements.map((entry) => createCaulkDraftLine(entry))
  );
  const [manufacturer, setManufacturer] = useState(manufacturerOptions[0] || '');
  const [filmName, setFilmName] = useState('');
  const [widthIn, setWidthIn] = useState('');
  const [requiredFeet, setRequiredFeet] = useState('');
  const [caulkProductId, setCaulkProductId] = useState(preferredCaulkProductId);
  const [caulkRequiredTubes, setCaulkRequiredTubes] = useState('');
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
    setWarehouse(initialWarehouse || defaultWarehouse);
    setSections(getSectionsInputValue(initialSections));
    setDueDate(initialDueDate);
    setCrewLeader(initialCrewLeader);
    setRequirements(initialRequirements.map((entry) => createDraftLine(entry)));
    setCaulkRequirements(initialCaulkRequirements.map((entry) => createCaulkDraftLine(entry)));
    setManufacturer(manufacturerOptions[0] || '');
    setFilmName('');
    setWidthIn('');
    setRequiredFeet('');
    setCaulkProductId(preferredCaulkProductId);
    setCaulkRequiredTubes('');
    setCustomWidthDraft('');
    setIsCustomWidthOpen(false);
    setError('');
  }, [
    caulkProductEntries,
    initialDueDate,
    initialCaulkRequirements,
    initialCrewLeader,
    initialJobNumber,
    initialRequirements,
    initialSections,
    defaultWarehouse,
    initialWarehouse,
    open,
    preferredCaulkProductId
  ]);

  useEffect(() => {
    if (!caulkProductId && caulkProductOptions.length > 0) {
      setCaulkProductId(preferredCaulkProductId || caulkProductOptions[0].value);
    }
  }, [caulkProductId, caulkProductOptions, preferredCaulkProductId]);

  if (!open) {
    return null;
  }

  function updateRequirementLine(id: string, patch: Partial<RequirementDraftLine>) {
    setRequirements((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line))
    );
  }

  function updateCaulkRequirementLine(id: string, patch: Partial<CaulkRequirementDraftLine>) {
    setCaulkRequirements((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line))
    );
  }

  function removeRequirementLine(id: string) {
    setRequirements((current) => current.filter((line) => line.id !== id));
  }

  function removeCaulkRequirementLine(id: string) {
    setCaulkRequirements((current) => current.filter((line) => line.id !== id));
  }

  function handleAddRequirement() {
    const parsedWidth = Number(widthIn);
    const parsedRequiredFeet = Number(requiredFeet);
    const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);

    if (!normalizedManufacturer.trim()) {
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
    const nextLine: RequirementDraftLine = {
      id: makeRequirementLineId(),
      requirementId: '',
      manufacturer: normalizedManufacturer.trim(),
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

  function handleAddCaulkRequirement() {
    const parsedRequiredTubes = Number(caulkRequiredTubes);
    if (!caulkProductId.trim()) {
      setError('Select a caulk product first.');
      return;
    }
    if (!Number.isFinite(parsedRequiredTubes) || parsedRequiredTubes <= 0) {
      setError('Caulk required tubes must be greater than zero.');
      return;
    }

    setCaulkRequirements((current) => {
      const existingIndex = current.findIndex((line) => line.productId === caulkProductId);
      if (existingIndex === -1) {
        return [
          ...current,
          {
            id: makeRequirementLineId(),
            requirementId: '',
            productId: caulkProductId,
            requiredTubes: String(Math.floor(parsedRequiredTubes))
          }
        ];
      }

      const next = [...current];
      const existing = next[existingIndex];
      const mergedRequired = Math.floor(Number(existing.requiredTubes || 0)) + Math.floor(parsedRequiredTubes);
      next[existingIndex] = {
        ...existing,
        requiredTubes: String(mergedRequired)
      };
      return next;
    });

    setCaulkRequiredTubes('');
    setError('');
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

    const pendingDrafts = getPendingJobEditorDrafts({
      filmName,
      widthIn,
      requiredFeet,
      caulkRequiredTubes
    });
    const pendingDraftMessage = buildPendingJobEditorDraftMessage(pendingDrafts);
    if (pendingDraftMessage) {
      setError(pendingDraftMessage);
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
        manufacturer: canonicalizeManufacturerLabel(line.manufacturer).trim(),
        filmName: line.filmName.trim(),
        widthIn: parsedWidth,
        requiredFeet: Math.floor(parsedRequiredFeet)
      });
    }

    const mergedLines = mergeRequirementLines(normalizedLines);
    const normalizedCaulkLines: JobCaulkRequirementEditorLine[] = [];
    for (let index = 0; index < caulkRequirements.length; index += 1) {
      const line = caulkRequirements[index];
      const parsedRequiredTubes = Number(line.requiredTubes);
      if (!line.productId.trim()) {
        setError(`Caulk line ${index + 1}: product is required.`);
        return;
      }
      if (!Number.isFinite(parsedRequiredTubes) || parsedRequiredTubes <= 0) {
        setError(`Caulk line ${index + 1}: required tubes must be greater than zero.`);
        return;
      }
      normalizedCaulkLines.push({
        requirementId: line.requirementId || undefined,
        productId: line.productId,
        requiredTubes: Math.floor(parsedRequiredTubes)
      });
    }
    setError('');
    onSubmit({
      jobNumber: mode === 'edit' ? initialJobNumber : normalizedJobNumber,
      warehouse,
      sections,
      dueDate,
      crewLeader: crewLeader.trim(),
      requirements: mergedLines,
      caulkRequirements: normalizedCaulkLines
    });
  }

  const disableJobNumber = mode === 'edit';

  return (
    <DialogSurface open={open} onClose={onCancel} className="dialog-job-editor" titleId="job-editor-title">
      <div className="dialog-header">
        <h2 id="job-editor-title">{title}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close job editor dialog"
          onClick={onCancel}
        >
          x
        </button>
      </div>

      <div className="dialog-copy">
        <p>Set the core job details first, then add any film and caulk requirements the crew should pull against.</p>
      </div>

      <div className="dialog-section">
        <div className="dialog-section-header">
          <h3>Job Basics</h3>
          <p className="muted-text">Keep the current create and edit flow intact while making the first fields easier to scan.</p>
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
            label="Install Date"
            type="date"
            value={dueDate}
            onChange={(event) => {
              setDueDate(event.target.value);
              setError('');
            }}
          />
          <Input
            label="Crew Leader"
            value={crewLeader}
            onChange={(event) => {
              setCrewLeader(event.target.value);
              setError('');
            }}
          />
          <WarehouseSelectField
            label="Warehouse"
            value={warehouse}
            onChange={(nextWarehouse) => setWarehouse(nextWarehouse as Warehouse)}
          />
        </div>
      </div>

      <div className="dialog-section">
        <div className="dialog-section-header">
          <h3>Film Requirements</h3>
          <p className="muted-text">Add the film lines the job needs, then fine-tune the table if anything changes.</p>
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
          <Button type="button" variant="secondary" onClick={handleAddRequirement} disabled={submitting}>
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
                        size="sm"
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
      </div>

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
                setCaulkProductId(event.target.value);
                setError('');
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
              setCaulkRequiredTubes(event.target.value.replace(/[^0-9]/g, ''));
              setError('');
            }}
          />
        </div>

        <div className="dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={handleAddCaulkRequirement}
            disabled={submitting || caulkProductLoading || !caulkProductOptions.length}
          >
            Add Caulk Requirement
          </Button>
        </div>

        {caulkProductError ? (
          <p className="error-text">
            {caulkProductError instanceof Error ? caulkProductError.message : 'Caulk products failed to load.'}
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
                          updateCaulkRequirementLine(line.id, {
                            requiredTubes: event.target.value.replace(/[^0-9]/g, '')
                          });
                          setError('');
                        }}
                      />
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeCaulkRequirementLine(line.id)}
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

        {error ? <p className="error-text">{error}</p> : null}

        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" fullWidth onClick={handleSave} disabled={submitting}>
            {submitting ? 'Saving...' : submitLabel}
          </Button>
        </div>

      {isCustomWidthOpen ? (
        <DialogSurface
          open={isCustomWidthOpen}
          onClose={() => setIsCustomWidthOpen(false)}
          className="width-dialog"
          titleId="job-custom-width-title"
          closeOnBackdrop
        >
          <div className="dialog-header">
            <h2 id="job-custom-width-title">Custom Width</h2>
            <button
              type="button"
              className="dialog-close"
              aria-label="Close custom width dialog"
              onClick={() => setIsCustomWidthOpen(false)}
            >
              x
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
        </DialogSurface>
      ) : null}
    </DialogSurface>
  );
}
