import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CaulkProductEntry,
  FilmCatalogEntry,
  Warehouse
} from '../../../../domain';
import {
  STANDARD_WIDTH_OPTIONS,
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog
} from '../../utils/boxHelpers';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import { getPreferredCaulkProductId } from '../../utils/caulkProductPreferences';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import {
  buildRequirementLineKey,
  createCaulkDraftLine,
  createDraftLine,
  getSectionsInputValue,
  makeNewCaulkDraftLine,
  makeNewRequirementDraftLine,
  type WidthButtonValue
} from './helpers';
import { buildJobEditorSubmitPayload } from './submit';
import type {
  CaulkRequirementDraftLine,
  JobCaulkRequirementEditorLine,
  JobEditorSubmitPayload,
  JobRequirementEditorLine,
  RequirementDraftLine
} from './types';

interface UseJobEditorFormOptions {
  open: boolean;
  mode: 'create' | 'edit';
  initialJobNumber: string;
  initialWarehouse?: Warehouse;
  initialSections?: string | number | null;
  initialDueDate?: string;
  initialCrewLeader?: string;
  initialRequirements: JobRequirementEditorLine[];
  initialCaulkRequirements: JobCaulkRequirementEditorLine[];
  filmCatalogEntries?: FilmCatalogEntry[];
  caulkProductEntries: CaulkProductEntry[];
  onSubmit: (payload: JobEditorSubmitPayload) => void;
}

