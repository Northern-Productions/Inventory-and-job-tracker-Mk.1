// Purpose: Edge runtime environment/config constants.
export const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').trim().replace(/\/+$/g, '');
export const SUPABASE_ANON_KEY = (Deno.env.get('SUPABASE_ANON_KEY') || '').trim();
export const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
export const DEFAULT_ORG_ID = (Deno.env.get('DEFAULT_ORG_ID') || '').trim();
export const RESEND_API_KEY = (Deno.env.get('RESEND_API_KEY') || '').trim();
export const RESEND_FROM_EMAIL = (Deno.env.get('RESEND_FROM_EMAIL') || '').trim();
export const CACHE_TTL_MS = Number(Deno.env.get('CACHE_TTL_MS') || '30000');
export const MAX_CACHE_ENTRIES = Number(Deno.env.get('MAX_CACHE_ENTRIES') || '500');
export const FILM_NAME_ALIAS_CACHE_TTL_MS = Number(Deno.env.get('FILM_NAME_ALIAS_CACHE_TTL_MS') || '30000');
export const CORS_ALLOWED_ORIGINS = (Deno.env.get('CORS_ALLOWED_ORIGINS') || '*')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
