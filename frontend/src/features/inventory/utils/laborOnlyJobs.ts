interface JobMaterialSelection {
  requirements?: unknown[];
  caulkRequirements?: unknown[];
}

export function hasJobMaterialRequirements(selection: JobMaterialSelection): boolean {
  return (selection.requirements?.length || 0) > 0 || (selection.caulkRequirements?.length || 0) > 0;
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
