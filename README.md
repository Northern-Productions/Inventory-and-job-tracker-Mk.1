# Window Film Inventory

Window film inventory and jobs app with:

- frontend hosted on Vercel
- backend runtime on Supabase Edge Functions
- auth and data in Supabase

Google Sheets and Apps Script are now legacy migration sources only. They are not part of the live app path.

Architecture map: [docs/architecture/modular-map.md](docs/architecture/modular-map.md)

## Current Architecture

- Frontend: `frontend/`
  - React + Vite + TypeScript
  - TanStack Query
  - PWA via `vite-plugin-pwa`
  - inventory route containers now delegate page wiring into local page-model hooks under `frontend/src/features/inventory/pages/*/`
- Canonical backend: `supabase/functions/api`
  - preserves the existing `?path=/...` API contract
  - validates Supabase bearer tokens
  - serves inventory, jobs, allocations, film orders, audit history, roll history, and reports
- Database: Supabase Postgres
  - canonical migration history lives in `backend/migrations/`
  - apply migrations in numeric order through the current checkpoint: `backend/migrations/0065_caulk_transfer_assist_and_new_products.sql`
  - mirrored deploy copy lives in `supabase/migrations/`
- Rollback/parity host: `backend/`
  - optional local or temporary rollback tooling
  - not required for production
- Shared runtime contracts: `shared/`
  - pure cross-runtime domain helpers used by frontend, backend parity host, and Supabase Edge

## Project Structure

```text
frontend/
  public/
  src/
shared/
  domain/
supabase/
  functions/
    api/
    _shared/
backend/
  migrations/
  docs/
```

## Modular Notes

- `frontend/src/domain/*` remains a compatibility layer over `shared/domain/*`.
- `backend/src/app/services/runtime/runtimeCheckoutOperations.mjs` and `runtimeBoxesMutations.mjs` remain stable facades over smaller `runtime/checkout/*` and `runtime/boxes/*` modules.
- `backend/src/app/services/runtimeDeps.mjs` remains the aggregate helper surface, now composed from grouped `runtime/deps/*` barrels.
- `supabase/functions/_shared/api-handler.ts` remains the stable Edge composition root while shared pure helpers continue moving into `_shared/core/` and repository barrels.
- Backend and Supabase code should never import from `frontend/`; cross-runtime pure logic belongs in `shared/`.

## Production Setup

### 1. Run Supabase migrations

Run all checked-in `backend/migrations/*.sql` files in numeric order through:

1. `backend/migrations/0065_caulk_transfer_assist_and_new_products.sql`

The mirrored Supabase deploy copy for this release is:

- `supabase/migrations/20260416130000_caulk_transfer_assist_and_new_products.sql`

### 2. Import legacy sheet data if needed

If you are migrating existing data, export these sheet tabs to CSV and import them into the matching `import.*_raw` tables:

- `FILM DATA` -> `import.film_data_raw`
- `Boxes_IL`, `Boxes_MS`, `Zeroed_IL`, `Zeroed_MS` -> `import.boxes_raw`
- `ALLOCATIONS` -> `import.allocations_raw`
- `FILM ORDERS` -> `import.film_orders_raw`
- `FILM ORDER BOXES` -> `import.film_order_box_links_raw`
- `JOBS` -> `import.jobs_raw`
- `JOB REQUIREMENTS` -> `import.job_requirements_raw`
- `AuditLog` -> `import.audit_log_raw`
- `ROLL WEIGHT LOG` -> `import.roll_weight_log_raw`

Then run:

```sql
select import.load_inventory_from_staging('<org_uuid>');
```

### 3. Configure auth membership

Create an org in `app.organizations` and add each user to `app.organization_members`.

### 4. Deploy the Supabase Edge API

From repo root:

