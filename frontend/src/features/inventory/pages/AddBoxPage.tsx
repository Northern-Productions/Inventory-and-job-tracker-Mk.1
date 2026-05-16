import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { APIError } from '../../../api/http';
import { useToast } from '../../../components/Toast';
import { isWarehouse, parseWarehouse, type Warehouse } from '../../../domain';
import { formatJobDisplayNumber } from '../../../lib/jobDisplay';
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
  useSearchBoxes,
  useUpsertBoxDealer
} from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { parseAddBoxDraft } from '../schemas/boxSchemas';
import { confirmWarnings, getAddOrEditWarnings } from '../utils/boxWarnings';
import {
  canonicalizeManufacturerLabel,
  createEmptyBoxDraft,
  getNextBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';
import { buildAllocationJobRoute } from '../utils/jobRoutes';
import { getWarehousePrefix } from '../utils/warehouseOptions';

interface FilmOrderPrefill {
  filmOrderId: string;
  jobId: string;
  jobNumber: string;
  warehouse: Warehouse;
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
  const filmOrdersQuery = useFilmOrders({
    enabled: auth.isAuthenticated && Boolean(searchParams.get('filmOrderId'))
  });
  const upsertBoxDealerMutation = useUpsertBoxDealer();
  const warehouseRegistry = useWarehouseRegistry();
  const prefillToken = searchParams.toString();
  const retryState = useMemo(() => readRetryState(location.state), [location.state]);
  const filmOrderPrefill = useMemo(
    () => buildFilmOrderPrefill(new URLSearchParams(prefillToken)),
    [prefillToken]
  );
  const defaultWarehouse = warehouseRegistry.entries[0]?.code || '';
  const [warehouse, setWarehouse] = useState<Warehouse>(
    retryState?.retryWarehouse ?? filmOrderPrefill.warehouse ?? defaultWarehouse
  );
  const warehouseBoxesQuery = useSearchBoxes({ warehouse, showRetired: false });
  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const [filmOrderDraftSeed, setFilmOrderDraftSeed] = useState<BoxDraft | null>(null);
  const [filmOrderRemainingFeet, setFilmOrderRemainingFeet] = useState<number | null>(null);
  const [filmOrderResetNonce, setFilmOrderResetNonce] = useState(0);
  const [shipDirectToJobSite, setShipDirectToJobSite] = useState(false);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (retryState?.retryWarehouse) {
      setWarehouse(retryState.retryWarehouse);
      return;
    }

    if (filmOrderPrefill.warehouse) {
      setWarehouse(filmOrderPrefill.warehouse);
      return;
    }

    if (defaultWarehouse) {
      setWarehouse(defaultWarehouse);
    }
  }, [defaultWarehouse, filmOrderPrefill.warehouse, retryState?.retryWarehouse]);

  const warehousePrefix = useMemo(
    () => getWarehousePrefix(warehouseRegistry.entries, warehouse),
    [warehouse, warehouseRegistry.entries]
  );
  const nextBoxIdForCreateWarehouse = useMemo(
    () => getNextBoxIdForWarehouse(warehouseBoxesQuery.data ?? [], warehouse, warehousePrefix),
    [warehouse, warehouseBoxesQuery.data, warehousePrefix]
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
    ? formatRemainingToOrderFeetValue(filmOrderRemainingFeet, filmOrderPrefill.remainingToOrderFeet)
    : '';

  useEffect(() => {
    if (!filmOrderPrefill.filmOrderId) {
      setFilmOrderDraftSeed(null);
      setFilmOrderRemainingFeet(null);
      setShipDirectToJobSite(false);
      return;
    }

    setFilmOrderDraftSeed(baseInitialDraft);
    setFilmOrderRemainingFeet(parseRemainingFeetValue(filmOrderPrefill.remainingToOrderFeet));
    setFilmOrderResetNonce((current) => current + 1);
    setShipDirectToJobSite(false);
  }, [baseInitialDraft, filmOrderPrefill.filmOrderId, filmOrderPrefill.remainingToOrderFeet]);

  useEffect(
    () => () => {
      if (redirectTimerRef.current !== null) {
        clearTimeout(redirectTimerRef.current);
      }
    },
    []
  );

  async function handleSubmit(draft: BoxDraft, submitContext?: BoxFormSubmitContext) {
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
      const prefixToken = warehousePrefix ? `${warehousePrefix}-` : '';
      if (prefixToken && (normalizedBoxId === warehousePrefix || normalizedBoxId === prefixToken)) {
        toast.push({
          title: `${warehouse} box ID is incomplete`,
          description: `Enter the number or suffix after the ${prefixToken} prefix.`,
          variant: 'error'
        });
        return;
      }

      if (prefixToken && !normalizedBoxId.startsWith(prefixToken)) {
        toast.push({
          title: `${warehouse} box IDs must start with ${prefixToken}`,
          description: `Use a ${prefixToken}-prefixed BoxID for the ${warehouse} warehouse.`,
          variant: 'error'
        });
        return;
      }

      const conflictingWarehouse = warehouseRegistry.entries.find(
        (entry) => {
          const candidatePrefix = entry.boxIdPrefix ? `${entry.boxIdPrefix}-` : '';
          return (
            entry.code !== warehouse &&
            candidatePrefix !== '' &&
            normalizedBoxId.startsWith(candidatePrefix)
          );
        }
      );
      if (!prefixToken && conflictingWarehouse) {
        toast.push({
          title: `${warehouse} box IDs cannot use ${conflictingWarehouse.boxIdPrefix}-`,
          description: `Switch the warehouse dropdown to ${conflictingWarehouse.name} or use a different BoxID format.`,
          variant: 'error'
        });
        return;
      }

      const payload = parseAddBoxDraft(draft);
      payload.warehouse = warehouse;
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
        const { result, warnings } = await addBoxMutation.mutateAsync(payload);
        const currentRemainingFeet =
          filmOrderRemainingFeet ?? parseRemainingFeetValue(filmOrderPrefill.remainingToOrderFeet) ?? 0;
        const nextRemainingFeet = Math.max(currentRemainingFeet - payload.initialFeet, 0);

        setFilmOrderRemainingFeet(nextRemainingFeet);
        const jobIdentity = {
          jobId: filmOrderPrefill.jobId,
          jobNumber: filmOrderPrefill.jobNumber
        };
        void invalidateJobLifecycleQueries(queryClient, jobIdentity);

        if (nextRemainingFeet <= 0) {
          toast.push({
            title: 'Film Order Covered',
            description: 'closing order',
            variant: 'success',
            durationMs: 2000
          });

          if (redirectTimerRef.current !== null) {
            clearTimeout(redirectTimerRef.current);
          }

          redirectTimerRef.current = setTimeout(() => {
            navigate(buildAllocationJobRoute(jobIdentity), {
              replace: true
            });
          }, 2000);
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
          <div className="page-hero-topline">
            <span className="eyebrow">Receiving Intake</span>
          </div>
          <div className="page-hero-title-row">
            <div className="page-hero-copy add-box-hero-copy">
              <h2>Add Box</h2>
              <p className="muted-text">
                Create a warehouse-ready box record with pricing, dates, and roll tracking details.
              </p>
              <WarehouseSelectField
                label="Warehouse"
                value={warehouse}
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
                {formatJobDisplayNumber(filmOrderPrefill.jobNumber, filmOrderPrefill.warehouse)}.
              </p>
            </div>
          </div>
          <div className="detail-grid">
            <div className="key-value">
              <dt>Warehouse</dt>
              <dd>{filmOrderPrefill.warehouse}</dd>
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
                {formatJobDisplayNumber(filmOrderPrefill.jobNumber, filmOrderPrefill.warehouse)} and its first
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
        submitting={addBoxMutation.isPending}
        disabled={!canWriteInventory}
        createWarehouse={warehouse}
        nextBoxIdForCreateWarehouse={nextBoxIdForCreateWarehouse}
        dealerEntries={boxDealersQuery.data}
        dealerLoading={boxDealersQuery.isLoading}
        dealerError={boxDealersQuery.error}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
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
