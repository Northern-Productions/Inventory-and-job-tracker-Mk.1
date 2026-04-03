interface JobMaterialSelection {
  requirements?: Array<{ requiredFeet?: number | string | null }>;
  caulkRequirements?: Array<{ requiredTubes?: number | string | null }>;
}

export function hasJobMaterialRequirements(selection: JobMaterialSelection): boolean {
  return (
    (selection.requirements || []).some((entry) => Number(entry.requiredFeet || 0) > 0) ||
    (selection.caulkRequirements || []).some((entry) => Number(entry.requiredTubes || 0) > 0)
  );
}

export function hasNoJobMaterialRequirements(selection: JobMaterialSelection): boolean {
  return !hasJobMaterialRequirements(selection);
}

export function shouldPromptForLaborOnlyConfirmation(
  selection: JobMaterialSelection,
  currentIsLaborOnly = false
): boolean {
  return hasNoJobMaterialRequirements(selection) && !currentIsLaborOnly;
}
