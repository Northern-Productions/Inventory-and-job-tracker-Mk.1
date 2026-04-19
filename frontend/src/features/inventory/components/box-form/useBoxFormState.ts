import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoxDealerEntry, FilmCatalogEntry, Warehouse } from '../../../../domain';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import {
  STANDARD_WIDTH_OPTIONS,
  deriveFeetAvailableFromRollWeight,
  deriveLastRollWeightLbsFromCurrentFeet,
  getManufacturerOptionsWithCatalog,
  getWarehouseBoxIdPrefixToken,
  getWidthMode,
  hasManufacturerOption,
  isWarehousePrefixOnlyBoxId,
  normalizeCreateBoxIdForWarehouse,
  remapCreateBoxIdForWarehouse,
  type BoxDraft
} from '../../utils/boxHelpers';
import { getWarehousePrefix } from '../../utils/warehouseOptions';
import {
  applyDealerSelectValue,
  buildDealerOptions,
  resolveDealerFieldState
} from './dealerFieldUtils';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
const BOX_FORM_WIDTH_BUTTON_VALUES = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;

interface UseBoxFormStateOptions {
  createWarehouse?: Warehouse;
  dealerEntries?: BoxDealerEntry[];
  filmCatalogEntries?: FilmCatalogEntry[];
  initialDraft: BoxDraft;
  mode: 'create' | 'edit';
  nextBoxIdForCreateWarehouse?: string;
  preserveInitialFeetInEdit: boolean;
  resetKey: string;
}

export function useBoxFormState({
  createWarehouse,
  dealerEntries,
  filmCatalogEntries,
  initialDraft,
  mode,
  nextBoxIdForCreateWarehouse,
  preserveInitialFeetInEdit,
  resetKey
}: UseBoxFormStateOptions) {
  const [draft, setDraft] = useState(initialDraft);
  const [widthMode, setWidthMode] = useState(getWidthMode(initialDraft.widthIn));
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const [isAddingCustomDealer, setIsAddingCustomDealer] = useState(false);
  const [hasAutoSelectedManufacturer, setHasAutoSelectedManufacturer] = useState(false);
  const lastSuggestedBoxIdRef = useRef(initialDraft.boxId);
  const lastCreateWarehouseRef = useRef<Warehouse | null>(createWarehouse ?? null);
  const warehouseRegistry = useWarehouseRegistry();
  const createWarehousePrefix = getWarehousePrefix(warehouseRegistry.entries, createWarehouse || '');
  const createWarehousePrefixToken = getWarehouseBoxIdPrefixToken(createWarehousePrefix);

  useEffect(() => {
    const nextWidthMode = getWidthMode(initialDraft.widthIn);
    setDraft(initialDraft);
    setWidthMode(nextWidthMode);
    setIsCustomWidthOpen(false);
    setCustomWidthDraft(nextWidthMode === 'CUSTOM' ? initialDraft.widthIn : '');
    setIsAddingCustomDealer(false);
    lastSuggestedBoxIdRef.current = initialDraft.boxId;
    lastCreateWarehouseRef.current = createWarehouse ?? null;
    setHasAutoSelectedManufacturer(false);
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

  const manufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogEntries),
    [filmCatalogEntries]
  );
  const dealerOptions = useMemo(() => buildDealerOptions(dealerEntries), [dealerEntries]);
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
  const isKnownManufacturer = hasManufacturerOption(draft.manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? draft.manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const { isCustomDealerSelected, dealerSelectValue } = resolveDealerFieldState(
    draft.dealer,
    dealerOptions,
    isAddingCustomDealer
  );

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

  const handleWidthButtonClick = (value: (typeof BOX_FORM_WIDTH_BUTTON_VALUES)[number]) => {
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

  const handleDealerSelectChange = (value: string) => {
    const nextDealerSelection = applyDealerSelectValue(value, draft.dealer, dealerOptions);
    setIsAddingCustomDealer(nextDealerSelection.isAddingCustomDealer);
    updateField('dealer', nextDealerSelection.dealer);
  };

  return {
    dealerOptions,
    dealerSelectValue,
    canCaptureReceivingDetails,
    closeCustomWidthDialog: () => setIsCustomWidthOpen(false),
    customWidthDraft,
    draft,
    footageSectionCopy,
    handleBoxIdChange,
    handleCurrentFeetChange,
    handleDealerSelectChange,
    handleInitialFeetChange,
    handleLastRollWeightChange,
    handleWidthButtonClick,
    isCustomManufacturerSelected,
    isCustomDealerSelected,
    isCustomWidthOpen,
    isCustomWidthValid,
    manufacturerOptions,
    manufacturerSelectValue,
    pricePerLfHint,
    saveCustomWidth,
    setCustomWidthDraft,
    shouldAutoDerivePricePerLf,
    showCurrentFeetField,
    updateField,
    widthButtonValues: BOX_FORM_WIDTH_BUTTON_VALUES,
    widthMode
  };
}
