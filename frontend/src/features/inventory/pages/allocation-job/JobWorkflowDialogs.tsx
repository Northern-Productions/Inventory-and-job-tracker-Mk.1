import type { Dispatch, SetStateAction } from 'react';
import type {
  AllocationJobDetailEntry,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  CaulkProductEntry,
  FilmCatalogEntry,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobRequirementLine,
  Warehouse
} from '../../../../domain';
import { JobAllocateDialog } from '../../components/JobAllocateDialog';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../../components/JobEditorDialog';
import { LaborOnlyJobConfirmDialog } from '../../components/LaborOnlyJobConfirmDialog';
import { CaulkAllocationDialog } from './CaulkAllocationDialog';
import { CaulkCheckoutDialog } from './CaulkCheckoutDialog';
import { CaulkCheckinDialog } from './CaulkCheckinDialog';
import type {
  CaulkAllocationEditorState,
  CaulkCheckinDraft,
  CaulkCheckoutDraft
} from './types';

type JobWorkflowDialogsProps = {
  caulkAllocationEditor: CaulkAllocationEditorState | null;
  setCaulkAllocationEditor: Dispatch<SetStateAction<CaulkAllocationEditorState | null>>;
  caulkAllocationEditorError: string;
  setCaulkAllocationEditorError: Dispatch<SetStateAction<string>>;
  pendingCaulkMutation: boolean;
  caulkAllocationEditorPending?: boolean;
  caulkRequirements: JobCaulkRequirementLine[];
  caulkAllocations: CaulkJobAllocationEntry[];
  caulkProducts: CaulkProductEntry[];
  warehouseOptions: Warehouse[];
  onSubmitCaulkAllocation: () => void;
  caulkCheckoutDraft: CaulkCheckoutDraft | null;
  setCaulkCheckoutDraft: Dispatch<SetStateAction<CaulkCheckoutDraft | null>>;
  caulkCheckoutError: string;
  setCaulkCheckoutError: Dispatch<SetStateAction<string>>;
  checkoutCaulkAllocationPending: boolean;
  onSubmitCaulkCheckout: () => void;
  caulkCheckinDraft: CaulkCheckinDraft | null;
  setCaulkCheckinDraft: Dispatch<SetStateAction<CaulkCheckinDraft | null>>;
  caulkCheckinError: string;
  setCaulkCheckinError: Dispatch<SetStateAction<string>>;
  checkinCaulkAllocationPending: boolean;
  onSubmitCaulkCheckin: () => void;
  isEditOpen: boolean;
  editDraftOverride?: JobEditorSubmitPayload | null;
  jobNumber: string;
  warehouse: Warehouse;
  sections: string | null;
  installDate: string;
  crewLeader: string;
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  filmCatalogEntries: FilmCatalogEntry[] | undefined;
  filmCatalogLoading: boolean;
  filmCatalogError: unknown;
  caulkProductLoading: boolean;
  caulkProductError: unknown;
  updateJobPending: boolean;
  onCancelEdit: () => void;
  onSubmitEdit: (payload: JobEditorSubmitPayload) => void;
  pendingLaborOnlyUpdate: JobEditorSubmitPayload | null;
  onCancelLaborOnly: () => void;
  onConfirmLaborOnly: () => void;
  isAllocateOpen: boolean;
  isExtraFilmMode: boolean;
  onCancelAllocate: () => void;
};

