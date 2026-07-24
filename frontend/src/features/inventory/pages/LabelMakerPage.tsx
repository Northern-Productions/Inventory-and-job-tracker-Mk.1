import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import { normalizeManufacturerLookupKey } from '../../../lib/manufacturerCanonicalization';
import { filterOfflineBoxes } from '../../../lib/offlineInventory';
import type { Box } from '../../../domain';
import { InventoryFilters } from '../components/InventoryFilters';
import { LabelBoxPicker } from '../components/labels/LabelBoxPicker';
import { LabelSlotPanel } from '../components/labels/LabelSlotPanel';
import {
  PrintableLabelSheet,
  type PrintableLabel
} from '../components/labels/PrintableLabelSheet';
import { useOfflineInventorySearch } from '../hooks/useOfflineInventorySearch';
import { useDefaultWarehouse } from '../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { useBox, useFilmCatalog, useMarkLabelsPrinted } from '../hooks/useInventoryQueries';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import {
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog
} from '../utils/boxHelpers';
import { getInventorySearchSuggestions } from '../utils/inventorySearchSuggestions';
import {
  buildLabelDraftFromBox,
  buildLabelDraftWarnings,
  EMPTY_LABEL_DRAFT,
  getLabelDraftFieldLabel,
  getMissingRequiredLabelFields,
  LABEL_RESULT_LIMIT,
  LABEL_SEARCH_DEBOUNCE_MS,
  LABEL_SLOTS,
  type LabelDraft,
  type LabelSlot
} from '../utils/labelMaker';
import {
  getActiveCustomWidth,
  normalizeSelectedWidths,
  readSelectedWidths
} from '../utils/widthFilters';
import { getSafeWarehouseFilterValue, parseWarehouseFilterValue } from '../utils/warehouseOptions';
import { buildBoxQrPayload, createBoxQrCodeDataUrl } from '../utils/qrCode';

type SlotBoxState = Record<LabelSlot, Box | null>;
type SlotDraftState = Record<LabelSlot, LabelDraft>;
type SlotQrState = Record<LabelSlot, {
  dataUrl: string;
  payload: string;
  pending: boolean;
  error: string;
}>;
type LabelStatusFilter = 'all' | 'unlabeled';

const EMPTY_SLOT_BOXES: SlotBoxState = {
  A: null,
  B: null
};

const EMPTY_SLOT_DRAFTS: SlotDraftState = {
  A: EMPTY_LABEL_DRAFT,
  B: EMPTY_LABEL_DRAFT
};

const EMPTY_SLOT_QR: SlotQrState = {
  A: { dataUrl: '', payload: '', pending: false, error: '' },
  B: { dataUrl: '', payload: '', pending: false, error: '' }
};

function readFilters(searchParams: URLSearchParams, defaultWarehouse = ''): InventoryFilterValues {
  const hasWarehouseParam = searchParams.has('warehouse');
  return {
    warehouse: hasWarehouseParam
      ? parseWarehouseFilterValue(searchParams.get('warehouse'))
      : parseWarehouseFilterValue(defaultWarehouse),
    manufacturer: canonicalizeManufacturerLabel(searchParams.get('manufacturer') || ''),
    q: searchParams.get('q') || '',
    status: (searchParams.get('status') || '') as InventoryFilterValues['status'],
    film: '',
    widths: readSelectedWidths(searchParams),
    showRetired: false
  };
}

function isSnapshotStale(lastSyncedAt: string): boolean {
  if (!lastSyncedAt) {
    return false;
  }

  const parsed = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(parsed)) {
    return false;
  }

  return Date.now() - parsed > 24 * 60 * 60 * 1000;
}

function isUnlabeledLabelCandidate(box: Box): boolean {
  const status = String(box.status || '').trim().toUpperCase();
  return box.hasLabel === false && (status === 'IN_STOCK' || status === 'ORDERED');
}

