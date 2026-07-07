import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { APIError } from '../../../api/http';
import { useToast } from '../../../components/Toast';
import { isWarehouse, parseWarehouse, type Warehouse } from '../../../domain';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { formatMutationWarningDescription } from '../../../lib/mutationWarnings';
import { useAuth } from '../../auth/AuthContext';
import { BoxForm, type BoxFormSubmitContext } from '../components/BoxForm';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import { invalidateJobLifecycleQueries } from '../hooks/inventoryInvalidation';
import {
  useAddBox,
  useBoxDealers,
  useFilmCatalog,
  useFilmOrders,
  useOwnerCompanies,
  useSearchBoxesWithOptions,
  useSuggestedNextBoxId,
  useUpsertBoxDealer
} from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { useDefaultSpecificWarehouse } from '../hooks/useDefaultWarehouse';
import { parseAddBoxDraft } from '../schemas/boxSchemas';
import { confirmWarnings, getAddOrEditWarnings } from '../utils/boxWarnings';
import {
  canonicalizeManufacturerLabel,
  createEmptyBoxDraft,
  getNextBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';
import { getSafeSpecificWarehouseValue, getWarehousePrefix } from '../utils/warehouseOptions';

interface FilmOrderPrefill {
  filmOrderId: string;
  jobId: string;
  jobNumber: string;
  warehouse: Warehouse;
  workScope: string;
  sections: string;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  remainingToOrderFeet: string;
  notes: string;
}

interface AddBoxRetryState {
  retryDraft: BoxDraft;
  retryWarehouse: Warehouse;
  retryNonce: number;
}

interface FilmOrderIntakeLinkedBox {
  boxId: string;
  widthIn: number | null;
  orderedFeet: number;
  isReceived: boolean;
  isDirectToJobSite: boolean;
  isPending?: boolean;
}

export default function AddBoxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const addBoxMutation = useAddBox();
  const boxDealersQuery = useBoxDealers({ enabled: auth.isAuthenticated });
  const filmCatalogQuery = useFilmCatalog();
  const ownerCompaniesQuery = useOwnerCompanies({ enabled: auth.isAuthenticated });
  const filmOrdersQuery = useFilmOrders({
    enabled: auth.isAuthenticated && Boolean(searchParams.get('filmOrderId'))
  });
  const upsertBoxDealerMutation = useUpsertBoxDealer();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseScopeReady = warehouseRegistry.scopeReady !== false;
  const defaultSpecificWarehouse = useDefaultSpecificWarehouse();
  const prefillToken = searchParams.toString();
  const retryState = useMemo(() => readRetryState(location.state), [location.state]);
  const filmOrderPrefill = useMemo(
    () => buildFilmOrderPrefill(new URLSearchParams(prefillToken)),
    [prefillToken]
  );
  const defaultWarehouse = defaultSpecificWarehouse || warehouseRegistry.entries[0]?.code || '';
  const [warehouse, setWarehouse] = useState<Warehouse>(
    retryState?.retryWarehouse ?? filmOrderPrefill.warehouse ?? defaultWarehouse
  );
  const safeWarehouse = getSafeSpecificWarehouseValue(warehouseRegistry.entries, warehouse);
  const warehouseBoxesQuery = useSearchBoxesWithOptions(
    { warehouse: safeWarehouse, showRetired: true },
    { enabled: Boolean(safeWarehouse) }
  );
  const suggestedBoxIdQuery = useSuggestedNextBoxId(safeWarehouse, { enabled: Boolean(safeWarehouse) });
  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const [filmOrderDraftSeed, setFilmOrderDraftSeed] = useState<BoxDraft | null>(null);
  const [filmOrderRemainingFeet, setFilmOrderRemainingFeet] = useState<number | null>(null);
  const [confirmedFilmOrderBoxes, setConfirmedFilmOrderBoxes] = useState<FilmOrderIntakeLinkedBox[]>([]);
  const [pendingFilmOrderBox, setPendingFilmOrderBox] = useState<FilmOrderIntakeLinkedBox | null>(null);
  const [filmOrderResetNonce, setFilmOrderResetNonce] = useState(0);
  const [shipDirectToJobSite, setShipDirectToJobSite] = useState(false);
  const isCreatingBox = addBoxMutation.isPending || upsertBoxDealerMutation.isPending;
  const linkedFilmOrder = useMemo(
    () =>
      (filmOrdersQuery.data || []).find((entry) => entry.filmOrderId === filmOrderPrefill.filmOrderId) || null,
    [filmOrderPrefill.filmOrderId, filmOrdersQuery.data]
  );
  const directToJobSiteBlockedReason = useMemo(() => {
    if (!filmOrderPrefill.filmOrderId) {
      return '';
    }

    if (filmOrdersQuery.isLoading) {
      return 'Loading the linked Film Order before direct-to-site can be used.';
    }

    if (!linkedFilmOrder) {
      return `Film Order ${filmOrderPrefill.filmOrderId} could not be loaded for direct-to-site fulfillment.`;
    }

    if (!String(linkedFilmOrder.installDate || '').trim()) {
      return `Film Order ${filmOrderPrefill.filmOrderId} needs an Install Date before Ship Directly to Job Site can be used.`;
    }

    return '';
  }, [
    filmOrderPrefill.filmOrderId,
    filmOrdersQuery.isLoading,
    linkedFilmOrder
  ]);

  useEffect(() => {
    if (!warehouseScopeReady) {
      return;
    }

    const nextWarehouse =
      getSafeSpecificWarehouseValue(
        warehouseRegistry.entries,
        retryState?.retryWarehouse ?? filmOrderPrefill.warehouse ?? defaultWarehouse
      ) || defaultWarehouse;

    if (retryState?.retryWarehouse) {
      setWarehouse(nextWarehouse);
      return;
    }

    if (filmOrderPrefill.warehouse) {
      setWarehouse(nextWarehouse);
      return;
    }

    if (defaultWarehouse) {
      setWarehouse(defaultWarehouse);
    }
  }, [
    defaultWarehouse,
    filmOrderPrefill.warehouse,
    retryState?.retryWarehouse,
    warehouseRegistry.entries,
    warehouseScopeReady
  ]);

  const warehousePrefix = useMemo(
    () => getWarehousePrefix(warehouseRegistry.entries, safeWarehouse),
    [safeWarehouse, warehouseRegistry.entries]
  );
  const fallbackNextBoxIdForCreateWarehouse = useMemo(
    () => getNextBoxIdForWarehouse(warehouseBoxesQuery.data ?? [], safeWarehouse, warehousePrefix),
    [safeWarehouse, warehouseBoxesQuery.data, warehousePrefix]
  );
  const suggestedBoxId = suggestedBoxIdQuery.data?.boxId?.trim() || '';
  const suggestedBoxIdIsAlreadyKnown = useMemo(() => {
    if (!suggestedBoxId) {
      return false;
    }

    const normalizedSuggestion = suggestedBoxId.toUpperCase();
    return (warehouseBoxesQuery.data ?? []).some(
      (box) => String(box.boxId || '').trim().toUpperCase() === normalizedSuggestion
    );
  }, [suggestedBoxId, warehouseBoxesQuery.data]);
  const nextBoxIdForCreateWarehouse = useMemo(
    () =>
      suggestedBoxId && !suggestedBoxIdIsAlreadyKnown
        ? suggestedBoxId
        : fallbackNextBoxIdForCreateWarehouse,
    [fallbackNextBoxIdForCreateWarehouse, suggestedBoxId, suggestedBoxIdIsAlreadyKnown]
  );
  const baseInitialDraft = useMemo(() => {
    if (retryState?.retryDraft) {
      return retryState.retryDraft;
    }

    const draft = createEmptyBoxDraft();

    if (!filmOrderPrefill.filmOrderId) {
      return draft;
    }

    return {
      ...draft,
      manufacturer: filmOrderPrefill.manufacturer || draft.manufacturer,
      filmName: filmOrderPrefill.filmName || draft.filmName,
      widthIn: filmOrderPrefill.widthIn || draft.widthIn,
      initialFeet: '',
      currentFeetOnRoll: '',
      feetAvailable: '',
      notes: filmOrderPrefill.notes || draft.notes
    };
  }, [filmOrderPrefill, retryState?.retryDraft]);
  const initialDraft = filmOrderPrefill.filmOrderId
    ? filmOrderDraftSeed || baseInitialDraft
    : baseInitialDraft;
  const resetKey = useMemo(
    () =>
      `create-box-${filmOrderPrefill.filmOrderId || 'default'}-${prefillToken || 'blank'}-${retryState?.retryNonce || 0}-${filmOrderResetNonce}`,
    [filmOrderPrefill.filmOrderId, filmOrderResetNonce, prefillToken, retryState?.retryNonce]
  );
  const displayedRemainingToOrderFeet = filmOrderPrefill.filmOrderId
    ? formatRemainingToOrderFeetValue(
        linkedFilmOrder ? Math.max(0, Number(linkedFilmOrder.remainingToOrderFeet || 0)) : filmOrderRemainingFeet,
        filmOrderPrefill.remainingToOrderFeet
      )
    : '';
  const intakeLinkedBoxes = useMemo(
    () =>
      buildFilmOrderIntakeLinkedBoxes({
        linkedFilmOrder,
        prefillWidthIn: filmOrderPrefill.widthIn,
        confirmedBoxes: confirmedFilmOrderBoxes,
        pendingBox: pendingFilmOrderBox
      }),
    [
      confirmedFilmOrderBoxes,
      filmOrderPrefill.widthIn,
      linkedFilmOrder,
      pendingFilmOrderBox
    ]
  );
  const filmOrderJobLabel = useMemo(
    () =>
      formatJobDisplayLabel({
        jobNumber: filmOrderPrefill.jobNumber,
        warehouse: safeWarehouse,
        workScope:
          String(linkedFilmOrder?.workScope || linkedFilmOrder?.sections || '').trim() ||
          filmOrderPrefill.workScope,
        sections:
          String(linkedFilmOrder?.sections || linkedFilmOrder?.workScope || '').trim() ||
          filmOrderPrefill.sections
      }),
    [
      filmOrderPrefill.jobNumber,
      filmOrderPrefill.sections,
      safeWarehouse,
      filmOrderPrefill.workScope,
      linkedFilmOrder?.sections,
      linkedFilmOrder?.workScope
    ]
  );

  useEffect(() => {
    if (!filmOrderPrefill.filmOrderId) {
      setFilmOrderDraftSeed(null);
      setFilmOrderRemainingFeet(null);
      setShipDirectToJobSite(false);
      return;
    }

    setFilmOrderDraftSeed(baseInitialDraft);
    setFilmOrderRemainingFeet(parseRemainingFeetValue(filmOrderPrefill.remainingToOrderFeet));
    setConfirmedFilmOrderBoxes([]);
    setPendingFilmOrderBox(null);
    setFilmOrderResetNonce((current) => current + 1);
    setShipDirectToJobSite(false);
  }, [baseInitialDraft, filmOrderPrefill.filmOrderId, filmOrderPrefill.remainingToOrderFeet]);

  async function handleSubmit(draft: BoxDraft, submitContext?: BoxFormSubmitContext) {
    if (isCreatingBox) {
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating boxes.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating boxes.',
        variant: 'error'
      });
      return;
    }

    if (!canWriteInventory) {
      toast.push({
        title: 'Permission denied',
        description: 'Your account cannot create new boxes.',
        variant: 'error'
      });
      return;
    }

    try {
      const normalizedBoxId = draft.boxId.trim().toUpperCase();
      if (!safeWarehouse) {
        toast.push({
          title: 'Warehouse is required',
          description: 'Add or select a configured warehouse before creating this box.',
          variant: 'error'
        });
        return;
      }

      const prefixToken = warehousePrefix ? `${warehousePrefix}-` : '';
      if (prefixToken && (normalizedBoxId === warehousePrefix || normalizedBoxId === prefixToken)) {
        toast.push({
          title: `${safeWarehouse} box ID is incomplete`,
          description: `Enter the number or suffix after the ${prefixToken} prefix.`,
          variant: 'error'
        });
        return;
      }

      if (prefixToken && !normalizedBoxId.startsWith(prefixToken)) {
        toast.push({
          title: `${safeWarehouse} box IDs must start with ${prefixToken}`,
          description: `Use a ${prefixToken}-prefixed BoxID for the ${safeWarehouse} warehouse.`,
          variant: 'error'
        });
        return;
      }

      const conflictingWarehouse = warehouseRegistry.entries.find(
        (entry) => {
          const candidatePrefix = entry.boxIdPrefix ? `${entry.boxIdPrefix}-` : '';
          return (
            entry.code !== safeWarehouse &&
            candidatePrefix !== '' &&
            normalizedBoxId.startsWith(candidatePrefix)
          );
        }
      );
      if (!prefixToken && conflictingWarehouse) {
        toast.push({
          title: `${safeWarehouse} box IDs cannot use ${conflictingWarehouse.boxIdPrefix}-`,
          description: `Switch the warehouse dropdown to ${conflictingWarehouse.name} or use a different BoxID format.`,
          variant: 'error'
        });
        return;
      }

      if (!draft.ownerCompanyId.trim()) {
        toast.push({
          title: 'Owner company is required',
          description: 'Select the company that owns this box before saving.',
          variant: 'error'
        });
        return;
      }

      const payload = parseAddBoxDraft(draft);
      payload.warehouse = safeWarehouse;
      const auditNote = submitContext?.auditNote?.trim();
      if (auditNote) {
        payload.auditNote = auditNote;
      }
      if (filmOrderPrefill.filmOrderId) {
        payload.filmOrderId = filmOrderPrefill.filmOrderId;
      }
      if (shipDirectToJobSite) {
        if (directToJobSiteBlockedReason) {
          toast.push({
            title: 'Direct-to-site unavailable',
            description: directToJobSiteBlockedReason,
            variant: 'error'
          });
          return;
        }
        payload.shipDirectToJobSite = true;
      }
      const shouldContinue = confirmWarnings(getAddOrEditWarnings(payload));
      if (!shouldContinue) {
        return;
      }

      const normalizedDealer = payload.dealer?.trim();
      const nextDraft =
        normalizedDealer
          ? {
              ...draft,
              dealer: (await upsertBoxDealerMutation.mutateAsync({ name: normalizedDealer })).name
            }
          : draft;
      if (nextDraft !== draft) {
        payload.dealer = nextDraft.dealer;
      }

      if (filmOrderPrefill.filmOrderId) {
        const pendingLinkedBox = buildPendingFilmOrderIntakeBox({
          boxId: payload.boxId,
          widthIn: payload.widthIn,
          orderedFeet: payload.initialFeet,
          isReceived: Boolean(payload.receivedDate),
          isDirectToJobSite: Boolean(payload.shipDirectToJobSite)
        });
        setPendingFilmOrderBox(pendingLinkedBox);
        const { result, warnings } = await addBoxMutation.mutateAsync(payload);
        const currentRemainingFeet =
          (linkedFilmOrder
            ? Math.max(0, Number(linkedFilmOrder.remainingToOrderFeet || 0))
            : filmOrderRemainingFeet) ??
          parseRemainingFeetValue(filmOrderPrefill.remainingToOrderFeet) ??
          0;
        const nextRemainingFeet = Math.max(currentRemainingFeet - payload.initialFeet, 0);

        setPendingFilmOrderBox(null);
        setConfirmedFilmOrderBoxes((current) =>
          upsertFilmOrderIntakeLinkedBox(current, {
            ...pendingLinkedBox,
            boxId: result.box.boxId,
            isPending: false
          })
        );
        setFilmOrderRemainingFeet(nextRemainingFeet);
        const jobIdentity = {
          jobId: filmOrderPrefill.jobId,
          jobNumber: filmOrderPrefill.jobNumber
        };
        void invalidateJobLifecycleQueries(queryClient, jobIdentity);

        if (nextRemainingFeet <= 0) {
          setFilmOrderDraftSeed(buildNextFilmOrderDraft(nextDraft));
          setFilmOrderResetNonce((current) => current + 1);
          toast.push({
            title: 'Film Order Covered',
            description: 'Connected boxes and remaining LF are updated.',
            variant: 'success',
            durationMs: 2000
          });
          return;
        }

        setFilmOrderDraftSeed(buildNextFilmOrderDraft(nextDraft));
        setFilmOrderResetNonce((current) => current + 1);
        toast.push({
          title: `Added ${result.box.boxId}`,
          description: formatMutationWarningDescription(
            warnings,
            `${nextRemainingFeet} LF still needs to be entered on ${filmOrderPrefill.filmOrderId}.`,
            'add-box'
          ),
          variant: 'success'
        });
        return;
      }

      const destination = `/inventory/${encodeURIComponent(payload.boxId)}?showQr=1`;
      const savePromise = addBoxMutation.mutateAsync(payload);
      navigate(destination);

      const { result } = await savePromise;
      navigate(`/inventory/${encodeURIComponent(result.box.boxId)}?showQr=1`, { replace: true });
    } catch (error) {
      if (filmOrderPrefill.filmOrderId) {
        setPendingFilmOrderBox(null);
      }

      if (!filmOrderPrefill.filmOrderId) {
        navigate('/inventory/add', {
          replace: true,
          state: {
            retryDraft: draft,
            retryWarehouse: warehouse,
            retryNonce: Date.now()
          } satisfies AddBoxRetryState
        });
      }
      toast.push({
        title: 'Unable to add box',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : 'The request failed.',
        variant: 'error'
      });
    }
  }

  return (
    <>
      {!filmOrderPrefill.filmOrderId ? (
        <section className="panel">
          <div className="add-box-hero-layout">
            <div className="page-hero-copy add-box-hero-copy">
              <div className="page-hero-topline">
                <span className="eyebrow">Receiving Intake</span>
              </div>
              <h2>Add Box</h2>
              <p className="muted-text">
                Create a warehouse-ready box record with pricing, dates, and roll tracking details.
              </p>
            </div>
            <div className="add-box-warehouse-control">
              <WarehouseSelectField
                label="Warehouse"
                value={safeWarehouse}
                onChange={(nextWarehouse) => setWarehouse(nextWarehouse as Warehouse)}
              />
            </div>
          </div>
        </section>
      ) : null}
      {filmOrderPrefill.filmOrderId ? (
        <section className="panel">
          <div className="panel-title-row">
            <div>
              <h2>Film Order Intake</h2>
              <p className="muted-text">
                This new box will link to {filmOrderPrefill.filmOrderId} for job{' '}
                {filmOrderJobLabel}.
              </p>
            </div>
          </div>
          <div className="detail-grid">
            <div className="key-value">
              <dt>Warehouse</dt>
              <dd>{safeWarehouse || '--'}</dd>
            </div>
            <div className="key-value">
              <dt>Film</dt>
              <dd>
                {filmOrderPrefill.manufacturer} {filmOrderPrefill.filmName}
              </dd>
            </div>
            <div className="key-value">
              <dt>Width</dt>
              <dd>{filmOrderPrefill.widthIn || '--'}</dd>
            </div>
            <div className="key-value">
              <dt>Remaining To Order LF</dt>
              <dd>{displayedRemainingToOrderFeet || '--'}</dd>
            </div>
          </div>
          <section className="film-order-intake-boxes" aria-labelledby="film-order-intake-boxes-title">
            <div className="film-order-intake-boxes-header">
              <h3 id="film-order-intake-boxes-title">Created boxes</h3>
              <span className="muted-text">
                {intakeLinkedBoxes.length} box{intakeLinkedBoxes.length === 1 ? '' : 'es'}
              </span>
            </div>
            {intakeLinkedBoxes.length ? (
              <div className="table-wrap film-order-intake-boxes-table-wrap">
                <table className="film-order-intake-boxes-table">
                  <thead>
                    <tr>
                      <th>Box ID</th>
                      <th>Width</th>
                      <th>LF</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intakeLinkedBoxes.map((linkedBox) => (
                      <tr key={linkedBox.boxId}>
                        <td>
                          {linkedBox.isPending ? (
                            <span>{linkedBox.boxId}</span>
                          ) : (
                            <Link to={`/inventory/${encodeURIComponent(linkedBox.boxId)}`}>
                              {linkedBox.boxId}
                            </Link>
                          )}
                        </td>
                        <td>{linkedBox.widthIn ?? '--'}</td>
                        <td>{linkedBox.orderedFeet}</td>
                        <td>
                          <span className="film-order-intake-box-state">
                            {linkedBox.isPending
                              ? 'Saving...'
                              : linkedBox.isDirectToJobSite
                                ? 'Direct to site'
                                : linkedBox.isReceived
                                  ? 'Received'
                                  : 'Ordered'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted-text film-order-intake-empty">
                {filmOrdersQuery.isLoading
                  ? 'Loading created boxes...'
                  : 'No boxes have been created for this film order yet.'}
              </p>
            )}
          </section>
          <div className="panel panel-subtle" style={{ marginTop: '1rem' }}>
            <label
              htmlFor="ship-direct-to-job-site"
              style={{ display: 'grid', gap: '0.5rem' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  id="ship-direct-to-job-site"
                  aria-label="Ship Directly to Job Site"
                  type="checkbox"
                  checked={shipDirectToJobSite}
                  disabled={Boolean(directToJobSiteBlockedReason)}
                  onChange={(event) => setShipDirectToJobSite(event.target.checked)}
                />
                <strong>Ship Directly to Job Site</strong>
              </span>
              <span className="muted-text">
                Skip warehouse receipt for this Film Order. The box will be created already checked out to job{' '}
                {filmOrderJobLabel} and its first
                warehouse return will require both return weight and remaining LF.
              </span>
              {directToJobSiteBlockedReason ? (
                <span className="muted-text" role="alert">
                  {directToJobSiteBlockedReason}
                </span>
              ) : null}
            </label>
          </div>
        </section>
      ) : null}
      {!auth.isAuthenticated ? (
        <section className="panel panel-subtle">
          <p className="muted-text">Sign in with email/password before creating boxes.</p>
        </section>
      ) : null}
      {auth.isAuthenticated && !canWriteInventory ? (
        <section className="panel panel-subtle">
          <p className="muted-text">Your role does not allow creating new boxes.</p>
        </section>
      ) : null}
        <BoxForm
        initialDraft={initialDraft}
        resetKey={resetKey}
        mode="create"
        submitLabel="Create Box"
        submitting={isCreatingBox}
        disabled={!canWriteInventory}
        createWarehouse={safeWarehouse}
        nextBoxIdForCreateWarehouse={nextBoxIdForCreateWarehouse}
        dealerEntries={boxDealersQuery.data}
        dealerLoading={boxDealersQuery.isLoading}
        dealerError={boxDealersQuery.error}
          filmCatalogEntries={filmCatalogQuery.data}
          filmCatalogLoading={filmCatalogQuery.isLoading}
          filmCatalogError={filmCatalogQuery.error}
          ownerCompanies={ownerCompaniesQuery.data}
          ownerCompaniesLoading={ownerCompaniesQuery.isLoading}
          ownerCompaniesError={ownerCompaniesQuery.error}
          onSubmit={handleSubmit}
      />
    </>
  );
}

function buildFilmOrderPrefill(searchParams: URLSearchParams): FilmOrderPrefill {
  const warehouse = searchParams.get('warehouse');
  const width = searchParams.get('width');
  const remainingToOrderFeet = searchParams.get('remainingToOrderFeet') || searchParams.get('initialFeet');

  return {
    filmOrderId: (searchParams.get('filmOrderId') || '').trim(),
    jobId: (searchParams.get('jobId') || '').trim(),
    jobNumber: (searchParams.get('jobNumber') || '').trim(),
    warehouse: parseWarehouse(warehouse),
    workScope: (searchParams.get('workScope') || '').trim(),
    sections: (searchParams.get('sections') || '').trim(),
    manufacturer: canonicalizeManufacturerLabel(searchParams.get('manufacturer') || ''),
    filmName: (searchParams.get('filmName') || '').trim(),
    widthIn: width && Number.isFinite(Number(width)) && Number(width) > 0 ? width : '',
    remainingToOrderFeet:
      remainingToOrderFeet && Number.isFinite(Number(remainingToOrderFeet)) && Number(remainingToOrderFeet) >= 0
        ? String(Math.floor(Number(remainingToOrderFeet)))
        : '',
    notes: (searchParams.get('notes') || '').trim()
  };
}

function parseRemainingFeetValue(value: string): number | null {
  if (!value.trim()) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.floor(parsed));
}

function formatRemainingToOrderFeetValue(currentValue: number | null, fallbackValue: string) {
  if (currentValue !== null) {
    return String(currentValue);
  }

  return fallbackValue.trim();
}

function buildNextFilmOrderDraft(currentDraft: BoxDraft): BoxDraft {
  const nextDraft = createEmptyBoxDraft();

  return {
    ...nextDraft,
    boxId: '',
    dealer: currentDraft.dealer,
    manufacturer: currentDraft.manufacturer,
    filmName: currentDraft.filmName,
    widthIn: currentDraft.widthIn,
    initialFeet: '',
    currentFeetOnRoll: '',
    feetAvailable: '',
    lotRun: '',
    orderDate: currentDraft.orderDate,
    receivedDate: currentDraft.receivedDate,
    initialWeightLbs: '',
    lastRollWeightLbs: '',
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: '',
    lfWeightLbsPerFt: '',
    pricePerLf: '',
    purchaseCost: '',
    notes: currentDraft.notes,
    currentFeetOnRollManuallyEdited: false,
    lastRollWeightLbsManuallyEdited: false
  };
}

function buildPendingFilmOrderIntakeBox(entry: {
  boxId: string;
  widthIn: number;
  orderedFeet: number;
  isReceived: boolean;
  isDirectToJobSite: boolean;
}): FilmOrderIntakeLinkedBox {
  return {
    boxId: String(entry.boxId || '').trim().toUpperCase(),
    widthIn: Number.isFinite(Number(entry.widthIn)) ? Number(entry.widthIn) : null,
    orderedFeet: Math.max(0, Math.trunc(Number(entry.orderedFeet || 0))),
    isReceived: entry.isReceived,
    isDirectToJobSite: entry.isDirectToJobSite,
    isPending: true
  };
}

function upsertFilmOrderIntakeLinkedBox(
  current: FilmOrderIntakeLinkedBox[],
  nextBox: FilmOrderIntakeLinkedBox
) {
  const normalizedBoxId = String(nextBox.boxId || '').trim().toUpperCase();
  if (!normalizedBoxId) {
    return current;
  }

  const nextEntry = {
    ...nextBox,
    boxId: normalizedBoxId
  };
  const existingIndex = current.findIndex((entry) => entry.boxId === normalizedBoxId);
  if (existingIndex === -1) {
    return [...current, nextEntry];
  }

  return current.map((entry) => (entry.boxId === normalizedBoxId ? nextEntry : entry));
}

function buildFilmOrderIntakeLinkedBoxes(options: {
  linkedFilmOrder: {
    widthIn?: number;
    linkedBoxes?: Array<{
      boxId: string;
      orderedFeet?: number;
      initialFeet?: number;
      isReceived?: boolean;
      isDirectToJobSite?: boolean;
    }>;
  } | null;
  prefillWidthIn: string;
  confirmedBoxes: FilmOrderIntakeLinkedBox[];
  pendingBox: FilmOrderIntakeLinkedBox | null;
}): FilmOrderIntakeLinkedBox[] {
  const entriesByBoxId = new Map<string, FilmOrderIntakeLinkedBox>();
  const fallbackWidth = Number(options.prefillWidthIn);
  const orderWidth = Number(options.linkedFilmOrder?.widthIn);
  const widthIn = Number.isFinite(orderWidth) && orderWidth > 0
    ? orderWidth
    : Number.isFinite(fallbackWidth) && fallbackWidth > 0
      ? fallbackWidth
      : null;

  function addEntry(entry: FilmOrderIntakeLinkedBox | null) {
    const boxId = String(entry?.boxId || '').trim().toUpperCase();
    if (!boxId || !entry) {
      return;
    }

    const previous = entriesByBoxId.get(boxId);
    entriesByBoxId.set(boxId, {
      boxId,
      widthIn: entry.widthIn ?? previous?.widthIn ?? widthIn,
      orderedFeet: Math.max(entry.orderedFeet, previous?.orderedFeet || 0),
      isReceived: Boolean(entry.isReceived || previous?.isReceived),
      isDirectToJobSite: Boolean(entry.isDirectToJobSite || previous?.isDirectToJobSite),
      isPending: Boolean(entry.isPending || previous?.isPending)
    });
  }

  for (const linkedBox of options.linkedFilmOrder?.linkedBoxes || []) {
    const orderedFeet = Number(linkedBox.orderedFeet ?? linkedBox.initialFeet ?? 0);
    addEntry({
      boxId: linkedBox.boxId,
      widthIn,
      orderedFeet: Number.isFinite(orderedFeet) ? Math.max(0, Math.trunc(orderedFeet)) : 0,
      isReceived: Boolean(linkedBox.isReceived),
      isDirectToJobSite: Boolean(linkedBox.isDirectToJobSite),
      isPending: false
    });
  }

  for (const confirmedBox of options.confirmedBoxes) {
    addEntry(confirmedBox);
  }

  addEntry(options.pendingBox);

  return Array.from(entriesByBoxId.values()).sort((left, right) => left.boxId.localeCompare(right.boxId));
}

function readRetryState(state: unknown): AddBoxRetryState | null {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const candidate = state as Partial<AddBoxRetryState>;
  if (!candidate.retryDraft || typeof candidate.retryDraft !== 'object') {
    return null;
  }

  const retryWarehouse = typeof candidate.retryWarehouse === 'string'
    ? candidate.retryWarehouse.toUpperCase()
    : '';
  if (!isWarehouse(retryWarehouse)) {
    return null;
  }

  if (!candidate.retryNonce || !Number.isFinite(Number(candidate.retryNonce))) {
    return null;
  }

  return {
    retryDraft: candidate.retryDraft as BoxDraft,
    retryWarehouse,
    retryNonce: Number(candidate.retryNonce)
  };
}
