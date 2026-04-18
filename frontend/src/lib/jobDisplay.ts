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
