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

- Confirm the target project before any mutating Supabase command. This repo may
  be linked to the PROD project, so treat mutating `--linked` commands as PROD
  unless you have explicitly verified otherwise.
- Apply the checked-in mirrored Supabase migrations for the target environment
  before deploying the Edge function.
- Run the latest schema guard against the same target DB before deploy.

```bash
npx supabase login
npx supabase migration list --linked
npx supabase secrets set --project-ref tiwpulgvxtwlmqdnyuzd DEFAULT_ORG_ID="YOUR_ORG_UUID" CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*" RESEND_API_KEY="YOUR_RESEND_API_KEY" RESEND_FROM_EMAIL="inventory@yourdomain.com" SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" API_BUILD_SHA="YOUR_GIT_SHA" API_BUILT_AT="YYYY-MM-DDTHH:MM:SSZ"
# verify the latest required schema objects are present in the same DB before deploy
npm --prefix backend run check:schema:latest
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

After deploy, prefer the read-only live verification check:

```bash
npm --prefix backend run verify:edge:live
```

Set `SMOKE_AUTH_TOKEN` before running the command, or configure
`SMOKE_USER_EMAIL` and `SMOKE_USER_PASSWORD` in `backend/.env` so the backend
script can mint a fresh token automatically. Override `VERIFY_EDGE_JOB_NUMBER`
and the `VERIFY_EDGE_EXPECTED_*` env vars when you need to verify a different
live job.

`verify:edge:caulk` is a mutating smoke workflow. Run it only after explicit
DEV/PROD smoke instruction; in PROD it must use clearly labeled smoke/test
records and approved smoke credentials. If safe smoke data does not exist, stop
at read-only verification and report the mutating smoke as skipped. It also
expects `SMOKE_FRONTEND_URL` to point at the live frontend so the browser
portion of the smoke can verify the inbound transfer UI.

See `docs/automation/codex-operating-manual.md` for Codex automation,
secret-handling, and smoke-test guardrails.

To provision a dedicated local smoke user and persist those credentials into
`backend/.env`, run `npm --prefix backend run smoke:provision-user`.

## Frontend Env

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```
