import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { APIError } from '../../../api/http';
import { useToast } from '../../../components/Toast';
import type { Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { BoxForm } from '../components/BoxForm';
import { useAddBox, useSearchBoxes, useUndoAudit } from '../hooks/useInventoryQueries';
import { parseAddBoxDraft } from '../schemas/boxSchemas';
import { confirmWarnings, getAddOrEditWarnings } from '../utils/boxWarnings';
import {
  addManufacturerOption,
  createEmptyBoxDraft,
  getNextBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';

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

export default function AddBoxPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const addBoxMutation = useAddBox();
  const undoMutation = useUndoAudit();
  const ilBoxesQuery = useSearchBoxes({ warehouse: 'IL', showRetired: true });
  const msBoxesQuery = useSearchBoxes({ warehouse: 'MS', showRetired: true });
  const prefillToken = searchParams.toString();
  const filmOrderPrefill = useMemo(
    () => buildFilmOrderPrefill(searchParams),
    [prefillToken, searchParams]
  );
  const [warehouse, setWarehouse] = useState<Warehouse>(filmOrderPrefill.warehouse);

  useEffect(() => {
    setWarehouse(filmOrderPrefill.warehouse);
  }, [filmOrderPrefill.warehouse]);

  const nextBoxIdByWarehouse = useMemo(
    () => ({
      IL: getNextBoxIdForWarehouse(ilBoxesQuery.data ?? [], 'IL'),
      MS: getNextBoxIdForWarehouse(msBoxesQuery.data ?? [], 'MS')
    }),
    [ilBoxesQuery.data, msBoxesQuery.data]
  );
  const initialDraft = useMemo(() => {
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
  }, [filmOrderPrefill]);
  const resetKey = useMemo(
    () => `create-box-${filmOrderPrefill.filmOrderId || 'default'}-${prefillToken || 'blank'}`,
    [filmOrderPrefill.filmOrderId, prefillToken]
  );

  async function handleSubmit(draft: BoxDraft) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before creating boxes.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with Google in the header before creating boxes.',
        variant: 'error'
      });
      return;
    }

    try {
      const normalizedBoxId = draft.boxId.trim().toUpperCase();
      if (warehouse === 'MS' && normalizedBoxId === 'M') {
        toast.push({
          title: 'Mississippi box ID is incomplete',
          description: 'Enter the number or suffix after the M prefix.',
          variant: 'error'
        });
        return;
      }

      if (warehouse === 'MS' && !normalizedBoxId.startsWith('M')) {
        toast.push({
          title: 'Mississippi box IDs must start with M',
          description: 'Use an M-prefixed BoxID for the Mississippi warehouse.',
          variant: 'error'
        });
        return;
      }

      if (warehouse === 'IL' && normalizedBoxId.startsWith('M')) {
        toast.push({
          title: 'Illinois box IDs cannot start with M',
          description: 'Switch the warehouse toggle to Mississippi or use a non-M BoxID.',
          variant: 'error'
        });
        return;
      }

      const payload = parseAddBoxDraft(draft);
      if (filmOrderPrefill.filmOrderId) {
        payload.filmOrderId = filmOrderPrefill.filmOrderId;
      }
      const shouldContinue = confirmWarnings(getAddOrEditWarnings(payload));
      if (!shouldContinue) {
        return;
      }

      const { result, warnings } = await addBoxMutation.mutateAsync(payload);
      addManufacturerOption(result.box.manufacturer);

      toast.push({
        title: `Saved ${result.box.boxId}`,
        description:
          warnings.length > 0
            ? `${warnings.join(' ')} QR image and export actions are ready on the box details page.`
            : `${result.box.boxId} was created and stored in ${result.box.warehouse}. QR image and export actions are ready on the box details page.`,
        actionLabel: 'Undo',
        onAction: async () => {
          try {
            const undone = await undoMutation.mutateAsync({
              logId: result.logId,
              reason: 'Undo add from success toast'
            });

            toast.push({
              title: 'Undo completed',
              description:
                undone.warnings.join(' ') ||
                `${result.box.boxId} was reverted using the latest audit log.`
            });
          } catch (error) {
            toast.push({
              title: 'Undo failed',
              description:
                error instanceof Error ? error.message : 'The undo request could not be completed.',
              variant: 'error'
            });
          }
        }
      });

      navigate(`/inventory/${encodeURIComponent(result.box.boxId)}?showQr=1`);
    } catch (error) {
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
        <section className="panel">
          <p className="muted-text">Sign in with Google in the header before creating boxes.</p>
        </section>
      ) : null}
      <BoxForm
        initialDraft={initialDraft}
        resetKey={resetKey}
        mode="create"
        submitLabel="Create Box"
        submitting={addBoxMutation.isPending}
        createWarehouse={warehouse}
        nextBoxIdByWarehouse={nextBoxIdByWarehouse}
        onCreateWarehouseChange={setWarehouse}
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
    warehouse: warehouse === 'MS' ? 'MS' : 'IL',
    manufacturer: (searchParams.get('manufacturer') || '').trim(),
    filmName: (searchParams.get('filmName') || '').trim(),
    widthIn: width && Number.isFinite(Number(width)) && Number(width) > 0 ? width : '',
    initialFeet:
      initialFeet && Number.isFinite(Number(initialFeet)) && Number(initialFeet) > 0 ? initialFeet : '',
    notes: (searchParams.get('notes') || '').trim()
  };
}
