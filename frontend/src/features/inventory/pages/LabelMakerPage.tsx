import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
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
import { useFilmCatalog } from '../hooks/useInventoryQueries';
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
import { parseWarehouseFilterValue } from '../utils/warehouseOptions';
import { buildBoxQrPayload, createBoxQrCodeDataUrl } from '../utils/qrCode';

type SlotBoxState = Record<LabelSlot, Box | null>;
type SlotDraftState = Record<LabelSlot, LabelDraft>;
type SlotQrState = Record<LabelSlot, {
  dataUrl: string;
  payload: string;
  pending: boolean;
  error: string;
}>;

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

function readFilters(searchParams: URLSearchParams): InventoryFilterValues {
  return {
    warehouse: parseWarehouseFilterValue(searchParams.get('warehouse')),
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

export default function LabelMakerPage() {
  const [searchParams] = useSearchParams();
  const hasMountedRef = useRef(false);
  const [filters, setFilters] = useState<InventoryFilterValues>(() => readFilters(searchParams));
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
  const [rememberedCustomWidth, setRememberedCustomWidth] = useState(() =>
    getActiveCustomWidth(filters.widths)
  );
  const [selectedBoxesBySlot, setSelectedBoxesBySlot] = useState<SlotBoxState>(EMPTY_SLOT_BOXES);
  const [draftsBySlot, setDraftsBySlot] = useState<SlotDraftState>(EMPTY_SLOT_DRAFTS);
  const [qrStateBySlot, setQrStateBySlot] = useState<SlotQrState>(EMPTY_SLOT_QR);
  const boxesQuery = useOfflineInventorySearch(filters.warehouse);
  const filmCatalogQuery = useFilmCatalog();

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
      ...filters,
      q: debouncedQuery,
      film: '',
      widths: normalizeSelectedWidths(filters.widths),
      showRetired: false
    }),
    [debouncedQuery, filters]
  );
  const hasSearchTerm = debouncedQuery.trim().length > 0;
  const deferredFilters = useDeferredValue(searchFilters);
  const filteredBoxes = useMemo(
    () => (hasSearchTerm ? filterOfflineBoxes(boxesQuery.snapshotBoxes, deferredFilters) : []),
    [boxesQuery.snapshotBoxes, deferredFilters, hasSearchTerm]
  );
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

    window.print();
  }

  const printOnlySheet =
    typeof document !== 'undefined' && printableLabels.length > 0
      ? createPortal(
          <div className="label-print-only-root print-root" aria-hidden="true">
            <PrintableLabelSheet labels={printableLabels} />
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
          <InventoryFilters
            values={filters}
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
          hasSearchTerm={hasSearchTerm}
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
            Browser print settings: use landscape, 100% scale / actual size, and disable fit-to-page if your browser offers it.
          </p>
          {printDisabledReason ? (
            <p className="label-print-disabled-reason">{printDisabledReason}</p>
          ) : null}
          <div className="label-print-root">
            <PrintableLabelSheet labels={printableLabels} />
          </div>
        </section>
      </div>
      {printOnlySheet}
    </>
  );
}
