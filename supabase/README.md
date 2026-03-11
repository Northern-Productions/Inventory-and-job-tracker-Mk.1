# Supabase Edge Backend

This folder contains the canonical production backend runtime.

## Function

- `functions/api/index.ts`
- shared logic: `functions/_shared/api-handler.ts`
- config: `config.toml`

The function keeps the existing frontend contract:

- `?path=/...`
- `GET` and `POST`
- `{ ok, data, warnings }`

## Deploy

From repo root:

```bash
npx supabase login
npx supabase secrets set DEFAULT_ORG_ID="YOUR_ORG_UUID" CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*" RESEND_API_KEY="YOUR_RESEND_API_KEY" RESEND_FROM_EMAIL="inventory@yourdomain.com" SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
# verify 0006 is applied in the same DB before deploy
npm --prefix backend run check:schema:0006
npx supabase functions deploy api --no-verify-jwt
```

If you prefer an env file:

```bash
copy supabase\\.env.example supabase\\.env
# edit supabase/.env first
npx supabase secrets set --env-file supabase/.env
```

## Health Check

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/api?path=/health"
```

## Frontend Env

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```
