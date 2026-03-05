import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { APIError } from '../../../api/http';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { LoadingState } from '../../../components/LoadingState';
import { useToast } from '../../../components/Toast';
import type { Box, SetBoxStatusPayload, UpdateBoxPayload } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { useAuth } from '../../auth/AuthContext';
import { AllocateDialog } from '../components/AllocateDialog';
import { AllocationsPanel } from '../components/AllocationsPanel';
import { BoxForm } from '../components/BoxForm';
import { HistoryPanel } from '../components/HistoryPanel';
import { RollHistoryPanel } from '../components/RollHistoryPanel';
import {
  useBoxAllocations,
  useBox,
  useSetBoxStatus,
  useUndoAudit,
  useUpdateBox
} from '../hooks/useInventoryQueries';
import { parseUpdateBoxDraft } from '../schemas/boxSchemas';
import {
  addManufacturerOption,
  createDraftFromBox,
  deriveFeetAvailableFromRollWeight,
  getActiveAllocatedFeet,
  getRiskyFieldChanges,
  shouldAutoMoveToZeroed,
  type BoxDraft
} from '../utils/boxHelpers';
import {
  confirmWarnings,
  getAddOrEditWarnings,
  getCheckInWarnings,
  getCheckoutWarnings
} from '../utils/boxWarnings';

