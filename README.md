# Window Film Inventory PWA

Phase 1 is a production-focused inventory PWA for window-film boxes/rolls. It provides inventory-only flows now, while keeping the codebase structured for later Jobs and Allocations modules.

## Stack

- Frontend: React + Vite + TypeScript
- Routing: `react-router-dom` with hash routing for static-host refresh stability
- Data: TanStack React Query
- Validation: Zod
- PWA: `vite-plugin-pwa`
- QR scanning: `html5-qrcode`
- Backend: Google Apps Script Web App reading/writing Google Sheets
  - Optional hosted proxy/backend: `backend/` (Node service, Render-ready)

## Project Structure

```text
frontend/
  public/
  src/
    api/
    components/
    domain/
    features/
      inventory/
      jobs/
      allocations/
    lib/
    routes/
apps-script/
  lib/
  router/
  services/
```

## Google Sheets Setup

Create one spreadsheet with these tabs:

- `Boxes_IL`
- `Boxes_MS`
- `Zeroed_IL`
- `Zeroed_MS`
- `AuditLog`
- `FILM DATA`

Use these exact headers and order for `Boxes_IL`, `Boxes_MS`, `Zeroed_IL`, and `Zeroed_MS`:

1. `BoxID`
2. `Manufacturer`
3. `FilmName`
4. `WidthIn`
5. `InitialFeet`
6. `FeetAvailable`
7. `LotRun`
8. `Status`
9. `OrderDate`
10. `ReceivedDate`
11. `InitialWeightLbs`
12. `LastRollWeightLbs`
13. `LastWeighedDate`
14. `FilmKey`
15. `CoreType`
16. `CoreWeightLbs`
17. `LfWeightLbsPerFt`
18. `PurchaseCost`
19. `Notes`

Use these exact headers and order for `FILM DATA`:

1. `FilmKey`
2. `Manufacturer`
3. `FilmName`
4. `SqFtWeightLbsPerSqFt`
5. `DefaultCoreType`
6. `SourceWidthIn`
7. `SourceInitialFeet`
8. `SourceInitialWeightLbs`
9. `UpdatedAt`
10. `SourceBoxId`
11. `Notes`

Defaults and rules:

- `Status` is derived from `ReceivedDate`: blank or future dates are `ORDERED`, and today/past dates are `IN_STOCK`
- `FeetAvailable` defaults to `InitialFeet` when `ReceivedDate` is today or earlier; otherwise it defaults to `0`
- `InitialFeet` and `FeetAvailable` are stored as whole integers
- `FilmKey` is auto-generated as `MANUFACTURER|FILMNAME` in uppercase unless explicitly overridden
- `SqFtWeightLbsPerSqFt` in `FILM DATA` is the canonical film-only weight value; future box weights are derived from it
- `CoreType` is one of `White`, `Red`, or `Cardboard`; core weights are derived from fixed 72-inch reference weights
- When a received box is saved for a new `FilmKey`, the first measured `InitialWeightLbs` seeds a new `FILM DATA` row automatically
- `OrderDate` and `ReceivedDate` are stored as `yyyy-mm-dd`
- `ReceivedDate` may be blank until the box physically arrives at the warehouse
- `RETIRED` is implemented as a soft-delete status inside the existing `Status` column
- Retire reason is captured in `AuditLog.Notes` to preserve the required sheet headers

If you are upgrading an existing sheet, update all four inventory tabs to match the new header order exactly:

- `Boxes_IL`
- `Boxes_MS`
- `Zeroed_IL`
- `Zeroed_MS`

Minimum migration:

- Insert `InitialWeightLbs` immediately after `ReceivedDate`
- Insert `CoreType` immediately after `FilmKey`
- Create the new `FILM DATA` tab with the headers above

Use these exact headers and order for `AuditLog`:

1. `LogID`
2. `Date`
3. `Action`
4. `BoxID`
5. `Before`
6. `After`
7. `User`
8. `Notes`

## Local Development

1. Install dependencies:

   ```bash
   cd frontend
   npm install
   ```

2. Create `frontend/.env` from `frontend/.env.example`.

3. Set:

   - `VITE_API_BASE_URL=/api`
   - `VITE_PROXY_TARGET=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec`
   - `VITE_GOOGLE_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com`

4. Start Vite:

   ```bash
   npm run dev
   ```

### Optional Hosted Backend (Recommended)

If you deploy `backend/` (Render or similar), point the frontend directly to that host:

- `VITE_API_BASE_URL=https://your-backend.onrender.com/api`
- `VITE_PROXY_TARGET=` (blank)

The backend remains API-compatible with the current frontend request format (`?path=/...`) and can proxy Apps Script while you migrate to Postgres.

### Why `/api` in dev

Google Apps Script Web Apps do not reliably expose configurable CORS headers. For stable local development, this project uses the Vite dev proxy so the browser talks to `/api`, and Vite forwards requests to the deployed Apps Script Web App.

The frontend still uses `VITE_API_BASE_URL` exactly as requested; in local dev, that base URL should be `/api`.

## Environment Variables

`frontend/.env.example`:

- `VITE_API_BASE_URL`: Base URL used by the frontend API client
- `VITE_PROXY_TARGET`: Optional Vite dev proxy target for local development
- `VITE_GOOGLE_CLIENT_ID`: Google Identity Services web client ID used for sign-in

## Apps Script Deployment

