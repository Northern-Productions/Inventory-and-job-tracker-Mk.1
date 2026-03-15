function normalizeManufacturerSpacing(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function canonicalizeManufacturerLabel(value: string): string {
  const normalized = normalizeManufacturerSpacing(value);
  const key = normalized.toLowerCase();

  switch (key) {
    case '3m':
      return '3M Solar';
    case 'avery':
      return 'Avery Dennison';
    case 'solar guard':
      return 'Solar Gard';
    default:
      return normalized;
  }
}

export function normalizeManufacturerLookupKey(value: string): string {
  return canonicalizeManufacturerLabel(value).toLowerCase();
}
