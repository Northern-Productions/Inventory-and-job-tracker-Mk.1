import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { getWarehouseAssetAuditReport } from '../../../../api/features/reportsClient';
import { Button } from '../../../../components/Button';
import { DeferredLoadingState } from '../../../../components/DeferredLoadingState';
import { Input } from '../../../../components/Input';
import { Select } from '../../../../components/Select';
import type {
  WarehouseAssetAuditFilters,
  WarehouseAssetAuditResponse,
  WarehouseAssetAuditStatus
} from '../../../../domain';
import { useAuth } from '../../../auth/AuthContext';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useWarehouseAssetAuditReport } from '../../hooks/useInventoryQueries';
import {
  normalizeWarehouseAssetAuditFilters,
  toWarehouseAssetAuditRequestFilters,
  WAREHOUSE_ASSET_AUDIT_STATUSES,
  warehouseAssetAuditFiltersEqual,
  type CanonicalWarehouseAssetAuditFilters
} from '../../utils/warehouseAssetAuditFilters';
import {
  WarehouseAssetAuditTable,
  WarehouseAssetAuditTotals,
  WarehouseAssetAuditWorksheet
} from './WarehouseAssetAuditWorksheet';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 200;
const OWNER_OPTION_UNAVAILABLE = 'owner-selection-unavailable';
const OWNER_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

type AuditFilterOptions = WarehouseAssetAuditResponse['filterOptions'];

interface ScopedWarehouseAssetAuditReportProps {
  userId: string;
  orgId: string;
  scopeKey: string;
  defaultWarehouse: string;
}

