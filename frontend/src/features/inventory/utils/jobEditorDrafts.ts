export interface PendingJobEditorDrafts {
  hasPendingFilmRequirementDraft: boolean;
  hasPendingCaulkRequirementDraft: boolean;
}

function hasMeaningfulValue(value: string) {
  return value.trim() !== '';
}

export function getPendingJobEditorDrafts(input: {
  filmName: string;
  widthIn: string;
  requiredFeet: string;
  caulkRequiredTubes: string;
}): PendingJobEditorDrafts {
  const hasPendingFilmRequirementDraft =
    hasMeaningfulValue(input.filmName) ||
    hasMeaningfulValue(input.widthIn) ||
    hasMeaningfulValue(input.requiredFeet);
  const hasPendingCaulkRequirementDraft = hasMeaningfulValue(input.caulkRequiredTubes);

  return {
    hasPendingFilmRequirementDraft,
    hasPendingCaulkRequirementDraft
  };
}

export function buildPendingJobEditorDraftMessage(pendingDrafts: PendingJobEditorDrafts) {
  if (pendingDrafts.hasPendingFilmRequirementDraft && pendingDrafts.hasPendingCaulkRequirementDraft) {
    return 'Add or clear the pending film and caulk requirement drafts before saving.';
  }

  if (pendingDrafts.hasPendingFilmRequirementDraft) {
    return 'Add or clear the pending film requirement draft before saving.';
  }

  if (pendingDrafts.hasPendingCaulkRequirementDraft) {
    return 'Add or clear the pending caulk requirement draft before saving.';
  }

  return '';
}
