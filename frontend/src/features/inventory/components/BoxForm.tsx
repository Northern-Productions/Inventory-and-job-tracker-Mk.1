import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import type { FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  STANDARD_WIDTH_OPTIONS,
  deriveFeetAvailableFromRollWeight,
  deriveLastRollWeightLbsFromCurrentFeet,
  getWarehouseBoxIdPrefixToken,
  isWarehousePrefixOnlyBoxId,
  getManufacturerOptionsWithCatalog,
  getWidthMode,
  hasManufacturerOption,
  normalizeCreateBoxIdForWarehouse,
  remapCreateBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { getWarehousePrefix } from '../utils/warehouseOptions';
import { BoxIdentitySection } from './box-form/BoxIdentitySection';
import { CustomWidthDialog } from './box-form/CustomWidthDialog';
import { DatesAndCostingSection } from './box-form/DatesAndCostingSection';
import { DeleteBoxDialog } from './box-form/DeleteBoxDialog';
import { NotesSection } from './box-form/NotesSection';
import { RollTrackingSection } from './box-form/RollTrackingSection';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
const DELETE_DIALOG_FADE_MS = 180;
const DELETE_BACKDROP_FADE_MS = 180;

interface BoxFormProps {
  initialDraft: BoxDraft;
  resetKey: string;
  mode: 'create' | 'edit';
  submitLabel: string;
  disabled?: boolean;
  submitting?: boolean;
  deleting?: boolean;
  preserveInitialFeetInEdit?: boolean;
  createWarehouse?: Warehouse;
  nextBoxIdForCreateWarehouse?: string;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onSubmit: (draft: BoxDraft) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

export function BoxForm({
  initialDraft,
  resetKey,
  mode,
  submitLabel,
  disabled = false,
  submitting = false,
  deleting = false,
  preserveInitialFeetInEdit = false,
  createWarehouse,
  nextBoxIdForCreateWarehouse,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onSubmit,
  onCancel,
  onDelete
}: BoxFormProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [widthMode, setWidthMode] = useState(getWidthMode(initialDraft.widthIn));
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleteDialogClosing, setIsDeleteDialogClosing] = useState(false);
  const [isDeleteBackdropClosing, setIsDeleteBackdropClosing] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [hasAutoSelectedManufacturer, setHasAutoSelectedManufacturer] = useState(false);
  const lastSuggestedBoxIdRef = useRef(initialDraft.boxId);
  const lastCreateWarehouseRef = useRef<Warehouse | null>(createWarehouse ?? null);
  const deleteDialogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warehouseRegistry = useWarehouseRegistry();
  const createWarehousePrefix = getWarehousePrefix(warehouseRegistry.entries, createWarehouse || '');
  const createWarehousePrefixToken = getWarehouseBoxIdPrefixToken(createWarehousePrefix);

  function clearDeleteDialogTimer() {
    if (deleteDialogTimeoutRef.current !== null) {
      clearTimeout(deleteDialogTimeoutRef.current);
      deleteDialogTimeoutRef.current = null;
    }
  }

  function resetDeleteDialog() {
    clearDeleteDialogTimer();
    setIsDeleteDialogOpen(false);
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setDeleteConfirmText('');
  }

  function openDeleteDialog() {
    clearDeleteDialogTimer();
    setDeleteConfirmText('');
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setIsDeleteDialogOpen(true);
  }

  function closeDeleteDialog(afterClose?: () => void) {
    if (!isDeleteDialogOpen || isDeleteDialogClosing) {
      return;
    }

    clearDeleteDialogTimer();
    setIsDeleteDialogClosing(true);
    setIsDeleteBackdropClosing(false);

    deleteDialogTimeoutRef.current = setTimeout(() => {
      setIsDeleteBackdropClosing(true);

      deleteDialogTimeoutRef.current = setTimeout(() => {
        resetDeleteDialog();
        afterClose?.();
      }, DELETE_BACKDROP_FADE_MS);
    }, DELETE_DIALOG_FADE_MS);
  }

  useEffect(() => {
    setDraft(initialDraft);
    setWidthMode(getWidthMode(initialDraft.widthIn));
    setIsCustomWidthOpen(false);
    setCustomWidthDraft(getWidthMode(initialDraft.widthIn) === 'CUSTOM' ? initialDraft.widthIn : '');
    lastSuggestedBoxIdRef.current = initialDraft.boxId;
    lastCreateWarehouseRef.current = createWarehouse ?? null;
    setHasAutoSelectedManufacturer(false);
    resetDeleteDialog();
  }, [initialDraft, resetKey]);

  useEffect(() => {
    if (mode !== 'create' || !createWarehouse) {
      return;
    }

    setDraft((current) => {
      const warehouseChanged = lastCreateWarehouseRef.current !== createWarehouse;
      const previousWarehousePrefix = getWarehousePrefix(
        warehouseRegistry.entries,
        lastCreateWarehouseRef.current || ''
      );
      const shouldReplace =
        current.boxId.trim() === '' ||
        current.boxId === lastSuggestedBoxIdRef.current ||
        isWarehousePrefixOnlyBoxId(current.boxId, previousWarehousePrefix || createWarehousePrefix);

      lastCreateWarehouseRef.current = createWarehouse;

      if (shouldReplace) {
        if (nextBoxIdForCreateWarehouse) {
          lastSuggestedBoxIdRef.current = nextBoxIdForCreateWarehouse;
          return current.boxId === nextBoxIdForCreateWarehouse
            ? current
            : {
                ...current,
                boxId: nextBoxIdForCreateWarehouse
              };
        }

        if (createWarehousePrefixToken && current.boxId !== createWarehousePrefixToken) {
          return {
            ...current,
            boxId: createWarehousePrefixToken
          };
        }

        return current;
      }

      if (!warehouseChanged || !createWarehousePrefix) {
        return current;
      }

      const remappedBoxId = remapCreateBoxIdForWarehouse(current.boxId, createWarehousePrefix);
      if (remappedBoxId === current.boxId) {
        return current;
      }

      return {
        ...current,
        boxId: remappedBoxId
      };
    });
  }, [
    createWarehouse,
    createWarehousePrefix,
    createWarehousePrefixToken,
    mode,
    nextBoxIdForCreateWarehouse,
    warehouseRegistry.entries
  ]);

  useEffect(
    () => () => {
      clearDeleteDialogTimer();
    },
    []
  );

  useEffect(() => {
    if (!isDeleteDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isDeleteDialogClosing || deleting) {
        return;
      }

      event.preventDefault();
      closeDeleteDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [deleting, isDeleteDialogClosing, isDeleteDialogOpen]);

  const updateField = <K extends keyof BoxDraft,>(key: K, value: BoxDraft[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value
    }));
  };

  const handleInitialFeetChange = (value: string) => {
    const nextInitialFeet = value.replace(/[^0-9]/g, '');

    setDraft((current) => {
      const nextDraft: BoxDraft = {
        ...current,
        initialFeet: nextInitialFeet
      };

      if (mode !== 'edit' || !preserveInitialFeetInEdit) {
        nextDraft.currentFeetOnRoll = nextInitialFeet;
      }

      return nextDraft;
    });
  };

  const handleCurrentFeetChange = (value: string) => {
    const nextCurrentFeet = value.replace(/[^0-9]/g, '');

    setDraft((current) => {
      const nextDraft: BoxDraft = {
        ...current,
        currentFeetOnRoll: nextCurrentFeet,
        currentFeetOnRollManuallyEdited: true
      };

      if (
        mode === 'edit' &&
        preserveInitialFeetInEdit &&
        !current.lastRollWeightLbsManuallyEdited
      ) {
        const currentFeetValue = Number(nextCurrentFeet);
        const coreWeightValue = Number(current.coreWeightLbs);
        const lfWeightValue = Number(current.lfWeightLbsPerFt);

        if (
          nextCurrentFeet.trim() &&
          Number.isFinite(currentFeetValue) &&
          currentFeetValue >= 0 &&
          Number.isFinite(coreWeightValue) &&
          coreWeightValue >= 0 &&
          Number.isFinite(lfWeightValue) &&
          lfWeightValue > 0
        ) {
          nextDraft.lastRollWeightLbs = String(
            deriveLastRollWeightLbsFromCurrentFeet(currentFeetValue, coreWeightValue, lfWeightValue)
          );
        }
      }

      return nextDraft;
    });
  };

  const handleLastRollWeightChange = (value: string) => {
    setDraft((current) => {
      const nextDraft: BoxDraft = {
        ...current,
        lastRollWeightLbs: value,
        lastRollWeightLbsManuallyEdited: true
      };

      if (
        mode === 'edit' &&
        preserveInitialFeetInEdit &&
        !current.currentFeetOnRollManuallyEdited
      ) {
        const lastRollWeightValue = Number(value);
        const coreWeightValue = Number(current.coreWeightLbs);
        const lfWeightValue = Number(current.lfWeightLbsPerFt);
        const initialFeetValueForRollMath = Number(current.initialFeet);

        if (
          value.trim() &&
          Number.isFinite(lastRollWeightValue) &&
          lastRollWeightValue >= 0 &&
          Number.isFinite(coreWeightValue) &&
          coreWeightValue >= 0 &&
          Number.isFinite(lfWeightValue) &&
          lfWeightValue > 0 &&
          Number.isFinite(initialFeetValueForRollMath) &&
          initialFeetValueForRollMath >= 0
        ) {
          nextDraft.currentFeetOnRoll = String(
            deriveFeetAvailableFromRollWeight(
              lastRollWeightValue,
              coreWeightValue,
              lfWeightValue,
              initialFeetValueForRollMath
            )
          );
        }
      }

      return nextDraft;
    });
  };

  const widthButtonValues = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;
  const canCaptureReceivingDetails = draft.receivedDate.trim() !== '';
  const purchaseCostValue = Number(draft.purchaseCost);
  const initialFeetValue = Number(draft.initialFeet);
  const hasPurchaseCost = draft.purchaseCost.trim() !== '';
  const shouldAutoDerivePricePerLf =
    hasPurchaseCost &&
    Number.isFinite(purchaseCostValue) &&
    purchaseCostValue >= 0 &&
    Number.isFinite(initialFeetValue) &&
    initialFeetValue > 0;
  const derivedPricePerLf = shouldAutoDerivePricePerLf
    ? (Math.round((purchaseCostValue / initialFeetValue) * 10000) / 10000).toFixed(4)
    : '';
  const pricePerLfHint = shouldAutoDerivePricePerLf
    ? 'Auto-calculated from Purchase Cost / Initial Linear Feet.'
    : hasPurchaseCost
      ? 'Initial Linear Feet must be greater than 0 when Purchase Cost is set.'
      : undefined;
  const showCurrentFeetField = mode === 'edit' && preserveInitialFeetInEdit;
  const footageSectionCopy =
    mode === 'create'
      ? 'Set the label, product, width, and starting footage.'
      : showCurrentFeetField
        ? 'Set the label, product, width, and both the starting and current footage.'
        : 'Set the label, product, width, and starting footage.';
  const manufacturerOptions = getManufacturerOptionsWithCatalog(filmCatalogEntries);
  const isKnownManufacturer = hasManufacturerOption(draft.manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? draft.manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const isDeleteConfirmUnlocked = deleteConfirmText.trim().toLowerCase() === 'delete';

  useEffect(() => {
    if (
      mode !== 'create' ||
      hasAutoSelectedManufacturer ||
      draft.manufacturer.trim() ||
      manufacturerOptions.length === 0
    ) {
      return;
    }

    setDraft((current) => ({
      ...current,
      manufacturer: manufacturerOptions[0]
    }));
    setHasAutoSelectedManufacturer(true);
  }, [
    draft.manufacturer,
    hasAutoSelectedManufacturer,
    manufacturerOptions,
    mode
  ]);

  useEffect(() => {
    if (!shouldAutoDerivePricePerLf) {
      return;
    }

    setDraft((current) =>
      current.pricePerLf === derivedPricePerLf
        ? current
        : {
            ...current,
            pricePerLf: derivedPricePerLf
          }
    );
  }, [derivedPricePerLf, shouldAutoDerivePricePerLf]);

  const handleWidthButtonClick = (value: (typeof widthButtonValues)[number]) => {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(widthMode === 'CUSTOM' ? draft.widthIn : '');
      setIsCustomWidthOpen(true);
      return;
    }

    setWidthMode(value);
    updateField('widthIn', value);
  };

  const saveCustomWidth = () => {
    if (!isCustomWidthValid) {
      return;
    }

    const nextWidth = customWidthDraft.trim();
    setWidthMode('CUSTOM');
    updateField('widthIn', nextWidth);
    setIsCustomWidthOpen(false);
  };

  const handleBoxIdChange = (value: string) => {
    if (mode === 'create' && createWarehousePrefix) {
      updateField('boxId', normalizeCreateBoxIdForWarehouse(value, createWarehousePrefix));
      return;
    }

    updateField('boxId', value);
  };

  return (
    <>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) {
            return;
          }
          onSubmit(draft);
        }}
      >
        {mode === 'edit' ? (
          <>
            <div className="panel-title-row">
              <h2>Edit Box</h2>
              {onCancel ? (
                <Button type="button" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
            <p className="muted-text form-intro">
              Update the box record without changing its workflow logic or warehouse rules.
            </p>
          </>
        ) : null}

        <BoxIdentitySection
          customManufacturerSelected={isCustomManufacturerSelected}
          draft={draft}
          filmCatalogEntries={filmCatalogEntries}
          filmCatalogError={filmCatalogError}
          filmCatalogLoading={filmCatalogLoading}
          footageSectionCopy={footageSectionCopy}
          manufacturerOptions={manufacturerOptions}
          manufacturerSelectValue={manufacturerSelectValue}
          mode={mode}
          showCurrentFeetField={showCurrentFeetField}
          widthButtonValues={widthButtonValues}
          widthMode={widthMode}
          onBoxIdChange={handleBoxIdChange}
          onFilmNameChange={(value) => updateField('filmName', value)}
          onCurrentFeetChange={handleCurrentFeetChange}
          onInitialFeetChange={handleInitialFeetChange}
          onLotRunChange={(value) => updateField('lotRun', value)}
          onManufacturerChange={(value) => updateField('manufacturer', value)}
          onWidthButtonClick={handleWidthButtonClick}
        />

        <DatesAndCostingSection
          draft={draft}
          pricePerLfHint={pricePerLfHint}
          shouldAutoDerivePricePerLf={shouldAutoDerivePricePerLf}
          onOrderDateChange={(value) => updateField('orderDate', value)}
          onPricePerLfChange={(value) => updateField('pricePerLf', value)}
          onPurchaseCostChange={(value) => updateField('purchaseCost', value)}
          onReceivedDateChange={(value) => updateField('receivedDate', value)}
        />

        <RollTrackingSection
          canCaptureReceivingDetails={canCaptureReceivingDetails}
          draft={draft}
          mode={mode}
          onCoreTypeChange={(value) => updateField('coreType', value)}
          onInitialWeightChange={(value) => updateField('initialWeightLbs', value)}
          onLastRollWeightChange={handleLastRollWeightChange}
          onLastWeighedDateChange={(value) => updateField('lastWeighedDate', value)}
        />

        <NotesSection notes={draft.notes} onChange={(value) => updateField('notes', value)} />
        <div className="page-actions form-actions">
          {mode === 'edit' && onDelete ? (
            <Button
              type="button"
              variant="danger"
              onClick={openDeleteDialog}
              disabled={disabled || submitting || deleting}
            >
              Delete
            </Button>
          ) : null}
          <Button type="submit" disabled={disabled || submitting || deleting}>
            {submitting ? 'Saving...' : submitLabel}
          </Button>
        </div>
      </form>

      <DeleteBoxDialog
        open={isDeleteDialogOpen}
        backdropClosing={isDeleteBackdropClosing}
        dialogClosing={isDeleteDialogClosing}
        confirmText={deleteConfirmText}
        deleting={deleting}
        unlocked={isDeleteConfirmUnlocked}
        onCancel={() => closeDeleteDialog()}
        onConfirm={() => closeDeleteDialog(() => onDelete?.())}
        onConfirmTextChange={setDeleteConfirmText}
      />

      <CustomWidthDialog
        open={isCustomWidthOpen}
        customWidthDraft={customWidthDraft}
        valid={isCustomWidthValid}
        onChange={setCustomWidthDraft}
        onClose={() => setIsCustomWidthOpen(false)}
        onSave={saveCustomWidth}
      />
    </>
  );
}
