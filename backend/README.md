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
# Optional: defaults to ${SUPABASE_URL}/functions/v1/api when omitted
EDGE_API_BASE_URL=
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

`npm run start` now performs a schema preflight (`check:schema:0006`) and fails fast if migration `0006` is missing in the configured DB.
Use `npm run start:unsafe` only for debugging when you intentionally want to skip that guard.

Health check:

```bash
curl "http://localhost:3000/health"
```

The health payload includes `apiBuildSha` and `apiBuiltAt` when those env vars are set, so the local rollback host can be version-checked against the deployed Edge runtime.

Live Edge verification:

```bash
npm run verify:edge:live
```

Authenticated smoke setup:

```env
SMOKE_AUTH_TOKEN=
SMOKE_USER_EMAIL=smoke-user@example.com
SMOKE_USER_PASSWORD=your-local-smoke-password
```

`SMOKE_AUTH_TOKEN` still works, but it expires. For repeatable local runs, prefer
setting `SMOKE_USER_EMAIL` and `SMOKE_USER_PASSWORD` in `backend/.env`; the smoke
scripts will mint a fresh access token automatically when needed.

To create a dedicated local smoke user and persist those credentials into
`backend/.env`, run:

```bash
npm run smoke:provision-user
```

You can print the currently resolved token with:

```bash
npm run smoke:token
```

## Frontend Pairing

If you intentionally use this rollback host in local frontend dev:

```env
VITE_API_BASE_URL=/api
VITE_PROXY_TARGET=http://localhost:3000
```

For production, point the frontend directly at the Supabase Edge API instead.
