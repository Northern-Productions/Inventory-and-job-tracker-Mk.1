export function formatJobDisplayNumber(jobNumber: string, warehouse?: string | null): string {
  const normalizedJobNumber = String(jobNumber || '').trim();
  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase();

  if (!normalizedJobNumber) {
    return '';
  }

  if (!normalizedWarehouse) {
    return normalizedJobNumber;
  }

  const prefixedJobNumber = `${normalizedWarehouse}-`;
  if (normalizedJobNumber.toUpperCase().startsWith(prefixedJobNumber)) {
    return normalizedJobNumber;
  }

  return `${normalizedWarehouse}-${normalizedJobNumber}`;
}

export function formatJobDisplayLabel(job: {
  jobNumber?: string | null;
  warehouse?: string | null;
  workScope?: string | null;
  sections?: string | null;
  phaseNumber?: number | null;
  phaseCount?: number | null;
}): string {
  const displayJobNumber = formatJobDisplayNumber(String(job.jobNumber || ''), job.warehouse);
  const rawWorkScope = String(job.workScope ?? job.sections ?? '').trim();
  const phaseNumber = Number(job.phaseNumber || 0);
  const showPhase = phaseNumber > 0 && (Number(job.phaseCount || 0) > 1 || phaseNumber !== 1);
  const workScope = showPhase
    ? `Phase ${phaseNumber}${rawWorkScope ? ` - ${rawWorkScope}` : ''}`
    : rawWorkScope;

  if (!displayJobNumber) {
    return workScope;
  }

  return workScope ? `${displayJobNumber} / ${workScope}` : displayJobNumber;
}