1. Open the Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Copy the files from `apps-script/` into the Apps Script project, or use `clasp` to push the folder.
   Fastest option for manual setup: use the single-file [apps-script/Code.gs](C:/Users/Rober/OneDrive/Desktop/Work/Spreadsheet-inventory-tracker/apps-script/Code.gs) and paste it into one Apps Script file named `Code.gs`.

   If you use the single-file option:

   - Keep only one script file such as `Code.gs`
   - Paste the full contents of `apps-script/Code.gs`
   - Do not also paste the modular `.gs` files, because that would create duplicate function names

   If you prefer the modular option, use this exact file mapping:

   - `apps-script/main.gs` -> `main.gs`
   - `apps-script/lib/http.gs` -> `http.gs`
   - `apps-script/lib/validate.gs` -> `validate.gs`
   - `apps-script/router/routes.gs` -> `routes.gs`
   - `apps-script/services/sheets.gs` -> `sheets.gs`
   - `apps-script/services/boxes.gs` -> `boxes.gs`
   - `apps-script/services/audit.gs` -> `audit.gs`

   In Apps Script, create each `.gs` file from the `+` button, then paste the full contents from the matching local file.
   The local folders (`lib`, `router`, `services`) are only for organizing this repo; Apps Script itself is flat.
4. In Apps Script, set `Script Properties`:

   - Key: `SPREADSHEET_ID`
   - Value: the target spreadsheet ID
   - Key: `GOOGLE_CLIENT_ID`
   - Value: the same Google web client ID used by the frontend (`VITE_GOOGLE_CLIENT_ID`)

5. Deploy as Web App:

   - Execute as: `Me`
   - Who has access: `Anyone with the link` (or your allowed org audience if appropriate)

6. Use the generated `/exec` URL as the backend target.

### Apps Script API Routing Note

Apps Script does not behave like a traditional path-based server. This project normalizes all requests using a `path` query parameter internally.

Examples:

- `GET https://.../exec?path=/health`
- `POST https://.../exec?path=/boxes/add`

The frontend client handles that for you.

## Google Sign-In Setup

Inventory mutations now use Google sign-in for audit identity. The frontend sends the signed-in Google identity with each write request, and Apps Script writes that identity to `AuditLog`.

1. In Google Cloud Console, open or create a project.
2. Go to `APIs & Services -> Credentials`.
3. Create an `OAuth client ID` of type `Web application`.
4. Add authorized JavaScript origins for every frontend origin you will use:

   - `http://localhost:5173`
   - `http://127.0.0.1:5173`
   - your production app origin

5. Copy the client ID (it ends with `.apps.googleusercontent.com`).
6. Put that value in:

   - `frontend/.env` as `VITE_GOOGLE_CLIENT_ID`

7. Restart Vite after updating `frontend/.env`.
8. Paste the updated `apps-script/Code.gs` into Apps Script and create a new deployment version.

When a user is signed in, the backend writes the signed-in Google identity into `AuditLog.User` as `Name <email>` when available, or just the email.

## Frontend Deployment

1. Build the frontend:

   ```bash
   cd frontend
   npm run build
   ```

2. Deploy the generated `dist/` directory to any static host.
3. Prefer hosting behind a same-origin proxy to the Apps Script API, or keep using a reverse proxy route such as `/api`.

### Backend Host Deployment

Deployable backend host files live in `backend/`:

- Service: `backend/server.mjs`
- Env template: `backend/.env.example`
- Render blueprint: `backend/render.yaml`
- Supabase migration starter: `backend/migrations/0001_supabase_inventory_schema.sql`
- Cutover guide: `backend/docs/MIGRATION_TO_SUPABASE.md`

Hash routing is used, so page refreshes continue to work on static hosting without server-side rewrite rules.

## QR Code Generation / Printing

Each QR code should contain only the `BoxID` text.

Recommended workflow:

1. Export `BoxID` values from Sheets or the app.
2. Use a label/QR generator that accepts plain text input.
3. Print one QR label per box.
4. Verify with the app’s `Scan` page or a phone camera before attaching to inventory.

## Acceptance Checklist — Phase 1

### A) Sheet & API health

1. Tabs exist with correct headers.
2. `GET /health` returns `ok=true`.
3. Local dev works through Vite proxy (`/api`) and the frontend can call the API successfully.

### B) Add box validations

4. Add IL box (no `M` prefix) goes to `Boxes_IL`.
5. Add MS box (`M` prefix) goes to `Boxes_MS`.
6. Duplicate `BoxID` is rejected even across warehouses.
7. `InitialFeet` and `FeetAvailable` are rounded down to integers.
8. Negative `FeetAvailable` is clamped to `0` with a warning.
9. `AuditLog` records add operation with before/after.

### C) Search & view

10. Inventory list shows results for IL and MS correctly.
11. Search by `BoxID` returns correct box.
12. Filters (`status` / `width` / `film` text) work.

### D) Update & status

13. Update box fields persists to the correct sheet row.
14. Set status to `CHECKED_OUT` persists.
15. `AuditLog` records update and status changes.

### E) QR flow

16. QR scan navigates to the correct Box Details.
17. Manual entry fallback works.

### F) Regression sanity

18. Refreshing a route still works because the app uses hash routing.
19. The app installs as a PWA and opens offline; the UI shell loads and API failures surface a readable message.

## Notes for Later Phases

- `frontend/src/features/jobs` is reserved for Phase 2.
- `frontend/src/features/allocations` is reserved for Phase 3.
- `apps-script/services` is already split so `jobs` and `allocations` services can be added without rewriting the router or inventory logic.
