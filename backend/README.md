# Inventory Backend Host

This service gives you a deployable backend host now, while you migrate off Google Sheets.

## Current Mode (`proxy`)

`BACKEND_MODE=proxy` forwards your existing API requests to Apps Script and adds short-lived read caching to reduce repeated latency.

- Compatible with the frontend's current `?path=/...` request format
- Supports `GET` and `POST`
- Clears cache after mutation routes

## Local Run

```bash
cd backend
npm run start
```

Required env vars:

- `BACKEND_MODE=proxy`
- `APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec`

Optional env vars:

- `PORT` (default `3000`)
- `CACHE_TTL_MS` (default `30000`)
- `MAX_CACHE_ENTRIES` (default `500`)
- `CORS_ALLOWED_ORIGINS` (default `*`)

## Render Deployment

Use `backend/render.yaml` as blueprint or configure manually:

- Root directory: `backend`
- Build command: `npm ci`
- Start command: `npm run start`
- Health check: `/health`

Set env vars in Render:

- `BACKEND_MODE=proxy`
- `APPS_SCRIPT_URL=<your apps script /exec url>`
- `CACHE_TTL_MS=30000`
- `MAX_CACHE_ENTRIES=500`

## Frontend Configuration

Set frontend API base to your backend host URL:

```env
VITE_API_BASE_URL=https://your-backend.onrender.com/api
VITE_PROXY_TARGET=
```

## Migration Starter (Supabase)

Supabase schema + RLS starter:

- `migrations/0001_supabase_inventory_schema.sql`

This schema is designed to mirror your current inventory/jobs/allocations/film-order/audit model before replacing the route handlers.