export function JobWorkflowDialogs({
  caulkAllocationEditor,
  setCaulkAllocationEditor,
  caulkAllocationEditorError,
  setCaulkAllocationEditorError,
  pendingCaulkMutation,
  caulkAllocationEditorPending = pendingCaulkMutation,
  caulkRequirements,
  caulkAllocations,
  caulkProducts,
  warehouseOptions,
  onSubmitCaulkAllocation,
  caulkCheckoutDraft,
  setCaulkCheckoutDraft,
  caulkCheckoutError,
  setCaulkCheckoutError,
  checkoutCaulkAllocationPending,
  onSubmitCaulkCheckout,
  caulkCheckinDraft,
  setCaulkCheckinDraft,
  caulkCheckinError,
  setCaulkCheckinError,
  checkinCaulkAllocationPending,
  onSubmitCaulkCheckin,
  isEditOpen,
  editDraftOverride = null,
  jobNumber,
  warehouse,
  sections,
  installDate,
  crewLeader,
  requirements,
  filmOrders,
  filmCatalogEntries,
  filmCatalogLoading,
  filmCatalogError,
  caulkProductLoading,
  caulkProductError,
  updateJobPending,
  onCancelEdit,
  onSubmitEdit,
  pendingLaborOnlyUpdate,
  onCancelLaborOnly,
  onConfirmLaborOnly,
  isAllocateOpen,
  isExtraFilmMode,
  onCancelAllocate
}: JobWorkflowDialogsProps) {
  return (
    <>
      <CaulkAllocationDialog
        editor={caulkAllocationEditor}
        setEditor={setCaulkAllocationEditor}
        error={caulkAllocationEditorError}
        setError={setCaulkAllocationEditorError}
        pending={caulkAllocationEditorPending}
        caulkRequirements={caulkRequirements}
        caulkAllocations={caulkAllocations}
        caulkProducts={caulkProducts}
        warehouseOptions={warehouseOptions}
        onSubmit={onSubmitCaulkAllocation}
      />

      <CaulkCheckoutDialog
        draft={caulkCheckoutDraft}
        setDraft={setCaulkCheckoutDraft}
        error={caulkCheckoutError}
        setError={setCaulkCheckoutError}
        pending={checkoutCaulkAllocationPending}
        onSubmit={onSubmitCaulkCheckout}
      />

      <CaulkCheckinDialog
        draft={caulkCheckinDraft}
        setDraft={setCaulkCheckinDraft}
        error={caulkCheckinError}
        setError={setCaulkCheckinError}
        pending={checkinCaulkAllocationPending}
        onSubmit={onSubmitCaulkCheckin}
      />

      <JobEditorDialog
        open={isEditOpen}
        mode="edit"
        title={`Edit Job ${jobNumber}`}
        submitLabel="Save Job"
        submitting={updateJobPending}
        initialJobNumber={jobNumber}
        restoreDraft={editDraftOverride}
        initialWarehouse={warehouse}
        initialSections={sections}
        initialInstallDate={installDate}
        initialCrewLeader={crewLeader}
        initialRequirements={requirements}
        initialCaulkRequirements={caulkRequirements.map((entry) => ({
          requirementId: entry.requirementId,
          productId: entry.productId,
          requiredTubes: entry.requiredTubes
        }))}
        filmCatalogEntries={filmCatalogEntries}
        filmCatalogLoading={filmCatalogLoading}
        filmCatalogError={filmCatalogError}
        caulkProductEntries={caulkProducts}
        caulkProductLoading={caulkProductLoading}
        caulkProductError={caulkProductError}
        onCancel={onCancelEdit}
        onSubmit={onSubmitEdit}
      />
      <LaborOnlyJobConfirmDialog
        open={Boolean(pendingLaborOnlyUpdate)}
        jobNumber={pendingLaborOnlyUpdate?.jobNumber || jobNumber}
        pending={updateJobPending}
        onCancel={onCancelLaborOnly}
        onConfirmLaborOnly={onConfirmLaborOnly}
      />

      <JobAllocateDialog
        open={isAllocateOpen}
        jobNumber={jobNumber}
        warehouse={warehouse}
        installDate={installDate}
        crewLeader={crewLeader}
        requirements={requirements}
        filmOrders={filmOrders}
        isExtraFilmMode={isExtraFilmMode}
        onCancel={onCancelAllocate}
      />
    </>
  );
}