interface ActivePrintOperation {
  id: number;
  controller: AbortController;
  scopeKey: string;
  filters: CanonicalWarehouseAssetAuditFilters;
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return isOnline;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  return value;
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function formatRefreshTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ensureSelectedOption(
  options: Array<{ label: string; value: string }>,
  value: string,
  fallbackLabel = value
) {
  if (!value || options.some((entry) => entry.value === value)) {
    return options;
  }
  return [...options, { label: fallbackLabel, value }];
}

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

function safeReportErrorMessage(error: unknown, ownerIdentities: readonly string[]) {
  const message = error instanceof Error ? error.message.trim() : '';
  const containsOwnerIdentity = ownerIdentities.some(
    (identity) => identity && message.toLowerCase().includes(identity.toLowerCase())
  );
  if (!message || containsOwnerIdentity || OWNER_ID_PATTERN.test(message)) {
    return 'The warehouse asset audit could not be updated safely. Try again.';
  }
  return message;
}

function labelContainsIdentity(label: string, identity: string) {
  return Boolean(identity && label.toLowerCase().includes(identity.toLowerCase()));
}

function isSafeOwnerLabel(identity: string, label: string) {
  if (OWNER_ID_PATTERN.test(label)) {
    return false;
  }
  if (identity === 'UNASSIGNED') {
    return label === 'Unassigned';
  }
  return !labelContainsIdentity(label, identity);
}

function isOwnerPresentationSafe(snapshot: WarehouseAssetAuditResponse) {
  const ownersById = new Map<string, string>();
  const ownerIdsByLabel = new Map<string, string>();

  for (const option of snapshot.filterOptions.owners) {
    const identity = String(option.value || '').trim();
    const label = String(option.label || '').trim();
    const normalizedLabel = label.toLowerCase();
    if (
      !identity ||
      !label ||
      !isSafeOwnerLabel(identity, label) ||
      ownersById.has(identity) ||
      (ownerIdsByLabel.has(normalizedLabel) && ownerIdsByLabel.get(normalizedLabel) !== identity)
    ) {
      return false;
    }
    ownersById.set(identity, label);
    ownerIdsByLabel.set(normalizedLabel, identity);
  }

  for (const row of snapshot.rows) {
    if (row.ownerCategory === 'UNASSIGNED') {
      if (row.ownerCompanyId !== null || row.ownerCompanyLabel !== 'Unassigned') {
        return false;
      }
      continue;
    }
    const identity = String(row.ownerCompanyId || '').trim();
    const label = String(row.ownerCompanyLabel || '').trim();
    if (
      !identity ||
      !label ||
      ownersById.get(identity) !== label ||
      !isSafeOwnerLabel(identity, label)
    ) {
      return false;
    }
  }

  const selectedOwner = String(snapshot.appliedFilters.ownerCompanyId || '').trim();
  if (!selectedOwner) {
    if (snapshot.appliedFilterLabels.owner !== 'All Owners') {
      return false;
    }
  } else {
    const selectedLabel = ownersById.get(selectedOwner);
    if (!selectedLabel || snapshot.appliedFilterLabels.owner !== selectedLabel) {
      return false;
    }
  }
  return true;
}

function buildOwnerSelectModel(
  filterOptions: AuditFilterOptions | null,
  selectedOwnerCompanyId: string
) {
  const options = [{ label: 'All Owners', value: '' }];
  const canonicalByToken = new Map<string, string>([['', '']]);
  const tokenByCanonical = new Map<string, string>([['', '']]);
  const labels = new Map<string, string>();
  let isRegistrySafe = true;

  for (const [index, entry] of (filterOptions?.owners || []).entries()) {
    const identity = String(entry.value || '').trim();
    const label = String(entry.label || '').trim();
    const normalizedLabel = label.toLowerCase();
    if (
      !identity ||
      !label ||
      !isSafeOwnerLabel(identity, label) ||
      tokenByCanonical.has(identity) ||
      (labels.has(normalizedLabel) && labels.get(normalizedLabel) !== identity)
    ) {
      isRegistrySafe = false;
      continue;
    }
    const token = `owner-option-${index + 1}`;
    options.push({ label, value: token });
    canonicalByToken.set(token, identity);
    tokenByCanonical.set(identity, token);
    labels.set(normalizedLabel, identity);
  }

  const normalizedSelection = selectedOwnerCompanyId.trim();
  const selectedToken = tokenByCanonical.get(normalizedSelection);
  const isSelectedResolved = !normalizedSelection || Boolean(selectedToken);
  if (normalizedSelection && !selectedToken) {
    options.push({ label: 'Selected owner unavailable', value: OWNER_OPTION_UNAVAILABLE });
  }

  return {
    options: isRegistrySafe
      ? options
      : [
          { label: 'All Owners', value: '' },
          ...(normalizedSelection
            ? [{ label: 'Selected owner unavailable', value: OWNER_OPTION_UNAVAILABLE }]
            : [])
        ],
    canonicalByToken,
    selectedToken: selectedToken || (normalizedSelection ? OWNER_OPTION_UNAVAILABLE : ''),
    isRegistrySafe,
    isSelectedResolved
  };
}

export function WarehouseAssetAuditReport() {
  const { accessContext, session } = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const userId = String(session?.user?.sub || '').trim();
  const orgId = String(accessContext?.orgId || '').trim();
  const scopeKey = JSON.stringify([userId, orgId]);

  return (
    <ScopedWarehouseAssetAuditReport
      key={scopeKey}
      userId={userId}
      orgId={orgId}
      scopeKey={scopeKey}
      defaultWarehouse={defaultWarehouse}
    />
  );
}

function ScopedWarehouseAssetAuditReport({
  userId,
  orgId,
  scopeKey,
  defaultWarehouse
}: ScopedWarehouseAssetAuditReportProps) {
  const isOnline = useOnlineStatus();
  const initializedDefaultWarehouse = useRef(false);
  const printSequence = useRef(0);
  const activePrintOperation = useRef<ActivePrintOperation | null>(null);
  const [filters, setFilters] = useState<WarehouseAssetAuditFilters>({
    warehouse: defaultWarehouse,
    ownerCompanyId: '',
    manufacturer: '',
    filmName: '',
    width: '',
    statuses: [...WAREHOUSE_ASSET_AUDIT_STATUSES],
    q: ''
  });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isSearchComposing, setIsSearchComposing] = useState(false);
  const [page, setPage] = useState(1);
  const [retainedSnapshot, setRetainedSnapshot] = useState<WarehouseAssetAuditResponse | null>(null);
  const [retainedFilterOptions, setRetainedFilterOptions] = useState<AuditFilterOptions | null>(null);
  const [printSnapshot, setPrintSnapshot] = useState<WarehouseAssetAuditResponse | null>(null);
  const [isPreparingPrint, setIsPreparingPrint] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [printError, setPrintError] = useState('');

