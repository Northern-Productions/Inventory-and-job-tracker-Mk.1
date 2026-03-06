# Inventory Backend Host

This service is now the primary inventory API for the app. In `supabase` mode it keeps the existing frontend API contract and serves inventory, jobs, allocations, film orders, audit history, and reports from Supabase/Postgres instead of Apps Script.

## Supported Modes

### `supabase` (recommended)

- Uses direct Postgres access through `DATABASE_URL` / `SUPABASE_DB_URL`
- Verifies frontend Supabase auth tokens with `SUPABASE_URL` + `SUPABASE_ANON_KEY`
- Keeps the current `?path=/...` API format so the frontend does not need route changes
- Wraps multi-table writes in SQL transactions
- Caches read responses for a short TTL, keyed per authenticated user

Required env vars:

- `BACKEND_MODE=supabase`
- `DATABASE_URL` or `SUPABASE_DB_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DEFAULT_ORG_ID` if a user belongs to more than one org

### `proxy` (legacy fallback)

- Forwards requests to the old Apps Script backend
- Useful only during rollback or migration validation

Required env vars:

- `BACKEND_MODE=proxy`
- `APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec`

## Local Run

```bash
cd backend
npm ci
npm run start
```

Optional env vars for both modes:

- `PORT` (default `3000`)
- `CACHE_TTL_MS` (default `30000`)
- `MAX_CACHE_ENTRIES` (default `500`)
- `CORS_ALLOWED_ORIGINS` (default `*`)

## Supabase Setup

Run these in order:

1. `migrations/0001_supabase_inventory_schema.sql`
2. `migrations/0002_supabase_import_staging.sql`

Then:

1. Create at least one row in `app.organizations`
2. Add your user to `app.organization_members`
3. Import legacy Sheets CSVs into the `import.*_raw` staging tables
4. Run `select import.load_inventory_from_staging('<org_uuid>');`

The staging migration handles legacy CSV imports that still use natural keys like `JobNumber` and `FilmOrderID`, then resolves them into the UUID-backed `app.*` tables.

## Render Deployment

Use `backend/render.yaml` as blueprint or configure manually:

- Root directory: `backend`
- Build command: `npm ci`
- Start command: `npm run start`
- Health check: `/health`

Set env vars in Render:

- `BACKEND_MODE=supabase`
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DEFAULT_ORG_ID`
- `CACHE_TTL_MS=30000`
- `MAX_CACHE_ENTRIES=500`

## Frontend Configuration

Point the frontend at this backend host:

```env
VITE_API_BASE_URL=https://your-backend.onrender.com/api
VITE_PROXY_TARGET=
```

If you still use Vite's local proxy in frontend dev, keep `VITE_API_BASE_URL=/api` and point the dev proxy at this backend instead of Apps Script.
