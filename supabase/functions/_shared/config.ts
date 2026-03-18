// Purpose: Edge runtime environment/config constants.
export const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').trim().replace(/\/+$/g, '');
export const SUPABASE_ANON_KEY = (Deno.env.get('SUPABASE_ANON_KEY') || '').trim();
export const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
export const DEFAULT_ORG_ID = (Deno.env.get('DEFAULT_ORG_ID') || '').trim();
export const RESEND_API_KEY = (Deno.env.get('RESEND_API_KEY') || '').trim();
export const RESEND_FROM_EMAIL = (Deno.env.get('RESEND_FROM_EMAIL') || '').trim();

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Deno.env.get(name);
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.trunc(parsed);
  if (normalized < min) {
    return min;
  }

  if (normalized > max) {
    return max;
  }

  return normalized;
}

export const CACHE_TTL_MS = readIntEnv('CACHE_TTL_MS', 30000, 1000, 10 * 60 * 1000);
export const MAX_CACHE_ENTRIES = readIntEnv('MAX_CACHE_ENTRIES', 500, 10, 10_000);
export const FILM_NAME_ALIAS_CACHE_TTL_MS = readIntEnv(
  'FILM_NAME_ALIAS_CACHE_TTL_MS',
  30000,
  1000,
  10 * 60 * 1000
);
export const CORS_ALLOWED_ORIGINS = (Deno.env.get('CORS_ALLOWED_ORIGINS') || '*')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
