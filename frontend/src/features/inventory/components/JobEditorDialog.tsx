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
    label: `Phase ${phase.phaseNumber}${phase.sections ? ` - ${phase.sections}` : ''}`
  }));
  const primaryPhase = phases.find((phase) => phase.isPrimary) || phases[0];

  function handleSectionsChange(value: string) {
    setSections(value);
    if (primaryPhase) {
      updatePhaseLine(primaryPhase.id, { sections: value, workScope: value });
    }
  }

  function handleInstallDateChange(value: string) {
    setInstallDate(value);
    if (primaryPhase) {
      updatePhaseLine(primaryPhase.id, { installDate: value });
    }
  }

  function handleCrewLeaderChange(value: string) {
    setCrewLeader(value);
    if (primaryPhase) {
      updatePhaseLine(primaryPhase.id, { crewLeader: value });
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
          onJobNumberChange={setJobNumber}
          onSectionsChange={handleSectionsChange}
          onInstallDateChange={handleInstallDateChange}
          onCrewLeaderChange={handleCrewLeaderChange}
          onWarehouseChange={setWarehouse}
          onClearError={clearError}
        />

        <section className="job-editor-section">
          <div className="panel-title-row">
            <h3>Phases</h3>
            <Button type="button" variant="secondary" size="sm" onClick={addPhaseLine}>
              Add New Phase
            </Button>
          </div>
          <div className="job-editor-phase-list">
            {phases.map((phase, index) => (
              <div className="job-editor-phase-row" key={phase.id}>
                <label>
                  <span>Phase</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={phase.phaseNumber}
                    onChange={(event) =>
                      updatePhaseLine(phase.id, {
                        phaseNumber: event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  <span>Work Scope</span>
                  <input
                    value={phase.sections}
                    onChange={(event) =>
                      updatePhaseLine(phase.id, {
                        sections: event.target.value,
                        workScope: event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  <span>Install Date</span>
                  <input
                    type="date"
                    value={phase.installDate}
                    onChange={(event) => updatePhaseLine(phase.id, { installDate: event.target.value })}
                  />
                </label>
                <label>
                  <span>Crew Leader</span>
                  <input
                    value={phase.crewLeader}
                    onChange={(event) => updatePhaseLine(phase.id, { crewLeader: event.target.value })}
                  />
                </label>
              </div>
            ))}
          </div>
          <label className="field">
            <span>Add requirements to phase</span>
            <select value={selectedPhaseKey} onChange={(event) => setSelectedPhaseKey(event.target.value)}>
              {phaseOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </section>

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
