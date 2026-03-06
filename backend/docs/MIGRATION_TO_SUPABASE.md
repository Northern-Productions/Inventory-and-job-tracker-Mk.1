# Migration Plan: Sheets -> Supabase

This is the practical sequence that moved the app off Google Sheets and Apps Script.

## 1. Create the Supabase project

Run:

1. `backend/migrations/0001_supabase_inventory_schema.sql`
2. `backend/migrations/0002_supabase_import_staging.sql`
3. `backend/migrations/0003_supabase_app_api_reads.sql`
4. `backend/migrations/0004_supabase_app_api_mutations.sql`

Then:

1. create an org row in `app.organizations`
2. add users to `app.organization_members`

## 2. Import legacy CSV data

Export these sheet tabs to CSV:

- `Boxes_IL`, `Boxes_MS`, `Zeroed_IL`, `Zeroed_MS`
- `ALLOCATIONS`
- `FILM ORDERS`
- `FILM ORDER BOXES`
- `JOBS`
- `JOB REQUIREMENTS`
- `AuditLog`
- `ROLL WEIGHT LOG`
- `FILM DATA`

Import into:

1. `FILM DATA` -> `import.film_data_raw`
2. all four box sheets -> `import.boxes_raw`
3. `ALLOCATIONS` -> `import.allocations_raw`
4. `FILM ORDERS` -> `import.film_orders_raw`
5. `FILM ORDER BOXES` -> `import.film_order_box_links_raw`
6. `JOBS` -> `import.jobs_raw`
7. `JOB REQUIREMENTS` -> `import.job_requirements_raw`
8. `AuditLog` -> `import.audit_log_raw`
9. `ROLL WEIGHT LOG` -> `import.roll_weight_log_raw`

Then load staging:

```sql
select import.load_inventory_from_staging('<org_uuid>');
```

Optional cleanup:

```sql
select import.clear_staging();
```

## 3. Deploy the live backend

The live backend is now the Supabase Edge Function:

- `supabase/functions/api`

Set function secrets:

- `DEFAULT_ORG_ID`
- `CACHE_TTL_MS`
- `MAX_CACHE_ENTRIES`
- `CORS_ALLOWED_ORIGINS`

Deploy:

```bash
npx supabase functions deploy api --no-verify-jwt
```

## 4. Point the frontend at Supabase directly

Hosted frontend env:

```env
VITE_API_BASE_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

## 5. Verify the cutover

Recommended checks:

1. `GET /health` returns `mode: "supabase"`
2. inventory list loads
3. box detail loads allocations, history, and roll history
4. jobs list and job detail load
5. checkout/check-in writes succeed
6. audit and roll history entries land in Postgres

## Notes

- The frontend API contract stayed unchanged: `?path=/...` and `{ ok, data, warnings }`.
- Multi-table writes now live in Postgres RPCs for atomicity.
- Google Sheets and Apps Script are legacy migration sources only and are no longer part of the live app path.