  useEffect(() => {
    if (initializedDefaultWarehouse.current || !defaultWarehouse) {
      return;
    }
    initializedDefaultWarehouse.current = true;
    setFilters((current) => ({ ...current, warehouse: current.warehouse || defaultWarehouse }));
  }, [defaultWarehouse]);

  useEffect(() => {
    if (isSearchComposing) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(String(filters.q || ''));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [filters.q, isSearchComposing]);

  const canonicalLiveFilters = useMemo(
    () => normalizeWarehouseAssetAuditFilters(filters),
    [filters]
  );
  const requestFilters = useMemo(
    () => ({ ...filters, q: debouncedSearch }),
    [debouncedSearch, filters]
  );
  const canonicalRequestFilters = useMemo(
    () => normalizeWarehouseAssetAuditFilters(requestFilters),
    [requestFilters]
  );
  const query = useWarehouseAssetAuditReport(
    userId,
    orgId,
    toWarehouseAssetAuditRequestFilters(canonicalRequestFilters),
    { enabled: Boolean(userId) && Boolean(orgId) && isOnline }
  );
  const queryOwnerPresentationSafe = useMemo(
    () => query.data ? isOwnerPresentationSafe(query.data) : true,
    [query.data]
  );

  useEffect(() => {
    if (
      !query.data ||
      query.error ||
      query.isPlaceholderData ||
      !queryOwnerPresentationSafe
    ) {
      return;
    }
    setRetainedSnapshot(query.data);
    setRetainedFilterOptions(query.data.filterOptions);
  }, [
    query.data,
    query.error,
    query.isPlaceholderData,
    queryOwnerPresentationSafe
  ]);

  const safeQuerySnapshot = query.data && queryOwnerPresentationSafe ? query.data : null;
  const displaySnapshot = safeQuerySnapshot || retainedSnapshot;
  const activeFilterOptions =
    safeQuerySnapshot && !query.isPlaceholderData && !query.error
      ? safeQuerySnapshot.filterOptions
      : retainedFilterOptions || safeQuerySnapshot?.filterOptions || null;
  const ownerSelect = useMemo(
    () => buildOwnerSelectModel(activeFilterOptions, canonicalLiveFilters.ownerCompanyId),
    [activeFilterOptions, canonicalLiveFilters.ownerCompanyId]
  );
  const ownerIdentities = useMemo(
    () => [
      ...(activeFilterOptions?.owners.map((entry) => String(entry.value || '').trim()) || []),
      canonicalLiveFilters.ownerCompanyId
    ].filter(Boolean),
    [activeFilterOptions, canonicalLiveFilters.ownerCompanyId]
  );
  const ownerSafetyError =
    !queryOwnerPresentationSafe || !ownerSelect.isRegistrySafe || !ownerSelect.isSelectedResolved
      ? 'Warehouse asset audit owner labels could not be resolved safely.'
      : '';
  const reportSnapshot = ownerSafetyError ? null : displaySnapshot;
  const currentAppliedFilters = useMemo(
    () => safeQuerySnapshot
      ? normalizeWarehouseAssetAuditFilters(safeQuerySnapshot.appliedFilters)
      : null,
    [safeQuerySnapshot]
  );
  const displayAppliedFilters = useMemo(
    () => reportSnapshot
      ? normalizeWarehouseAssetAuditFilters(reportSnapshot.appliedFilters)
      : null,
    [reportSnapshot]
  );
  const liveMatchesRequest = warehouseAssetAuditFiltersEqual(
    canonicalLiveFilters,
    canonicalRequestFilters
  );
  const requestMatchesCurrentResponse = Boolean(
    currentAppliedFilters &&
    warehouseAssetAuditFiltersEqual(canonicalRequestFilters, currentAppliedFilters)
  );
  const scopeReady = Boolean(userId && orgId);
  const isSettled =
    scopeReady &&
    isOnline &&
    liveMatchesRequest &&
    requestMatchesCurrentResponse &&
    !query.isPlaceholderData &&
    !query.isFetching &&
    !query.error &&
    !isManualRefreshing &&
    !ownerSafetyError;
  const displayMatchesLive = Boolean(
    displayAppliedFilters &&
    warehouseAssetAuditFiltersEqual(canonicalLiveFilters, displayAppliedFilters)
  );
  const isPreviousResults = Boolean(
    reportSnapshot &&
    (
      !displayMatchesLive ||
      query.isPlaceholderData ||
      query.isFetching ||
      query.error ||
      ownerSafetyError ||
      isManualRefreshing ||
      !isOnline
    )
  );
  const isAutomaticUpdating = Boolean(
    displaySnapshot && query.isFetching && !isManualRefreshing
  );
  const backgroundStatus = isManualRefreshing
    ? 'Refreshing current results...'
    : isAutomaticUpdating
      ? 'Updating results...'
      : '';

  useEffect(() => {
    setPage(1);
  }, [safeQuerySnapshot?.metadata.generatedAt]);

  useEffect(() => {
    const operation = activePrintOperation.current;
    if (
      operation &&
      (
        operation.scopeKey !== scopeKey ||
        !warehouseAssetAuditFiltersEqual(operation.filters, canonicalLiveFilters)
      )
    ) {
      operation.controller.abort();
    }
  }, [canonicalLiveFilters, scopeKey]);

  useEffect(() => () => {
    activePrintOperation.current?.controller.abort();
    document.body.classList.remove('warehouse-asset-audit-printing');
  }, []);

  const pageCount = Math.max(1, Math.ceil((reportSnapshot?.rows.length || 0) / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleRows = useMemo(
    () => reportSnapshot?.rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) || [],
    [reportSnapshot?.rows, safePage]
  );
  const warehouseOptions = ensureSelectedOption(
    [
      { label: 'All Warehouses', value: '' },
      ...(activeFilterOptions?.warehouses.map((entry) => ({
        label: entry.label,
        value: entry.value
      })) || [])
    ],
    canonicalLiveFilters.warehouse,
    canonicalLiveFilters.warehouse
  );
  const manufacturerOptions = ensureSelectedOption(
    [
      { label: 'All Manufacturers', value: '' },
      ...(activeFilterOptions?.manufacturers.map((value) => ({ label: value, value })) || [])
    ],
    canonicalLiveFilters.manufacturer
  );
  const filmOptions = ensureSelectedOption(
    [
      { label: 'All Films', value: '' },
      ...(activeFilterOptions?.filmNames.map((value) => ({ label: value, value })) || [])
    ],
    canonicalLiveFilters.filmName
  );
  const widthOptions = ensureSelectedOption(
    [
      { label: 'All Widths', value: '' },
      ...(activeFilterOptions?.widths.map((value) => ({
        label: `${value}"`,
        value: String(value)
      })) || [])
    ],
    canonicalLiveFilters.width === null ? '' : String(canonicalLiveFilters.width)
  );
  const selectedStatuses = canonicalLiveFilters.statuses;

  function patchFilters(next: Partial<WarehouseAssetAuditFilters>) {
    setPage(1);
    setPrintError('');
    setFilters((current) => ({ ...current, ...next }));
  }

  function toggleStatus(status: WarehouseAssetAuditStatus) {
    if (selectedStatuses.includes(status) && selectedStatuses.length === 1) {
      return;
    }
    patchFilters({
      statuses: selectedStatuses.includes(status)
        ? selectedStatuses.filter((entry) => entry !== status)
        : WAREHOUSE_ASSET_AUDIT_STATUSES.filter(
            (entry) => entry === status || selectedStatuses.includes(entry)
          )
    });
  }

  async function handleRefresh() {
    if (!scopeReady || !isOnline || isPreparingPrint || isManualRefreshing) {
      return;
    }
    setPrintError('');
    setIsManualRefreshing(true);
    try {
      await query.refetch({ cancelRefetch: true });
    } finally {
      setIsManualRefreshing(false);
    }
  }

  function printOperationIsCurrent(operation: ActivePrintOperation) {
    return (
      activePrintOperation.current?.id === operation.id &&
      operation.scopeKey === scopeKey &&
      warehouseAssetAuditFiltersEqual(operation.filters, canonicalLiveFilters)
    );
  }

  async function handlePrint() {
    if (!isSettled || !safeQuerySnapshot || isPreparingPrint) {
      return;
    }
    const operation: ActivePrintOperation = {
      id: ++printSequence.current,
      controller: new AbortController(),
      scopeKey,
      filters: deepFreeze(structuredClone(canonicalRequestFilters))
    };
    activePrintOperation.current = operation;
    setIsPreparingPrint(true);
    setPrintSnapshot(null);
    setPrintError('');
    try {
      const liveResponse = await getWarehouseAssetAuditReport(
        toWarehouseAssetAuditRequestFilters(operation.filters),
        { signal: operation.controller.signal }
      );
      if (
        !printOperationIsCurrent(operation) ||
        !warehouseAssetAuditFiltersEqual(
          operation.filters,
          normalizeWarehouseAssetAuditFilters(liveResponse.appliedFilters)
        )
      ) {
        operation.controller.abort();
        throw new DOMException('The print request was superseded.', 'AbortError');
      }
      if (!isOwnerPresentationSafe(liveResponse)) {
        throw new Error('Warehouse asset audit owner labels could not be resolved safely.');
      }
      const immutableSnapshot = deepFreeze(structuredClone(liveResponse));
      flushSync(() => setPrintSnapshot(immutableSnapshot));
      document.body.classList.add('warehouse-asset-audit-printing');
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
      await waitForPaint();
      if (!printOperationIsCurrent(operation)) {
        operation.controller.abort();
        throw new DOMException('The print request was superseded.', 'AbortError');
      }
      const root = document.querySelector(
        '.warehouse-asset-audit-print-only-root [data-audit-print-snapshot]'
      );
      const renderedRows = root?.querySelectorAll('[data-audit-row-id]') || [];
      const renderedIds = new Set(
        Array.from(renderedRows, (row) => row.getAttribute('data-audit-row-id'))
      );
      if (
        !root ||
        renderedRows.length !== immutableSnapshot.rows.length ||
        renderedIds.size !== immutableSnapshot.rows.length
      ) {
        throw new Error('The print worksheet did not render every matching box exactly once.');
      }
      window.print();
    } catch (error) {
      setPrintSnapshot(null);
      if (!isAbortError(error)) {
        setPrintError(safeReportErrorMessage(error, ownerIdentities));
      }
    } finally {
      if (activePrintOperation.current?.id === operation.id) {
        activePrintOperation.current = null;
        document.body.classList.remove('warehouse-asset-audit-printing');
        setIsPreparingPrint(false);
      }
    }
  }

  const printDisabled = !isSettled || isPreparingPrint;
  const queryErrorMessage = query.error
    ? safeReportErrorMessage(query.error, ownerIdentities)
    : '';
  const printPortal =
    typeof document !== 'undefined' && printSnapshot
      ? createPortal(
          <div className="warehouse-asset-audit-print-only-root" aria-hidden="true">
            <WarehouseAssetAuditWorksheet snapshot={printSnapshot} />
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <section className="panel warehouse-asset-audit-controls">
        <div className="panel-title-row">
          <div>
            <h2>Audit Filters</h2>
            <p className="muted-text">Current physical custody and on-hand asset value.</p>
          </div>
          <div className="page-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleRefresh()}
              disabled={!scopeReady || !isOnline || isPreparingPrint || isManualRefreshing}
              loading={isManualRefreshing}
              loadingLabel="Refreshing..."
            >
              Refresh
            </Button>
            <Button
              type="button"
              onClick={() => void handlePrint()}
              disabled={printDisabled}
              loading={isPreparingPrint}
              loadingLabel="Preparing..."
            >
              Print Audit
            </Button>
          </div>
        </div>
        <div className="toolbar-grid reports-filters warehouse-asset-audit-filter-grid">
          <Select
            label="Warehouse"
            value={canonicalLiveFilters.warehouse}
            onChange={(event) => patchFilters({ warehouse: event.target.value })}
            options={warehouseOptions}
            disabled={isPreparingPrint}
          />
          <Select
            label="Owner"
            value={ownerSelect.selectedToken}
            onChange={(event) => {
              const ownerCompanyId = ownerSelect.canonicalByToken.get(event.target.value);
              if (ownerCompanyId !== undefined) {
                patchFilters({ ownerCompanyId });
              }
            }}
            options={ownerSelect.options}
            disabled={isPreparingPrint}
            error={ownerSafetyError || undefined}
          />
          <Select
            label="Manufacturer"
            value={canonicalLiveFilters.manufacturer}
            onChange={(event) => patchFilters({ manufacturer: event.target.value })}
            options={manufacturerOptions}
            disabled={isPreparingPrint}
          />
          <Select
            label="Film"
            value={canonicalLiveFilters.filmName}
            onChange={(event) => patchFilters({ filmName: event.target.value })}
            options={filmOptions}
            disabled={isPreparingPrint}
          />
          <Select
            label="Width"
            value={canonicalLiveFilters.width === null ? '' : String(canonicalLiveFilters.width)}
            onChange={(event) => patchFilters({ width: event.target.value })}
            options={widthOptions}
            disabled={isPreparingPrint}
          />
          <Input
            label="Search"
            value={filters.q || ''}
            onChange={(event) => patchFilters({ q: event.target.value })}
            onCompositionStart={() => setIsSearchComposing(true)}
            onCompositionEnd={(event) => {
              patchFilters({ q: event.currentTarget.value });
              setIsSearchComposing(false);
            }}
            placeholder="Box ID, owner, film"
            disabled={isPreparingPrint}
          />
        </div>
        <fieldset className="warehouse-asset-audit-status-filter" disabled={isPreparingPrint}>
          <legend>Status</legend>
          {WAREHOUSE_ASSET_AUDIT_STATUSES.map((status) => {
            const label =
              activeFilterOptions?.statuses.find((entry) => entry.value === status)?.label ||
              (status === 'IN_STOCK'
                ? 'In Stock'
                : status === 'CHECKED_OUT'
                  ? 'Checked Out'
                  : 'Pending Transfer');
            return (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={selectedStatuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </fieldset>
        {backgroundStatus ? (
          <p className="muted-text" role="status" aria-live="polite" aria-atomic="true">
            {backgroundStatus}
          </p>
        ) : null}
        {!isOnline ? <p className="error-text">Connect to the internet to load or print this live audit.</p> : null}
        {printError ? <p className="error-text">{printError}</p> : null}
      </section>

      <section
        className="panel warehouse-asset-audit-results"
        aria-busy={query.isFetching || isManualRefreshing || undefined}
      >
        <div className="panel-title-row">
          <div>
            <h2>Warehouse Asset Audit</h2>
            <p className="muted-text">
              {reportSnapshot
                ? `${isPreviousResults ? 'Previous results from' : 'Live data refreshed'} ${formatRefreshTime(reportSnapshot.metadata.generatedAt)}.`
                : 'Loading live data.'}
            </p>
          </div>
          {reportSnapshot ? (
            <span className="muted-text">
              {reportSnapshot.totals.matchingBoxes} {isPreviousResults ? 'previous ' : ''}box(es)
            </span>
          ) : null}
        </div>
        <DeferredLoadingState
          when={query.isLoading && !reportSnapshot}
          label="Loading warehouse asset audit..."
        />
        {isPreviousResults ? (
          <p className="muted-text">
            {query.error || ownerSafetyError
              ? 'Previous results are shown and may not match the selected filters.'
              : 'Previous results remain visible while the selected filters update.'}
          </p>
        ) : null}
        {queryErrorMessage ? <p className="error-text">{queryErrorMessage}</p> : null}
        {ownerSafetyError ? <p className="error-text">{ownerSafetyError}</p> : null}
        {reportSnapshot ? (
          <>
            {!reportSnapshot.rows.length ? (
              <div className="empty-state">
                {isPreviousResults
                  ? 'The previous audit results contain no matching boxes.'
                  : 'No boxes match the current audit filters.'}
              </div>
            ) : (
              <div className="table-wrap warehouse-asset-audit-screen-table">
                <WarehouseAssetAuditTable rows={visibleRows} />
              </div>
            )}
            {reportSnapshot.rows.length > PAGE_SIZE ? (
              <div className="warehouse-asset-audit-pagination" aria-label="Audit result pages">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <span>Page {safePage} of {pageCount}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  Next
                </Button>
              </div>
            ) : null}
            <WarehouseAssetAuditTotals
              snapshot={reportSnapshot}
              className="warehouse-asset-audit-screen-totals"
            />
          </>
        ) : null}
      </section>
      {printPortal}
    </>
  );
}