type ConfirmState =
  | {
      type: 'update';
      payload: UpdateBoxPayload;
      message: string;
    }
  | {
      type: 'checkout';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | {
      type: 'checkin';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | null;

function DetailField({
  label,
  value,
  labelClassName = ''
}: {
  label: string;
  value: string | number | null;
  labelClassName?: string;
}) {
  return (
    <div className="key-value">
      <dt className={labelClassName}>{label}</dt>
      <dd>{value === '' || value === null ? '--' : value}</dd>
    </div>
  );
}

function createStatusConfirmState(
  boxId: string,
  status: SetBoxStatusPayload['status'],
  message: string
): Exclude<ConfirmState, { type: 'update' } | null> {
  return {
    type: status === 'CHECKED_OUT' ? 'checkout' : 'checkin',
    payload: {
      boxId,
      status
    },
    message
  };
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const didCopy = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!didCopy) {
    throw new Error('Clipboard access is not available.');
  }
}

async function createBlobFromDataUrl(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

export default function BoxDetailsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const boxId = decodeURIComponent(params.boxId || '');
  const boxQuery = useBox(boxId);
  const updateMutation = useUpdateBox();
  const statusMutation = useSetBoxStatus();
  const undoMutation = useUndoAudit();
  const allocationsQuery = useBoxAllocations(boxId);
  const [isEditing, setIsEditing] = useState(false);
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [isQrSectionOpen, setIsQrSectionOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [qrCodeError, setQrCodeError] = useState('');
  const didHandleScanCheckIn = useRef(false);

  const box = boxQuery.data;
  const activeAllocatedFeet = getActiveAllocatedFeet(allocationsQuery.data || []);
  const checkoutJobOptions = useMemo(() => {
    const activeAllocations = (allocationsQuery.data || [])
      .filter((entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim())
      .slice()
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();

        if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
          return 0;
        }

        if (Number.isNaN(leftTime)) {
          return 1;
        }

        if (Number.isNaN(rightTime)) {
          return -1;
        }

        return leftTime - rightTime;
      });
    const seenJobNumbers = new Set<string>();

    return activeAllocations.reduce<Array<{ label: string; value: string }>>((options, entry) => {
      const jobNumber = entry.jobNumber.trim();
      if (seenJobNumbers.has(jobNumber)) {
        return options;
      }

      seenJobNumbers.add(jobNumber);
      options.push({
        label: jobNumber,
        value: jobNumber
      });
      return options;
    }, []);
  }, [allocationsQuery.data]);
  const initialDraft = useMemo(
    () => (box ? createDraftFromBox(box) : createDraftFromBox(createFallbackBox(boxId))),
    [box, boxId]
  );

  function ensureSignedIn(actionLabel: string) {
    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before trying to change inventory.',
        variant: 'error'
      });
      return false;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: `Sign in with Google before you ${actionLabel}.`,
        variant: 'error'
      });
      return false;
    }

    return true;
  }

  useEffect(() => {
    let isActive = true;

    if (!box?.boxId) {
      setQrCodeDataUrl('');
      setQrCodeError('');
      return () => {
        isActive = false;
      };
    }

    setQrCodeDataUrl('');
    setQrCodeError('');

    void QRCode.toDataURL(box.boxId, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: {
        dark: '#12343b',
        light: '#ffffffff'
      }
    })
      .then((nextDataUrl: string) => {
        if (!isActive) {
          return;
        }

        setQrCodeDataUrl(nextDataUrl);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setQrCodeError('The QR image could not be generated. You can still copy the BoxID text.');
      });

    return () => {
      isActive = false;
    };
  }, [box?.boxId]);

  async function handleCopyQrCode() {
    if (!box) {
      return;
    }

    try {
      await copyTextToClipboard(box.boxId);
      toast.push({
        title: 'QR code copied',
        description: `${box.boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      toast.push({
        title: 'Copy failed',
        description: 'Clipboard access is unavailable. Copy the BoxID manually from the QR code section.',
        variant: 'error'
      });
    }
  }

  async function handleCopyQrImage() {
    if (!box || !qrCodeDataUrl) {
      return;
    }

    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      toast.push({
        title: 'Image copy is not supported',
        description: 'Use Download QR PNG or Copy QR Code on this device/browser.',
        variant: 'error'
      });
      return;
    }

    try {
      const imageBlob = await createBlobFromDataUrl(qrCodeDataUrl);
      await navigator.clipboard.write([
        new ClipboardItem({
          [imageBlob.type]: imageBlob
        })
      ]);

      toast.push({
        title: 'QR image copied',
        description: `${box.boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      toast.push({
        title: 'Image copy failed',
        description: 'Use Download QR PNG or Copy QR Code instead.',
        variant: 'error'
      });
    }
  }

  function handleDownloadQrImage() {
    if (!box || !qrCodeDataUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = qrCodeDataUrl;
    link.download = `${box.boxId}-qr.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function pushUndoToast(
    logId: string,
    title: string,
    boxIdValue: string,
    warnings: string[],
    successDescription = `${boxIdValue} was saved successfully.`
  ) {
    toast.push({
      title,
      description: warnings.join(' ') || successDescription,
      actionLabel: 'Undo',
      onAction: async () => {
        try {
          const undone = await undoMutation.mutateAsync({
            logId,
            reason: 'Undo from success toast'
          });

          toast.push({
            title: 'Undo completed',
            description: undone.warnings.join(' ') || `${boxIdValue} was reverted.`,
            variant: 'success'
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
  }

  async function submitUpdate(payload: UpdateBoxPayload) {
    try {
      const { result, warnings } = await updateMutation.mutateAsync(payload);
      addManufacturerOption(result.box.manufacturer);
      setIsEditing(false);

      const didMoveToZeroed = result.box.status === 'ZEROED';
      const successTitle = didMoveToZeroed ? 'Moved to zeroed out inventory' : 'Box updated';
      const successDescription = didMoveToZeroed
        ? `${result.box.boxId} was moved to zeroed out inventory.`
        : undefined;

      await pushUndoToast(result.logId, successTitle, result.box.boxId, warnings, successDescription);

      if (didMoveToZeroed) {
        navigate('/');
      }
    } catch (error) {
      const expectsZeroedMove = shouldAutoMoveToZeroed(
        payload.receivedDate,
        box?.feetAvailable ?? 0,
        payload.feetAvailable,
        payload.lastRollWeightLbs ?? null
      );

      toast.push({
        title: expectsZeroedMove ? 'Move failed' : 'Update failed',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : expectsZeroedMove
              ? 'The box could not be moved to zeroed out inventory.'
              : 'The update could not be completed.',
        variant: 'error'
      });
    }
  }

  async function runStandardUpdateFlow(payload: UpdateBoxPayload) {
    const addOrEditWarnings = getAddOrEditWarnings(payload, box);
    if (!confirmWarnings(addOrEditWarnings)) {
      return;
    }

    if (
      shouldAutoMoveToZeroed(
        payload.receivedDate,
        box?.feetAvailable ?? 0,
        payload.feetAvailable,
        payload.lastRollWeightLbs ?? null
      )
    ) {
      payload.auditNote = 'Auto-moved to zeroed out inventory';
      await submitUpdate(payload);
      return;
    }

    const riskyFields = box ? getRiskyFieldChanges(box, payload) : [];
    if (riskyFields.length > 0) {
      setConfirmState({
        type: 'update',
        payload,
        message: `This change affects ${riskyFields.join(', ')}. A reason is required.`
      });
      return;
    }

    payload.auditNote = 'Inventory metadata update';
    await submitUpdate(payload);
  }

  async function handleEditSubmit(draft: BoxDraft) {
    if (!ensureSignedIn('save box changes')) {
      return;
    }

    try {
      const payload = parseUpdateBoxDraft(draft);
      await runStandardUpdateFlow(payload);
    } catch (error) {
      toast.push({
        title: 'Validation failed',
        description:
          error instanceof Error ? error.message : 'Review the form values and try again.',
        variant: 'error'
      });
    }
  }

  async function handleStatusChange(status: SetBoxStatusPayload['status']) {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('change box status')) {
      return;
    }

    if (status === 'CHECKED_OUT') {
      const checkoutMessage =
        checkoutJobOptions.length > 0
          ? "Select one of this box's active allocated jobs, or choose Enter New Job Number if this checkout is for something else."
          : 'Enter the job number for this checkout. It will be saved in the box history.';

      setConfirmState(
        createStatusConfirmState(box.boxId, status, checkoutMessage)
      );
      return;
    }

    setConfirmState(
      createStatusConfirmState(
        box.boxId,
        status,
        'Enter the latest roll weight in pounds to complete the check-in.'
      )
    );
  }

  function handleCancelConfirm() {
    setConfirmState(null);
  }

  async function handleConfirm(reason: string) {
    if (!confirmState) {
      return;
    }

    if (confirmState.type === 'update') {
      const payload = {
        ...confirmState.payload,
        auditNote: reason
      };

      setConfirmState(null);
      await submitUpdate(payload);
      return;
    }

    if (!box) {
      setConfirmState(null);
      return;
    }

    if (confirmState.type === 'checkout') {
      const warnings = getCheckoutWarnings(box);
      if (!confirmWarnings(warnings)) {
        return;
      }

      const payload = {
        ...confirmState.payload,
        auditNote: `Checked out for job ${reason}`
      };

      try {
        setConfirmState(null);
        const { result, warnings: responseWarnings } = await statusMutation.mutateAsync(payload);
        await pushUndoToast(result.logId, 'Box checked out', result.box.boxId, responseWarnings);
      } catch (error) {
        toast.push({
          title: 'Status change failed',
          description:
            error instanceof Error ? error.message : 'The status update could not be completed.',
          variant: 'error'
        });
      }

      return;
    }

    const parsedWeight = Number(reason);
    if (!Number.isFinite(parsedWeight) || parsedWeight < 0) {
      toast.push({
        title: 'Roll weight required',
        description: 'Enter a valid non-negative roll weight in pounds before checking the box in.',
        variant: 'error'
      });
      return;
    }

    const checkInWarnings = getCheckInWarnings(box, parsedWeight);
    if (!confirmWarnings(checkInWarnings)) {
      return;
    }

    const payload = {
      ...confirmState.payload,
      lastRollWeightLbs: parsedWeight,
      auditNote: `Checked in at ${parsedWeight} lbs`
    };

    try {
      setConfirmState(null);

      const { result, warnings } = await statusMutation.mutateAsync(payload);
      const returnedBox = result.box;
      const didPersistWeight = returnedBox.lastRollWeightLbs === parsedWeight;
      const didPersistFeet =
        returnedBox.coreWeightLbs !== null && returnedBox.lfWeightLbsPerFt !== null
          ? returnedBox.feetAvailable <=
            deriveFeetAvailableFromRollWeight(
              parsedWeight,
              returnedBox.coreWeightLbs,
              returnedBox.lfWeightLbsPerFt,
              returnedBox.initialFeet
            )
          : true;

      if (!didPersistWeight || !didPersistFeet) {
        toast.push({
          title: 'Check-in did not apply the new roll weight',
          description:
            'The backend responded without saving the submitted weight. Repaste the latest Apps Script files and redeploy, then try the check-in again.',
          variant: 'error'
        });
        return;
      }

      const didMoveToZeroed = result.box.status === 'ZEROED';
      await pushUndoToast(
        result.logId,
        didMoveToZeroed ? 'Moved to zeroed out inventory' : 'Box checked in',
        result.box.boxId,
        warnings,
        didMoveToZeroed ? `${result.box.boxId} was moved to zeroed out inventory.` : undefined
      );

      if (didMoveToZeroed) {
        navigate('/');
      }
    } catch (error) {
      toast.push({
        title: 'Status change failed',
        description:
          error instanceof Error ? error.message : 'The status update could not be completed.',
        variant: 'error'
      });
    }
  }

  useEffect(() => {
    if (searchParams.get('scanAction') !== 'checkin' || didHandleScanCheckIn.current || !box) {
      return;
    }

    didHandleScanCheckIn.current = true;

    if (box.status === 'CHECKED_OUT') {
      void handleStatusChange('IN_STOCK');
    }
  }, [box, searchParams]);

  if (boxQuery.isLoading) {
    return <LoadingState label="Loading box details..." />;
  }

  if (boxQuery.isError || !box) {
    return (
      <section className="panel">
        <p className="error-text">{boxQuery.error?.message || 'Box not found.'}</p>
        <Button type="button" variant="ghost" onClick={() => navigate('/')}>
          Back to Inventory
        </Button>
      </section>
    );
  }

  return (
    <>
      {isEditing ? (
        <BoxForm
          initialDraft={initialDraft}
          resetKey={`${box.boxId}-${box.status}`}
          mode="edit"
          submitLabel="Save Changes"
          submitting={updateMutation.isPending}
          onSubmit={handleEditSubmit}
          onCancel={() => setIsEditing(false)}
        />
      ) : null}

      <section className="panel">
        <div className="panel-title-row detail-title-row">
          <div>
            <h2>{box.boxId}</h2>
            <p className="warehouse-pill">
              {box.warehouse === 'IL' ? 'Illinois' : 'Mississippi'} warehouse
            </p>
          </div>
          <div className="detail-actions">
            <span className={`badge badge-${box.status}`}>{box.status}</span>
            {!isEditing ? (
              <Button
                type="button"
                onClick={() => setIsEditing(true)}
                disabled={
                  box.status === 'ZEROED' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured
                }
              >
                Edit
              </Button>
            ) : null}
          </div>
        </div>

        <div className="detail-grid">
          <DetailField label="Manufacturer" value={box.manufacturer} />
          <DetailField label="Film Name" value={box.filmName} />
          <DetailField
            label="Width"
            value={box.widthIn}
            labelClassName="detail-label-pill detail-label-pill-orange"
          />
          <DetailField label="Initial Feet" value={box.initialFeet} />
          <DetailField
            label="Available Feet"
            value={box.feetAvailable}
            labelClassName="detail-label-pill detail-label-pill-green"
          />
          <DetailField
            label="Allocated Feet"
            value={allocationsQuery.isLoading ? '...' : activeAllocatedFeet}
            labelClassName="detail-label-pill detail-label-pill-red"
          />
          <DetailField label="Lot Run" value={box.lotRun} />
          <DetailField label="Order Date" value={formatDate(box.orderDate)} />
          <DetailField label="Received Date" value={formatDate(box.receivedDate)} />
          <DetailField label="Initial Weight" value={box.initialWeightLbs} />
          <DetailField label="Last Roll Weight" value={box.lastRollWeightLbs} />
          <DetailField label="Last Weighed Date" value={formatDate(box.lastWeighedDate)} />
          <DetailField label="Core Type" value={box.coreType} />
          <DetailField label="Core Weight" value={box.coreWeightLbs} />
          <DetailField label="LF Weight / Ft" value={box.lfWeightLbsPerFt} />
          <DetailField label="Purchase Cost" value={box.purchaseCost} />
          <DetailField label="Last Checkout Job" value={box.lastCheckoutJob} />
          <DetailField label="Last Checkout Date" value={formatDate(box.lastCheckoutDate)} />
          <DetailField label="Zeroed Date" value={formatDate(box.zeroedDate)} />
          <DetailField label="Zeroed Reason" value={box.zeroedReason} />
          <DetailField label="Zeroed By" value={box.zeroedBy} />
          <DetailField label="Notes" value={box.notes} />
        </div>

        <div className={`qr-code-card ${isQrSectionOpen ? 'qr-code-card-open' : 'qr-code-card-closed'}`}>
          <button
            type="button"
            className="qr-code-toggle"
            onClick={() => setIsQrSectionOpen((current) => !current)}
            aria-expanded={isQrSectionOpen}
          >
            <span className="qr-code-toggle-label">QR Code</span>
            <span className="qr-code-toggle-symbol" aria-hidden="true">
              {isQrSectionOpen ? '-' : '+'}
            </span>
          </button>
          <div
            className={`qr-code-card-body ${isQrSectionOpen ? 'qr-code-card-body-open' : 'qr-code-card-body-closed'}`}
            aria-hidden={!isQrSectionOpen}
          >
            <div className="qr-code-preview">
              {qrCodeDataUrl ? (
                <img
                  src={qrCodeDataUrl}
                  alt={`QR code for box ${box.boxId}`}
                  className="qr-code-image"
                />
              ) : (
                <div className="qr-code-placeholder">
                  {qrCodeError ? 'QR unavailable' : 'Generating QR...'}
                </div>
              )}
            </div>
            <div className="qr-code-meta">
              <p className="muted-text">
                Copy the image for supported label software, download a PNG, or copy the raw BoxID
                text. The QR contains only the BoxID.
              </p>
              <div className="qr-code-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCopyQrImage()}
                  disabled={!qrCodeDataUrl || !isQrSectionOpen}
                >
                  Copy QR Image
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDownloadQrImage}
                  disabled={!qrCodeDataUrl || !isQrSectionOpen}
                >
                  Download QR PNG
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleCopyQrCode()}
                  disabled={!isQrSectionOpen}
                >
                  Copy QR Code
                </Button>
              </div>
              <p className="qr-code-value">{box.boxId}</p>
              {qrCodeError ? <p className="error-text">{qrCodeError}</p> : null}
            </div>
          </div>
        </div>

        {!isEditing ? (
          <>
            {!auth.isAuthenticated ? (
              <p className="muted-text">Sign in with Google in the header before making changes.</p>
            ) : null}

            <div className="page-actions detail-status-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleStatusChange('IN_STOCK')}
                disabled={
                  statusMutation.isPending ||
                  box.status === 'ORDERED' ||
                  box.status === 'IN_STOCK' ||
                  box.status === 'ZEROED' ||
                  box.status === 'RETIRED' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured
                }
              >
                Check In
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsAllocateOpen(true)}
                disabled={
                  statusMutation.isPending ||
                  box.status !== 'IN_STOCK' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  box.feetAvailable <= 0
                }
              >
                Allocate
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleStatusChange('CHECKED_OUT')}
                disabled={
                  statusMutation.isPending ||
                  box.status === 'ORDERED' ||
                  box.status === 'CHECKED_OUT' ||
                  box.status === 'ZEROED' ||
                  box.status === 'RETIRED' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured
                }
              >
                Check Out
              </Button>
            </div>
          </>
        ) : null}
      </section>

      <AllocationsPanel boxId={box.boxId} feetAvailable={box.feetAvailable} />
      <HistoryPanel boxId={box.boxId} />
      <RollHistoryPanel boxId={box.boxId} />

      <AllocateDialog
        open={isAllocateOpen}
        box={box}
        onCancel={() => setIsAllocateOpen(false)}
      />
      <ConfirmDialog
        open={Boolean(confirmState)}
        title={
          confirmState?.type === 'checkout'
            ? 'Check Out Box'
            : confirmState?.type === 'checkin'
              ? 'Check In Box'
              : 'Confirm Risky Edit'
        }
        message={confirmState?.message || ''}
        confirmLabel={
          confirmState?.type === 'checkout'
            ? 'Check Out'
            : confirmState?.type === 'checkin'
              ? 'Check In'
              : 'Confirm Save'
        }
        cancelLabel="Cancel"
        requireReason={
          confirmState?.type === 'update' ||
          confirmState?.type === 'checkout' ||
          confirmState?.type === 'checkin'
        }
        reasonLabel={
          confirmState?.type === 'checkout'
            ? checkoutJobOptions.length > 0
              ? 'Allocated Job'
              : 'Job Number'
            : confirmState?.type === 'checkin'
              ? 'Roll Weight (lbs)'
              : 'Reason'
        }
        reasonPlaceholder={
          confirmState?.type === 'checkout' ? 'Numbers only' : 'Required'
        }
        reasonField={
          confirmState?.type === 'update'
            ? 'textarea'
            : confirmState?.type === 'checkout' || confirmState?.type === 'checkin'
              ? 'input'
              : 'textarea'
        }
        reasonInputType={
          confirmState?.type === 'checkin'
            ? 'number'
            : confirmState?.type === 'checkout'
              ? 'text'
              : 'text'
        }
        reasonInputStep={confirmState?.type === 'checkin' ? '0.01' : undefined}
        reasonInputMin={confirmState?.type === 'checkin' ? '0' : undefined}
        reasonInputMode={confirmState?.type === 'checkout' ? 'numeric' : undefined}
        reasonInputPattern={confirmState?.type === 'checkout' ? '[0-9]*' : undefined}
        reasonDigitsOnly={confirmState?.type === 'checkout'}
        reasonOptions={
          confirmState?.type === 'checkout' && checkoutJobOptions.length > 0
            ? checkoutJobOptions
            : undefined
        }
        reasonSelectLabel={confirmState?.type === 'checkout' ? 'Allocated Job' : undefined}
        reasonAllowCustomOption={
          confirmState?.type === 'checkout' && checkoutJobOptions.length > 0
        }
        reasonCustomOptionLabel="Enter New Job Number"
        customReasonLabel={confirmState?.type === 'checkout' ? 'New Job Number' : undefined}
        onCancel={handleCancelConfirm}
        onConfirm={(reason) => void handleConfirm(reason)}
      />
    </>
  );
}

function createFallbackBox(boxId: string): Box {
  return {
    boxId,
    warehouse: boxId.startsWith('M') ? 'MS' : 'IL',
    manufacturer: '',
    filmName: '',
    widthIn: 36,
    initialFeet: 0,
    feetAvailable: 0,
    lotRun: '',
    status: 'ORDERED',
    orderDate: '',
    receivedDate: '',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}
