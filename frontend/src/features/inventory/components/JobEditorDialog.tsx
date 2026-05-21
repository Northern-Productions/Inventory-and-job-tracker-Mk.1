import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import type { CaulkProductEntry, FilmCatalogEntry, Warehouse } from '../../../domain';
import { JobBasicsSection } from './job-editor/JobBasicsSection';
import { JobCaulkRequirementsSection } from './job-editor/JobCaulkRequirementsSection';
import { JobCustomWidthDialog } from './job-editor/JobCustomWidthDialog';
import { JobFilmRequirementsSection } from './job-editor/JobFilmRequirementsSection';
import type {
  JobCaulkRequirementEditorLine,
  JobEditorSubmitPayload,
  JobPhaseEditorLine,
  JobRequirementEditorLine
} from './job-editor/types';
import {
  EMPTY_CAULK_REQUIREMENT_LINES,
  EMPTY_PHASE_LINES,
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
  restoreDraft?: JobEditorSubmitPayload | null;
  initialJobNumber?: string;
  initialWarehouse?: Warehouse;
  initialSections?: string | number | null;
  initialInstallDate?: string;
  initialCrewLeader?: string;
  initialPhases?: JobPhaseEditorLine[];
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
  restoreDraft = null,
  initialJobNumber = '',
  initialWarehouse = '',
  initialSections = null,
  initialInstallDate = '',
  initialCrewLeader = '',
  initialPhases = EMPTY_PHASE_LINES,
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
    installDate,
    error,
    filmName,
    addPhaseLine,
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
    phases,
    requiredFeet,
    removeCaulkRequirementLine,
    removeRequirementLine,
    requirements,
    saveCustomWidth,
    sections,
    selectedPhaseKey,
    setCaulkProductId,
    setCaulkRequiredTubes,
    setCrewLeader,
    setCustomWidthDraft,
    setInstallDate,
    setFilmName,
    setJobNumber,
    setManufacturer,
    setRequiredFeet,
    setSections,
    setSelectedPhaseKey,
    setWarehouse,
    updateCaulkRequirementLine,
    updatePhaseLine,
    updateRequirementLine,
    warehouse,
    widthIn
  } = useJobEditorForm({
    open,
    mode,
    restoreDraft,
    initialJobNumber,
    initialWarehouse,
    initialSections,
    initialInstallDate,
    initialCrewLeader,
    initialPhases,
    initialRequirements,
    initialCaulkRequirements,
    filmCatalogEntries,
    caulkProductEntries,
    onSubmit
  });

  if (!open) {
    return null;
  }

  const phaseOptions = phases.map((phase) => ({
    value: phase.id,
    label: `Phase ${phase.phaseNumber}${phase.sections ? ` — ${phase.sections}` : ''}`
  }));

  const selectedPhase = phases.find((phase) => phase.id === selectedPhaseKey) || phases[0] || null;
  const selectedPhaseRequirements = requirements.filter((line) => line.phaseKey === selectedPhaseKey);
  const selectedPhaseCaulkRequirements = caulkRequirements.filter((line) => line.phaseKey === selectedPhaseKey);

  function updateSelectedPhase(patch: Partial<JobPhaseEditorLine>) {
    if (!selectedPhase) {
      return;
    }
    updatePhaseLine(selectedPhase.id, patch);
    if (selectedPhase.isPrimary) {
      if (typeof patch.sections === 'string' || typeof patch.workScope === 'string') {
        const nextScope = String(patch.sections ?? patch.workScope ?? '');
        setSections(nextScope);
      }
      if (typeof patch.installDate === 'string') {
        setInstallDate(patch.installDate);
      }
      if (typeof patch.crewLeader === 'string') {
        setCrewLeader(patch.crewLeader);
      }
    }
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
          installDate={installDate}
          crewLeader={crewLeader}
          warehouse={warehouse}
          showPhaseFields={false}
          onJobNumberChange={setJobNumber}
          onWarehouseChange={setWarehouse}
          onClearError={clearError}
        />

        <section className="job-editor-section">
          <div className="dialog-section-header">
            <h3>Phase Details</h3>
          </div>

          <div className="job-editor-phase-selector-row">
            <label className="field">
              <span className="field-label">Phase to edit</span>
              <select
                className="field-input"
                value={selectedPhaseKey}
                onChange={(event) => {
                  setSelectedPhaseKey(event.target.value);
                  clearError();
                }}
              >
                {phaseOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="secondary" size="sm" onClick={addPhaseLine}>
              Add New Phase
            </Button>
          </div>

          {selectedPhase ? (
            <div className="job-editor-selected-phase-fields">
              <Input
                label="Phase Number"
                type="number"
                min="1"
                step="1"
                value={String(selectedPhase.phaseNumber)}
                onChange={(event) => {
                  updateSelectedPhase({ phaseNumber: event.target.value });
                  clearError();
                }}
              />
              <Input
                label="Work Scope"
                value={selectedPhase.sections}
                hint="Optional. Examples: Section 1, Sections 4, 5, Lobby."
                inputMode="text"
                onChange={(event) => {
                  updateSelectedPhase({
                    sections: event.target.value,
                    workScope: event.target.value
                  });
                  clearError();
                }}
              />
              <Input
                label="Install Date"
                type="date"
                value={selectedPhase.installDate}
                onChange={(event) => {
                  updateSelectedPhase({ installDate: event.target.value });
                  clearError();
                }}
              />
              <Input
                label="Install End Date"
                type="date"
                value={selectedPhase.installEndDate || ''}
                onChange={(event) => {
                  updateSelectedPhase({ installEndDate: event.target.value });
                  clearError();
                }}
              />
              <Input
                label="Crew Leader"
                value={selectedPhase.crewLeader}
                onChange={(event) => {
                  updateSelectedPhase({ crewLeader: event.target.value });
                  clearError();
                }}
              />
            </div>
          ) : null}
        </section>

        <JobFilmRequirementsSection
          manufacturerOptions={manufacturerOptions}
          manufacturer={manufacturer}
          filmName={filmName}
          widthIn={widthIn}
          requiredFeet={requiredFeet}
          requirements={selectedPhaseRequirements}
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
          caulkRequirements={selectedPhaseCaulkRequirements}
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
