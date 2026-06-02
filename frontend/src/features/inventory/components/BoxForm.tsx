import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import type { BoxDealerEntry, FilmCatalogEntry, Warehouse } from '../../../domain';
import type { BoxDraft } from '../utils/boxHelpers';
import { BoxIdentitySection } from './box-form/BoxIdentitySection';
import { CustomWidthDialog } from './box-form/CustomWidthDialog';
import { DatesAndCostingSection } from './box-form/DatesAndCostingSection';
import { DeleteBoxDialog } from './box-form/DeleteBoxDialog';
import { NotesSection } from './box-form/NotesSection';
import { RollTrackingSection } from './box-form/RollTrackingSection';
import { useBoxFormState } from './box-form/useBoxFormState';
import { useDeleteBoxDialog } from './box-form/useDeleteBoxDialog';
import { MissingDealerDialog } from './box-form/MissingDealerDialog';
import {
  applyDealerSelectValue,
  resolveDealerFieldState
} from './box-form/dealerFieldUtils';

export interface BoxFormSubmitContext {
  auditNote?: string;
}

const DEFAULT_NO_DEALER_REASON = 'No dealer for unknown reason.';

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
  dealerEntries?: BoxDealerEntry[];
  dealerLoading?: boolean;
  dealerError?: unknown;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onSubmit: (draft: BoxDraft, context?: BoxFormSubmitContext) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onTransferBox?: () => void;
  transferBoxDisabled?: boolean;
  transferBoxPending?: boolean;
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
  dealerEntries,
  dealerLoading = false,
  dealerError,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onSubmit,
  onCancel,
  onDelete,
  onTransferBox,
  transferBoxDisabled = false,
  transferBoxPending = false
}: BoxFormProps) {
  const {
    canCaptureReceivingDetails,
    closeCustomWidthDialog,
    customWidthDraft,
    dealerOptions,
    dealerSelectValue,
    draft,
    footageSectionCopy,
    handleBoxIdChange,
    handleCurrentFeetChange,
    handleDealerSelectChange,
    handleInitialFeetChange,
    handleLastRollWeightChange,
    handleWidthButtonClick,
    isCustomDealerSelected,
    isCustomManufacturerSelected,
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
    widthButtonValues,
    widthMode
  } = useBoxFormState({
    createWarehouse,
    dealerEntries,
    filmCatalogEntries,
    initialDraft,
    mode,
    nextBoxIdForCreateWarehouse,
    preserveInitialFeetInEdit,
    resetKey
  });
  const {
    closeDeleteDialog,
    deleteConfirmText,
    isDeleteBackdropClosing,
    isDeleteConfirmUnlocked,
    isDeleteDialogClosing,
    isDeleteDialogOpen,
    openDeleteDialog,
    resetDeleteDialog,
    setDeleteConfirmText
  } = useDeleteBoxDialog({ deleting });
  const [isMissingDealerDialogOpen, setIsMissingDealerDialogOpen] = useState(false);
  const [missingDealerDraft, setMissingDealerDraft] = useState('');
  const [missingDealerComment, setMissingDealerComment] = useState('');
  const [isAddingCustomMissingDealer, setIsAddingCustomMissingDealer] = useState(false);
  const missingDealerFieldState = resolveDealerFieldState(
    missingDealerDraft,
    dealerOptions,
    isAddingCustomMissingDealer
  );

  useEffect(() => {
    resetDeleteDialog();
  }, [initialDraft, resetDeleteDialog, resetKey]);

  useEffect(() => {
    setIsMissingDealerDialogOpen(false);
    setMissingDealerDraft('');
    setMissingDealerComment('');
    setIsAddingCustomMissingDealer(false);
  }, [initialDraft, resetKey]);

  function openMissingDealerDialog() {
    setMissingDealerDraft(draft.dealer);
    setMissingDealerComment('');
    setIsAddingCustomMissingDealer(isCustomDealerSelected);
    setIsMissingDealerDialogOpen(true);
  }

  function closeMissingDealerDialog() {
    setIsMissingDealerDialogOpen(false);
    setMissingDealerDraft('');
    setMissingDealerComment('');
    setIsAddingCustomMissingDealer(false);
  }

  function handleMissingDealerSelectChange(value: string) {
    const nextDealerSelection = applyDealerSelectValue(value, missingDealerDraft, dealerOptions);
    setIsAddingCustomMissingDealer(nextDealerSelection.isAddingCustomDealer);
    setMissingDealerDraft(nextDealerSelection.dealer);
  }

  function handleMissingDealerSubmit() {
    const normalizedDealer = missingDealerDraft.trim();
    if (normalizedDealer) {
      const nextDraft = normalizedDealer === draft.dealer ? draft : { ...draft, dealer: normalizedDealer };
      updateField('dealer', normalizedDealer);
      closeMissingDealerDialog();
      onSubmit(nextDraft);
      return;
    }

    closeMissingDealerDialog();
    onSubmit(draft, {
      auditNote: missingDealerComment.trim() || DEFAULT_NO_DEALER_REASON
    });
  }

  return (
    <>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) {
            return;
          }
          if (mode === 'create' && !draft.dealer.trim()) {
            openMissingDealerDialog();
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
          dealerHint={
            dealerLoading
              ? 'Loading shared dealer list...'
              : dealerError
                ? 'Dealer list could not be loaded. You can still type and save a dealer name.'
                : 'Select a saved dealer or add a new one.'
          }
          dealerOptions={dealerOptions}
          dealerSelectValue={dealerSelectValue}
          isCustomDealerSelected={isCustomDealerSelected}
          pricePerLfHint={pricePerLfHint}
          shouldAutoDerivePricePerLf={shouldAutoDerivePricePerLf}
          onDealerInputChange={(value) => updateField('dealer', value)}
          onDealerSelectChange={handleDealerSelectChange}
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
          {mode === 'edit' && onTransferBox ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onTransferBox}
              disabled={disabled || submitting || deleting || transferBoxDisabled || transferBoxPending}
            >
              Transfer Box
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
        onClose={closeCustomWidthDialog}
        onSave={saveCustomWidth}
      />
      <MissingDealerDialog
        open={isMissingDealerDialogOpen}
        dealerHint={
          dealerLoading
            ? 'Loading shared dealer list...'
            : dealerError
              ? 'Dealer list could not be loaded. You can still type a dealer name or explain why there is no dealer.'
              : undefined
        }
        dealerOptions={dealerOptions}
        dealerSelectValue={missingDealerFieldState.dealerSelectValue}
        dealerValue={missingDealerDraft}
        isCustomDealerSelected={missingDealerFieldState.isCustomDealerSelected}
        comment={missingDealerComment}
        submitting={submitting}
        onDealerInputChange={setMissingDealerDraft}
        onDealerSelectChange={handleMissingDealerSelectChange}
        onCommentChange={setMissingDealerComment}
        onCancel={closeMissingDealerDialog}
        onSubmit={handleMissingDealerSubmit}
      />
    </>
  );
}
