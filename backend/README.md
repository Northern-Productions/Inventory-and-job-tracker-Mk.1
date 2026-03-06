# Backend Rollback Host

`backend/` is now optional rollback and parity tooling.

Production uses Supabase Edge Functions directly at `supabase/functions/api`. You only need this Node host if you want:

- a temporary rollback target
- a local parity reference while changing the Edge API
- a separate Node runtime for debugging

## Runtime

Recommended mode:

```env
BACKEND_MODE=supabase
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
SUPABASE_URL=https://[PROJECT-REF].supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
DEFAULT_ORG_ID=YOUR_ORG_UUID
PORT=3000
CORS_ALLOWED_ORIGINS=*
CACHE_TTL_MS=30000
MAX_CACHE_ENTRIES=500
```

## Run Locally

```bash
cd backend
npm ci
npm run start
```

Health check:

```bash
curl "http://localhost:3000/health"
```

## Frontend Pairing

If you intentionally use this rollback host in local frontend dev:

```env
VITE_API_BASE_URL=/api
VITE_PROXY_TARGET=http://localhost:3000
```

For production, point the frontend directly at the Supabase Edge API instead.
