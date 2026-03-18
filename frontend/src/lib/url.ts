// Purpose: URL helpers for route/path parameter handling.
export function safeDecodePathParam(value: string | undefined | null): string {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) {
    return '';
  }

  try {
    return decodeURIComponent(raw);
  } catch (_error) {
    return raw;
  }
}
