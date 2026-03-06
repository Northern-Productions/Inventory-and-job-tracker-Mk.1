# Migration Plan: Sheets -> Supabase

This is the practical sequence to move your app off Sheets without downtime surprises.

## 1) Stand up backend host now

1. Deploy `backend/` to Render in `proxy` mode.
2. Point frontend to the new backend URL (`VITE_API_BASE_URL`).
3. Verify the app works exactly as before.

This gives you stable hosting and caching immediately.

## 2) Create Supabase project

1. Create project in nearest US region.
2. In SQL editor, run:
   - `backend/migrations/0001_supabase_inventory_schema.sql`
3. Create your first org row in `app.organizations`.
4. Add your user to `app.organization_members` with role `owner`.

## 3) Export and import data

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

Import order recommendation:

1. `organizations`, `organization_members`
2. `film_catalog`
3. `boxes`
4. `jobs`, `job_requirements`
5. `film_orders`, `film_order_box_links`
6. `allocations`
7. `audit_log`, `roll_weight_log`

## 4) Route-by-route cutover

Replace backend proxy behavior route by route (read routes first):

1. `/health`
2. `/boxes/search`, `/boxes/get`
3. `/jobs/list`, `/jobs/get`
4. `/allocations/jobs`, `/allocations/by-job`, `/allocations/by-box`
5. `/film-orders/list`, `/film-data/catalog`
6. Mutations (`/boxes/add`, `/boxes/update`, `/boxes/set-status`, `/allocations/apply`, job/film-order mutations)

After each route group, compare old vs new responses for parity.

## 5) Final cutover

1. Freeze writes briefly in old system.
2. Run a final incremental data sync.
3. Flip backend mode/routes to Supabase implementation.
4. Keep Apps Script read-only for rollback window.
5. After confidence window, retire Apps Script write path.

## Notes

- Keep API response envelopes unchanged (`{ ok, data, warnings }`) to avoid frontend churn.
- Preserve audit-first mutation behavior during rewrite.
- Use SQL transactions for multi-table mutations to prevent partial writes.
