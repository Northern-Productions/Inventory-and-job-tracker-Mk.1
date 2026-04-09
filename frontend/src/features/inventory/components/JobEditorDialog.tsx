import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import type { CaulkProductEntry, FilmCatalogEntry, Warehouse } from '../../../domain';
import { JobBasicsSection } from './job-editor/JobBasicsSection';
import { JobCaulkRequirementsSection } from './job-editor/JobCaulkRequirementsSection';
import { JobCustomWidthDialog } from './job-editor/JobCustomWidthDialog';
import { JobFilmRequirementsSection } from './job-editor/JobFilmRequirementsSection';
import type {
  JobCaulkRequirementEditorLine,
  JobEditorSubmitPayload,
  JobRequirementEditorLine
} from './job-editor/types';
import {
  EMPTY_CAULK_REQUIREMENT_LINES,
  EMPTY_REQUIREMENT_LINES
} from './job-editor/helpers';
import { useJobEditorForm } from './job-editor/useJobEditorForm';

export type {
  JobCaulkRequirementEditorLine,
  JobEditorSubmitPayload,
  JobRequirementEditorLine
} from './job-editor/types';

interface JobEditorDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  title: string;
  submitLabel: string;
  submitting?: boolean;
  initialJobNumber?: string;
  initialWarehouse?: Warehouse;
  initialSections?: string | number | null;
  initialDueDate?: string;
  initialCrewLeader?: string;
  initialRequirements?: JobRequirementEditorLine[];
  initialCaulkRequirements?: JobCaulkRequirementEditorLine[];
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  caulkProductEntries?: CaulkProductEntry[];
  caulkProductLoading?: boolean;
  caulkProductError?: unknown;
  onCancel: () => void;
  onSubmit: (payload: JobEditorSubmitPayload) => void;
}

export function JobEditorDialog({
  open,
  mode,
  title,
  submitLabel,
  submitting = false,
  initialJobNumber = '',
  initialWarehouse = '',
  initialSections = null,
  initialDueDate = '',
  initialCrewLeader = '',
  initialRequirements = EMPTY_REQUIREMENT_LINES,
  initialCaulkRequirements = EMPTY_CAULK_REQUIREMENT_LINES,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  caulkProductEntries = [],
  caulkProductLoading = false,
  caulkProductError,
  onCancel,
  onSubmit
}: JobEditorDialogProps) {
  const {
    caulkProductId,
    caulkProductLabelById,
    caulkProductOptions,
    caulkRequiredTubes,
    caulkRequirements,
    clearError,
    closeCustomWidth,
    crewLeader,
    customWidthDraft,
    dueDate,
    error,
    filmName,
    handleAddCaulkRequirement,
    handleAddRequirement,
    handleSave,
    handleWidthButtonClick,
    hasCustomWidth,
    isCustomWidthOpen,
    isCustomWidthValid,
    jobNumber,
    manufacturer,
    manufacturerOptions,
    requiredFeet,
    removeCaulkRequirementLine,
    removeRequirementLine,
    requirements,
    saveCustomWidth,
    sections,
    setCaulkProductId,
    setCaulkRequiredTubes,
    setCrewLeader,
    setCustomWidthDraft,
    setDueDate,
    setFilmName,
    setJobNumber,
    setManufacturer,
    setRequiredFeet,
    setSections,
    setWarehouse,
    updateCaulkRequirementLine,
    updateRequirementLine,
    warehouse,
    widthIn
  } = useJobEditorForm({
    open,
    mode,
    initialJobNumber,
    initialWarehouse,
    initialSections,
    initialDueDate,
    initialCrewLeader,
    initialRequirements,
    initialCaulkRequirements,
    filmCatalogEntries,
    caulkProductEntries,
    onSubmit
  });

  if (!open) {
    return null;
  }

  return (
    <>
      <DialogSurface
        open={open}
        onClose={onCancel}
        className="dialog-job-editor"
        titleId="job-editor-title"
      >
        <div className="dialog-header">
          <h2 id="job-editor-title">{title}</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close job editor dialog"
            onClick={onCancel}
          >
            x
          </button>
        </div>

        <div className="dialog-copy">
          <p>
            Set the core job details first, then add any film and caulk requirements the crew
            should pull against.
          </p>
        </div>

        <JobBasicsSection
          mode={mode}
          jobNumber={jobNumber}
          sections={sections}
          dueDate={dueDate}
          crewLeader={crewLeader}
          warehouse={warehouse}
          onJobNumberChange={setJobNumber}
          onSectionsChange={setSections}
          onDueDateChange={setDueDate}
          onCrewLeaderChange={setCrewLeader}
          onWarehouseChange={setWarehouse}
          onClearError={clearError}
        />

        <JobFilmRequirementsSection
          manufacturerOptions={manufacturerOptions}
          manufacturer={manufacturer}
          filmName={filmName}
          widthIn={widthIn}
          requiredFeet={requiredFeet}
          requirements={requirements}
          filmCatalogEntries={filmCatalogEntries}
          filmCatalogLoading={filmCatalogLoading}
          filmCatalogError={filmCatalogError}
          submitting={submitting}
          hasCustomWidth={hasCustomWidth}
          onManufacturerChange={setManufacturer}
          onFilmNameChange={setFilmName}
          onWidthButtonClick={handleWidthButtonClick}
          onRequiredFeetChange={setRequiredFeet}
          onAddRequirement={handleAddRequirement}
          onUpdateRequirementLine={updateRequirementLine}
          onRemoveRequirementLine={removeRequirementLine}
          onClearError={clearError}
        />

        <JobCaulkRequirementsSection
          caulkProductOptions={caulkProductOptions}
          caulkProductLabelById={caulkProductLabelById}
          caulkProductId={caulkProductId}
          caulkRequiredTubes={caulkRequiredTubes}
          caulkRequirements={caulkRequirements}
          caulkProductLoading={caulkProductLoading}
          caulkProductError={caulkProductError}
          submitting={submitting}
          onCaulkProductChange={setCaulkProductId}
          onCaulkRequiredTubesChange={setCaulkRequiredTubes}
          onAddCaulkRequirement={handleAddCaulkRequirement}
          onUpdateCaulkRequirementLine={updateCaulkRequirementLine}
          onRemoveCaulkRequirementLine={removeCaulkRequirementLine}
          onClearError={clearError}
        />

        {error ? <p className="error-text">{error}</p> : null}

        <div className="dialog-actions dialog-actions-sticky-footer">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            fullWidth
            onClick={handleSave}
            disabled={submitting}
          >
            {submitting ? 'Saving...' : submitLabel}
          </Button>
        </div>
      </DialogSurface>

      <JobCustomWidthDialog
        open={isCustomWidthOpen}
        customWidthDraft={customWidthDraft}
        isCustomWidthValid={isCustomWidthValid}
        onClose={closeCustomWidth}
        onDraftChange={setCustomWidthDraft}
        onSave={saveCustomWidth}
      />
    </>
  );
}
