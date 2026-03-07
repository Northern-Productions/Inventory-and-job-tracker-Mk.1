# Window Film Inventory

Window film inventory and jobs app with:

- frontend hosted on Vercel
- backend runtime on Supabase Edge Functions
- auth and data in Supabase

Google Sheets and Apps Script are now legacy migration sources only. They are not part of the live app path.

## Current Architecture

- Frontend: `frontend/`
  - React + Vite + TypeScript
  - TanStack Query
  - PWA via `vite-plugin-pwa`
- Canonical backend: `supabase/functions/api`
  - preserves the existing `?path=/...` API contract
  - validates Supabase bearer tokens
  - serves inventory, jobs, allocations, film orders, audit history, roll history, and reports
- Database: Supabase Postgres
  - schema in `backend/migrations/0001_supabase_inventory_schema.sql`
  - CSV staging import in `backend/migrations/0002_supabase_import_staging.sql`
  - API read helpers in `backend/migrations/0003_supabase_app_api_reads.sql`
  - API mutation RPCs in `backend/migrations/0004_supabase_app_api_mutations.sql`
  - follow-up fixes in `backend/migrations/0005_fix_roll_history_ordering.sql`
- Rollback/parity host: `backend/`
  - optional local or temporary rollback tooling
  - not required for production

## Project Structure

```text
frontend/
  public/
  src/
supabase/
  functions/
    api/
    _shared/
backend/
  migrations/
  docs/
apps-script/         # legacy migration source only
```

## Production Setup

### 1. Run Supabase migrations

Run these in Supabase SQL Editor:

1. `backend/migrations/0001_supabase_inventory_schema.sql`
2. `backend/migrations/0002_supabase_import_staging.sql`
3. `backend/migrations/0003_supabase_app_api_reads.sql`
4. `backend/migrations/0004_supabase_app_api_mutations.sql`
5. `backend/migrations/0005_fix_roll_history_ordering.sql`

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
npx supabase secrets set DEFAULT_ORG_ID="YOUR_ORG_UUID" CACHE_TTL_MS="30000" MAX_CACHE_ENTRIES="500" CORS_ALLOWED_ORIGINS="*"
npx supabase functions deploy api --no-verify-jwt
```

Health check:

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/api?path=/health"
```

### 5. Configure Vercel frontend env

Set these in Vercel for `Production`, `Preview`, and `Development`:

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Do not set `VITE_PROXY_TARGET` in Vercel.

Redeploy after changing env vars.

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
- `apps-script/` remains in the repo only as a historical reference and migration aid.
