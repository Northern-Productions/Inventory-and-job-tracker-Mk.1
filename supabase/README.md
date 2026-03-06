# Supabase Edge Function Backend Host

This folder hosts a no-card deployment path using Supabase Edge Functions.

## Function

- Name: `api-proxy`
- File: `functions/api-proxy/index.ts`
- Auth: `verify_jwt = false` (public proxy endpoint)

This function proxies your current Apps Script API and is compatible with your existing frontend request format (`?path=/...`).

## Prerequisites

1. Supabase account + project
2. Node.js 20+ installed

You can run CLI commands with `npx supabase ...` without installing globally.

## Deploy

From repo root:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set APPS_SCRIPT_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
npx supabase secrets set CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*"
npx supabase functions deploy api-proxy --no-verify-jwt --use-api
```

Or use an env file:

```bash
copy supabase\\.env.example supabase\\.env
# edit supabase/.env values first
npx supabase secrets set --env-file supabase/.env
```

## Test

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/api-proxy/health"
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/api-proxy?path=/health"
```

## Frontend env

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api-proxy
VITE_PROXY_TARGET=
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=PASTE_SUPABASE_ANON_KEY
```

Then redeploy frontend.