function getUniqueSelectedBoxIds(selectedBoxesBySlot: SlotBoxState): string[] {
  return Array.from(
    new Set(
      LABEL_SLOTS.map((slot) => selectedBoxesBySlot[slot]?.boxId || '')
        .map((boxId) => boxId.trim())
        .filter(Boolean)
    )
  );
}

function getLabelBoxHydrationSignature(box: Box): string {
  const draft = buildLabelDraftFromBox(box);
  return JSON.stringify({
    draft,
    warnings: buildLabelDraftWarnings(box, draft)
  });
}

export default function LabelMakerPage() {
  const [searchParams] = useSearchParams();
  const defaultWarehouse = useDefaultWarehouse();
  const hasMountedRef = useRef(false);
  const [filters, setFilters] = useState<InventoryFilterValues>(() =>
    readFilters(searchParams, defaultWarehouse)
  );
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
  const [rememberedCustomWidth, setRememberedCustomWidth] = useState(() =>
    getActiveCustomWidth(filters.widths)
  );
  const [labelStatusFilter, setLabelStatusFilter] = useState<LabelStatusFilter>('all');
  const [selectedBoxesBySlot, setSelectedBoxesBySlot] = useState<SlotBoxState>(EMPTY_SLOT_BOXES);
  const [draftsBySlot, setDraftsBySlot] = useState<SlotDraftState>(EMPTY_SLOT_DRAFTS);
  const [qrStateBySlot, setQrStateBySlot] = useState<SlotQrState>(EMPTY_SLOT_QR);
  const [pendingPrintedBoxIds, setPendingPrintedBoxIds] = useState<string[]>([]);
  const [printLabels, setPrintLabels] = useState<PrintableLabel[] | null>(null);
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseScopeReady = warehouseRegistry.scopeReady !== false;
  const safeWarehouseFilter = warehouseScopeReady
    ? getSafeWarehouseFilterValue(warehouseRegistry.entries, filters.warehouse)
    : '';
  const safeFilters = useMemo<InventoryFilterValues>(
    () => ({
      ...filters,
      warehouse: safeWarehouseFilter
    }),
    [filters, safeWarehouseFilter]
  );
  const boxesQuery = useOfflineInventorySearch(safeWarehouseFilter);
  const filmCatalogQuery = useFilmCatalog();
  const markLabelsPrintedMutation = useMarkLabelsPrinted();
  const selectedBoxAQuery = useBox(selectedBoxesBySlot.A?.boxId || '');
  const selectedBoxBQuery = useBox(selectedBoxesBySlot.B?.boxId || '');
  const toast = useToast();

  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(filters.q);
    }, LABEL_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const searchFilters = useMemo<InventoryFilterValues>(
    () => ({
      ...safeFilters,
      q: debouncedQuery,
      status: labelStatusFilter === 'unlabeled' ? '' : safeFilters.status,
      film: '',
      widths: normalizeSelectedWidths(safeFilters.widths),
      showRetired: false
    }),
    [debouncedQuery, labelStatusFilter, safeFilters]
  );
  const hasSearchTerm = debouncedQuery.trim().length > 0;
  const shouldShowMatchingBoxes = hasSearchTerm || labelStatusFilter === 'unlabeled';
  const deferredFilters = useDeferredValue(searchFilters);
  const filteredBoxes = useMemo(() => {
    if (!shouldShowMatchingBoxes) {
      return [];
    }

    const boxes = filterOfflineBoxes(boxesQuery.snapshotBoxes, deferredFilters);
    return labelStatusFilter === 'unlabeled'
      ? boxes.filter(isUnlabeledLabelCandidate)
      : boxes;
  }, [boxesQuery.snapshotBoxes, deferredFilters, labelStatusFilter, shouldShowMatchingBoxes]);
  const visibleBoxes = useMemo(
    () => filteredBoxes.slice(0, LABEL_RESULT_LIMIT),
    [filteredBoxes]
  );
  const searchSuggestions = useMemo(
    () => getInventorySearchSuggestions(boxesQuery.snapshotBoxes, searchFilters),
    [boxesQuery.snapshotBoxes, searchFilters]
  );
  const manufacturerOptions = useMemo(() => {
    const optionsByKey = new Map<string, string>();
    const addOption = (value: string) => {
      const label = canonicalizeManufacturerLabel(value);
      if (!label) {
        return;
      }

      const key = normalizeManufacturerLookupKey(label);
      if (!optionsByKey.has(key)) {
        optionsByKey.set(key, label);
      }
    };

    for (const entry of getManufacturerOptionsWithCatalog(filmCatalogQuery.data)) {
      addOption(entry);
    }
    addOption(filters.manufacturer);

    return Array.from(optionsByKey.values()).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
  }, [filmCatalogQuery.data, filters.manufacturer]);
  const activeSlots = useMemo(
    () => LABEL_SLOTS.filter((slot) => selectedBoxesBySlot[slot]),
    [selectedBoxesBySlot]
  );
  const staleWarning =
    boxesQuery.isOffline || boxesQuery.syncError || isSnapshotStale(boxesQuery.lastSyncedAt)
      ? 'This box data may be outdated. Refresh inventory if needed.'
      : '';

  useEffect(() => {
    const detailedBoxesBySlot: Partial<Record<LabelSlot, Box | undefined>> = {
      A: selectedBoxAQuery.data,
      B: selectedBoxBQuery.data
    };

    for (const slot of LABEL_SLOTS) {
      const detailedBox = detailedBoxesBySlot[slot];
      const selectedBox = selectedBoxesBySlot[slot];
      if (!detailedBox || !selectedBox || detailedBox.boxId !== selectedBox.boxId) {
        continue;
      }

      const nextDraft = buildLabelDraftFromBox(detailedBox);
      if (getLabelBoxHydrationSignature(selectedBox) !== getLabelBoxHydrationSignature(detailedBox)) {
        setSelectedBoxesBySlot((current) => ({
          ...current,
          [slot]: detailedBox
        }));
      }
      setDraftsBySlot((current) => {
        const currentDraft = current[slot];
        if (currentDraft.jobId.trim() || !nextDraft.jobId) {
          return current;
        }

        return {
          ...current,
          [slot]: {
            ...currentDraft,
            jobId: nextDraft.jobId
          }
        };
      });
    }
  }, [selectedBoxAQuery.data, selectedBoxBQuery.data, selectedBoxesBySlot.A, selectedBoxesBySlot.B]);

  useEffect(() => {
    let isActive = true;

    for (const slot of LABEL_SLOTS) {
      const box = selectedBoxesBySlot[slot];
      if (!box) {
        setQrStateBySlot((current) => ({
          ...current,
          [slot]: { dataUrl: '', payload: '', pending: false, error: '' }
        }));
        continue;
      }

      const payload = buildBoxQrPayload(box.boxId);
      setQrStateBySlot((current) => ({
        ...current,
        [slot]: { dataUrl: '', payload, pending: true, error: '' }
      }));

      void createBoxQrCodeDataUrl(box.boxId)
        .then((dataUrl) => {
          if (!isActive) {
            return;
          }
          setQrStateBySlot((current) => ({
            ...current,
            [slot]: { dataUrl, payload, pending: false, error: '' }
          }));
        })
        .catch(() => {
          if (!isActive) {
            return;
          }
          setQrStateBySlot((current) => ({
            ...current,
            [slot]: {
              dataUrl: '',
              payload,
              pending: false,
              error: 'The QR code could not be generated.'
            }
          }));
        });
    }

    return () => {
      isActive = false;
    };
  }, [selectedBoxesBySlot.A, selectedBoxesBySlot.B]);

  function patchFilters(next: Partial<InventoryFilterValues>) {
    setFilters((current) => ({
      ...current,
      ...next,
      warehouse:
        next.warehouse === undefined
          ? current.warehouse
          : getSafeWarehouseFilterValue(warehouseRegistry.entries, next.warehouse),
      film: '',
      widths: normalizeSelectedWidths(next.widths ?? current.widths),
      showRetired: false
    }));
  }

  function applyBoxToSlot(slot: LabelSlot, box: Box) {
    const nextDraft = buildLabelDraftFromBox(box);
    setSelectedBoxesBySlot((current) => ({
      ...current,
      [slot]: box
    }));
    setDraftsBySlot((current) => ({
      ...current,
      [slot]: nextDraft
    }));
  }

  function clearSlot(slot: LabelSlot) {
    setSelectedBoxesBySlot((current) => ({
      ...current,
      [slot]: null
    }));
    setDraftsBySlot((current) => ({
      ...current,
      [slot]: EMPTY_LABEL_DRAFT
    }));
  }

  function handleDraftChange(slot: LabelSlot, field: keyof LabelDraft, value: string) {
    setDraftsBySlot((current) => ({
      ...current,
      [slot]: {
        ...current[slot],
        [field]: value
      }
    }));
  }

  const printableLabels = useMemo<PrintableLabel[]>(
    () =>
      LABEL_SLOTS
        .map((slot) => {
          const box = selectedBoxesBySlot[slot];
          if (!box) {
            return null;
          }

          const qrState = qrStateBySlot[slot];
          return {
            slot,
            draft: draftsBySlot[slot],
            qrDataUrl: qrState.dataUrl,
            qrPayload: qrState.payload,
            qrError: qrState.error
          };
        })
        .filter((entry): entry is PrintableLabel => Boolean(entry)),
    [draftsBySlot, qrStateBySlot, selectedBoxesBySlot]
  );

  const printDisabledReason = useMemo(() => {
    if (activeSlots.length === 0) {
      return 'Select a box for Label A or Label B before printing.';
    }

    const slotWithMissingFields = activeSlots
      .map((slot) => ({
        slot,
        missingFields: getMissingRequiredLabelFields(draftsBySlot[slot])
      }))
      .find((entry) => entry.missingFields.length > 0);

    if (slotWithMissingFields) {
      const missingLabels = slotWithMissingFields.missingFields
        .map(getLabelDraftFieldLabel)
        .join(', ');
      return `Complete ${missingLabels} for Label ${slotWithMissingFields.slot} before printing.`;
    }

    const pendingQrSlot = activeSlots.find((slot) => qrStateBySlot[slot].pending);
    if (pendingQrSlot) {
      return `QR code for Label ${pendingQrSlot} is still generating.`;
    }

    const failedQrSlot = activeSlots.find((slot) => qrStateBySlot[slot].error);
    if (failedQrSlot) {
      return `QR code for Label ${failedQrSlot} failed. Refresh or select the box again.`;
    }

    return '';
  }, [activeSlots, draftsBySlot, qrStateBySlot]);

  function handlePrint() {
    if (printDisabledReason) {
      return;
    }

    document.body.classList.add('label-printing');
    try {
      flushSync(() => setPrintLabels(printableLabels));
      window.print();
    } finally {
      document.body.classList.remove('label-printing');
      flushSync(() => setPrintLabels(null));
    }
    setPendingPrintedBoxIds(getUniqueSelectedBoxIds(selectedBoxesBySlot));
  }

  async function confirmLabelsPrinted() {
    const boxIds = pendingPrintedBoxIds;
    if (boxIds.length === 0) {
      setPendingPrintedBoxIds([]);
      return;
    }

    try {
      const response = await markLabelsPrintedMutation.mutateAsync({ boxIds });
      const updatedBoxes = new Map(response.result.boxes.map((box) => [box.boxId, box]));
      setSelectedBoxesBySlot((current) => {
        const next = { ...current };
        for (const slot of LABEL_SLOTS) {
          const selectedBox = next[slot];
          if (selectedBox && updatedBoxes.has(selectedBox.boxId)) {
            next[slot] = updatedBoxes.get(selectedBox.boxId) || selectedBox;
          }
        }
        return next;
      });
      toast.push({
        title: 'Labels marked printed',
        description: `${boxIds.length} selected box${boxIds.length === 1 ? '' : 'es'} marked labeled.`
      });
      setPendingPrintedBoxIds([]);
    } catch (error) {
      toast.push({
        title: 'Unable to mark labels printed',
        description: error instanceof Error ? error.message : 'Try again after confirming inventory access.',
        variant: 'error'
      });
    }
  }

  const printOnlySheet =
    typeof document !== 'undefined' && printLabels
      ? createPortal(
          <div className="label-print-only-root print-root" aria-hidden="true">
            <PrintableLabelSheet labels={printLabels} />
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div className={`${hasMountedRef.current ? 'route-content-animate' : ''}`.trim()}>
        <section className="panel inventory-filter-panel label-filter-panel">
          <div className="panel-title-row">
            <div>
              <h2>Find Box</h2>
              <p className="muted-text">Filters match the Inventory page to avoid a second search model.</p>
            </div>
          </div>
          {staleWarning ? <p className="label-warning">{staleWarning}</p> : null}
          <div className="label-mode-row">
            <Select
              label="Label Status"
              value={labelStatusFilter}
              onChange={(event) => setLabelStatusFilter(event.target.value as LabelStatusFilter)}
              options={[
                { label: 'All boxes', value: 'all' },
                { label: 'Unlabeled boxes', value: 'unlabeled' }
              ]}
              hint="Unlabeled shows ordered or received boxes whose labels have not been printed."
            />
          </div>
          <InventoryFilters
            values={safeFilters}
            manufacturerOptions={manufacturerOptions}
            searchSuggestions={searchSuggestions}
            rememberedCustomWidth={rememberedCustomWidth}
            onRememberedCustomWidthChange={setRememberedCustomWidth}
            onChange={patchFilters}
          />
        </section>

        <LabelBoxPicker
          boxes={visibleBoxes}
          totalCount={filteredBoxes.length}
          hasSearchTerm={shouldShowMatchingBoxes}
          loading={boxesQuery.isLoading}
          error={boxesQuery.isError ? (boxesQuery.error as Error) : null}
          selectedBoxesBySlot={selectedBoxesBySlot}
          onRetry={() => void boxesQuery.refetch()}
          onSelect={applyBoxToSlot}
        />

        <div className="label-slot-grid">
          {LABEL_SLOTS.map((slot) => {
            const box = selectedBoxesBySlot[slot];
            const draft = draftsBySlot[slot];

            return (
              <LabelSlotPanel
                key={slot}
                slot={slot}
                box={box}
                draft={draft}
                warnings={box ? buildLabelDraftWarnings(box, draft) : []}
                onDraftChange={handleDraftChange}
                onClear={clearSlot}
              />
            );
          })}
        </div>

        <section className="panel label-preview-panel">
          <div className="panel-title-row">
            <div>
              <h2>Preview</h2>
              <p className="muted-text">The preview below uses the same label sheet component as print output.</p>
            </div>
            <div className="page-actions label-preview-actions">
              <Button type="button" onClick={handlePrint} disabled={Boolean(printDisabledReason)}>
                Print Labels
              </Button>
            </div>
          </div>
          <p className="label-print-note">
            Browser print settings are advisory: use US Letter, Landscape, 100% / Actual size,
            and disable Fit to page. Margins None is preferred; Default is supported. Turn
            Headers and footers Off for the cleanest labels.
          </p>
          {printDisabledReason ? (
            <p className="label-print-disabled-reason">{printDisabledReason}</p>
          ) : null}
          <div className="label-print-root">
            <PrintableLabelSheet labels={printableLabels} />
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={pendingPrintedBoxIds.length > 0}
        title="Mark selected boxes as labeled?"
        message="Only confirm after the selected labels were printed successfully. Cancel keeps them in the unlabeled list."
        confirmLabel={markLabelsPrintedMutation.isPending ? 'Marking...' : 'Mark Labeled'}
        cancelLabel="Keep Unlabeled"
        onCancel={() => {
          if (!markLabelsPrintedMutation.isPending) {
            setPendingPrintedBoxIds([]);
          }
        }}
        onConfirm={() => {
          if (!markLabelsPrintedMutation.isPending) {
            void confirmLabelsPrinted();
          }
        }}
      />
      {printOnlySheet}
    </>
  );
}