```bash
npx supabase login
npx supabase secrets set --project-ref tiwpulgvxtwlmqdnyuzd DEFAULT_ORG_ID="YOUR_ORG_UUID" CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*" RESEND_API_KEY="YOUR_RESEND_API_KEY" RESEND_FROM_EMAIL="inventory@yourdomain.com" SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" API_BUILD_SHA="YOUR_GIT_SHA" API_BUILT_AT="YYYY-MM-DDTHH:MM:SSZ"
# verify the latest required schema objects exist in the same target DB
npm --prefix backend run check:schema:latest
npx supabase functions deploy api --project-ref tiwpulgvxtwlmqdnyuzd --no-verify-jwt
```

Health check:

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/api?path=/health"
```

The health payload now includes `apiBuildSha` and `apiBuiltAt` so the deployed Edge runtime can be identified without auth.

### 5. Configure Vercel frontend env

Set these in Vercel for `Production`, `Preview`, and `Development`:

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Do not set `VITE_PROXY_TARGET` in Vercel.

Redeploy after changing env vars.

### Supabase password reset redirect URLs

The login page now supports `Forgot Password`, which sends Supabase password reset emails back to the frontend shell root path instead of a hash route.

In Supabase Auth URL Configuration:

- Set the Site URL to your real production app origin and path.
- Add your production frontend URL as an allowed Redirect URL.
- Add your local frontend dev URL, for example `http://localhost:5173/**`.
- If you use Vercel previews, add the preview pattern as an allowed Redirect URL as well.

If these redirect URLs are missing, reset-password emails will not return users to the app correctly.

## Local Development

Install frontend deps:

```bash
cd frontend
npm install
```

Create `frontend/.env` from `frontend/.env.example`.

For hosted-like local development:

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_PROXY_TARGET=
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

For local rollback/parity backend development:

```env
VITE_API_BASE_URL=/api
VITE_PROXY_TARGET=http://localhost:3000
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Start the frontend:

```bash
cd frontend
npm run dev
```

## Notes

- The app uses hash routing for static-host refresh stability.
- The app is a PWA. After deployments, browsers may hold an older cached shell until the site data or service worker is refreshed.
- `backend/` remains available for rollback or parity testing, but production no longer depends on it.

## Release Checklist

1. Apply DB migrations before API/frontend deploy through `0065_caulk_transfer_assist_and_new_products.sql`.
2. Run `npm --prefix backend run check:schema:latest` against the target DB.
3. Set Edge secrets for `API_BUILD_SHA` and `API_BUILT_AT`.
4. Deploy Supabase function `api`.
5. Run `npm --prefix backend run verify:edge:live` with an authenticated smoke user configured via `SMOKE_AUTH_TOKEN` or `SMOKE_USER_EMAIL` / `SMOKE_USER_PASSWORD`.
6. Run `npm --prefix backend run verify:edge:caulk` with `SMOKE_FRONTEND_URL` pointing at the production frontend and the approved smoke admin credentials configured in `backend/.env`.
7. Deploy frontend after API verification is live.

Changes under `supabase/functions/api` or `supabase/functions/_shared` require a Supabase Edge deploy even if the frontend is already on the correct git commit.

### Backend Smoke Auth Setup

For repeatable local backend verification, add a dedicated smoke user to `backend/.env`:

```env
SMOKE_AUTH_TOKEN=
SMOKE_USER_EMAIL=smoke-user@example.com
SMOKE_USER_PASSWORD=your-local-smoke-password
```

The backend smoke scripts prefer `SMOKE_AUTH_TOKEN` when present, but they can also
mint a fresh token automatically from `SMOKE_USER_EMAIL` and `SMOKE_USER_PASSWORD`.
That is the recommended setup because copied access tokens expire.

For the live caulk smoke, also set:

```env
SMOKE_FRONTEND_URL=https://YOUR_PRODUCTION_FRONTEND_ORIGIN
SMOKE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
```

If you want the backend to provision a dedicated low-privilege smoke user locally
and persist those credentials into `backend/.env`, run:

```bash
npm --prefix backend run smoke:provision-user
```