export function useJobEditorForm({
  open,
  mode,
  initialJobNumber,
  initialWarehouse,
  initialSections,
  initialDueDate = '',
  initialCrewLeader = '',
  initialRequirements,
  initialCaulkRequirements,
  filmCatalogEntries,
  caulkProductEntries,
  onSubmit
}: UseJobEditorFormOptions) {
  const warehouseRegistry = useWarehouseRegistry();
  const defaultWarehouse = warehouseRegistry.entries[0]?.code || '';
  const resetTargetKey = mode === 'edit' ? `edit:${initialJobNumber}` : 'create';
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
      Object.fromEntries(
        caulkProductOptions.map((entry) => [entry.value, entry.label])
      ) as Record<string, string>,
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
  const wasOpenRef = useRef(false);
  const lastResetTargetKeyRef = useRef('');
  const previousManufacturerOptionsLengthRef = useRef(0);

  const hasCustomWidth =
    widthIn.trim() !== '' &&
    !STANDARD_WIDTH_OPTIONS.includes(widthIn as (typeof STANDARD_WIDTH_OPTIONS)[number]);
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) > 0;

  const initializeFormState = useCallback(() => {
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
    defaultWarehouse,
    initialCaulkRequirements,
    initialCrewLeader,
    initialDueDate,
    initialJobNumber,
    initialRequirements,
    initialSections,
    initialWarehouse,
    manufacturerOptions,
    preferredCaulkProductId
  ]);

  useEffect(() => {
    const becameOpen = open && !wasOpenRef.current;
    const targetChangedWhileOpen =
      open &&
      wasOpenRef.current &&
      lastResetTargetKeyRef.current !== resetTargetKey;

    if (becameOpen || targetChangedWhileOpen) {
      initializeFormState();
      lastResetTargetKeyRef.current = resetTargetKey;
    } else if (!open) {
      lastResetTargetKeyRef.current = '';
    }

    wasOpenRef.current = open;
  }, [initializeFormState, open, resetTargetKey]);

  useEffect(() => {
    if (open && !warehouse && defaultWarehouse) {
      setWarehouse(defaultWarehouse);
    }
  }, [defaultWarehouse, open, warehouse]);

  useEffect(() => {
    const hadManufacturerOptions = previousManufacturerOptionsLengthRef.current > 0;
    if (open && !manufacturer && manufacturerOptions.length > 0 && !hadManufacturerOptions) {
      setManufacturer(manufacturerOptions[0]);
    }
    previousManufacturerOptionsLengthRef.current = manufacturerOptions.length;
  }, [manufacturer, manufacturerOptions, open]);

  useEffect(() => {
    if (open && !caulkProductId && caulkProductOptions.length > 0) {
      setCaulkProductId(preferredCaulkProductId || caulkProductOptions[0].value);
    }
  }, [caulkProductId, caulkProductOptions, open, preferredCaulkProductId]);

  function clearError() {
    setError('');
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
    const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer).trim();
    const normalizedFilmName = filmName.trim();
    const normalizedRequiredFeet = Math.floor(parsedRequiredFeet);

    if (!normalizedManufacturer) {
      setError('Manufacturer is required for each film line.');
      return;
    }

    if (!normalizedFilmName) {
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

    const nextLine = makeNewRequirementDraftLine({
      manufacturer: normalizedManufacturer,
      filmName: normalizedFilmName,
      widthIn: parsedWidth,
      requiredFeet: normalizedRequiredFeet
    });
    const nextKey = buildRequirementLineKey(
      nextLine.manufacturer,
      nextLine.filmName,
      parsedWidth
    );

    setRequirements((current) => {
      const existingIndex = current.findIndex((line) => {
        const lineWidth = Number(line.widthIn);
        if (!Number.isFinite(lineWidth)) {
          return false;
        }

        return buildRequirementLineKey(line.manufacturer, line.filmName, lineWidth) === nextKey;
      });

      if (existingIndex === -1) {
        return [...current, nextLine];
      }

      const currentLine = current[existingIndex];
      const mergedFeet =
        Math.floor(Number(currentLine.requiredFeet || 0)) + normalizedRequiredFeet;
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
    clearError();
  }

  function handleAddCaulkRequirement() {
    const parsedRequiredTubes = Number(caulkRequiredTubes);
    const normalizedRequiredTubes = Math.floor(parsedRequiredTubes);

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
          makeNewCaulkDraftLine({
            productId: caulkProductId,
            requiredTubes: normalizedRequiredTubes
          })
        ];
      }

      const next = [...current];
      const existing = next[existingIndex];
      const mergedRequired =
        Math.floor(Number(existing.requiredTubes || 0)) + normalizedRequiredTubes;
      next[existingIndex] = {
        ...existing,
        requiredTubes: String(mergedRequired)
      };
      return next;
    });

    setCaulkRequiredTubes('');
    clearError();
  }

  function handleWidthButtonClick(value: WidthButtonValue) {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(hasCustomWidth ? widthIn : '');
      setIsCustomWidthOpen(true);
      return;
    }

    setWidthIn(value);
    clearError();
  }

  function closeCustomWidth() {
    setIsCustomWidthOpen(false);
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    setWidthIn(customWidthDraft.trim());
    setIsCustomWidthOpen(false);
    clearError();
  }

  function handleSave() {
    const result = buildJobEditorSubmitPayload({
      mode,
      initialJobNumber,
      jobNumber,
      warehouse,
      sections,
      dueDate,
      crewLeader,
      requirements,
      caulkRequirements,
      filmNameDraft: filmName,
      widthDraft: widthIn,
      requiredFeetDraft: requiredFeet,
      caulkRequiredTubesDraft: caulkRequiredTubes
    });

    if (result.error || !result.payload) {
      setError(result.error || 'Unable to prepare the job payload.');
      return;
    }

    clearError();
    onSubmit(result.payload);
  }

  return {
    caulkProductId,
    caulkProductLabelById,
    caulkProductOptions,
    caulkRequiredTubes,
    caulkRequirements,
    clearError,
    closeCustomWidth,
    crewLeader,
    customWidthDraft,
    dueDate,
    error,
    filmName,
    handleAddCaulkRequirement,
    handleAddRequirement,
    handleSave,
    handleWidthButtonClick,
    hasCustomWidth,
    isCustomWidthOpen,
    isCustomWidthValid,
    jobNumber,
    manufacturer,
    manufacturerOptions,
    requiredFeet,
    removeCaulkRequirementLine,
    removeRequirementLine,
    requirements,
    saveCustomWidth,
    sections,
    setCaulkProductId,
    setCaulkRequiredTubes,
    setCrewLeader,
    setCustomWidthDraft,
    setDueDate,
    setFilmName,
    setJobNumber,
    setManufacturer,
    setRequiredFeet,
    setSections,
    setWarehouse,
    updateCaulkRequirementLine,
    updateRequirementLine,
    warehouse,
    widthIn
  };
}
