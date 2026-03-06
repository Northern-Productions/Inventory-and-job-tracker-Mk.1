# Migration Plan: Sheets -> Supabase

This is the practical sequence to move your app off Sheets without downtime surprises.

## 1) Create Supabase project

1. Create project in nearest US region.
2. In SQL editor, run:
   - `backend/migrations/0001_supabase_inventory_schema.sql`
   - `backend/migrations/0002_supabase_import_staging.sql`
3. Create your first org row in `app.organizations`.
4. Add your user to `app.organization_members` with role `owner`.

## 2) Import legacy Sheets data through staging

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

Import each CSV into the matching staging table:

1. `FILM DATA` -> `import.film_data_raw`
2. `Boxes_IL`, `Boxes_MS`, `Zeroed_IL`, `Zeroed_MS` -> append all into `import.boxes_raw`
3. `ALLOCATIONS` -> `import.allocations_raw`
4. `FILM ORDERS` -> `import.film_orders_raw`
5. `FILM ORDER BOXES` -> `import.film_order_box_links_raw`
6. `JOBS` -> `import.jobs_raw`
7. `JOB REQUIREMENTS` -> `import.job_requirements_raw`
8. `AuditLog` -> `import.audit_log_raw`
9. `ROLL WEIGHT LOG` -> `import.roll_weight_log_raw`

Then load everything into the live app schema:

```sql
select import.load_inventory_from_staging('<org_uuid>');
```

Optional cleanup after a successful import:

```sql
select import.clear_staging();
```

Why staging exists:

- Legacy CSVs use natural keys like `JobNumber`, `FilmOrderID`, and `BoxID`
- The Supabase schema uses UUID primary keys for `jobs`, `job_requirements`, and other relations
- `import.load_inventory_from_staging(...)` resolves those joins for you during cutover

## 3) Configure the backend host

Set `backend/` to run in Supabase mode:

- `BACKEND_MODE=supabase`
- `DATABASE_URL` or `SUPABASE_DB_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DEFAULT_ORG_ID` if a user can belong to multiple orgs

Point the frontend to the backend URL:

- `VITE_API_BASE_URL=https://your-backend-host/api`
- `VITE_PROXY_TARGET=` for hosted use

## 4) Verify route parity

The Supabase backend now serves the current inventory routes directly:

1. `/health`
2. `/boxes/search`, `/boxes/get`
3. `/jobs/list`, `/jobs/get`
4. `/allocations/jobs`, `/allocations/by-job`, `/allocations/by-box`
5. `/film-orders/list`, `/film-orders/create`, `/film-orders/cancel`, `/film-orders/delete`
6. `/film-data/catalog`
7. `/roll-history/by-box`
8. `/reports/summary`
9. Mutations (`/boxes/add`, `/boxes/update`, `/boxes/set-status`, `/allocations/apply`, `/jobs/create`, `/jobs/update`, `/audit/undo`)

Recommended checks after import:

1. Confirm `/health` returns `mode: "supabase"`
2. Open an inventory box detail page and confirm allocations, history, and roll history load
3. Open the jobs list and a job detail page
4. Create a test film order
5. Check out and check in a test box
6. Confirm new audit and roll history entries appear in Postgres

## 5) Final cutover

1. Freeze writes briefly in the old sheet-backed system.
2. Export fresh CSVs and re-run the staging import.
3. Switch production backend env to `BACKEND_MODE=supabase`.
4. Keep Apps Script read-only for a short rollback window.
5. After the confidence window, retire Apps Script and Google Sheets from the live app path.

## Notes

- Keep API response envelopes unchanged (`{ ok, data, warnings }`) to avoid frontend churn.
- Preserve audit-first mutation behavior during rewrite.
- Use SQL transactions for multi-table mutations to prevent partial writes.
- The Supabase Edge Function in `supabase/functions/api-proxy` is still a legacy Apps Script proxy. The Supabase-native path is `backend/` in `supabase` mode.
