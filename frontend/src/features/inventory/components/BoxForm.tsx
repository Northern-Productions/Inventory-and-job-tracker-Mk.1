import { useEffect } from 'react';
import { Button } from '../../../components/Button';
import type { FilmCatalogEntry, Warehouse } from '../../../domain';
import type { BoxDraft } from '../utils/boxHelpers';
import { BoxIdentitySection } from './box-form/BoxIdentitySection';
import { CustomWidthDialog } from './box-form/CustomWidthDialog';
import { DatesAndCostingSection } from './box-form/DatesAndCostingSection';
import { DeleteBoxDialog } from './box-form/DeleteBoxDialog';
import { NotesSection } from './box-form/NotesSection';
import { RollTrackingSection } from './box-form/RollTrackingSection';
import { useBoxFormState } from './box-form/useBoxFormState';
import { useDeleteBoxDialog } from './box-form/useDeleteBoxDialog';

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
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onSubmit: (draft: BoxDraft) => void;
  onCancel?: () => void;
  onDelete?: () => void;
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
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onSubmit,
  onCancel,
  onDelete
}: BoxFormProps) {
  const {
    canCaptureReceivingDetails,
    closeCustomWidthDialog,
    customWidthDraft,
    draft,
    footageSectionCopy,
    handleBoxIdChange,
    handleCurrentFeetChange,
    handleInitialFeetChange,
    handleLastRollWeightChange,
    handleWidthButtonClick,
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

  useEffect(() => {
    resetDeleteDialog();
  }, [initialDraft, resetDeleteDialog, resetKey]);

  return (
    <>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) {
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
          pricePerLfHint={pricePerLfHint}
          shouldAutoDerivePricePerLf={shouldAutoDerivePricePerLf}
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
    </>
  );
}
