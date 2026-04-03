import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { APIError } from '../../../api/http';
import { useToast } from '../../../components/Toast';
import { isWarehouse, parseWarehouse, type Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { BoxForm } from '../components/BoxForm';
import { WarehouseSelectField } from '../components/WarehouseSelectField';
import { useAddBox, useFilmCatalog, useSearchBoxes } from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { parseAddBoxDraft } from '../schemas/boxSchemas';
import { confirmWarnings, getAddOrEditWarnings } from '../utils/boxWarnings';
import {
  canonicalizeManufacturerLabel,
  createEmptyBoxDraft,
  getNextBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';
import { getWarehousePrefix } from '../utils/warehouseOptions';

interface FilmOrderPrefill {
  filmOrderId: string;
  jobNumber: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: string;
  initialFeet: string;
  notes: string;
}

interface AddBoxRetryState {
  retryDraft: BoxDraft;
  retryWarehouse: Warehouse;
  retryNonce: number;
}

export default function AddBoxPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const addBoxMutation = useAddBox();
  const filmCatalogQuery = useFilmCatalog();
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
  const initialDraft = useMemo(() => {
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
      initialFeet: filmOrderPrefill.initialFeet || draft.initialFeet,
      notes: filmOrderPrefill.notes || draft.notes
    };
  }, [filmOrderPrefill, retryState?.retryDraft]);
  const resetKey = useMemo(
    () =>
      `create-box-${filmOrderPrefill.filmOrderId || 'default'}-${prefillToken || 'blank'}-${retryState?.retryNonce || 0}`,
    [filmOrderPrefill.filmOrderId, prefillToken, retryState?.retryNonce]
  );

  async function handleSubmit(draft: BoxDraft) {
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
      if (filmOrderPrefill.filmOrderId) {
        payload.filmOrderId = filmOrderPrefill.filmOrderId;
      }
      const shouldContinue = confirmWarnings(getAddOrEditWarnings(payload));
      if (!shouldContinue) {
        return;
      }

      const destination = `/inventory/${encodeURIComponent(payload.boxId)}?showQr=1`;
      const savePromise = addBoxMutation.mutateAsync(payload);
      navigate(destination);

      const { result } = await savePromise;
      navigate(`/inventory/${encodeURIComponent(result.box.boxId)}?showQr=1`, { replace: true });
    } catch (error) {
      navigate('/inventory/add', {
        replace: true,
        state: {
          retryDraft: draft,
          retryWarehouse: warehouse,
          retryNonce: Date.now()
        } satisfies AddBoxRetryState
      });
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
                This new box will link to {filmOrderPrefill.filmOrderId} for job {filmOrderPrefill.jobNumber}.
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
              <dt>Starting LF</dt>
              <dd>{filmOrderPrefill.initialFeet || '--'}</dd>
            </div>
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
  const initialFeet = searchParams.get('initialFeet');

  return {
    filmOrderId: (searchParams.get('filmOrderId') || '').trim(),
    jobNumber: (searchParams.get('jobNumber') || '').trim(),
    warehouse: parseWarehouse(warehouse),
    manufacturer: canonicalizeManufacturerLabel(searchParams.get('manufacturer') || ''),
    filmName: (searchParams.get('filmName') || '').trim(),
    widthIn: width && Number.isFinite(Number(width)) && Number(width) > 0 ? width : '',
    initialFeet:
      initialFeet && Number.isFinite(Number(initialFeet)) && Number(initialFeet) > 0 ? initialFeet : '',
    notes: (searchParams.get('notes') || '').trim()
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
