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
npx supabase secrets set --project-ref tiwpulgvxtwlmqdnyuzd DEFAULT_ORG_ID="YOUR_ORG_UUID" CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*" RESEND_API_KEY="YOUR_RESEND_API_KEY" RESEND_FROM_EMAIL="inventory@yourdomain.com" SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" API_BUILD_SHA="YOUR_GIT_SHA" API_BUILT_AT="YYYY-MM-DDTHH:MM:SSZ"
# verify 0006 is applied in the same DB before deploy
npm --prefix backend run check:schema:0006
npx supabase functions deploy api --project-ref tiwpulgvxtwlmqdnyuzd --no-verify-jwt
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

The health payload includes `apiBuildSha` and `apiBuiltAt` for deployment verification.

## Verify Live Edge Summary

After deploy, run:

```bash
npm --prefix backend run verify:edge:live
```

Set `SMOKE_AUTH_TOKEN` before running the command. Override `VERIFY_EDGE_JOB_NUMBER` and the `VERIFY_EDGE_EXPECTED_*` env vars when you need to verify a different live job.

## Frontend Env

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```
