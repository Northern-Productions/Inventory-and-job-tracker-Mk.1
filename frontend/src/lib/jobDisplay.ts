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
}): string {
  const displayJobNumber = formatJobDisplayNumber(String(job.jobNumber || ''), job.warehouse);
  const workScope = String(job.workScope ?? job.sections ?? '').trim();

  if (!displayJobNumber) {
    return workScope;
  }

  return workScope ? `${displayJobNumber} · ${workScope}` : displayJobNumber;
}
